// Sync engine for the devbox questboard endpoint.
//   GET/PUT  <base>/QUESTS.md       text/markdown
//   GET/PUT  <base>/progress.json   {"log":[{"text","at","device"}]}
//   GET      <base>/health          {"ok":true}  (no auth)
// Auth: Authorization: Bearer <token>. GET returns ETag; PUT sends If-Match and gets 412 + current
// body on conflict, in which case we three-way merge (shared merge.js) and retry once.
// Local copies, the last synced "base" text and the etags live in small files via the bridge.
(function () {
  const api = window.questboard;
  const M = window.Merge;
  const FILES = {
    quests: { remote: 'QUESTS.md', local: 'QUESTS.md', base: 'base.QUESTS.md', text: true },
    progress: { remote: 'progress.json', local: 'progress.json', base: 'base.progress.json', text: false },
  };
  const META = 'sync.json';

  let cfg = { baseUrl: '', token: '', device: 'phone' };
  const hooks = {};
  let meta = loadMeta();
  let chain = Promise.resolve();
  let status = { state: 'unset', message: 'Sync not set up', at: null };
  const listeners = { status: [], quests: [], progress: [] };

  function loadMeta() { try { return JSON.parse(api.readFile(META) || '{}') || {}; } catch { return {}; } }
  function saveMeta() { api.writeFile(META, JSON.stringify(meta)); }
  const etagOf = (k) => (meta.etags || {})[k] || '';
  const setEtag = (k, v) => { meta.etags = meta.etags || {}; meta.etags[k] = v || ''; saveMeta(); };

  function on(evt, cb) { listeners[evt].push(cb); }
  function emit(evt, payload) { listeners[evt].forEach((f) => { try { f(payload); } catch (e) { console.error(e); } }); }
  function setStatus(state, message) { status = { state, message, at: new Date().toISOString() }; emit('status', status); }

  function configure(c) {
    cfg = { baseUrl: String(c.baseUrl || '').trim().replace(/\/+$/, ''), token: String(c.token || '').trim(), device: String(c.device || 'phone').trim() || 'phone' };
    if (!isConfigured()) setStatus('unset', 'Sync not set up'); else if (status.state === 'unset') setStatus('idle', 'Ready to sync');
  }
  const isConfigured = () => /^https?:\/\//.test(cfg.baseUrl) && cfg.token.length > 0;
  const headers = (extra) => Object.assign({ Authorization: `Bearer ${cfg.token}` }, extra || {});
  const url = (name) => `${cfg.baseUrl}/${name}`;

  // ----- local file helpers -----
  const readLocal = (k) => api.readFile(FILES[k].local);
  const readBase = (k) => api.readFile(FILES[k].base);
  function writeLocal(k, text) { api.writeFile(FILES[k].local, text); }
  function writeBase(k, text) { api.writeFile(FILES[k].base, text); }
  const isDirty = (k) => { const l = readLocal(k); const b = readBase(k); return l !== null && l !== (b === null ? '' : b); };
  function anyDirty() { return Object.keys(FILES).some(isDirty); }

  function mergeTexts(k, base, local, remote) {
    if (FILES[k].text) return M.merge(base || '', local || '', remote || '');
    let a, b; try { a = JSON.parse(local || '{"log":[]}'); } catch { a = { log: [] }; } try { b = JSON.parse(remote || '{"log":[]}'); } catch { b = { log: [] }; }
    return JSON.stringify(M.mergeProgressDoc(a, b), null, 2);
  }

  // Adopt a remote body: merge with local edits if there are any, remember it as the new base.
  // Returns true when the local text changed.
  function adoptRemote(k, remoteBody, etag) {
    const local = readLocal(k);
    const base = readBase(k);
    let next;
    if (local === null || local === (base === null ? '' : base)) next = remoteBody;  // no local edits
    else if (!base && FILES[k].text && typeof hooks.localIsStarter === 'function' && hooks.localIsStarter()) next = remoteBody; // first contact: the starter board is just a placeholder
    else next = mergeTexts(k, base || '', local, remoteBody);
    writeBase(k, remoteBody);
    setEtag(k, etag);
    const changed = next !== local;
    if (changed) { writeLocal(k, next); emit(k, next); }
    return changed;
  }

  async function pullOne(k) {
    const r = await api.http('GET', url(FILES[k].remote), headers());
    if (r.status === 404) { if (readBase(k) === null) { writeBase(k, ''); } return { changed: false, missing: true }; }
    if (r.status === 401) throw new Error('Token rejected (401)');
    if (r.status < 200 || r.status >= 300) throw new Error(`GET ${FILES[k].remote} → ${r.status || r.error || 'no response'}`);
    if (r.etag && r.etag === etagOf(k) && readBase(k) === r.body) return { changed: false };
    return { changed: adoptRemote(k, r.body, r.etag) };
  }

  async function pushOne(k, attempt) {
    if (!isDirty(k)) return false;
    const local = readLocal(k);
    const etag = etagOf(k);
    const h = headers({ 'Content-Type': FILES[k].text ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8' });
    if (etag) h['If-Match'] = etag;
    const r = await api.http('PUT', url(FILES[k].remote), h, local);
    if (r.status === 200 || r.status === 201 || r.status === 204) {
      writeBase(k, local);
      setEtag(k, r.etag || '');
      return true;
    }
    if ((r.status === 412 || r.status === 409) && (attempt || 0) < 2) {
      // Someone else wrote first: merge their version with ours, then try again.
      let remoteBody = r.body, remoteEtag = r.etag;
      if (!remoteEtag) { const g = await api.http('GET', url(FILES[k].remote), headers()); remoteBody = g.body; remoteEtag = g.etag; }
      adoptRemote(k, remoteBody, remoteEtag);
      return pushOne(k, (attempt || 0) + 1);
    }
    if (r.status === 401) throw new Error('Token rejected (401)');
    throw new Error(`PUT ${FILES[k].remote} → ${r.status || r.error || 'no response'}`);
  }

  // Serialize all sync work so pulls and pushes never interleave.
  function run(label, fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  function syncNow(reason) {
    if (!isConfigured()) { setStatus('unset', 'Sync not set up'); return Promise.resolve({ ok: false, unset: true }); }
    return run(reason, async () => {
      setStatus('syncing', 'Syncing…');
      try {
        let changed = false;
        for (const k of Object.keys(FILES)) { const r = await pullOne(k); changed = changed || r.changed; }
        let pushed = false;
        for (const k of Object.keys(FILES)) pushed = (await pushOne(k, 0)) || pushed;
        setStatus('ok', pushed ? 'Synced (sent changes)' : 'Synced');
        return { ok: true, changed, pushed };
      } catch (e) {
        setStatus('error', e.message || String(e));
        return { ok: false, error: e.message || String(e) };
      }
    });
  }

  let pushTimer = null;
  function schedulePush(delay) {
    if (!isConfigured()) return;
    clearTimeout(pushTimer);
    setStatus('dirty', 'Changes to send');
    pushTimer = setTimeout(() => syncNow('push'), delay == null ? 2000 : delay);
  }

  async function test(c) {
    const base = String(c.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) return { ok: false, message: 'Address must start with https://' };
    try {
      const h = await api.http('GET', `${base}/health`, {});
      if (h.status < 200 || h.status >= 300) return { ok: false, message: `Server answered ${h.status || h.error || 'nothing'} on /health` };
      const q = await api.http('GET', `${base}/QUESTS.md`, { Authorization: `Bearer ${String(c.token || '').trim()}` });
      if (q.status === 401) return { ok: false, message: 'Server reachable, but the token was rejected' };
      if (q.status === 404) return { ok: true, message: 'Connected. No quest file on the server yet; yours will be uploaded.' };
      if (q.status < 200 || q.status >= 300) return { ok: false, message: `Quest file: HTTP ${q.status}` };
      const n = (q.body.match(/^\s*[-*]\s+\[ \]/gm) || []).length;
      return { ok: true, message: `Connected. ${n} open quest${n === 1 ? '' : 's'} on the server.` };
    } catch (e) { return { ok: false, message: e.message || String(e) }; }
  }

  // Forget etags/base so the next sync re-pulls everything (used when the address changes).
  function reset() { meta = {}; saveMeta(); for (const k of Object.keys(FILES)) api.writeFile(FILES[k].base, ''); }

  window.Sync = { configure, isConfigured, syncNow, schedulePush, test, reset, on, hooks, getStatus: () => status, isDirty: anyDirty, device: () => cfg.device };
})();
