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
  const SYNC_GUIDE_URL = 'https://github.com/Mild-Solvent/Questboard/blob/main/docs/SYNC.md';
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
  // XP is the sum of each log entry's xp (quests 25, secrets their own); counts skip secrets (desktop 0.5.0)
  const xp = () => progress.log.reduce((n, e) => n + (progress.resetAt && e.at <= progress.resetAt ? 0 : Number(e.xp) || XP_PER_QUEST), 0);
  const questLog = () => progress.log.filter((e) => !e.secret);

  // Rank tiers: every three levels the crest turns into a better metal or gem.
  const TIERS = [
    { name: 'Bronze', from: 1, a: '#ffd2a1', b: '#9a5320', glow: 'rgba(240,150,80,.55)' },
    { name: 'Silver', from: 4, a: '#ffffff', b: '#8494a8', glow: 'rgba(220,235,255,.6)' },
    { name: 'Gold', from: 7, a: '#fff4b0', b: '#c88a10', glow: 'rgba(255,205,60,.7)' },
    { name: 'Emerald', from: 10, a: '#c4ffe0', b: '#0f8a4c', glow: 'rgba(60,230,140,.65)' },
    { name: 'Sapphire', from: 13, a: '#cfe6ff', b: '#1f50c8', glow: 'rgba(80,150,255,.75)' },
    { name: 'Ruby', from: 16, a: '#ffd0d6', b: '#b0142e', glow: 'rgba(255,60,90,.7)' },
    { name: 'Amethyst', from: 19, a: '#f0dcff', b: '#7027b8', glow: 'rgba(180,90,255,.75)' },
    { name: 'Diamond', from: 22, a: '#ffffff', b: '#6fd3ff', glow: 'rgba(190,240,255,.9)' },
    { name: 'Mythic', from: 26, a: '#fff0b0', b: '#ff3fd0', glow: 'rgba(255,120,220,.9)' },
  ];
  const tierIndex = (level) => { let i = 0; TIERS.forEach((t, j) => { if (level >= t.from) i = j; }); return i; };
  const tierColors = (t) => [t.a, t.b, '#ffffff', t.b, '#ffd36b'];
  function applyTier(level) {
    const i = tierIndex(level), t = TIERS[i], root = document.documentElement.style;
    root.setProperty('--tier-a', t.a); root.setProperty('--tier-b', t.b); root.setProperty('--tier-glow', t.glow);
    $('#hero').dataset.tier = t.name.toLowerCase();
    $('#hero').style.setProperty('--tier-i', i);
    $('#tier-name').textContent = t.name;
    return i;
  }

  // "Cleared today" heats up the more you clear in one day.
  const HEAT = [
    { at: 0, lbl: 'cleared today' }, { at: 1, lbl: 'cleared today' }, { at: 3, lbl: 'on fire' },
    { at: 5, lbl: 'blazing!' }, { at: 8, lbl: 'inferno!!' }, { at: 12, lbl: 'legendary day' },
  ];
  const heatFor = (n) => { let h = 0; HEAT.forEach((x, i) => { if (n >= x.at) h = i; }); return h; };
  let lastToday = null, lastHeat = null;
  const HEAT_COLORS = [null, ['#ffd36b', '#ffb347'], ['#ffb347', '#ff6a2b', '#ffd36b'], ['#ff6a2b', '#ff3b1f', '#ffd36b', '#fff1c2'],
    ['#9be7ff', '#ffffff', '#5ab8ff', '#ffd36b'], ['#ff5fd2', '#b36bff', '#ffffff', '#ffd36b', '#5ab8ff']];
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
    applyTier(li.level);
    $('#xp-fill').style.width = `${Math.round((li.into / li.need) * 100)}%`;
    $('#xp-label').textContent = `${li.into} / ${li.need} XP`;
    const today = new Date().toDateString();
    const n = questLog().filter((e) => new Date(e.at).toDateString() === today).length;
    const heat = heatFor(n), box = $('#stat-today-box');
    $('#stat-today').textContent = n;
    box.dataset.heat = String(heat);
    $('#stat-today-lbl').textContent = HEAT[heat].lbl;
    if (lastToday !== null && n > lastToday) {
      const num = $('#stat-today'); num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      const r = box.getBoundingClientRect();
      FX.burst(r.left + r.width / 2, r.top + r.height / 2, { count: 16 + heat * 10, power: 0.5 + heat * 0.12, colors: HEAT_COLORS[heat] });
      if (heat > lastHeat && heat >= 2) { setTimeout(() => { banner(HEAT[heat].lbl, `${n} quests cleared today`); Sound.heat && Sound.heat(); api.vibrate(60); }, 700); }
    }
    lastToday = n; lastHeat = heat;
    $('#stat-total').textContent = questLog().length;
    $('#stat-open').textContent = doc.groups.reduce((n, g) => n + g.items.filter((i) => i.type === 'quest' && !doneNow(g, i)).length, 0);
  }

  // ---------- rendering ----------
  const boards = $('#boards');
  const cutLayer = document.createElement('div');
  cutLayer.className = 'cut-layer';
  const tplGroup = $('#tpl-group');
  const tplQuest = $('#tpl-quest');

  function inline(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function isFeatured(g) { return /^active\b/i.test(g.title); }
  // Daily boards ("## Life [daily]", desktop 0.4.6): their quests never move to Completed and are never
  // set done in QUESTS.md. A tick is a progress-log entry that counts for 9 hours, so every device agrees.
  const DAILY_RE = /\s*\[daily\]\s*$/i;
  const DAILY_MS = 9 * 60 * 60 * 1000;
  const isDaily = (g) => DAILY_RE.test(g.title);
  const groupKey = (g) => g.title.replace(DAILY_RE, '');            // name used for looks and layout
  function dailyEntry(q) {
    const k = norm(q.text), now = Date.now();
    let best = null;
    for (const e of progress.log) {
      if (norm(e.text) !== k) continue;
      const t = Date.parse(e.at);
      if (now - t < DAILY_MS && (!best || t > Date.parse(best.at))) best = e;
    }
    return best;
  }
  const doneNow = (g, q) => q.done || (isDaily(g) && !!dailyEntry(q));
  function toggleDaily(g) {
    g.title = isDaily(g) ? groupKey(g) : `${groupKey(g)} [daily]`;
    persist(); render();
    toast(isDaily(g) ? `${groupKey(g)} is a daily board now: ticks reset 9 hours after you make them.` : `${groupKey(g)} is a normal board again.`);
  }
  function countText(g) {
    const open = g.items.filter((x) => x.type === 'quest' && !x.done);
    return isDaily(g) ? `${open.filter((x) => !dailyEntry(x)).length} left today` : `${open.length} open`;
  }
  const GLYPHS = { echo: '⚔', money: '¢', skill: '✦', commit: '⚑', life: '☀', deadline: '⌛', someday: '☾', meta: '⚙' };

  function seeded(str, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  // Torn parchment outline (same as desktop 0.4.3): ragged bites, a few deep V-notches, and on
  // some scraps a dog-eared bottom corner (cut off here, the folded flap is drawn in CSS).
  function tornEdge(key, ear) {
    const steps = 30, EAR = 26;
    const j = (i) => {
      const r = seeded(key, 100 + i);
      if (r > 0.93) return 10 + Math.round(seeded(key, 400 + i) * 9);
      return Math.round(r * r * 8);
    };
    const pct = (i) => (i / steps * 100).toFixed(2);
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(`${pct(i)}% ${j(i)}px`);
    const rEnd = ear === 'r' ? steps - 2 : steps;
    for (let i = 1; i < rEnd; i++) pts.push(`calc(100% - ${j(50 + i)}px) ${pct(i)}%`);
    if (ear === 'r') pts.push(`100% calc(100% - ${EAR}px)`, `calc(100% - ${EAR}px) 100%`);
    const bStart = ear === 'r' ? steps - 2 : steps, bEnd = ear === 'l' ? 2 : 0;
    for (let i = bStart; i >= bEnd; i--) pts.push(`${pct(i)}% calc(100% - ${j(100 + i)}px)`);
    if (ear === 'l') pts.push(`${EAR}px 100%`, `0px calc(100% - ${EAR}px)`);
    const lStart = ear === 'l' ? steps - 2 : steps - 1;
    for (let i = lStart; i > 0; i--) pts.push(`${j(150 + i)}px ${pct(i)}%`);
    return `polygon(${pts.join(', ')})`;
  }

  let editing = null, renderLater = false;      // an open inline editor holds off re-renders (sync, timers)
  const backHandlers = new Set();                // the phone's back button cancels an open editor
  api.on('back', () => { for (const f of backHandlers) if (f()) return true; return false; });
  function render() {
    if (editing) { renderLater = true; return; }
    const scrollTop = boards.scrollTop;
    boards.innerHTML = '';
    boards.prepend(cutLayer);
    cutLayer.after(secretLayer);
    drawSecrets();
    const ordered = [...doc.groups].sort((a, b) => (isFeatured(b) ? 1 : 0) - (isFeatured(a) ? 1 : 0));
    ordered.forEach((g, i) => {
      const wrap = tplGroup.content.firstElementChild.cloneNode(true);
      const el = $('.board', wrap);
      wrap.style.setProperty('--i', i);
      wrap.style.setProperty('--rot', `${seeded(groupKey(g), 1) * 2 - 1}deg`);
      wrap.style.setProperty('--nx', `${Math.round(seeded(groupKey(g), 2) * 40 - 20)}px`);
      const earPick = seeded(groupKey(g), 7);
      const ear = isFeatured(g) ? (earPick < 0.6 ? 'l' : '') : (earPick < 0.35 ? 'l' : earPick < 0.7 ? 'r' : '');
      el.style.setProperty('--tear', tornEdge(groupKey(g), ear));
      if (ear) el.dataset.ear = ear;
      // age spots and fold creases, placed per scrap so every paper looks different
      el.style.setProperty('--s1x', `${Math.round(10 + seeded(groupKey(g), 11) * 80)}%`);
      el.style.setProperty('--s1y', `${Math.round(10 + seeded(groupKey(g), 12) * 80)}%`);
      el.style.setProperty('--s2x', `${Math.round(10 + seeded(groupKey(g), 13) * 80)}%`);
      el.style.setProperty('--s2y', `${Math.round(10 + seeded(groupKey(g), 14) * 80)}%`);
      el.style.setProperty('--fx', `${Math.round(30 + seeded(groupKey(g), 15) * 40)}%`);
      el.style.setProperty('--fy', `${Math.round(35 + seeded(groupKey(g), 16) * 30)}%`);
      wrap.dataset.group = groupKey(g);
      if (isFeatured(g)) { wrap.classList.add('featured'); el.classList.add('featured'); }
      const cleanTitle = groupKey(g).replace(/^active:\s*/i, '');
      $('.board-title', el).innerHTML = inline(cleanTitle);
      $('.board-glyph', el).textContent = GLYPHS[Object.keys(GLYPHS).find((k) => new RegExp(k, 'i').test(cleanTitle))] || cleanTitle.replace(/\W/g, '').charAt(0).toUpperCase();
      const quests = g.items.filter((x) => x.type === 'quest');
      const daily = isDaily(g);
      const open = quests.filter((x) => !x.done);
      const done = quests.filter((x) => x.done);
      const left = daily ? open.filter((x) => !dailyEntry(x)).length : open.length;
      $('.board-count', el).textContent = quests.length ? countText(g) : '';
      el.classList.toggle('daily', daily);
      const dbtn = document.createElement('button');
      dbtn.type = 'button'; dbtn.className = 'daily-toggle' + (daily ? ' on' : '');
      dbtn.textContent = daily ? '↻ daily' : '↻';
      dbtn.title = daily ? 'Daily board: ticks reset 9 hours later. Tap to make it a normal board.' : 'Make this a daily board';
      dbtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ask(daily ? 'Make this a normal board?' : 'Make this a daily board?', daily ? 'Ticked quests go back to normal: done means done.' : 'Ticks stay on the board and reset 9 hours after you make them.', daily ? 'Normal board' : 'Daily board').then((ok) => { if (ok) toggleDaily(g); });
      });
      $('.board-head', el).appendChild(dbtn);
      const title = $('.board-title', el);
      onHold(title, () => ask('Rename this board?', cleanTitle, 'Rename').then((ok) => { if (ok) editBoardTitle(g, title, cleanTitle); }));

      const ul = $('.quests', el);
      open.forEach((q) => ul.appendChild(questEl(g, q)));
      if (!quests.length && !g.items.some((x) => x.type !== 'quest')) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing here yet.'; ul.appendChild(e);
      } else if (daily && open.length && !left) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'All done for today. See you tomorrow.'; ul.appendChild(e);
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

  // Gouges live inside #boards, in content coordinates, so they scroll with the wood and the papers.
  // All of them are baked into one canvas (desktop 0.5.0); the oldest go after MAX_CUTS.
  const MAX_CUTS = 1500;
  const cutMarks = [];
  const bake = document.createElement('canvas');
  bake.className = 'cut-bake';
  cutLayer.appendChild(bake);
  const bctx = bake.getContext('2d');
  const secretLayer = document.createElement('div');
  secretLayer.className = 'secret-layer';
  function sizeBake() {
    const w = boards.scrollWidth, h = boards.scrollHeight;
    cutLayer.style.width = `${w}px`; cutLayer.style.height = `${h}px`;
    if (bake.width >= w && bake.height >= h) return false;
    bake.width = Math.ceil(Math.max(w, bake.width) / 256) * 256;
    bake.height = Math.ceil(Math.max(h, bake.height) / 512) * 512;
    return true;                                                   // resizing wiped it: redraw
  }
  function redrawCuts() { bctx.clearRect(0, 0, bake.width, bake.height); for (const c of cutMarks) FX.drawCutOn(bctx, c); }
  function clearCuts() { cutMarks.length = 0; bctx.clearRect(0, 0, bake.width, bake.height); signCuts.length = 0; sctx.clearRect(0, 0, signBake.width, signBake.height); }
  // The guild sign (the XP header) takes cuts too, on a canvas of its own.
  const signCuts = [];
  const signBake = document.createElement('canvas');
  signBake.className = 'sign-cuts';
  const sctx = signBake.getContext('2d');
  function redrawSign() {
    const hero = $('#hero');
    if (signBake.parentNode !== hero) hero.prepend(signBake);
    signBake.width = hero.clientWidth; signBake.height = hero.clientHeight;
    for (const c of signCuts) FX.drawCutOn(sctx, c);
  }
  FX.setMarkLayer((c) => {
    const hr = $('#hero').getBoundingClientRect();
    if (c.x >= hr.left && c.x <= hr.right && c.y >= hr.top && c.y <= hr.bottom) {
      if (signBake.parentNode !== $('#hero')) redrawSign();
      const m = Object.assign({}, c, { x: c.x - hr.left, y: c.y - hr.top, len: c.len * 0.75, w: c.w * 0.85 });
      signCuts.push(m);
      if (signCuts.length > 400) { signCuts.splice(0, 50); redrawSign(); } else FX.drawCutOn(sctx, m);
      return;
    }
    if (cutLayer.parentNode !== boards) boards.prepend(cutLayer);
    const r = boards.getBoundingClientRect();
    const m = Object.assign({}, c, { x: c.x - r.left - boards.clientLeft + boards.scrollLeft, y: c.y - r.top - boards.clientTop + boards.scrollTop });
    cutMarks.push(m);
    if (cutMarks.length > MAX_CUTS) { cutMarks.splice(0, 100); redrawCuts(); }
    if (sizeBake()) redrawCuts(); else FX.drawCutOn(bctx, m);
  });

  // Tapping bare wood (or open water) leaves a mark: a sword cut in Tavern, a splash in Abyss.
  window.addEventListener('click', (e) => {
    const t = e.target;
    const onSign = !!t.closest('#hero') && !t.closest('button, .stat, .crest-wrap, .xp-bar');
    if (!(onSign || t === boards || t === document.body || t.id === 'app')) return;
    Sound.unlock();
    if (prefs.theme === 'abyss') { FX.splash(e.clientX, e.clientY); Sound.splash && Sound.splash(); }
    else { FX.cut(e.clientX, e.clientY); Sound.cut && Sound.cut(); }
    api.vibrate(12);
  });

  function questEl(g, q) {
    const li = tplQuest.content.firstElementChild.cloneNode(true);
    li.classList.toggle('done', doneNow(g, q));
    $('.quest-text', li).innerHTML = inline(q.text);
    if (isDaily(g)) {
      li.classList.add('daily-quest');
      const e = dailyEntry(q);
      if (e) {
        const left = DAILY_MS - (Date.now() - Date.parse(e.at));
        const h = Math.floor(left / 3600000), m = Math.max(1, Math.floor((left % 3600000) / 60000));
        const tag = document.createElement('span'); tag.className = 'resets'; tag.textContent = h ? `resets in ${h} h ${m} min` : `resets in ${m} min`;
        $('.quest-text', li).appendChild(tag);
      }
    }
    const rune = $('.rune', li);
    // Only a tap on the rune completes (or undoes) a quest, like the desktop. The rune sits away from
    // the scrolling thumb; a tap on the text or row does nothing, so scrolling never ticks anything.
    rune.addEventListener('click', (e) => { e.stopPropagation(); if (li.__held || li.classList.contains('editing-row')) return; toggle(g, q, li, rune); });
    const textEl = $('.quest-text', li);
    onHold(li, () => ask('Edit this quest?', q.text, 'Edit').then((ok) => { if (!ok) return; li.classList.add('editing-row'); editQuestText(g, q, textEl, () => li.classList.remove('editing-row')); }), (e) => !e.target.closest('.del, .rune'));
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
      $('.board-count', el).textContent = countText(g);
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
    const daily = isDaily(g);
    const isDone = daily ? !!dailyEntry(q) : q.done;
    if (!isDone) {
      busy = true;
      if (!daily) q.done = true;      // daily quests stay open in QUESTS.md; the log entry is the tick
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
        li.classList.remove('completing');
        if (daily) { busy = false; render(); return; }      // daily quests stay on the board, ticked
        li.classList.add('leaving');
        setTimeout(() => { busy = false; render(); }, 480);
      }, 750);
    } else {
      if (!daily) q.done = false;
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
    ask('Remove this quest?', q.text, 'Remove', true).then((ok) => { if (ok) removeQuest(g, q, li); });
  }

  // ---------- confirmations: everything except a rune tap asks first (Father, 2026-11-07) ----------
  let askOpen = null;
  function ask(title, detail, yes, danger) {
    if (askOpen) askOpen(false);
    return new Promise((resolve) => {
      const back = $('#ask-backdrop'), box = $('#ask');
      $('#ask-title').textContent = title;
      $('#ask-detail').innerHTML = detail ? inline(String(detail)) : '';
      const yb = $('#ask-yes'); yb.textContent = yes || 'Yes'; yb.classList.toggle('danger', !!danger);
      back.hidden = false; box.hidden = false;
      const done = (v) => {
        if (askOpen !== done) return;
        askOpen = null; back.hidden = true; box.hidden = true;
        yb.onclick = null; $('#ask-no').onclick = null; back.onclick = null;
        backHandlers.delete(onBack);
        resolve(v);
      };
      const onBack = () => { done(false); return true; };
      askOpen = done;
      backHandlers.add(onBack);
      yb.onclick = (e) => { e.stopPropagation(); done(true); };
      $('#ask-no').onclick = (e) => { e.stopPropagation(); done(false); };
      back.onclick = () => done(false);
    });
  }
  // ---------- inline editing (desktop 0.4.7: double-click; phone: press and hold) ----------
  function onHold(el, fn, accept) {
    let t = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(t); t = null; };
    el.addEventListener('pointerdown', (e) => {
      if (editing || (accept && !accept(e))) return;
      el.__held = false; sx = e.clientX; sy = e.clientY;
      cancel();
      t = setTimeout(fire, 520);
    });
    // Chrome's own long-press (contextmenu) also opens it, so a busy page can't miss the hold
    const fire = () => { if (!t) return; cancel(); el.__held = true; api.vibrate(20); fn(); };
    el.addEventListener('pointermove', (e) => { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(); });
    // the click that ends a hold must not also tick the quest
    el.addEventListener('click', (e) => { if (el.__held) { e.stopPropagation(); setTimeout(() => { el.__held = false; }, 0); } }, true);
  }
  function inlineEdit(host, value, onSave, onClose) {
    if (editing) return;
    const input = document.createElement('input');
    input.className = 'inline-edit'; input.value = value; input.spellcheck = false;
    input.setAttribute('enterkeyhint', 'done'); input.setAttribute('autocapitalize', 'sentences');
    const prev = host.innerHTML;
    host.innerHTML = ''; host.appendChild(input); host.classList.add('editing');
    editing = input;
    input.focus(); input.select();
    let closed = false;
    const finish = (save) => {
      if (closed) return; closed = true;
      editing = null; host.classList.remove('editing');
      backHandlers.delete(back);
      if (onClose) onClose();
      const v = input.value.replace(/\s+/g, ' ').trim();
      if (save && v && v !== value && onSave(v) !== false) { renderLater = false; render(); return; }
      host.innerHTML = prev;
      if (renderLater) { renderLater = false; render(); }
    };
    const back = () => { finish(false); return true; };
    backHandlers.add(back);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    for (const t of ['pointerdown', 'click', 'contextmenu']) input.addEventListener(t, (e) => e.stopPropagation());
  }
  function editQuestText(g, q, host, onClose) {
    inlineEdit(host, q.text, (text) => {
      const k = norm(text);
      if (doc.groups.some((x) => x.items.some((i) => i !== q && i.type === 'quest' && norm(i.text) === k))) { toast('There is already a quest with that name.'); return false; }
      const old = norm(q.text);
      q.text = text;
      // ticks and XP follow the quest: re-file its log entries under the new name
      progress.log = progress.log.map((e) => {
        if (norm(e.text) !== old) return e;
        progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`).slice(-500);
        return { ...e, text };
      });
      persist(); renderHero();
      Sound.add();
      return true;
    }, onClose);
  }
  function editBoardTitle(g, host, shown) {
    inlineEdit(host, shown, (name) => {
      const prefix = (/^active:\s*/i.exec(g.title) || [''])[0];
      const key = `${prefix}${name}`;
      if (doc.groups.some((x) => x !== g && norm(groupKey(x)) === norm(key))) { toast('There is already a board with that name.'); return false; }
      g.title = isDaily(g) ? `${key} [daily]` : key;
      persist();
      Sound.add();
      return true;
    });
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
    const ti = tierIndex(level), t = TIERS[ti], cols = tierColors(t);
    const ascended = ti > tierIndex(level - 1);
    banner(ascended ? `${t.name} rank!` : 'Level up!', `${level} — ${rankName(level)}`, true);
    Sound.levelUp();
    api.vibrate(ascended ? 260 : 120);
    const app = $('#app');
    app.classList.remove('quaking'); void app.offsetWidth; app.classList.add('quaking');
    setTimeout(() => app.classList.remove('quaking'), 1100);
    $$('.board-wrap').forEach((w) => { w.style.setProperty('--jolt-d', `${Math.random() * 160}ms`); w.style.setProperty('--jolt-r', `${(Math.random() * 2 - 1) * 4}deg`); w.classList.remove('jolt'); void w.offsetWidth; w.classList.add('jolt'); setTimeout(() => w.classList.remove('jolt'), 1200); });
    const flash = $('#flash'); flash.style.setProperty('--flash', t.glow); flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    const cr = $('#rank-crest').getBoundingClientRect();
    const crest = $('#rank-crest'); crest.classList.remove('pulse', 'ascend'); void crest.offsetWidth; crest.classList.add(ascended ? 'ascend' : 'pulse');
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    FX.nova(cx, cy, cols);
    FX.burst(cx, cy, { count: 160, power: 1.9, long: true, colors: cols });
    FX.nova(cr.left + cr.width / 2, cr.top + cr.height / 2, cols);
    setTimeout(() => FX.rain(ascended ? 240 : 150, cols), 200);
    const shots = ascended ? 10 : 6;
    for (let i = 0; i < shots; i++) {
      setTimeout(() => {
        const x = window.innerWidth * (0.12 + Math.random() * 0.76), y = window.innerHeight * (0.15 + Math.random() * 0.5);
        FX.burst(x, y, { count: 55, power: 1.1, colors: cols });
        FX.sparkle(x, y, { count: 8, spread: 50, colors: cols, big: true });
        if (i % 2 === 0) Sound.add();
      }, 300 + i * 190);
    }
  }

  // ---------- secrets: little treasures hidden on the wall, on a random schedule (per device) ----------
  const SECRET_KINDS = [
    { id: 'coin', name: 'Lost gold coin', xp: 10, w: 34 },
    { id: 'key', name: 'Rusty old key', xp: 20, w: 18 },
    { id: 'potion', name: 'Forgotten potion', xp: 20, w: 18 },
    { id: 'scroll', name: 'Tiny secret scroll', xp: 25, w: 12 },
    { id: 'gem', name: 'Glittering gem', xp: 40, w: 10 },
    { id: 'rune', name: 'Glowing rune stone', xp: 40, w: 6 },
    { id: 'egg', name: 'Dragon egg', xp: 100, w: 2 },
  ];
  const SECRET_ART = {
    coin: '<svg viewBox="0 0 24 24"><defs><radialGradient id="sc" cx="35%" cy="30%"><stop offset="0" stop-color="#fff7c8"/><stop offset=".5" stop-color="#f2b632"/><stop offset="1" stop-color="#8a5a0a"/></radialGradient></defs><ellipse cx="12" cy="12" rx="9" ry="9" fill="url(#sc)" stroke="#5a3a06" stroke-width="1"/><ellipse cx="12" cy="12" rx="6" ry="6" fill="none" stroke="#a8740e" stroke-width="1"/><path d="M12 8v8M10 10h4M10 14h4" stroke="#7a4e06" stroke-width="1.2"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="7" cy="12" r="4" fill="none" stroke="#b08a52" stroke-width="2.2"/><path d="M11 12h10M17 12v3M20 12v2" stroke="#b08a52" stroke-width="2.2" stroke-linecap="round"/><circle cx="7" cy="12" r="4" fill="none" stroke="#5a3a16" stroke-width=".6"/></svg>',
    potion: '<svg viewBox="0 0 24 24"><path d="M10 3h4v5l4 7a5 5 0 0 1-4.5 7h-3A5 5 0 0 1 6 15l4-7z" fill="#7a2dd6" fill-opacity=".85" stroke="#2a1040" stroke-width="1"/><path d="M8 15h8" stroke="#d9b3ff" stroke-width="1"/><circle cx="11" cy="17" r="1.2" fill="#f0ddff"/><rect x="9.5" y="2" width="5" height="2" rx="1" fill="#8a5a2a"/></svg>',
    scroll: '<svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="2" fill="#f1dcae" stroke="#6b4a22" stroke-width="1"/><circle cx="5" cy="12" r="2.5" fill="#d9bf8a" stroke="#6b4a22" stroke-width="1"/><circle cx="19" cy="12" r="2.5" fill="#d9bf8a" stroke="#6b4a22" stroke-width="1"/><path d="M12 9v6" stroke="#b8321c" stroke-width="2"/></svg>',
    gem: '<svg viewBox="0 0 24 24"><path d="M6 4h12l4 6-10 11L2 10z" fill="#38c8ff" stroke="#0a3a66" stroke-width="1"/><path d="M2 10h20M8 4l4 17M16 4l-4 17M6 4l2 6M18 4l-2 6" stroke="#bff0ff" stroke-width=".7" fill="none"/></svg>',
    rune: '<svg viewBox="0 0 24 24"><path d="M5 18c-1-6 1-12 7-14 6 2 8 8 7 14-3 3-11 3-14 0z" fill="#6b6b72" stroke="#2c2c30" stroke-width="1"/><path d="M12 7v10M12 9l3 3M12 13l-3 3" stroke="#7df9ff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    egg: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="7" ry="9" fill="#c0392b" stroke="#4a0e08" stroke-width="1"/><path d="M7 10l3 2 2-3 2 3 3-2M6 15l3 1 3-2 3 2 3-1" stroke="#ffb347" stroke-width="1" fill="none"/><ellipse cx="9.5" cy="9" rx="1.5" ry="2.5" fill="#ff8a7a" opacity=".6"/></svg>',
  };
  const now = () => Date.now();
  const rndIn = (a, b) => a + Math.random() * (b - a);
  function secretsState() {
    if (!prefs.secrets || typeof prefs.secrets !== 'object') prefs.secrets = {};
    const s = prefs.secrets;
    if (!Array.isArray(s.active)) s.active = [];
    if (!s.next) s.next = now() + rndIn(3, 12) * 60e3;           // the very first one turns up soon
    if (!s.found) s.found = 0;
    return s;
  }
  function pickKind() {
    const total = SECRET_KINDS.reduce((n, k) => n + k.w, 0);
    let r = Math.random() * total;
    for (const k of SECRET_KINDS) { r -= k.w; if (r <= 0) return k; }
    return SECRET_KINDS[0];
  }
  function bareSpot() {
    const br = boards.getBoundingClientRect();
    const W = Math.max(boards.clientWidth, 300), H = Math.max(boards.scrollHeight, boards.clientHeight);
    const rects = $$('.board-wrap', boards).map((w) => { const r = w.getBoundingClientRect(); return { l: r.left - br.left + boards.scrollLeft - 16, t: r.top - br.top + boards.scrollTop - 16, r: r.right - br.left + boards.scrollLeft + 16, b: r.bottom - br.top + boards.scrollTop + 16 }; });
    for (let i = 0; i < 80; i++) {
      const x = rndIn(8, W - 40), y = rndIn(20, H - 40);
      if (!rects.some((q) => x + 28 > q.l && x < q.r && y + 28 > q.t && y < q.b)) return { x, y };
    }
    return null;
  }
  function spawnSecret() {
    const s = secretsState(), spot = bareSpot();
    if (!spot) return false;
    const k = pickKind();
    s.active.push({ id: `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: k.id, x: Math.round(spot.x), y: Math.round(spot.y), until: now() + rndIn(2, 7) * 3600e3, tilt: Math.round(rndIn(-35, 35)) });
    savePrefs();
    return true;
  }
  function tickSecrets() {
    const s = secretsState();
    const before = s.active.length;
    s.active = s.active.filter((x) => x.until > now());
    if (now() >= s.next && s.active.length < 2) {
      if (spawnSecret()) s.next = now() + rndIn(20, 110) * 60e3;    // the next one: somewhere between 20 min and 2 h
    }
    if (s.active.length !== before) savePrefs();
    drawSecrets();
  }
  function drawSecrets() {
    const s = secretsState();
    secretLayer.innerHTML = '';
    for (const it of s.active) {
      const k = SECRET_KINDS.find((x) => x.id === it.kind) || SECRET_KINDS[0];
      const el = document.createElement('button');
      el.type = 'button'; el.className = `secret secret-${k.id}`; el.title = '';
      el.style.left = `${it.x}px`; el.style.top = `${it.y}px`;
      el.style.setProperty('--tilt', `${it.tilt || 0}deg`);
      el.style.setProperty('--glint-d', `${(Math.random() * 9).toFixed(1)}s`);
      el.innerHTML = SECRET_ART[k.id];
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => { e.stopPropagation(); findSecret(it, k, el); });
      secretLayer.appendChild(el);
    }
  }
  function findSecret(it, k, el) {
    const s = secretsState();
    s.active = s.active.filter((x) => x.id !== it.id);
    s.found += 1;
    savePrefs();
    const before = levelInfo(xp()).level;
    progress.log.push({ text: `Secret: ${k.name}`, at: new Date().toISOString(), device: Sync.device(), xp: k.xp, secret: true });
    const after = levelInfo(xp()).level;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.classList.add('found');
    setTimeout(() => el.remove(), 600);
    FX.burst(x, y, { count: 60, power: 1, colors: ['#fff4b0', '#ffd36b', '#ffffff', '#9be7ff'] });
    FX.sparkle(x, y, { count: 14, spread: 40, colors: ['#ffffff', '#fff4b0', '#9be7ff'], big: true });
    Sound.secret && Sound.secret();
    api.vibrate(50);
    floatText(x + 20, y, `+${k.xp} XP`);
    banner('Secret found!', `${k.name} · +${k.xp} XP · ${s.found} found so far`);
    persist(); renderHero();
    if (after > before) setTimeout(() => levelUp(after), 900);
  }

  // the wall behind the sign uses the same planks as the board wall, lined up with it
  function alignWood() {
    const y = boards.getBoundingClientRect().top;
    document.documentElement.style.setProperty('--wood-y', `${Math.round(y)}px`);
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
    if (prefs.theme !== name) clearCuts();
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
    if (s.state === 'unset') hint.textContent = 'Tap a rune to complete a quest, hold a quest to edit it. Sync is optional: ⚙.';
    else if (s.state === 'error') hint.textContent = `Sync error: ${s.message}`;
    else if (s.state === 'syncing') hint.textContent = 'Syncing…';
    else if (s.state === 'dirty') hint.textContent = 'Changes waiting to sync.';
    else hint.textContent = s.at ? `Synced ${timeAgo(s.at)}.` : 'Tap a rune to complete a quest, hold a quest to edit it.';
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
      toast('Board updated from your sync server.');
    };
    if (busy) setTimeout(apply, 1400); else apply();
  });
  Sync.on('progress', (text) => { try { const p = JSON.parse(text); if (p && Array.isArray(p.log)) { progress = Object.assign({ removed: [] }, p); renderHero(); } } catch { /* ignore */ } });

  let pollTimer = null;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') Sync.syncNow('poll'); }, 90 * 1000);
    tickSecrets();
    setInterval(() => { if (!editing) tickSecrets(); }, 30 * 1000);
    // the crest sparkles in its tier colours, a hot day throws embers
    setInterval(() => {
      if (document.hidden) return;
      const ti = tierIndex(levelInfo(xp()).level);
      if (ti >= 1) {
        const r = $('#rank-crest').getBoundingClientRect(), t = TIERS[ti];
        FX.sparkle(r.left + r.width / 2, r.top + r.height / 2, { count: Math.min(5, ti), spread: 30, colors: tierColors(t), big: ti >= 6 });
      }
      const heat = Number($('#stat-today-box').dataset.heat);
      if (heat >= 3) {
        const r = $('#stat-today-box').getBoundingClientRect();
        FX.embers(r.left + r.width / 2, r.top + 6, { count: heat * 2 - 3, w: r.width / 2 - 6, colors: HEAT_COLORS[heat] });
      }
    }, 900);
    if (window.ResizeObserver) new ResizeObserver(() => { alignWood(); if (signBake.parentNode) redrawSign(); }).observe($('#hero'));
    window.addEventListener('resize', alignWood);
    alignWood();
    // daily ticks expire on their own: redraw when one flips, and keep the "resets in" labels fresh
    let dailyStamp = '';
    setInterval(() => {
      if (busy || document.hidden) return;
      const stamp = doc.groups.filter(isDaily).flatMap((g) => g.items.filter((i) => i.type === 'quest').map((q) => (dailyEntry(q) ? '1' : '0'))).join('');
      if (stamp !== dailyStamp || document.querySelector('.quest .resets')) { if (dailyStamp || stamp.includes('1')) render(); dailyStamp = stamp; }
    }, 60 * 1000);
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
    $('#set-url').value = prefs.syncUrl || '';      // nothing built in: everyone points it at their own server
    $('#set-token').value = prefs.token || '';
    $('#set-device').value = prefs.device || defaultDevice();
    const s = Sync.getStatus();
    setSheetStatus(s.state === 'error' ? 'err' : s.state === 'ok' ? 'ok' : '', s.state === 'unset' ? '' : s.message);
    $('#set-about').textContent = `Questboard ${info.version || 'dev'} for Android · ${prefs.syncUrl && prefs.token ? 'syncing with your server' : 'sync is off'} · XP ${xp()} (${progress.log.length} cleared)`;
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
      setSheetStatus(r.ok ? 'ok' : 'err', r.ok ? (r.changed ? 'Synced. Board updated from the server.' : 'Synced.') : `Sync failed: ${r.error}`);
      if (r.ok) { startPolling(); setTimeout(closeSheet, 900); }
    });
    $('#set-reset-xp').addEventListener('click', async () => {
      if (!xp()) { toast('XP is already 0.'); return; }
      if (!(await ask('Reset your XP?', `You are level ${levelInfo(xp()).level} with ${xp()} XP. This resets it on every device.`, 'Reset XP', true))) return;
      if (!(await ask('Really reset?', 'Your quest history stays; only XP starts again from 0.', 'Yes, reset', true))) return;
      // desktop 0.5.1: an XP reset is a timestamp, not a wipe; merge keeps the latest one everywhere
      progress.resetAt = new Date().toISOString();
      persist(); renderHero(); toast('XP reset. Fresh start.'); $('#set-about').textContent = `Questboard ${info.version || 'dev'} for Android · XP 0`;
    });
    $('#set-guide').addEventListener('click', () => api.openExternal(SYNC_GUIDE_URL));
    $('#set-prompt').addEventListener('click', () => {
      const ok = api.copyText ? api.copyText(window.SYNC_AGENT_PROMPT || '') : false;
      toast(ok ? 'Setup prompt copied. Paste it to your AI agent.' : 'Could not copy; the prompt is in the guide.');
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
