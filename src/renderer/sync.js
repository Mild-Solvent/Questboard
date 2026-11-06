// HTTP sync client for the devbox sync server (see sync-server/server.py).
// Works in any runtime with fetch (Electron renderer, Capacitor WebView).
(function () {
  let cfg = { baseUrl: '', token: '' };

  const url = (file) => `${cfg.baseUrl.replace(/\/+$/, '')}/${file}`;
  const headers = (extra) => Object.assign({ Authorization: `Bearer ${cfg.token}` }, extra || {});

  async function get(file) {
    const r = await fetch(url(file), { headers: headers(), cache: 'no-store' });
    if (r.status === 404) return { text: null, etag: null };
    if (r.status === 401) throw new Error('Sync token rejected.');
    if (!r.ok) throw new Error(`Sync server answered ${r.status} for ${file}.`);
    return { text: await r.text(), etag: r.headers.get('ETag') };
  }

  // Returns { etag } on success, or { conflict: true, text, etag } when the server has a newer copy.
  async function put(file, text, etag) {
    const h = headers({ 'Content-Type': file.endsWith('.json') ? 'application/json' : 'text/markdown' });
    if (etag) h['If-Match'] = etag;
    const r = await fetch(url(file), { method: 'PUT', headers: h, body: text });
    if (r.status === 412) return { conflict: true, text: await r.text(), etag: r.headers.get('ETag') };
    if (r.status === 401) throw new Error('Sync token rejected.');
    if (!r.ok) throw new Error(`Sync server answered ${r.status} writing ${file}.`);
    return { etag: r.headers.get('ETag') };
  }

  async function check() {
    const r = await fetch(url('health'), { cache: 'no-store' });
    if (!r.ok) throw new Error(`Server unreachable (${r.status}).`);
    const t = await fetch(url('QUESTS.md'), { headers: headers(), cache: 'no-store' });
    if (t.status === 401) throw new Error('Token rejected.');
    return { ok: true, hasQuests: t.status === 200 };
  }

  window.Sync = {
    configure(c) { cfg = Object.assign({}, cfg, c || {}); },
    get ready() { return !!(cfg.baseUrl && cfg.token); },
    get baseUrl() { return cfg.baseUrl; },
    get, put, check,
  };
})();
