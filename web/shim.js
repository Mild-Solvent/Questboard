// Browser stand-in for the Electron preload bridge (src/preload.js).
// Data files live in localStorage; sync goes through whatever window.QB_WEB points at
// (by default a same-origin proxy that adds the Bearer token server-side).
(function () {
  const KEY = (name) => `questboard:${name}`;
  const cfg = Object.assign({ baseUrl: '', token: '', version: 'web', device: 'web' }, window.QB_WEB || {});
  const store = {
    get(name) { try { return localStorage.getItem(KEY(name)); } catch { return null; } },
    set(name, text) { try { localStorage.setItem(KEY(name), text); } catch { /* private mode etc. */ } },
  };

  // Seed the sync settings once, so the board connects on first open without any pasting.
  if (cfg.baseUrl && cfg.token) {
    let s = {};
    try { s = JSON.parse(store.get('settings.json') || '{}') || {}; } catch { s = {}; }
    const cur = s.sync || {};
    if (cur.baseUrl !== cfg.baseUrl || cur.token !== cfg.token) {
      s.sync = { baseUrl: cfg.baseUrl, token: cfg.token };
      s.base = { questsText: '', questsEtag: null, progressText: '', progressEtag: null };
      store.set('settings.json', JSON.stringify(s));
    }
  }

  document.documentElement.classList.add('web');

  window.questboard = {
    readFile: async (name) => store.get(name),
    writeFile: async (name, text) => { store.set(name, text); return true; },
    getAutostart: async () => ({ enabled: false, available: false }),
    setAutostart: async () => false,
    appInfo: async () => ({ version: cfg.version, packaged: true, dataDir: 'browser storage', launchedAtStartup: false, updateReady: false, device: cfg.device }),
    minimize: () => {},
    hide: () => {},
    quit: () => {},
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
    openDataDir: () => {},
    installUpdate: () => {},
    checkUpdate: () => {},
    updateState: async () => ({ state: 'idle' }),
    onQuestsChanged: () => {},
    onUpdateStatus: () => {},
    onIdle: () => {},
  };
})();
