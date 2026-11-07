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
  const listeners = { resume: [], back: [], insets: [] };
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
  window.questboard = { native: !!host, readFile, writeFile, getPrefs, setPrefs, info, http, openExternal, vibrate, copyText, on };
})();
