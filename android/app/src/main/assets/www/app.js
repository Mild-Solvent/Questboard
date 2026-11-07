// Questboard (Android) renderer logic: parse QUESTS.md, render boards, XP, effects, sync.
// Derived from the desktop renderer; the data model is shared through merge.js and the
// devbox sync endpoint (see sync.js). Progress (XP) is the shared progress.json log.
(function () {
  const api = window.questboard;
  const M = window.Merge;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const XP_PER_QUEST = 25;
  // in-app updates (Father, 2026-11-07): the newest release's -android.apk downloads inside the app
  const UPDATE_FEED = 'https://api.github.com/repos/Mild-Solvent/Questboard/releases/latest';
  const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
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
  const entryXp = (e) => (e.secret ? 0 : Number(e.xp) || XP_PER_QUEST);   // desktop 0.6.1: secrets are just for fun, no XP
  const xp = () => progress.log.reduce((n, e) => n + (progress.resetAt && e.at <= progress.resetAt ? 0 : entryXp(e)), 0);
  const questLog = () => progress.log.filter((e) => !e.secret && !e.bonus);

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
    ensureBorn();
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

      if (!g.items.length) {                     // desktop 0.6.2: an empty paper can be taken down (asks first)
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'board-remove'; del.textContent = '✕'; del.title = 'Take this empty paper down';
        del.addEventListener('click', (e) => { e.stopPropagation(); takeDownPaper(g, wrap); });
        $('.board-head', el).appendChild(del);
      }
      wireAdd(el, g);
      boards.appendChild(wrap);
    });
    boards.appendChild(blankPaper());
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
  const onWall = (t) => (!!t.closest('#hero') && !t.closest('button, .stat, .crest-wrap, .xp-bar')) || t === boards || t === document.body || t.id === 'app';
  window.addEventListener('click', (e) => {
    const t = e.target;
    if (castedAt && performance.now() - castedAt < 600) return;     // that touch cast a spell
    if (!onWall(t)) return;
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
    if (!isDaily(g) && !q.done) {
      const st = corruption(q);
      if (st) li.classList.add(`corrupt-${st}`);
      if (progress.enchant && progress.enchant.key && progress.enchant.key === norm(q.text)) li.classList.add('enchanted');
      if (learned('enchant')) {
        const en = document.createElement('button'); en.className = 'enchant-btn'; en.title = 'Enchant: double XP'; en.textContent = '✧';
        en.addEventListener('click', (e) => {
          e.stopPropagation();
          const on = progress.enchant && progress.enchant.key === norm(q.text);
          ask(on ? 'Lift the enchantment?' : 'Enchant this quest?', on ? q.text : `${q.text} · double XP (one quest at a time)`, on ? 'Lift it' : 'Enchant').then((ok) => { if (ok) enchantQuest(q, li); });
        });
        li.appendChild(en);
      }
    }
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
      const { xp: gain, notes } = questXp(g, q);
      const entry = { text: q.text, at: new Date().toISOString(), device: Sync.device() };
      if (gain !== XP_PER_QUEST) entry.xp = gain;
      progress.log.push(entry);
      if (progress.enchant && progress.enchant.key === norm(q.text)) progress.enchant = { key: null, at: entry.at };
      const comboHit = checkCombo();
      const after = levelInfo(xp()).level;
      if (spellOn('lightning')) { Magic.bolt(cx, cy); Sound.thunder && Sound.thunder(); }
      if (li.className.includes('corrupt-')) { Sound.purify && Sound.purify(); FX.burst(cx, cy, { count: 60, power: 1, colors: ['#c58cff', '#7a2dd6', '#ffffff', '#e6d0ff'] }); }

      li.classList.add('completing');
      FX.burst(cx, cy, { count: 70, power: 1.0 });
      FX.shake($('#app'));
      Sound.complete();
      api.vibrate(40);
      floatText(cx + 40, cy, `+${gain} XP`);
      banner(notes.length ? notes.join(' · ') : pick(['Quest complete!', 'Done and dusted!', 'Slain!', 'Another one!', 'Cleared!', 'Victory!']), q.text);
      if (comboHit) setTimeout(comboHit, 900);
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
      let lost = XP_PER_QUEST;
      if (idx >= 0) { const e = progress.log.splice(idx, 1)[0]; lost = Number(e.xp) || XP_PER_QUEST; progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`).slice(-500); }
      FX.poof(cx, cy);
      Sound.undo();
      api.vibrate(10);
      floatText(cx + 40, cy, `-${lost} XP`, true);
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
  // ---------- pin a new paper (board) to the wall (desktop 0.6.2) ----------
  const NP_LABEL = '<b>+</b> Pin a new paper';
  function blankPaper() {
    const b = document.createElement('div');
    b.className = 'new-paper';
    b.innerHTML = `<span class="np-label">${NP_LABEL}</span>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); namePaper(b); });
    return b;
  }
  function namePaper(b) {
    if (editing || b.classList.contains('naming')) return;
    b.classList.add('naming');
    const label = $('.np-label', b);
    inlineEdit(label, '', (name) => {
      const title = name.replace(/^#+\s*/, '');
      if (!title) return false;
      if (doc.groups.some((x) => norm(groupKey(x)) === norm(title))) { toast('There is already a paper with that name.'); return false; }
      doc.groups.push({ title, items: [] });
      persist();
      Sound.add && Sound.add();
      api.vibrate(20);
      setTimeout(() => {
        const w = $$('.board-wrap', boards).find((x) => x.dataset.group === title);
        if (!w) return;
        w.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        w.classList.add('nailing'); setTimeout(() => w.classList.remove('nailing'), 600);
        const r = w.getBoundingClientRect();
        FX.burst(r.left + r.width / 2, r.top + 10, { count: 26, power: 0.6 });
        if (prefs.theme !== 'abyss') Sound.cut && Sound.cut();
        const add = $('.add-btn', w); if (add) add.click();
      }, 60);
      return true;
    }, () => b.classList.remove('naming'));
    const input = $('input', label);
    if (input) input.placeholder = 'Name the paper, then Enter';
  }
  function newPaper() {
    const b = $('.new-paper', boards);
    if (!b) return;
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    namePaper(b);
  }
  async function takeDownPaper(g, wrap) {
    if (g.items.length) return;
    if (!(await ask('Take this paper down?', `"${groupKey(g).slice(0, 60)}" is empty. It goes off the wall on every device.`, 'Take down', true))) return;
    const i = doc.groups.indexOf(g);
    if (i < 0 || g.items.length) return;
    doc.groups.splice(i, 1);
    const r = wrap.getBoundingClientRect();
    FX.poof(r.left + r.width / 2, r.top + 20);
    wrap.classList.add('leaving');
    toast(`Took down: ${groupKey(g).slice(0, 60)}`);
    persist();
    setTimeout(render, 400);
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
    const newSpell = SPELLS.find((s) => s.level === level);
    if (newSpell) setTimeout(() => { banner(`New spell: ${newSpell.name}`, newSpell.how); refreshMagicUi(); }, 2600);
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
    { id: 'coin', name: 'Lost gold coin', w: 34 },
    { id: 'key', name: 'Rusty old key', w: 18 },
    { id: 'potion', name: 'Forgotten potion', w: 18 },
    { id: 'scroll', name: 'Tiny secret scroll', w: 12 },
    { id: 'gem', name: 'Glittering gem', w: 10 },
    { id: 'rune', name: 'Glowing rune stone', w: 6 },
    { id: 'egg', name: 'Dragon egg', w: 2 },
    { id: 'gatekey', name: 'Garden gate key', w: 9, when: () => !gardenOpen() },
    { id: 'spellscroll', name: 'Spell scroll: Enchant', w: 7, when: () => !learned('enchant') },
    ...Object.keys(Magic.FAMILIARS).filter((f) => f !== 'dragon').map((f) => ({ id: `fam-${f}`, fam: f, name: Magic.FAMILIARS[f].name, w: 4, when: () => !familiars().includes(f) })),
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
    if (s.v !== 2) { s.v = 2; s.next = now() + rndIn(2, 8) * 3600e3; s.active = s.active.slice(0, 1); }   // 0.6.1: easter eggs, rare
    if (!s.next) s.next = now() + rndIn(2, 8) * 3600e3;
    if (!s.found) s.found = 0;
    return s;
  }
  function pickKind() {
    const pool = SECRET_KINDS.filter((k) => !k.when || k.when());
    const total = pool.reduce((n, k) => n + k.w, 0);
    let r = Math.random() * total;
    for (const k of pool) { r -= k.w; if (r <= 0) return k; }
    return pool[0];
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
  function tuckedSpot() {
    const br = boards.getBoundingClientRect();
    const wraps = $$('.board-wrap', boards);
    if (!wraps.length) return null;
    const r = wraps[(Math.random() * wraps.length) | 0].getBoundingClientRect();
    const L = r.left - br.left + boards.scrollLeft, T = r.top - br.top + boards.scrollTop, R = L + r.width, B = T + r.height;
    const side = (Math.random() * 4) | 0, peek = 9;
    if (side === 0) return { x: rndIn(L + 30, R - 50), y: B - 18 + peek, under: true };
    if (side === 1) return { x: R - 18 + peek, y: rndIn(T + 40, B - 40), under: true };
    if (side === 2) return { x: L - peek, y: rndIn(T + 40, B - 40), under: true };
    return { x: rndIn(L + 30, R - 50), y: T - peek, under: true };
  }
  function spawnSecret() {
    const s = secretsState(), spot = (Math.random() < 0.7 && tuckedSpot()) || bareSpot();
    if (!spot) return false;
    const k = pickKind();
    s.active.push({ id: `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: k.id, x: Math.round(spot.x), y: Math.round(spot.y), under: !!spot.under, until: now() + rndIn(4, 12) * 3600e3, tilt: Math.round(rndIn(-35, 35)) });
    savePrefs();
    return true;
  }
  function tickSecrets() {
    const s = secretsState();
    const before = s.active.length;
    s.active = s.active.filter((x) => x.until > now());
    if (now() >= s.next && s.active.length < 1) {
      if (spawnSecret()) s.next = now() + rndIn(8, 36) * 3600e3;    // the next one: somewhere between 8 h and a day and a half
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
      el.innerHTML = k.fam ? `<span class="peek">${Magic.FAMILIARS[k.fam].e}</span>` : (SECRET_ART[k.id] || SECRET_ART.scroll);
      if (k.fam) el.classList.add('secret-fam');
      if (it.under) el.classList.add('tucked');
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
    progress.log.push({ text: `Secret: ${k.name}`, at: new Date().toISOString(), device: Sync.device(), xp: 0, secret: true, kind: k.id });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.classList.add('found');
    setTimeout(() => el.remove(), 600);
    FX.burst(x, y, { count: 60, power: 1, colors: ['#fff4b0', '#ffd36b', '#ffffff', '#9be7ff'] });
    FX.sparkle(x, y, { count: 14, spread: 40, colors: ['#ffffff', '#fff4b0', '#9be7ff'], big: true });
    Sound.secret && Sound.secret();
    api.vibrate(50);
    floatText(x + 20, y, k.name);
    secretFun(k, x, y, s);
    refreshMagicUi();
    persist(); renderHero();
  }

  // What each secret does (desktop 0.6.1): nothing useful, all of it silly. Secrets never give XP.
  const FORTUNES = [
    'The cat has been the guild master all along.',
    'A quest left alone long enough becomes a monster. Like laundry.',
    'You will find a coin. It will buy nothing.',
    'The tavern keeper waters the ale. Everyone knows.',
    'Somewhere a dragon is also procrastinating.',
    'The walls have ears. Also axe marks. Mostly axe marks.',
    'Your sword is fine. The wall is the one suffering.',
    'If you clear every quest, the board applauds. Nobody has seen it.',
    'This scroll is blank on the back. The scribe got lazy.',
    'Drink the potion. What could go wrong?',
  ];
  const POTIONS = [
    ['Shrinking potion', 'Everything is a bit smaller for a while', 'fx-tiny'],
    ['Wobble brew', 'The room will not stay still', 'fx-wobble'],
    ['Rainbow tonic', 'Colours have opinions now', 'fx-rainbow'],
    ['Mirror draught', 'Left is right. For twenty seconds', 'fx-mirror'],
    ['Giant draught', 'Your boards had a growth spurt', 'fx-giant'],
  ];
  function funLayer() {
    let l = document.getElementById('fun-layer');
    if (!l) { l = document.createElement('div'); l.id = 'fun-layer'; document.body.appendChild(l); }
    return l;
  }
  function rainOf(chars, n, ms = 3200) {
    const l = funLayer();
    for (let i = 0; i < n; i++) {
      const c = document.createElement('span'); c.className = 'fun-fall';
      c.textContent = chars[(Math.random() * chars.length) | 0];
      c.style.left = `${Math.random() * 100}%`; c.style.animationDuration = `${rndIn(1.6, 3).toFixed(2)}s`; c.style.animationDelay = `${rndIn(0, 1.2).toFixed(2)}s`;
      c.style.setProperty('--spin', `${rndIn(-540, 540) | 0}deg`); c.style.fontSize = `${rndIn(18, 34) | 0}px`;
      l.appendChild(c); setTimeout(() => c.remove(), ms + 1500);
    }
  }
  function walkAcross(ch, title) {
    const w = document.createElement('span'); w.className = 'fun-walk'; w.textContent = ch; w.title = title || '';
    if (Math.random() < 0.5) w.classList.add('rtl');
    funLayer().appendChild(w); setTimeout(() => w.remove(), 9000);
  }
  let potionTimer = null;
  function potionEffect(cls, ms) {
    const html = document.documentElement;
    ['fx-tiny', 'fx-wobble', 'fx-rainbow', 'fx-mirror', 'fx-giant', 'fx-disco'].forEach((c) => html.classList.remove(c));
    html.classList.add(cls);
    clearTimeout(potionTimer); potionTimer = setTimeout(() => html.classList.remove(cls), ms);
  }
  function secretFun(k, x, y, s) {
    const count = (id) => progress.log.filter((e) => e.secret && e.kind === id).length;
    if (k.fam) {
      walkAcross(Magic.FAMILIARS[k.fam].e, Magic.FAMILIARS[k.fam].name);
      banner(`${Magic.FAMILIARS[k.fam].name} joins you!`, gardenOpen() ? 'It moved into your garden' : 'It waits by a garden gate you have not found yet');
      return;
    }
    switch (k.id) {
      case 'coin': {
        rainOf(['🪙'], 30);
        for (let i = 0; i < 6; i++) setTimeout(() => Sound.add && Sound.add(), 120 * i);
        const n = count('coin');
        banner(n > 1 ? `${n} gold coins!` : 'A gold coin!', 'They buy absolutely nothing');
        break;
      }
      case 'key':
        $$('.quest .rune').forEach((rn, i) => setTimeout(() => { rn.classList.remove('rattle'); void rn.offsetWidth; rn.classList.add('rattle'); }, i * 45));
        banner('A rusty old key', 'It fits nothing. The runes did a little dance anyway');
        break;
      case 'potion': {
        const p = POTIONS[(Math.random() * POTIONS.length) | 0];
        potionEffect(p[2], p[2] === 'fx-mirror' ? 20000 : 30000);
        banner(p[0], p[1]);
        break;
      }
      case 'scroll':
        banner('A tiny scroll says:', FORTUNES[(Math.random() * FORTUNES.length) | 0], true);
        break;
      case 'gem':
        rainOf(['✨', '💎', '✦', '⭐'], 36); potionEffect('fx-disco', 9000);
        banner('A glittering gem', 'Disco in the tavern');
        break;
      case 'rune': {
        const pick = ['bolt', 'meteor', 'circle', 'rain', 'starfall', 'hearts'][(Math.random() * 6) | 0];
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        if (pick === 'bolt') { Magic.bolt(x, y); Sound.thunder && Sound.thunder(); }
        if (pick === 'meteor') Magic.meteor(cx, cy, () => { Sound.boom && Sound.boom(); FX.shake($('#app'), 600); api.vibrate(120); });
        if (pick === 'circle') { Magic.circle(x, y, 220, '#7df9ff'); Sound.cast && Sound.cast(); }
        if (pick === 'rain') Magic.rainfall(8000);
        if (pick === 'starfall') { Magic.starfall(); Sound.cast && Sound.cast(); }
        if (pick === 'hearts') { Magic.hearts(x, y); Sound.cast && Sound.cast(); }
        banner('A glowing rune stone', 'It cast a spell all by itself');
        break;
      }
      case 'egg':
        walkAcross('🐉', 'Dragonling');
        banner('A dragon egg!', 'It hatched: a dragonling lives in your garden now');
        break;
      case 'gatekey': banner('The garden gate key!', 'A secret garden opens: ⚙ → Magic → Garden'); break;
      case 'spellscroll': banner('You learned Enchant!', 'Tap ✧ on a quest to enchant it'); break;
      default: banner('Secret found!', `${k.name} · ${s.found} found so far`);
    }
  }

  // ---------- magic (desktop 0.6.0) ----------
  const SPELLS = [
    { id: 'ember', name: 'Ember trail', level: 5, how: 'Passive: your finger leaves a trail of fire.', toggle: true },
    { id: 'circle', name: 'Arcane circle', level: 5, shape: 'circle', how: 'Draw a circle.' },
    { id: 'fireball', name: 'Fireball', level: 6, shape: 'triangle', how: 'Draw a triangle.' },
    { id: 'hearts', name: 'Heartbloom', level: 8, shape: 'heart', how: 'Draw a heart.' },
    { id: 'lightning', name: 'Lightning', level: 10, shape: 'zigzag', how: 'Draw a zigzag. Also strikes every quest you clear.', toggle: true },
    { id: 'ward', name: 'Ward', level: 12, shape: 'square', how: 'Draw a square.' },
    { id: 'rain', name: 'Rainfall', level: 15, shape: 'down', how: 'Swipe straight down.' },
    { id: 'starfall', name: 'Starfall', level: 18, shape: 'star', how: 'Draw a five-pointed star in one stroke.' },
    { id: 'meteor', name: 'Meteor', level: 20, shape: 'diagonal', how: 'Slash diagonally.' },
    { id: 'vortex', name: 'Vortex', level: 25, shape: 'spiral', how: 'Draw a spiral.' },
    { id: 'enchant', name: 'Enchant', scroll: true, how: 'Learned from a secret scroll. Tap ✧ on a quest: it glows and gives double XP. One at a time.' },
  ];
  const level = () => levelInfo(xp()).level;
  const secretKinds = () => new Set(progress.log.filter((e) => e.secret && e.kind).map((e) => e.kind));
  function learned(id) {
    const sp = SPELLS.find((s) => s.id === id);
    if (!sp) return false;
    if (sp.scroll) return secretKinds().has('spellscroll');
    // spells are knowledge: an XP reset doesn't make you forget them
    const best = levelInfo(progress.log.reduce((n, e) => n + entryXp(e), 0)).level;
    return Math.max(level(), best) >= sp.level;
  }
  const spellOn = (id) => learned(id) && (prefs.spells || {})[id] !== false;
  const gardenOpen = () => secretKinds().has('gatekey');
  function familiars() {
    const k = secretKinds(), out = [];
    for (const f of Object.keys(Magic.FAMILIARS)) if (k.has(`fam-${f}`)) out.push(f);
    if (k.has('egg')) out.push('dragon');
    return out;
  }
  function refreshMagicUi() {
    const gb = $('#btn-garden'); if (gb) gb.hidden = !gardenOpen();
    if (FX.setTrail) FX.setTrail(spellOn('ember') ? 'ember' : 'normal');
  }
  function nightNow() { const h = new Date().getHours(); return h < 5; }
  function morningNow() { const h = new Date().getHours(); return h >= 6 && h < 11; }
  function questXp(g, q) {
    let gain = XP_PER_QUEST; const notes = [];
    if (progress.enchant && progress.enchant.key === norm(q.text)) { gain *= 2; notes.push('Enchanted ×2'); }
    const st = isDaily(g) ? 0 : corruption(q);
    if (st) { gain += [0, 10, 20, 40][st]; notes.push(st === 3 ? 'Monster slain!' : 'Purified!'); }
    if (nightNow()) { gain += 10; notes.push('Night owl'); }
    else if (morningNow()) { gain += 15; notes.push('Early bird'); }
    return { xp: gain, notes };
  }
  // corruption: quests nobody touched for a long time rot, then turn into monsters
  function ensureBorn() {
    if (!progress.born) progress.born = {};
    let added = false;
    const stamp = new Date().toISOString();
    for (const g of doc.groups) for (const it of g.items) {
      if (it.type !== 'quest' || it.done) continue;
      const k = norm(it.text);
      if (!progress.born[k]) { progress.born[k] = stamp; added = true; }
    }
    if (added) persist();
  }
  function corruption(q) {
    const b = progress.born && progress.born[norm(q.text)];
    if (!b) return 0;
    const days = (Date.now() - Date.parse(b)) / 86400e3;
    return days >= 30 ? 3 : days >= 14 ? 2 : days >= 7 ? 1 : 0;
  }
  function enchantQuest(q, li) {
    const k = norm(q.text);
    const same = progress.enchant && progress.enchant.key === k;
    progress.enchant = { key: same ? null : k, at: new Date().toISOString() };
    const r = li.getBoundingClientRect();
    if (!same) { FX.sparkle(r.left + 30, r.top + r.height / 2, { count: 14, spread: 30, colors: ['#e6d0ff', '#c58cff', '#ffffff', '#ffd36b'], big: true }); Sound.cast && Sound.cast(); toast('Enchanted: this quest gives double XP.'); }
    else toast('Enchantment lifted.');
    persist(); render();
  }
  // rune circle: three quests inside an hour
  function checkCombo() {
    const hour = Date.now() - 3600e3;
    const lastCombo = progress.log.filter((e) => e.bonus === 'combo').map((e) => Date.parse(e.at)).sort().pop() || 0;
    const recent = questLog().filter((e) => Date.parse(e.at) > Math.max(hour, lastCombo));
    if (recent.length < 3) return null;
    progress.log.push({ text: 'Combo: rune circle', at: new Date().toISOString(), device: Sync.device(), xp: 30, bonus: 'combo' });
    return () => {
      const br = boards.getBoundingClientRect();
      Magic.circle(br.left + br.width / 2, br.top + Math.min(br.height / 2, 300), Math.min(300, br.width * 0.8), TIERS[tierIndex(level())].a, 4200);
      Sound.cast && Sound.cast();
      api.vibrate(80);
      banner('Rune circle!', 'Three quests within an hour · +30 XP');
      renderHero();
    };
  }

  // casting on a phone: hold still on bare wall (so it never fights scrolling), feel a buzz, then draw
  const HOLD_MS = 380;
  let gesture = null, castedAt = 0;
  function castAt(kind, pts) {
    const end = pts[pts.length - 1];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const sp0 = SPELLS.find((x) => x.shape === kind);
    const id = sp0 && sp0.id;
    if (!id) { Sound.fizzle && Sound.fizzle(); FX.poof(end.x, end.y); return false; }
    const sp = SPELLS.find((s) => s.id === id);
    if (!learned(id)) { Sound.fizzle && Sound.fizzle(); FX.poof(end.x, end.y); toast(`You don't know ${sp.name} yet: it unlocks at level ${sp.level}.`); return false; }
    if (id === 'circle') { Magic.circle(cx, cy, Math.max(140, Math.max(...xs) - Math.min(...xs) + 60), TIERS[tierIndex(level())].a); FX.burst(cx, cy, { count: 60, power: 1, colors: tierColors(TIERS[tierIndex(level())]) }); Sound.cast && Sound.cast(); }
    if (id === 'lightning') { Magic.bolt(end.x, end.y); Sound.thunder && Sound.thunder(); FX.cut(end.x, end.y); }
    if (id === 'rain') { Magic.rainfall(15000); Sound.cast && Sound.cast(); toast('Rainfall: the tavern roof is leaking again.'); }
    const col = TIERS[tierIndex(level())].a;
    if (id === 'fireball') { Magic.fireball(cx, cy); Sound.boom && Sound.boom(); FX.shake($('#app'), 300); api.vibrate(60); }
    if (id === 'hearts') { Magic.hearts(cx, cy); Sound.cast && Sound.cast(); }
    if (id === 'ward') { Magic.ward(cx, cy, col); Sound.cast && Sound.cast(); }
    if (id === 'starfall') { Magic.starfall(); Sound.cast && Sound.cast(); }
    if (id === 'vortex') { Magic.vortex(cx, cy); Sound.cast && Sound.cast(); }
    if (id === 'meteor') { Magic.meteor(end.x, end.y, () => { Sound.boom && Sound.boom(); FX.shake($('#app'), 600); api.vibrate(120); for (let i = 0; i < 3; i++) FX.cut(end.x + (Math.random() - 0.5) * 60, end.y + (Math.random() - 0.5) * 40); }); }
    api.vibrate(30);
    return true;
  }
  function startDrawing() {
    if (!gesture) return;
    gesture.drawing = true;
    gesture.stroke = Magic.startStroke(TIERS[tierIndex(level())].a);
    for (const p of gesture.pts) gesture.stroke.add(p.x, p.y);
    document.documentElement.classList.add('casting');
    api.vibrate(15);
  }
  window.addEventListener('pointerdown', (e) => {
    if (editing || !onWall(e.target)) return;
    gesture = { x: e.clientX, y: e.clientY, pts: [{ x: e.clientX, y: e.clientY }], drawing: false, id: e.pointerId, stroke: null };
    gesture.timer = setTimeout(startDrawing, HOLD_MS);
  });
  window.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!gesture.drawing) {
      if (Math.hypot(p.x - gesture.x, p.y - gesture.y) > 10) { clearTimeout(gesture.timer); gesture = null; }   // it's a scroll
      return;
    }
    gesture.pts.push(p);
    gesture.stroke.add(p.x, p.y);
    if (Math.random() < 0.3) { FX.sparkle(p.x, p.y, { count: 1, spread: 4, colors: tierColors(TIERS[tierIndex(level())]) }); Sound.draw && Sound.draw(); }
  });
  // once drawing, the finger paints instead of scrolling the wall
  window.addEventListener('touchmove', (e) => { if (gesture && gesture.drawing) e.preventDefault(); }, { passive: false });
  window.addEventListener('contextmenu', (e) => { if (gesture || onWall(e.target)) e.preventDefault(); });
  function endGesture(e) {
    if (!gesture || (e && e.pointerId !== gesture.id)) return;
    const g = gesture; gesture = null; clearTimeout(g.timer);
    document.documentElement.classList.remove('casting');
    if (!g.drawing) return;                      // a plain tap: the click handler cuts the wood
    const len = g.pts.reduce((n, p, i) => (i ? n + Math.hypot(p.x - g.pts[i - 1].x, p.y - g.pts[i - 1].y) : 0), 0);
    if (len < 40) { g.stroke.end(false); return; }   // held but didn't draw: let the tap cut
    castedAt = performance.now();
    g.stroke.end(castAt(Magic.recognize(g.pts), g.pts));
  }
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', () => { if (gesture && gesture.stroke) gesture.stroke.end(false); if (gesture) clearTimeout(gesture.timer); gesture = null; document.documentElement.classList.remove('casting'); });

  function openSpellbook() {
    const wrap = document.createElement('div'); wrap.className = 'modal-wrap spellbook-wrap';
    const lv = level();
    wrap.innerHTML = `<div class="modal-card spellbook"><h3>Spellbook</h3><p>You learn new spells as you level up. To cast, hold still on bare wall (or the sign) until it buzzes, then draw the shape in one stroke.</p><ol class="spell-list"></ol><div class="modal-row"><span class="status">Level ${lv}</span><button class="btn" type="button">Close</button></div></div>`;
    const list = $('.spell-list', wrap);
    for (const sp of SPELLS) {
      const ok = learned(sp.id);
      const li = document.createElement('li'); li.className = ok ? 'known' : 'locked';
      li.innerHTML = `<b></b><span class="req"></span><small></small>`;
      $('b', li).textContent = sp.name;
      $('.req', li).textContent = ok ? 'learned' : sp.scroll ? 'find its scroll' : `level ${sp.level}`;
      $('small', li).textContent = sp.how;
      if (ok && sp.toggle) {
        const t = document.createElement('button'); t.type = 'button'; t.className = 'btn seg' + (spellOn(sp.id) ? ' on' : '');
        t.textContent = spellOn(sp.id) ? 'on' : 'off';
        t.addEventListener('click', () => { prefs.spells = prefs.spells || {}; prefs.spells[sp.id] = !spellOn(sp.id); savePrefs(); refreshMagicUi(); t.textContent = spellOn(sp.id) ? 'on' : 'off'; t.classList.toggle('on', spellOn(sp.id)); });
        li.appendChild(t);
      }
      list.appendChild(li);
    }
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); backHandlers.delete(onBack); };
    const onBack = () => { close(); return true; };
    backHandlers.add(onBack);
    $('.modal-row .btn', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  }
  function openGarden() {
    Magic.openGarden(familiars());
    const onBack = () => { Magic.closeGarden(); backHandlers.delete(onBack); return true; };
    backHandlers.add(onBack);
  }
  // wall textures (tavern): planks, weathered, cracked, charred, or the classic wood
  const WALLS = [['planks', 'Planks'], ['weathered', 'Weathered'], ['cracked', 'Cracked'], ['charred', 'Charred'], ['classic', 'Classic']];
  function applyWall() {
    const w = WALLS.find((x) => x[0] === prefs.wall) ? prefs.wall : 'planks';
    document.documentElement.setAttribute('data-wall', w);
    const b = $('#btn-wall'); if (b) b.textContent = 'Wall: ' + WALLS.find((x) => x[0] === w)[1].toLowerCase();
  }
  function cycleWall() {
    const i = WALLS.findIndex((x) => x[0] === (prefs.wall || 'planks'));
    prefs.wall = WALLS[(i + 1) % WALLS.length][0];
    applyWall(); savePrefs();
    if (prefs.theme !== 'tavern') toast('Wall: ' + WALLS.find((x) => x[0] === prefs.wall)[1] + ' (shows in the Tavern theme)');
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
    applyWall();
    refreshMagicUi();
    Magic.setNight(nightNow());
    setInterval(() => { Magic.setNight(nightNow()); refreshMagicUi(); }, 60 * 1000);
    $('#btn-spellbook').addEventListener('click', openSpellbook);
    $('#btn-garden').addEventListener('click', openGarden);
    $('#btn-wall').addEventListener('click', cycleWall);
    $('#btn-new-paper').addEventListener('click', () => { closeSheet(); setTimeout(newPaper, 250); });
    if (!api.native) window.__forceSecret = (kind) => { const s = secretsState(), sp = bareSpot() || { x: 120, y: 120 }; s.active = [{ id: `t${now()}`, kind, x: Math.round(sp.x), y: Math.round(sp.y), until: now() + 3600e3, tilt: 0 }]; drawSecrets(); };   // browser tests only
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
  // ---------- in-app updates ----------
  // Checks GitHub on start and every 6 hours, downloads the new APK in the background into the app's
  // private storage, then shows "Update ready · Install". Install hands it to Android, which asks
  // once and restarts Questboard; the downloaded file is deleted when the new version starts.
  const upd = { state: 'idle', version: null, url: null, done: 0, total: 0, checkedAt: 0, waitingPermission: false };
  const verParts = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  function isNewer(a, b) {
    if (!/^\d/.test(String(b || ''))) return true;               // a dev build takes any release
    const x = verParts(a), y = verParts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  }
  function renderUpdate() {
    const pill = $('#update-pill'), btn = $('#set-releases');
    const pct = upd.total > 0 ? Math.min(99, Math.round((upd.done / upd.total) * 100)) : 0;
    let text = '';
    if (upd.state === 'downloading') text = `Downloading v${upd.version}${pct ? ` · ${pct}%` : '…'}`;
    else if (upd.state === 'ready') text = `Update v${upd.version} ready · Install`;
    else if (upd.state === 'installing') text = `Installing v${upd.version}…`;
    pill.hidden = !text;
    pill.textContent = text;
    pill.classList.toggle('ready', upd.state === 'ready');
    btn.textContent = upd.state === 'ready' ? `Install v${upd.version}` : upd.state === 'downloading' ? `Downloading v${upd.version}…` : upd.state === 'checking' ? 'Checking…' : 'Check for updates';
  }
  async function checkUpdate(manual) {
    if (!api.update || !api.update.supported) { if (manual) toast('Updates are not available here.'); return; }
    if (upd.state === 'ready') { if (manual) installUpdate(); return; }
    if (upd.state === 'downloading' || upd.state === 'checking' || upd.state === 'installing') { if (manual) toast(upd.state === 'checking' ? 'Checking for updates…' : `v${upd.version} is on its way.`); return; }
    upd.state = 'checking'; upd.checkedAt = Date.now(); renderUpdate();
    try {
      const r = await api.http('GET', prefs.updateFeed || UPDATE_FEED, { Accept: 'application/vnd.github+json' }, null);
      if (r.status !== 200) throw new Error(r.error || `HTTP ${r.status}`);
      const rel = JSON.parse(r.body || '{}');
      const tag = String(rel.tag_name || '').replace(/^v/i, '');
      const asset = (rel.assets || []).find((a) => /-android\.apk$/i.test(a.name || ''));
      if (!tag || !asset || !isNewer(tag, info.version)) {
        upd.state = 'idle'; renderUpdate();
        if (manual) toast(`You have the newest version (v${info.version}).`);
        return;
      }
      Object.assign(upd, { state: 'downloading', version: tag, url: asset.browser_download_url, done: 0, total: asset.size || 0 });
      renderUpdate();
      if (manual) toast(`Downloading v${tag} inside the app…`);
      api.update.download(upd.url);
    } catch (e) {
      upd.state = 'idle'; renderUpdate();
      if (manual) toast(`Could not check for updates: ${e.message}`);
    }
  }
  async function installUpdate() {
    if (upd.state !== 'ready') return;
    if (!(await ask(`Install v${upd.version}?`, 'Android asks you to confirm. When it is done, tap the "Questboard updated" notification to open it again; your board stays as it is and the download is deleted.', 'Install'))) return;
    if (!api.update.canInstall()) {
      upd.waitingPermission = true;
      toast('Allow Questboard to install updates, then come back. It continues by itself.');
    }
    upd.state = 'installing'; renderUpdate();
    api.update.install();
  }
  api.on('update', (e) => {
    if (e.state === 'downloading') { if (upd.state !== 'downloading') return; upd.done = e.done; upd.total = e.total || upd.total; renderUpdate(); return; }
    if (e.state === 'ready') {
      upd.state = 'ready'; if (e.message) upd.version = String(e.message).replace(/^v/i, '');
      renderUpdate(); banner(`Update v${upd.version} ready`, 'Tap Install at the bottom when you are ready');
      return;
    }
    if (e.state === 'needs-permission') { upd.state = 'ready'; upd.waitingPermission = true; renderUpdate(); return; }
    if (e.state === 'installing' || e.state === 'confirming') { upd.state = 'installing'; renderUpdate(); return; }
    if (e.state === 'cancelled') { upd.state = 'ready'; renderUpdate(); toast('Update postponed. Tap Install when you are ready.'); return; }
    if (e.state === 'installed') { upd.state = 'idle'; renderUpdate(); return; }
    if (e.state === 'failed') {
      const had = upd.state;
      upd.state = 'idle'; renderUpdate();
      if (had !== 'idle') toast(`Update failed: ${e.message || 'unknown error'}`);
    }
  });
  function bootUpdates() {
    // came back from an update: say so once
    if (info.version && /^\d/.test(info.version) && prefs.lastVersion && prefs.lastVersion !== info.version && isNewer(info.version, prefs.lastVersion)) {
      setTimeout(() => toast(`Updated to v${info.version}.`), 1800);
    }
    if (prefs.lastVersion !== info.version) { prefs.lastVersion = info.version; savePrefs(); }
    $('#update-pill').addEventListener('click', () => { if (upd.state === 'ready') installUpdate(); });
    const waiting = api.update && api.update.readyVersion ? api.update.readyVersion() : null;
    if (waiting) { Object.assign(upd, { state: 'ready', version: waiting.replace(/^v/i, '') }); renderUpdate(); }
    else setTimeout(() => checkUpdate(false), 4000);
    setInterval(() => { if (Date.now() - upd.checkedAt >= UPDATE_EVERY_MS) checkUpdate(false); }, 10 * 60 * 1000);
  }

  function onResume() {
    if (upd.waitingPermission && upd.state !== 'idle' && api.update && api.update.canInstall()) { upd.waitingPermission = false; upd.state = 'installing'; renderUpdate(); api.update.install(); }
    else if (upd.state === 'idle' && upd.checkedAt && Date.now() - upd.checkedAt >= UPDATE_EVERY_MS) checkUpdate(false);
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
    $('#set-releases').addEventListener('click', () => { if (upd.state === 'ready') { closeSheet(); installUpdate(); } else checkUpdate(true); });
    bootUpdates();

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
