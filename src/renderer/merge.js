// Quest document model: parse/serialize QUESTS.md and three-way merge for sync.
// Pure functions, shared by the desktop and mobile apps (and unit-testable in node).
(function (root) {
  const norm = (s) => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

  function parse(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const d = { title: 'Quests', preamble: [], groups: [] };
    let g = null;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const h1 = line.match(/^#\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (h1 && !g) { d.title = h1[1].trim(); continue; }
      if (h2) { g = { title: h2[1].trim(), items: [] }; d.groups.push(g); continue; }
      if (!g) { d.preamble.push(line); continue; }
      if (task) { g.items.push({ type: 'quest', done: task[1].toLowerCase() === 'x', text: task[2].trim() }); continue; }
      if (bullet) { g.items.push({ type: 'note', text: bullet[1].trim() }); continue; }
      if (line.trim() === '') continue;
      g.items.push({ type: 'text', text: line });
    }
    return d;
  }

  function serialize(d) {
    const out = [`# ${d.title}`];
    const pre = d.preamble.join('\n').replace(/^\n+|\n+$/g, '');
    if (pre) out.push('', pre);
    for (const g of d.groups) {
      out.push('', `## ${g.title}`);
      for (const it of g.items) {
        if (it.type === 'quest') out.push(`- [${it.done ? 'x' : ' '}] ${it.text}`);
        else if (it.type === 'note') out.push(`- ${it.text}`);
        else out.push(it.text);
      }
    }
    return out.join('\n') + '\n';
  }

  // Map of normalized quest text -> { quest, group }
  function index(d) {
    const m = new Map();
    for (const g of d.groups) for (const it of g.items) if (it.type === 'quest') m.set(norm(it.text), { q: it, g });
    return m;
  }

  // Three-way merge at quest granularity. `remote` (the shared repo) decides structure,
  // prose and ordering; quests only one side added survive, quests one side removed go,
  // and a quest done on either side since `base` stays done.
  function merge(baseMd, localMd, remoteMd) {
    const base = parse(baseMd || ''), local = parse(localMd || ''), remote = parse(remoteMd || '');
    const bi = index(base), li = index(local), ri = index(remote);
    const out = { title: remote.title || local.title, preamble: remote.preamble.length ? remote.preamble : local.preamble, groups: [] };

    const doneFor = (key) => {
      const b = bi.get(key), l = li.get(key), r = ri.get(key);
      const bd = b ? b.q.done : false;
      const ld = l ? l.q.done : bd, rd = r ? r.q.done : bd;
      if (ld !== bd) return ld;          // local changed it
      if (rd !== bd) return rd;          // remote changed it
      return rd;
    };

    // A board renamed locally keeps its new name unless the remote renamed it too. The local board is
    // found by the quests it shares with the base board, or else by its position.
    const has = (doc, t) => doc.groups.some((x) => norm(x.title) === norm(t));
    const titleFor = (rg) => {
      const bi0 = base.groups.findIndex((x) => norm(x.title) === norm(rg.title));
      if (bi0 < 0 || has(local, rg.title)) return rg.title;
      const keys = new Set(base.groups[bi0].items.filter((i) => i.type === 'quest').map((i) => norm(i.text)));
      let best = null, score = 0;
      for (const lg of local.groups) {
        if (has(base, lg.title) || has(remote, lg.title)) continue;     // not a renamed board
        const n = lg.items.filter((i) => i.type === 'quest' && keys.has(norm(i.text))).length;
        if (n > score) { best = lg; score = n; }
      }
      if (!best) {
        const lg = local.groups[bi0];
        if (lg && !has(base, lg.title) && !has(remote, lg.title)) best = lg;
      }
      return best ? best.title : rg.title;
    };

    // 1. remote groups and items, dropping quests local deleted since base
    for (const rg of remote.groups) {
      const g = { title: titleFor(rg), items: [] };
      for (const it of rg.items) {
        if (it.type !== 'quest') { g.items.push({ ...it }); continue; }
        const key = norm(it.text);
        if (bi.has(key) && !li.has(key)) continue;       // deleted locally
        const lq = li.get(key);
        g.items.push({ type: 'quest', text: lq ? lq.q.text : it.text, done: doneFor(key) });
      }
      out.groups.push(g);
    }
    // 2. local-only quests (added locally since base) go into their group, creating it if needed
    for (const lg of local.groups) {
      for (const it of lg.items) {
        if (it.type !== 'quest') continue;
        const key = norm(it.text);
        if (ri.has(key)) continue;
        if (bi.has(key)) continue;                        // remote deleted it
        let g = out.groups.find((x) => norm(x.title) === norm(lg.title));
        if (!g) { g = { title: lg.title, items: [] }; out.groups.push(g); }
        let idx = -1; g.items.forEach((x, i) => { if (x.type === 'quest') idx = i; });
        g.items.splice(idx + 1, 0, { type: 'quest', text: it.text, done: it.done });
      }
    }
    // 3. local-only groups with only notes (no quests) are kept if remote lacks them
    for (const lg of local.groups) {
      if (lg.items.some((x) => x.type === 'quest')) continue;
      if (out.groups.find((x) => norm(x.title) === norm(lg.title))) continue;
      if (base.groups.find((x) => norm(x.title) === norm(lg.title))) continue;
      out.groups.push({ title: lg.title, items: lg.items.map((x) => ({ ...x })) });
    }
    return serialize(out);
  }

  // Progress log union: entries are {text, at, device?}; identity = text + at.
  function mergeProgress(a, b) {
    const seen = new Map();
    for (const e of [...(a || []), ...(b || [])]) {
      if (!e || !e.text || !e.at) continue;
      seen.set(`${e.text}@@${e.at}`, e);
    }
    return [...seen.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }

  // Progress document: { log: [...], removed: ["text@@at", ...] }. Removals win over entries so an
  // undo on one device is not resurrected by another device's older copy.
  function mergeProgressDoc(a, b) {
    a = a || {}; b = b || {};
    const removed = new Set([...(a.removed || []), ...(b.removed || [])]);
    const log = mergeProgress(a.log, b.log).filter((e) => !removed.has(`${e.text}@@${e.at}`));
    const out = { log, removed: [...removed].slice(-500) };
    // an XP reset on any device holds everywhere: the latest reset wins
    const resetAt = [a.resetAt, b.resetAt].filter(Boolean).sort().pop();
    if (resetAt) out.resetAt = resetAt;
    return out;
  }

  const Merge = { parse, serialize, merge, mergeProgress, mergeProgressDoc, norm, index };
  if (typeof module !== 'undefined' && module.exports) module.exports = Merge;
  else root.Merge = Merge;
})(typeof window !== 'undefined' ? window : globalThis);
