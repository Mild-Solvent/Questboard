// Bridge between the web app and the Android host (AndroidBridge, a @JavascriptInterface).
// When there is no host (opened in a desktop browser for development/tests), it falls back
// to localStorage + fetch so the whole UI can run and be tested in Chromium.
(function () {
  const host = window.AndroidBridge || null;
  const pending = new Map();
  let seq = 0;

  const safeName = (n) => String(n).replace(/[^A-Za-z0-9._-]/g, '_');

  // ----- files (small text files in the app's private storage) -----
  function readFile(name) {
    name = safeName(name);
    if (host) { const v = host.readFile(name); return v === null || v === undefined ? null : String(v); }
    const v = localStorage.getItem('qb.file.' + name); return v === null ? null : v;
  }
  function writeFile(name, text) {
    name = safeName(name);
    if (host) return !!host.writeFile(name, String(text));
    localStorage.setItem('qb.file.' + name, String(text)); return true;
  }

  // ----- prefs (theme, sound, sync url, token, device) -----
  function getPrefs() {
    try { return JSON.parse((host ? host.getPrefs() : localStorage.getItem('qb.prefs')) || '{}') || {}; } catch { return {}; }
  }
  function setPrefs(p) {
    const s = JSON.stringify(p || {});
    if (host) host.setPrefs(s); else localStorage.setItem('qb.prefs', s);
  }

  // ----- app info -----
  function info() {
    if (host) { try { return JSON.parse(host.info()); } catch { /* fall through */ } }
    return { version: 'dev', versionCode: 0, device: 'browser', platform: 'web', model: 'browser' };
  }

  // ----- http: done natively on Android (no CORS, no WebView origin issues) -----
  function http(method, url, headers, body) {
    headers = headers || {};
    if (!host) {
      return fetch(url, { method, headers, body: body == null ? undefined : body, cache: 'no-store' }).then(async (r) => ({
        status: r.status, etag: r.headers.get('etag') || '', body: await r.text(),
      }));
    }
    return new Promise((resolve) => {
      const id = String(++seq);
      pending.set(id, resolve);
      host.http(id, method, url, JSON.stringify(headers), body == null ? null : String(body));
    });
  }
  window.__qbHttp = (id, json) => {
    const cb = pending.get(String(id));
    if (!cb) return;
    pending.delete(String(id));
    let r; try { r = JSON.parse(json); } catch { r = { status: 0, etag: '', body: '', error: 'bad response' }; }
    cb(r);
  };

  // ----- misc -----
  function openExternal(url) {
    if (!/^https?:\/\//.test(String(url))) return;
    if (host) host.openExternal(url); else window.open(url, '_blank', 'noopener');
  }
  function vibrate(ms) {
    if (host) { try { host.vibrate(ms | 0); } catch { /* ignore */ } }
    else if (navigator.vibrate) navigator.vibrate(ms | 0);
  }

  // ----- events from the host -----
  const listeners = { resume: [], back: [], insets: [], update: [] };
  function on(evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); }
  window.__qbResume = () => listeners.resume.forEach((f) => f());
  // Return true when the page consumed the back press (e.g. closed a sheet).
  window.__qbBack = () => listeners.back.some((f) => !!f());
  window.__qbInsets = (top, bottom, left, right) => {
    const s = document.documentElement.style;
    s.setProperty('--inset-top', `${top | 0}px`); s.setProperty('--inset-bottom', `${bottom | 0}px`);
    s.setProperty('--inset-left', `${left | 0}px`); s.setProperty('--inset-right', `${right | 0}px`);
    listeners.insets.forEach((f) => f({ top, bottom, left, right }));
  };

  function copyText(text) {
    if (host && host.copyText) { try { return !!host.copyText(String(text)); } catch { return false; } }
    try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); window.__qbCopied = text; return ok || true; } catch { return false; }
  }
  // ----- in-app updates: the APK downloads into private storage and goes to Android's installer -----
  // Events ({state, done, total, message}) arrive at on('update'). States: downloading, ready,
  // failed, needs-permission, installing, confirming, cancelled, installed.
  window.__qbUpdate = (json) => {
    let e; try { e = JSON.parse(json); } catch { return; }
    (listeners.update || []).forEach((f) => f(e));
  };
  const emitUpdate = (e) => window.__qbUpdate(JSON.stringify(e));
  const update = host && host.updateDownload ? {
    supported: true,
    download: (url) => host.updateDownload(String(url)),
    install: () => host.updateInstall(),
    readyVersion: () => { const v = host.updateReadyVersion(); return v === null || v === undefined ? null : String(v); },
    canInstall: () => !!host.updateCanInstall(),
    discard: () => host.updateDiscard(),
  } : {
    // browser (tests): fetch the file, then pretend Android installed it
    supported: !host,
    download: (url) => {
      fetch(url, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
        const b = await r.arrayBuffer();
        window.__qbUpdateBytes = b.byteLength;
        emitUpdate({ state: 'downloading', done: b.byteLength / 2, total: b.byteLength });
        setTimeout(() => emitUpdate({ state: 'ready', done: b.byteLength, total: b.byteLength, message: window.__qbUpdateVersion || null }), 50);
      }).catch((err) => emitUpdate({ state: 'failed', done: 0, total: 0, message: err.message }));
    },
    install: () => { window.__qbInstalled = (window.__qbInstalled || 0) + 1; emitUpdate({ state: 'installing', done: 0, total: 0 }); },
    readyVersion: () => null,
    canInstall: () => true,
    discard: () => {},
  };

  // ----- saved copy of the board outside the app (Documents/Questboard), survives an uninstall -----
  // Events ({state: empty|cancelled|failed, message}) arrive at on('safecopy'); a restore reloads the page.
  window.__qbSafeCopy = (json) => {
    let e; try { e = JSON.parse(json); } catch { return; }
    (listeners.safecopy || []).forEach((f) => f(e));
  };
  const safeCopy = host && host.safeCopyInfo ? {
    info: () => { try { return JSON.parse(host.safeCopyInfo()) || {}; } catch { return {}; } },
    pick: () => host.safeCopyPick(),
    start: () => { if (host.safeCopyStart) host.safeCopyStart(); },
  } : {
    info: () => ({ available: false, where: null, savedAt: 0, fresh: false }),
    pick: () => window.__qbSafeCopy(JSON.stringify({ state: 'failed', message: 'only on the phone' })),
    start: () => {},
  };

  window.questboard = { native: !!host, readFile, writeFile, getPrefs, setPrefs, info, http, openExternal, vibrate, copyText, on, update, safeCopy };
})();
