// Questboard — main process.
// Frameless window + tray. Registers itself as a Windows startup app
// (HKCU\...\CurrentVersion\Run) so it shows up in Task Manager > Startup.
// Quest data lives in Documents\Questboard and is watched for outside edits.
// App updates come from GitHub releases via electron-updater.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev without deps */ }

let win = null;
let tray = null;
let quitting = false;
let updateReady = null;        // version string once an update is downloaded
let lastWrittenQuests = null;  // what we last wrote, to ignore our own file-watch events

// One instance only: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// ---------- paths ----------
function dataDir() {
  const dir = path.join(app.getPath('documents'), 'Questboard');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
const DATA_FILES = new Set(['QUESTS.md', 'progress.json', 'settings.json', 'state.json']);
const questsPath = () => path.join(dataDir(), 'QUESTS.md');
const dataFile = (name) => (DATA_FILES.has(name) ? path.join(dataDir(), name) : null);
const markerPath = () => path.join(app.getPath('userData'), 'autostart-registered');

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function writeFileSafe(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (p === questsPath()) lastWrittenQuests = data;
    fs.writeFileSync(p, data, 'utf8');
    return true;
  } catch (e) {
    console.error('write failed', p, e);
    return false;
  }
}

function ensureQuestsFile() {
  if (fs.existsSync(questsPath())) return;
  const starter = readFileSafe(path.join(__dirname, '..', 'assets', 'QUESTS.starter.md')) || '# Quests\n\n## Active: Today\n- [ ] Add a quest\n';
  writeFileSafe(questsPath(), starter);
}

// ---------- file watching ----------
let watcher = null;
let watchTimer = null;
function watchQuests() {
  try {
    watcher = fs.watch(dataDir(), { persistent: false }, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== 'quests.md') return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const text = readFileSafe(questsPath());
        if (text === null || text === lastWrittenQuests) return;
        lastWrittenQuests = text;
        if (win && !win.isDestroyed()) win.webContents.send('quests:changed', text);
      }, 300);
    });
  } catch (e) { console.error('watch failed', e); }
}

// ---------- autostart ----------
function autostartEnabled() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ path: process.execPath, args: ['--autostart'] }).openAtLogin;
}
function setAutostart(enabled) {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--autostart'], name: 'Questboard' });
  return autostartEnabled();
}
function ensureAutostartOnFirstRun() {
  if (!app.isPackaged || fs.existsSync(markerPath())) return;
  setAutostart(true);
  writeFileSafe(markerPath(), new Date().toISOString());
}

// ---------- updates ----------
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => send('update:status', { state: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => { updateReady = info.version; send('update:status', { state: 'ready', version: info.version }); rebuildTray(); });
  autoUpdater.on('error', (e) => console.error('updater', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 12000);
  setInterval(check, 4 * 60 * 60 * 1000);
}
function installUpdate() {
  if (!autoUpdater || !updateReady) return;
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 820, minHeight: 560,
    frame: false, show: false, backgroundColor: '#2a160a',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}
function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Questboard', click: showWindow },
    { label: 'Open quest file', click: () => shell.openPath(questsPath()) },
    { type: 'separator' },
    { label: 'Launch when Windows starts', type: 'checkbox', checked: autostartEnabled(), enabled: app.isPackaged, click: (item) => { setAutostart(item.checked); rebuildTray(); } },
    updateReady
      ? { label: `Restart to update to v${updateReady}`, click: installUpdate }
      : { label: 'Check for updates', enabled: !!autoUpdater && app.isPackaged, click: () => autoUpdater.checkForUpdates().catch(() => {}) },
    { type: 'separator' },
    { label: `Questboard v${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
  tray.setToolTip('Questboard');
  rebuildTray();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ---------- IPC ----------
ipcMain.handle('data:read', (_e, name) => { const p = dataFile(String(name)); if (!p) return null; if (name === 'QUESTS.md') ensureQuestsFile(); return readFileSafe(p); });
ipcMain.handle('data:write', (_e, name, text) => { const p = dataFile(String(name)); return p ? writeFileSafe(p, String(text)) : false; });
ipcMain.handle('autostart:get', () => ({ enabled: autostartEnabled(), available: app.isPackaged }));
ipcMain.handle('autostart:set', (_e, enabled) => setAutostart(!!enabled));
ipcMain.handle('app:info', () => ({
  version: app.getVersion(), packaged: app.isPackaged, dataDir: dataDir(), platform: process.platform,
  launchedAtStartup: process.argv.includes('--autostart'), updateReady, device: os.hostname(),
}));
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:hide', () => win && win.hide());
ipcMain.on('window:quit', () => { quitting = true; app.quit(); });
ipcMain.on('app:openExternal', (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });
ipcMain.on('app:openDataDir', () => shell.openPath(dataDir()));
ipcMain.on('update:install', installUpdate);

// ---------- lifecycle ----------
app.whenReady().then(() => {
  ensureQuestsFile();
  ensureAutostartOnFirstRun();
  createWindow();
  createTray();
  watchQuests();
  setupUpdater();
});
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; if (watcher) watcher.close(); });
