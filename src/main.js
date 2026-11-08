// Questboard — main process.
// Frameless window + tray. Registers itself as a Windows startup app
// (HKCU\...\CurrentVersion\Run) so it shows up in Task Manager > Startup.
// Quest data lives in Documents\Questboard and is watched for outside edits.
// App updates come from GitHub releases via electron-updater.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev without deps */ }

let win = null;
let tray = null;
let quitting = false;
let updateReady = null;        // version string once an update is downloaded
let updateFile = null;         // path of the downloaded installer (kept by electron-updater until the next one)
let sessionEnding = false;     // Windows is shutting down / restarting / signing out: never start an install now
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
        backupVersion('QUESTS.md', text);
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
// Checks GitHub releases on start, every 2 h, when the window is shown after a while, and on demand.
// A downloaded update installs by itself once the window has been hidden in the tray for a few
// minutes (silent install, app comes back hidden); while the window is open the footer offers
// "restart to update".
//
// Safety (2026-11-08: a silent 0.6.2 update removed 0.6.1 and never installed 0.6.2, most likely cut
// off by a shutdown/restart, and the app was gone):
//  - never start an install while Windows is shutting down, restarting or signing out, and never
//    on quit (autoInstallOnAppQuit is off: quitting during a shutdown would start the installer);
//  - before installing, a small watchdog (PowerShell, outside the app folder) waits for the
//    installer and, if Questboard.exe is missing afterwards, runs the kept installer again;
//  - the installer itself registers a one-time repair at the next sign-in (build/installer.nsh)
//    for the case where the PC goes down mid-install and takes the watchdog with it.
// The board (Documents\Questboard) is never touched by any of this.
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const updaterLogPath = () => path.join(app.getPath('userData'), 'updater.log');
const relaunchHiddenPath = () => path.join(app.getPath('userData'), 'relaunch-hidden');
const watchdogPath = () => path.join(app.getPath('userData'), 'update-watchdog.ps1');
const SILENT_INSTALL_DELAY = 3 * 60 * 1000;   // hidden this long before a tray install starts
function ulog(line) {
  try {
    const p = updaterLogPath();
    if (fs.existsSync(p) && fs.statSync(p).size > 256 * 1024) fs.renameSync(p, p + '.old');
    fs.appendFileSync(p, `${new Date().toISOString()} v${app.getVersion()} ${line}\n`);
  } catch { /* logging must never break the app */ }
}
let updateState = { state: 'idle' };
let lastCheck = 0;
let checking = false;
let silentTimer = null;
function setUpdateState(st) { updateState = st; send('update:status', st); }
function checkForUpdates(manual) {
  if (!autoUpdater || !app.isPackaged) {
    setUpdateState({ state: 'unavailable', manual, message: 'Updates work in the installed app only.' });
    return;
  }
  if (updateReady) { setUpdateState({ state: 'ready', version: updateReady, manual }); return; }
  if (checking) { if (manual) setUpdateState({ ...updateState, manual }); return; }
  checking = true; lastCheck = Date.now();
  setUpdateState({ state: 'checking', manual });
  autoUpdater.checkForUpdates().catch((e) => {
    checking = false;
    ulog(`check failed: ${e && e.message}`);
    setUpdateState({ state: 'error', manual, message: String((e && e.message) || e).split('\n')[0].slice(0, 160) });
  });
}
function markSessionEnding(why) {
  if (sessionEnding) return;
  sessionEnding = true;
  if (silentTimer) { clearTimeout(silentTimer); silentTimer = null; }
  ulog(`session ending (${why}): no update install now`);
}
// Starts the silent tray install only after the window has stayed hidden for a while: a shutdown
// closes/hides the window first, and an install must never race a shutdown.
function scheduleSilentInstall() {
  if (!updateReady || sessionEnding) return;
  if (silentTimer) clearTimeout(silentTimer);
  silentTimer = setTimeout(() => {
    silentTimer = null;
    if (sessionEnding || !updateReady) return;
    if (win && !win.isDestroyed() && win.isVisible()) return;
    installUpdate({ silent: true });
  }, SILENT_INSTALL_DELAY);
}
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: (m) => ulog(`info ${m}`), warn: (m) => ulog(`warn ${m}`), error: (m) => ulog(`error ${m}`), debug: () => {} };
  autoUpdater.on('update-available', (info) => { setUpdateState({ state: 'downloading', version: info.version, percent: 0, manual: updateState.manual }); });
  autoUpdater.on('update-not-available', () => { checking = false; setUpdateState({ state: 'none', manual: updateState.manual }); });
  autoUpdater.on('download-progress', (p) => setUpdateState({ ...updateState, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    checking = false; updateReady = info.version; updateFile = info.downloadedFile || null;
    ulog(`downloaded ${info.version}${updateFile ? ` -> ${updateFile}` : ''}`);
    setUpdateState({ state: 'ready', version: info.version, manual: updateState.manual });
    rebuildTray();
    if (!win || !win.isVisible()) scheduleSilentInstall();
  });
  autoUpdater.on('error', (e) => {
    checking = false;
    ulog(`error ${e && e.message}`);
    setUpdateState({ state: 'error', manual: updateState.manual, message: String((e && e.message) || e).split('\n')[0].slice(0, 160) });
  });
  if (powerMonitor) {
    try { powerMonitor.on('shutdown', () => markSessionEnding('shutdown')); } catch { /* not on this OS */ }
    try { powerMonitor.on('suspend', () => { if (silentTimer) { clearTimeout(silentTimer); silentTimer = null; } }); } catch { /* ignore */ }
    try { powerMonitor.on('resume', () => { if (!sessionEnding && updateReady && (!win || !win.isVisible())) scheduleSilentInstall(); }); } catch { /* ignore */ }
  }
  setTimeout(() => checkForUpdates(false), 12000);
  setInterval(() => checkForUpdates(false), 2 * 60 * 60 * 1000);
}

// PowerShell watchdog, run detached from outside the app folder. Waits for this app to exit and
// the installer to finish, then checks Questboard.exe is back; if not, runs the installer again.
const WATCHDOG_PS1 = String.raw`param([int]$AppPid, [string]$Installer, [string]$Exe, [string]$Log)
function L([string]$m) { try { Add-Content -LiteralPath $Log -Value ("{0} watchdog {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $m) } catch {} }
function InstallerRunning { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $Installer) }).Count -gt 0 }
L "started: app pid $AppPid, installer $Installer"
try { Wait-Process -Id $AppPid -Timeout 180 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 5
$deadline = (Get-Date).AddMinutes(15)
while ((InstallerRunning) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 2 }
Start-Sleep -Seconds 5
if (Test-Path -LiteralPath $Exe) { L "ok: app is installed"; exit 0 }
L "app missing after the update: running the installer again"
if (-not (Test-Path -LiteralPath $Installer)) { L "installer is gone too: download Questboard from https://github.com/Mild-Solvent/Questboard/releases/latest (board is safe in Documents\Questboard)"; exit 1 }
try { Start-Process -FilePath $Installer -ArgumentList '/S','--force-run' -Wait } catch { L "repair run failed: $($_.Exception.Message)" }
Start-Sleep -Seconds 3
if (Test-Path -LiteralPath $Exe) { L "repaired: app is back" } else { L "repair failed: run $Installer by hand (board is safe in Documents\Questboard)" }
`;
function startUpdateWatchdog() {
  if (process.platform !== 'win32' || !updateFile) return;
  try {
    fs.writeFileSync(watchdogPath(), WATCHDOG_PS1, 'utf8');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', watchdogPath(),
      '-AppPid', String(process.pid), '-Installer', updateFile, '-Exe', process.execPath, '-Log', updaterLogPath()],
    { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => ulog(`watchdog failed to start: ${e && e.message}`));
    child.unref();
  } catch (e) { ulog(`watchdog failed to start: ${e && e.message}`); }
}
// A repair entry left by an installer that did finish (or by a run that the app survived) is not needed.
function clearRepairEntry() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const child = spawn('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', '/v', 'QuestboardRepair', '/f'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* ignore */ });
  } catch { /* ignore */ }
}
function installUpdate(opts) {
  if (!autoUpdater || !updateReady) return;
  const silent = !!(opts && opts.silent);
  if (sessionEnding) { ulog(`not installing ${updateReady}: Windows is shutting down`); return; }
  if (silentTimer) { clearTimeout(silentTimer); silentTimer = null; }
  ulog(`installing ${updateReady}${silent ? ' (silent, from tray)' : ''}`);
  if (silent) writeFileSafe(relaunchHiddenPath(), JSON.stringify({ version: updateReady, at: Date.now() }));
  startUpdateWatchdog();
  quitting = true;
  autoUpdater.quitAndInstall(silent, true);
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
  // After a silent update from the tray the app comes back where it was: hidden. Only when the
  // installer started us (--updated) shortly after; a flag left behind by a failed update must not
  // hide the window after a hand-run install or a repair (that is when the user needs to see it).
  let startHidden = false;
  try {
    if (fs.existsSync(relaunchHiddenPath())) {
      const ageMs = Date.now() - fs.statSync(relaunchHiddenPath()).mtimeMs;
      startHidden = process.argv.includes('--updated') && ageMs < 20 * 60 * 1000;
      fs.unlinkSync(relaunchHiddenPath());
    }
  } catch { /* ignore */ }
  win.once('ready-to-show', () => { if (!startHidden) { win.show(); win.focus(); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // Windows only: shutdown / restart / sign-out. No update may start after this.
  win.on('query-session-end', () => markSessionEnding('query-session-end'));
  win.on('session-end', () => markSessionEnding('session-end'));
  // Hidden in the tray the renderer idles: no animation frames, lower priority, and a GC hint.
  win.on('hide', () => { win.webContents.setBackgroundThrottling(true); setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.webContents.send('app:idle', true); }, 1000); });
  win.on('show', () => {
    win.webContents.send('app:idle', false);
    if (Date.now() - lastCheck > 30 * 60 * 1000) checkForUpdates(false);
  });
  win.on('hide', () => { if (updateReady) scheduleSilentInstall(); });
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
      ? { label: `Restart to update to v${updateReady}`, click: () => installUpdate() }
      : { label: 'Check for updates', enabled: !!autoUpdater && app.isPackaged, click: () => { showWindow(); checkForUpdates(true); } },
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
// ---------- local backups ----------
// Every change to the quest list or the progress log is also kept in Documents\Questboard\backups\<file>\.
const BACKUP_FILES = ['QUESTS.md', 'progress.json'];
const BACKUP_KEEP = 500;
const backupDir = (name) => path.join(dataDir(), 'backups', name);
function backupVersion(name, text) {
  if (!BACKUP_FILES.includes(name)) return;
  try {
    const d = backupDir(name);
    fs.mkdirSync(d, { recursive: true });
    const versions = fs.readdirSync(d).filter((f) => !f.startsWith('.')).sort();
    if (versions.length && fs.readFileSync(path.join(d, versions[versions.length - 1]), 'utf8') === text) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');   // 20261106T234512123Z
    fs.writeFileSync(path.join(d, `${stamp}.${name.split('.').pop()}`), text, 'utf8');
    versions.slice(0, Math.max(0, versions.length + 1 - BACKUP_KEEP)).forEach((f) => { try { fs.unlinkSync(path.join(d, f)); } catch { /* ignore */ } });
  } catch (e) { console.error('backup', e && e.message); }
}
const VERSION_RE = /^\d{8}T\d{9}Z\.(md|json)$/;
function stampToIso(id) { const m = id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null; }
ipcMain.handle('backups:list', (_e, name) => {
  name = String(name);
  if (!BACKUP_FILES.includes(name)) return [];
  try {
    return fs.readdirSync(backupDir(name)).filter((f) => VERSION_RE.test(f)).sort().reverse().slice(0, 400)
      .map((id) => ({ id, at: stampToIso(id), text: fs.readFileSync(path.join(backupDir(name), id), 'utf8') }));
  } catch { return []; }
});
ipcMain.handle('data:write', (_e, name, text) => {
  const p = dataFile(String(name));
  if (!p) return false;
  const ok = writeFileSafe(p, String(text));
  if (ok) backupVersion(String(name), String(text));
  return ok;
});
ipcMain.handle('autostart:get', () => ({ enabled: autostartEnabled(), available: app.isPackaged }));
ipcMain.handle('autostart:set', (_e, enabled) => setAutostart(!!enabled));
ipcMain.handle('app:info', () => ({
  version: app.getVersion(), packaged: app.isPackaged, dataDir: dataDir(), platform: process.platform,
  launchedAtStartup: process.argv.includes('--autostart'), updateReady, device: os.hostname(),
  starter: readFileSafe(path.join(__dirname, '..', 'assets', 'QUESTS.starter.md')) || '',
}));
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:hide', () => win && win.hide());
ipcMain.on('window:quit', () => { quitting = true; app.quit(); });
ipcMain.on('app:openExternal', (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });
ipcMain.on('app:openDataDir', () => shell.openPath(dataDir()));
ipcMain.on('update:install', () => installUpdate());
ipcMain.on('update:check', () => checkForUpdates(true));
ipcMain.handle('update:state', () => updateState);

// ---------- lifecycle ----------
app.whenReady().then(() => {
  if (app.isPackaged) ulog(`started${process.argv.includes('--updated') ? ' after an update' : ''}`);
  clearRepairEntry();
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
