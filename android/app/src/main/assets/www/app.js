// Questboard (Android) renderer logic: parse QUESTS.md, render boards, XP, effects, sync.
// Derived from the desktop renderer; the data model is shared through merge.js and the
// devbox sync endpoint (see sync.js). Progress (XP) is the shared progress.json log.
(function () {
  const api = window.questboard;
  const M = window.Merge;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const XP_PER_QUEST = 25;
  const RELEASES_URL = 'https://github.com/Mild-Solvent/Questboard/releases/latest';
  const DEFAULT_SYNC_URL = 'https://devbox.tail20cc8f.ts.net/questboard';
  const RANKS = {
    tavern: ['Tavern Squire', 'Road Wanderer', 'Hedge Knight', 'Guild Adventurer', 'Dragon Botherer', 'Realm Champion', 'Living Legend', 'Myth Incarnate'],
    abyss:  ['Shallow Shrimp', 'Reef Diver', 'Kelp Ranger', 'Trench Explorer', 'Kraken Wrangler', 'Tide Sovereign', 'Abyssal Legend', 'Leviathan'],
  };
  const STARTER = `# Quests

This is your questboard. Set up sync in the settings (gear icon) to see the same quests as on your PC.

## Active: First steps
- [ ] Open the settings and paste the sync address + token
- [ ] Complete this quest to see what happens
- [ ] Try the other theme

## Life
- [ ] Drink water
- [ ] Go outside
`;

  // ---------- state ----------
  let doc = null;          // parsed quest document
  let progress = { log: [], removed: [] };
  let prefs = {};          // theme, sound, syncUrl, token, device
  let info = {};
  const norm = M.norm;

  const loadProgress = () => { try { const p = JSON.parse(api.readFile('progress.json') || 'null'); return p && Array.isArray(p.log) ? Object.assign({ removed: [] }, p) : { log: [], removed: [] }; } catch { return { log: [], removed: [] }; } };

  // ---------- persistence ----------
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.writeFile('QUESTS.md', M.serialize(doc));
      api.writeFile('progress.json', JSON.stringify(progress, null, 2));
      Sync.schedulePush(2000);
      refreshSyncButton();
    }, 150);
  }
  function savePrefs() { api.setPrefs(prefs); }

  // ---------- XP / rank ----------
  const xp = () => progress.log.length * XP_PER_QUEST;
  const xpForLevel = (lvl) => 100 + (lvl - 1) * 50;
  function levelInfo(total) {
    let lvl = 1, rem = total;
    while (rem >= xpForLevel(lvl)) { rem -= xpForLevel(lvl); lvl++; }
    return { level: lvl, into: rem, need: xpForLevel(lvl) };
  }
  function rankName(level) {
    const list = RANKS[prefs.theme] || RANKS.tavern;
    const idx = Math.min(list.length - 1, Math.floor((level - 1) / 2));
    const tier = level > list.length * 2 ? ` ${toRoman(level - list.length * 2 + 1)}` : '';
    return list[idx] + tier;
  }
  function toRoman(n) { const m = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; }

  function renderHero() {
    const li = levelInfo(xp());
    $('#level-num').textContent = li.level;
    $('#rank-name').textContent = rankName(li.level);
    $('#xp-fill').style.width = `${Math.round((li.into / li.need) * 100)}%`;
    $('#xp-label').textContent = `${li.into} / ${li.need} XP`;
    const today = new Date().toDateString();
    $('#stat-today').textContent = progress.log.filter((e) => new Date(e.at).toDateString() === today).length;
    $('#stat-total').textContent = progress.log.length;
    $('#stat-open').textContent = doc.groups.flatMap((g) => g.items).filter((i) => i.type === 'quest' && !i.done).length;
  }

  // ---------- rendering ----------
  const boards = $('#boards');
  const tplGroup = $('#tpl-group');
  const tplQuest = $('#tpl-quest');

  function inline(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function isFeatured(g) { return /^active\b/i.test(g.title); }
  const GLYPHS = { echo: '⚔', money: '¢', skill: '✦', commit: '⚑', life: '☀', deadline: '⌛', someday: '☾', meta: '⚙' };

  function seeded(str, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function tornEdge(key) {
    const pts = []; const steps = 14;
    const j = (i) => Math.round(seeded(key, 100 + i) * 7);
    for (let i = 0; i <= steps; i++) pts.push(`calc(${(i / steps * 100).toFixed(1)}% + 0px) ${j(i)}px`);
    for (let i = 1; i < steps; i++) pts.push(`calc(100% - ${j(50 + i)}px) ${(i / steps * 100).toFixed(1)}%`);
    for (let i = steps; i >= 0; i--) pts.push(`${(i / steps * 100).toFixed(1)}% calc(100% - ${j(100 + i)}px)`);
    for (let i = steps - 1; i > 0; i--) pts.push(`${j(150 + i)}px ${(i / steps * 100).toFixed(1)}%`);
    return `polygon(${pts.join(', ')})`;
  }

  function render() {
    const scrollTop = boards.scrollTop;
    boards.innerHTML = '';
    const ordered = [...doc.groups].sort((a, b) => (isFeatured(b) ? 1 : 0) - (isFeatured(a) ? 1 : 0));
    ordered.forEach((g, i) => {
      const wrap = tplGroup.content.firstElementChild.cloneNode(true);
      const el = $('.board', wrap);
      wrap.style.setProperty('--i', i);
      wrap.style.setProperty('--rot', `${seeded(g.title, 1) * 2 - 1}deg`);
      wrap.style.setProperty('--nx', `${Math.round(seeded(g.title, 2) * 40 - 20)}px`);
      el.style.setProperty('--tear', tornEdge(g.title));
      wrap.dataset.group = g.title;
      if (isFeatured(g)) { wrap.classList.add('featured'); el.classList.add('featured'); }
      const cleanTitle = g.title.replace(/^active:\s*/i, '');
      $('.board-title', el).innerHTML = inline(cleanTitle);
      $('.board-glyph', el).textContent = GLYPHS[Object.keys(GLYPHS).find((k) => new RegExp(k, 'i').test(cleanTitle))] || cleanTitle.replace(/\W/g, '').charAt(0).toUpperCase();
      const quests = g.items.filter((x) => x.type === 'quest');
      const open = quests.filter((x) => !x.done);
      const done = quests.filter((x) => x.done);
      $('.board-count', el).textContent = quests.length ? `${open.length} open` : '';

      const ul = $('.quests', el);
      open.forEach((q) => ul.appendChild(questEl(g, q)));
      if (!quests.length && !g.items.some((x) => x.type !== 'quest')) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing here yet.'; ul.appendChild(e);
      } else if (quests.length && !open.length) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Board cleared. Legendary.'; ul.appendChild(e);
      }

      const notes = $('.notes', el);
      g.items.filter((x) => x.type !== 'quest').forEach((n) => {
        const p = document.createElement('div'); p.className = n.type === 'note' ? 'note' : 'lead'; p.innerHTML = inline(n.text); notes.appendChild(p);
      });

      const dw = $('.done-wrap', el);
      if (done.length) {
        $('.done-count', el).textContent = `(${done.length})`;
        const dl = $('.done-list', el);
        done.forEach((q) => dl.appendChild(questEl(g, q)));
      } else dw.hidden = true;

      wireAdd(el, g);
      boards.appendChild(wrap);
    });
    boards.scrollTop = scrollTop;
    renderHero();
  }

  // Tapping bare wood (or open water) leaves a mark: a sword cut in Tavern, a splash in Abyss.
  window.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!(t === boards || t === document.body || t.id === 'app')) return;
    Sound.unlock();
    if (prefs.theme === 'abyss') { FX.splash(e.clientX, e.clientY); Sound.splash && Sound.splash(); }
    else { FX.cut(e.clientX, e.clientY); Sound.cut && Sound.cut(); }
    api.vibrate(12);
  });

  function questEl(g, q) {
    const li = tplQuest.content.firstElementChild.cloneNode(true);
    li.classList.toggle('done', q.done);
    $('.quest-text', li).innerHTML = inline(q.text);
    const rune = $('.rune', li);
    // On a phone the whole row is the tap target; the × removes.
    li.addEventListener('click', (e) => { if (e.target.closest('.del')) return; toggle(g, q, li, rune); });
    const del = document.createElement('button'); del.className = 'del'; del.title = 'Remove quest'; del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); confirmRemove(g, q, li); });
    li.appendChild(del);
    return li;
  }

  function wireAdd(el, g) {
    const btn = $('.add-btn', el), form = $('.add-form', el), input = $('.add-input', el);
    btn.addEventListener('click', () => { btn.hidden = true; form.hidden = false; input.focus(); setTimeout(() => form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 250); });
    const close = () => { form.hidden = true; btn.hidden = false; input.value = ''; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    input.addEventListener('blur', () => { setTimeout(() => { if (!input.value.trim()) close(); }, 120); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return close();
      const q = { type: 'quest', done: false, text };
      let idx = -1; g.items.forEach((it, i) => { if (it.type === 'quest') idx = i; });
      g.items.splice(idx + 1, 0, q);
      const li = questEl(g, q); li.classList.add('arriving');
      $('.quests', el).querySelector('.empty')?.remove();
      $('.quests', el).appendChild(li);
      $('.board-count', el).textContent = `${g.items.filter((x) => x.type === 'quest' && !x.done).length} open`;
      input.value = '';
      Sound.add();
      api.vibrate(15);
      const r = li.getBoundingClientRect();
      FX.burst(r.left + 18, r.top + 14, { count: 14, power: 0.5 });
      persist(); renderHero();
      close(); input.blur();
    });
  }

  // ---------- actions ----------
  let busy = false;
  function toggle(g, q, li, rune) {
    if (busy) return;
    Sound.unlock();
    const r = rune.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (!q.done) {
      busy = true;
      q.done = true;
      const before = levelInfo(xp()).level;
      progress.log.push({ text: q.text, at: new Date().toISOString(), device: Sync.device() });
      const after = levelInfo(xp()).level;

      li.classList.add('completing');
      FX.burst(cx, cy, { count: 70, power: 1.0 });
      FX.shake($('#app'));
      Sound.complete();
      api.vibrate(40);
      floatText(cx + 40, cy, `+${XP_PER_QUEST} XP`);
      banner(pick(['Quest complete!', 'Done and dusted!', 'Slain!', 'Another one!', 'Cleared!', 'Victory!']), q.text);
      $('#rank-crest').classList.remove('pulse'); void $('#rank-crest').offsetWidth; $('#rank-crest').classList.add('pulse');
      renderHero();
      persist();

      setTimeout(() => {
        if (after > before) levelUp(after);
        li.classList.remove('completing'); li.classList.add('leaving');
        setTimeout(() => { busy = false; render(); }, 480);
      }, 750);
    } else {
      q.done = false;
      // undo: drop the most recent log entry for this quest (if any)
      let idx = -1; progress.log.forEach((e, i) => { if (norm(e.text) === norm(q.text)) idx = i; });
      if (idx >= 0) { const e = progress.log.splice(idx, 1)[0]; progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`).slice(-500); }
      FX.poof(cx, cy);
      Sound.undo();
      api.vibrate(10);
      floatText(cx + 40, cy, `-${XP_PER_QUEST} XP`, true);
      persist();
      render();
    }
  }

  let pendingRemove = null;
  function confirmRemove(g, q, li) {
    // first tap asks, second tap (within 3s) removes
    if (pendingRemove && pendingRemove.q === q) { pendingRemove = null; removeQuest(g, q, li); return; }
    pendingRemove = { q };
    toast('Tap × again to remove this quest');
    setTimeout(() => { if (pendingRemove && pendingRemove.q === q) pendingRemove = null; }, 3000);
  }
  function removeQuest(g, q, li) {
    const i = g.items.indexOf(q);
    if (i < 0) return;
    g.items.splice(i, 1);
    const r = li.getBoundingClientRect();
    FX.poof(r.left + 18, r.top + 14);
    li.classList.add('leaving');
    api.vibrate(20);
    toast(`Removed: ${q.text.replace(/\*\*/g, '').slice(0, 60)}`);
    persist();
    setTimeout(render, 450);
  }

  function levelUp(level) {
    const name = rankName(level);
    banner('Level up!', `${level} — ${name}`, true);
    Sound.levelUp();
    api.vibrate(120);
    FX.shake($('#app'), 600);
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    FX.burst(cx, cy, { count: 140, power: 1.8, long: true });
    setTimeout(() => FX.rain(120), 200);
    setTimeout(() => FX.burst(cx * 0.5, cy * 0.7, { count: 50, power: 1.1 }), 350);
    setTimeout(() => FX.burst(cx * 1.5, cy * 0.7, { count: 50, power: 1.1 }), 500);
  }

  // ---------- ui helpers ----------
  const pick = (a) => a[(Math.random() * a.length) | 0];
  function banner(text, sub, big) {
    const layer = $('#banner-layer');
    const el = document.createElement('div');
    el.className = 'banner' + (big ? ' levelup' : '');
    el.textContent = text;
    if (sub) { const s = document.createElement('small'); s.textContent = sub.replace(/\*\*/g, '').slice(0, 70); el.appendChild(s); }
    layer.appendChild(el);
    setTimeout(() => el.remove(), big ? 2400 : 1500);
  }
  function floatText(x, y, text, neg) {
    const el = document.createElement('div');
    el.className = 'float-xp' + (neg ? ' neg' : '');
    el.textContent = text;
    el.style.left = `${Math.min(x, window.innerWidth - 40)}px`; el.style.top = `${y - 10}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }
  function toast(text) {
    $$('.toast').forEach((t) => t.remove());
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- theme / prefs ----------
  function applyTheme(name) {
    prefs.theme = name;
    document.documentElement.setAttribute('data-theme', name);
    FX.setTheme(name);
    renderHero();
  }
  function toggleTheme() {
    applyTheme(prefs.theme === 'abyss' ? 'tavern' : 'abyss');
    FX.burst(window.innerWidth - 140, 40, { count: 40, power: 0.9 });
    api.vibrate(10);
    savePrefs();
  }
  function applySound() {
    Sound.enabled = prefs.sound !== false;
    $('#btn-sound').classList.toggle('off', !Sound.enabled);
    $('#btn-sound').classList.toggle('on', Sound.enabled);
  }

  // ---------- sync wiring ----------
  const syncBtn = $('#btn-sync');
  function refreshSyncButton() {
    const s = Sync.getStatus();
    syncBtn.classList.remove('ok', 'err', 'dirty', 'unset', 'spinning');
    if (s.state === 'unset') syncBtn.classList.add('unset');
    else if (s.state === 'syncing') syncBtn.classList.add('spinning');
    else if (s.state === 'error') syncBtn.classList.add('err');
    else if (s.state === 'dirty' || Sync.isDirty()) syncBtn.classList.add('dirty');
    else if (s.state === 'ok') syncBtn.classList.add('ok');
    syncBtn.title = s.message;
    const hint = $('#footer-hint');
    if (s.state === 'unset') hint.textContent = 'Tap a quest to complete it. Set up sync in ⚙.';
    else if (s.state === 'error') hint.textContent = `Sync error: ${s.message}`;
    else if (s.state === 'syncing') hint.textContent = 'Syncing…';
    else if (s.state === 'dirty') hint.textContent = 'Changes waiting to sync.';
    else hint.textContent = s.at ? `Synced ${timeAgo(s.at)}.` : 'Tap a quest to complete it.';
  }
  function timeAgo(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 45) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }
  function configureSync() {
    Sync.configure({ baseUrl: prefs.syncUrl || '', token: prefs.token || '', device: prefs.device || defaultDevice() });
    refreshSyncButton();
  }
  function defaultDevice() { return (info.model && info.model !== 'browser') ? String(info.model).slice(0, 30) : 'phone'; }

  // Until the first sync, the starter board is a placeholder: the devbox copy replaces it instead of merging.
  const questKeys = (d) => d.groups.map((g) => norm(g.title) + ':' + g.items.filter((i) => i.type === 'quest').map((i) => norm(i.text)).join(',')).join(';');
  Sync.hooks.localIsStarter = () => questKeys(doc) === questKeys(M.parse(STARTER));
  Sync.on('status', refreshSyncButton);
  Sync.on('quests', (text) => {
    // The server (Claude on the devbox, or the PC) changed the quest file.
    const next = M.parse(text);
    if (M.serialize(next) === M.serialize(doc)) return;
    const apply = () => {
      doc = next; render();
      Sound.add();
      FX.burst(window.innerWidth / 2, 120, { count: 40, power: 0.9 });
      toast('Board updated from the devbox.');
    };
    if (busy) setTimeout(apply, 1400); else apply();
  });
  Sync.on('progress', (text) => { try { const p = JSON.parse(text); if (p && Array.isArray(p.log)) { progress = Object.assign({ removed: [] }, p); renderHero(); } } catch { /* ignore */ } });

  let pollTimer = null;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') Sync.syncNow('poll'); }, 90 * 1000);
  }
  let lastResumeSync = 0;
  function onResume() {
    if (Date.now() - lastResumeSync < 4000) return;
    lastResumeSync = Date.now();
    Sync.syncNow('resume').then(() => refreshSyncButton());
  }

  // ---------- settings sheet ----------
  const sheet = $('#sheet'), backdrop = $('#sheet-backdrop');
  function openSheet() {
    $('#set-url').value = prefs.syncUrl || DEFAULT_SYNC_URL;
    $('#set-token').value = prefs.token || '';
    $('#set-device').value = prefs.device || defaultDevice();
    const s = Sync.getStatus();
    setSheetStatus(s.state === 'error' ? 'err' : s.state === 'ok' ? 'ok' : '', s.state === 'unset' ? '' : s.message);
    $('#set-about').textContent = `Questboard ${info.version || 'dev'} for Android · quests sync through the devbox · XP ${xp()} (${progress.log.length} cleared)`;
    sheet.hidden = false; backdrop.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; backdrop.hidden = true; }
  function setSheetStatus(kind, text) { const el = $('#set-status'); el.className = 'sheet-status' + (kind ? ' ' + kind : ''); el.textContent = text || ''; }
  function readSheet() {
    return { syncUrl: $('#set-url').value.trim().replace(/\/+$/, ''), token: $('#set-token').value.trim(), device: $('#set-device').value.trim() || defaultDevice() };
  }

  // ---------- boot ----------
  function boot() {
    info = api.info();
    $('#version').textContent = `v${info.version || 'dev'}`;
    prefs = Object.assign({ theme: 'tavern', sound: true }, api.getPrefs() || {});

    let text = api.readFile('QUESTS.md');
    if (text === null) { text = STARTER; api.writeFile('QUESTS.md', text); }
    doc = M.parse(text);
    progress = loadProgress();

    applyTheme(prefs.theme || 'tavern');
    applySound();
    render();
    configureSync();

    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-sound').addEventListener('click', () => { prefs.sound = !(prefs.sound !== false); applySound(); if (Sound.enabled) { Sound.unlock(); Sound.add(); } savePrefs(); });
    $('#btn-sync').addEventListener('click', () => {
      if (!Sync.isConfigured()) { openSheet(); return; }
      api.vibrate(8);
      Sync.syncNow('manual').then((r) => { if (r.ok) toast(r.changed ? 'Board updated.' : (r.pushed ? 'Changes sent.' : 'Up to date.')); else if (!r.unset) toast(`Sync failed: ${r.error}`); });
    });
    $('#btn-settings').addEventListener('click', openSheet);
    $('#set-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);
    $('#set-token-eye').addEventListener('click', () => { const t = $('#set-token'); const show = t.type === 'password'; t.type = show ? 'text' : 'password'; $('#set-token-eye').textContent = show ? 'hide' : 'show'; });
    $('#set-test').addEventListener('click', async () => {
      const v = readSheet();
      setSheetStatus('', 'Testing…');
      const r = await Sync.test({ baseUrl: v.syncUrl, token: v.token });
      setSheetStatus(r.ok ? 'ok' : 'err', r.message);
    });
    $('#set-save').addEventListener('click', async () => {
      const v = readSheet();
      const changedUrl = v.syncUrl !== (prefs.syncUrl || '');
      Object.assign(prefs, v); savePrefs();
      if (changedUrl) Sync.reset();
      configureSync();
      if (!Sync.isConfigured()) { setSheetStatus('', 'Saved. Sync is off until both the address and the token are filled in.'); return; }
      setSheetStatus('', 'Saved. Syncing…');
      const r = await Sync.syncNow('settings');
      setSheetStatus(r.ok ? 'ok' : 'err', r.ok ? (r.changed ? 'Synced. Board updated from the devbox.' : 'Synced.') : `Sync failed: ${r.error}`);
      if (r.ok) { startPolling(); setTimeout(closeSheet, 900); }
    });
    $('#set-reset-xp').addEventListener('click', () => {
      if (!progress.log.length) { toast('XP is already 0.'); return; }
      // tombstone every entry so other devices do not bring the XP back
      progress = { log: [], removed: (progress.removed || []).concat(progress.log.map((e) => `${e.text}@@${e.at}`)).slice(-500) }; persist(); renderHero(); toast('XP reset. Fresh start.'); $('#set-about').textContent = `Questboard ${info.version || 'dev'} for Android · XP 0`;
    });
    $('#set-releases').addEventListener('click', () => api.openExternal(RELEASES_URL));

    api.on('back', () => { if (!sheet.hidden) { closeSheet(); return true; } return false; });
    api.on('resume', onResume);
    document.addEventListener('visibilitychange', () => { if (FX.setIdle) FX.setIdle(document.hidden); if (document.visibilityState === 'visible') onResume(); });
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      if (e.key === 't' || e.key === 'T') toggleTheme();
      if (e.key === 'm' || e.key === 'M') $('#btn-sound').click();
    });
    window.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

    if (Sync.isConfigured()) { Sync.syncNow('boot').then(() => refreshSyncButton()); startPolling(); }
    setTimeout(() => banner(pick(['A new day, adventurer.', 'The board awaits.', 'Rise and quest.']), rankName(levelInfo(xp()).level)), 500);
  }

  try { boot(); } catch (e) { console.error(e); toast('Something broke on load: ' + e.message); }
})();
