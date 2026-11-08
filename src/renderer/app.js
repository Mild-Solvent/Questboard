// Questboard renderer: boards, XP, effects, local files, and sync with the devbox.
(function () {
  const api = window.questboard;
  const { parse, serialize, norm } = window.Merge;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const XP_PER_QUEST = 25;
  const RANKS = {
    tavern: ['Tavern Squire', 'Road Wanderer', 'Hedge Knight', 'Guild Adventurer', 'Dragon Botherer', 'Realm Champion', 'Living Legend', 'Myth Incarnate'],
    abyss:  ['Shallow Shrimp', 'Reef Diver', 'Kelp Ranger', 'Trench Explorer', 'Kraken Wrangler', 'Tide Sovereign', 'Abyssal Legend', 'Leviathan'],
  };
  const GLYPHS = { echo: '⚔', money: '¢', skill: '✦', commit: '⚑', life: '☀', deadline: '⌛', someday: '☾', meta: '⚙' };

  // ---------- state ----------
  let doc = null;                      // parsed quest document
  let progress = { log: [], removed: [] };
  let settings = null;
  let info = { packaged: false, device: 'pc' };
  let busy = false;

  const defaultSettings = () => ({
    theme: 'tavern', sound: true,
    sync: { baseUrl: '', token: '' },
    base: { questsText: '', questsEtag: null, progressText: '', progressEtag: null },
    layout: { mode: 'grid', pos: {} },
  });

  // ---------- persistence ----------
  let saveTimer = null;
  function saveLocal() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.writeFile('QUESTS.md', serialize(doc));
      api.writeFile('progress.json', JSON.stringify(progress, null, 2));
      api.writeFile('settings.json', JSON.stringify(settings, null, 2));
    }, 150);
  }
  function saveSettings() { api.writeFile('settings.json', JSON.stringify(settings, null, 2)); }

  // ---------- XP / rank ----------
  const xpForLevel = (lvl) => 100 + (lvl - 1) * 50;
  // XP only counts what came after the last reset (the quest history itself is kept)
  const entryXp = (e) => (e.secret ? 0 : Number(e.xp) || XP_PER_QUEST);   // secrets are just for fun: no XP
  const totalXp = () => progress.log.reduce((n, e) => n + (progress.resetAt && e.at <= progress.resetAt ? 0 : entryXp(e)), 0);
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
  function levelInfo(xp) {
    let lvl = 1, rem = xp;
    while (rem >= xpForLevel(lvl)) { rem -= xpForLevel(lvl); lvl++; }
    return { level: lvl, into: rem, need: xpForLevel(lvl) };
  }
  function toRoman(n) { const m = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; }
  function rankName(level) {
    const list = RANKS[settings.theme] || RANKS.tavern;
    const idx = Math.min(list.length - 1, Math.floor((level - 1) / 2));
    const tier = level > list.length * 2 ? ` ${toRoman(level - list.length * 2 + 1)}` : '';
    return list[idx] + tier;
  }
  function renderHero() {
    const li = levelInfo(totalXp());
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
      if (heat > lastHeat && heat >= 2) { setTimeout(() => { banner(HEAT[heat].lbl, `${n} quests cleared today`); Sound.heat(); }, 700); }
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
  // Daily boards: "## Life [daily]". Their quests never move to Completed; a tick lasts 9 hours and
  // is read from the progress log, so every device agrees and nothing has to be un-ticked by hand.
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
    changed(); render();
    toast(isDaily(g) ? `${groupKey(g)} is a daily board now: ticks reset 9 hours after you make them.` : `${groupKey(g)} is a normal board again.`);
  }
  function seeded(str, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  // Torn parchment outline: small ragged bites everywhere, a few deep V-notches, and on some
  // scraps a dog-eared bottom corner (the corner is cut off here and the folded flap is drawn in CSS).
  function tornEdge(key, ear) {
    const steps = 30, EAR = 26;
    const j = (i) => {
      const r = seeded(key, 100 + i);
      if (r > 0.93) return 10 + Math.round(seeded(key, 400 + i) * 9);     // deep notch
      return Math.round(r * r * 8);                                        // mostly shallow
    };
    const pct = (i) => (i / steps * 100).toFixed(2);
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(`${pct(i)}% ${j(i)}px`);                                   // top, left to right
    const rEnd = ear === 'r' ? steps - 2 : steps;
    for (let i = 1; i < rEnd; i++) pts.push(`calc(100% - ${j(50 + i)}px) ${pct(i)}%`);                   // right, down
    if (ear === 'r') pts.push(`100% calc(100% - ${EAR}px)`, `calc(100% - ${EAR}px) 100%`);
    const bStart = ear === 'r' ? steps - 2 : steps, bEnd = ear === 'l' ? 2 : 0;
    for (let i = bStart; i >= bEnd; i--) pts.push(`${pct(i)}% calc(100% - ${j(100 + i)}px)`);           // bottom, right to left
    if (ear === 'l') pts.push(`${EAR}px 100%`, `0px calc(100% - ${EAR}px)`);
    const lStart = ear === 'l' ? steps - 2 : steps - 1;
    for (let i = lStart; i > 0; i--) pts.push(`${j(150 + i)}px ${pct(i)}%`);                             // left, up
    return `polygon(${pts.join(', ')})`;
  }

  let editing = null, renderLater = false;      // an open inline editor holds off re-renders
  function render() {
    if (editing) { renderLater = true; return; }
    const scroll = boards.scrollTop;
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
      wrap.style.setProperty('--rot', `${seeded(groupKey(g), 1) * 3 - 1.5}deg`);
      wrap.style.setProperty('--nx', `${Math.round(seeded(groupKey(g), 2) * 40 - 20)}px`);
      const featured = isFeatured(g);
      const earPick = seeded(groupKey(g), 7);
      const ear = featured ? (earPick < 0.6 ? 'l' : '') : (earPick < 0.35 ? 'l' : earPick < 0.7 ? 'r' : '');
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
      const open = daily ? quests.filter((x) => !x.done) : quests.filter((x) => !x.done);
      const done = quests.filter((x) => x.done);
      const left = daily ? open.filter((x) => !dailyEntry(x)).length : open.length;
      $('.board-count', el).textContent = quests.length ? (daily ? `${left} left today` : `${open.length} open`) : '';
      el.classList.toggle('daily', daily);
      const dbtn = document.createElement('button');
      dbtn.type = 'button'; dbtn.className = 'daily-toggle' + (daily ? ' on' : '');
      dbtn.textContent = daily ? '↻ daily' : '↻';
      dbtn.title = daily ? 'Daily board: ticks stay on the board and reset 9 hours later. Click to make it a normal board.' : 'Make this a daily board (ticks reset 9 hours after you make them)';
      dbtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDaily(g); });
      $('.board-head', el).appendChild(dbtn);
      const title = $('.board-title', el);
      title.title = 'Double-click to rename';
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); editBoardTitle(g, title, cleanTitle); });
      const ebtn = document.createElement('button');
      ebtn.type = 'button'; ebtn.className = 'board-edit'; ebtn.textContent = '✎'; ebtn.title = 'Rename board';
      ebtn.addEventListener('click', (e) => { e.stopPropagation(); editBoardTitle(g, title, cleanTitle); });
      $('.board-head', el).appendChild(ebtn);

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
      if (done.length) { $('.done-count', el).textContent = `(${done.length})`; done.forEach((q) => $('.done-list', el).appendChild(questEl(g, q))); }
      else dw.hidden = true;
      if (!g.items.length) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'board-remove'; del.textContent = '✕'; del.title = 'Take this empty paper down';
        del.addEventListener('click', (e) => { e.stopPropagation(); takeDownPaper(g, wrap); });
        $('.board-head', el).appendChild(del);
      }
      wireAdd(el, g);
      boards.appendChild(wrap);
    });
    boards.appendChild(blankPaper());
    boards.scrollTop = scroll;
    applyLayout();
    renderHero();
  }

  // ---------- free layout (drag boards around like a corkboard) ----------
  let drag = null;
  function applyLayout() {
    const free = settings.layout.mode === 'free';
    boards.classList.toggle('free', free);
    $('#btn-tidy').hidden = !free;
    if (!free) { $$('.board-wrap, .new-paper', boards).forEach((w) => { w.style.left = w.style.top = w.style.width = ''; }); return; }
    const pos = settings.layout.pos;
    // boards that have no saved spot get one from the grid position they would have had
    const missing = $$('.board-wrap', boards).filter((w) => !pos[w.dataset.group]);
    if (missing.length) {
      boards.classList.remove('free');
      const origin = boards.getBoundingClientRect();
      missing.forEach((w) => { const r = w.getBoundingClientRect(); pos[w.dataset.group] = { x: r.left - origin.left + boards.scrollLeft, y: r.top - origin.top + boards.scrollTop, w: r.width }; });
      boards.classList.add('free');
      saveSettings();
    }
    let maxX = 0, maxY = 0;
    const items = $$('.board-wrap', boards).map((w) => {
      const p = pos[w.dataset.group];
      w.style.left = `${p.x}px`; w.style.width = `${p.w}px`;
      return { w, p };
    });
    // Papers never overlap: a board that grew (more quests, "completed" opened) pushes the boards
    // below it down, the way stacked notes would. Pushed spots are saved so dragging stays smooth.
    if (!drag) {
      const placed = [];
      let moved = false;
      items.slice().sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x).forEach((it) => {
        const h = it.w.offsetHeight;
        let top = it.p.y, bumped = true;
        while (bumped) {
          bumped = false;
          for (const o of placed) {
            const overlapX = it.p.x < o.x + o.w - 14 && o.x < it.p.x + it.p.w - 14;
            if (overlapX && top < o.bottom + 22 && top + h > o.top) { top = o.bottom + 22; bumped = true; }
          }
        }
        if (top !== it.p.y) { it.p.y = top; moved = true; }
        placed.push({ x: it.p.x, w: it.p.w, top, bottom: top + h });
      });
      if (moved) saveSettings();
    }
    items.forEach(({ w, p }) => {
      w.style.top = `${p.y}px`;
      maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + w.offsetHeight);
    });
    // The blank "pin a new paper" sits below everything, lined up with the leftmost board.
    const blank = $('.new-paper', boards);
    if (blank) {
      const minX = items.length ? Math.min(...items.map((it) => it.p.x)) : 0;
      const widths = items.map((it) => it.p.w).sort((a, b) => a - b);
      const bw = widths.length ? widths[Math.floor(widths.length / 2)] : 320;
      const by = items.length ? maxY + 30 : 0;
      blank.style.left = `${minX}px`; blank.style.top = `${by}px`; blank.style.width = `${bw}px`;
      maxX = Math.max(maxX, minX + bw); maxY = Math.max(maxY, by + blank.offsetHeight);
    }
    let spacer = $('.canvas-spacer', boards);
    if (!spacer) { spacer = document.createElement('div'); spacer.className = 'canvas-spacer'; boards.appendChild(spacer); }
    spacer.style.left = `${maxX + 40}px`; spacer.style.top = `${maxY + 40}px`;
  }

  function tidyBoards() {
    settings.layout = { mode: 'grid', pos: {} };
    saveSettings();
    render();
    toast('Boards tidied back into the grid.');
  }

  // Drag starts on a board's head or empty background, never on quests, buttons or inputs.
  let zTop = 10;
  boards.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const wrap = e.target.closest('.board-wrap');
    if (!wrap || e.target.closest('.quest, .quests, button, input, form, summary, details, .add-row')) return;
    if (editing) return;
    drag = { wrap, sx: e.clientX, sy: e.clientY, moved: false, id: e.pointerId };
    e.preventDefault();
  });
  function liftBoard() {
    const { wrap } = drag;
    if (settings.layout.mode !== 'free') {
      settings.layout.mode = 'free';
      const d = drag; drag = null; applyLayout(); drag = d;   // freezes everything where it is
    }
    const p = settings.layout.pos[wrap.dataset.group];
    drag.ox = p.x; drag.oy = p.y;
    try { wrap.setPointerCapture(drag.id); } catch { /* pointer already gone */ }
    wrap.classList.remove('nailing');
    wrap.classList.add('lifted');
    wrap.style.zIndex = String(++zTop);
    Sound.lift();
  }
  boards.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { liftBoard(); drag.moved = true; }
    const p = settings.layout.pos[drag.wrap.dataset.group];
    p.x = Math.max(0, drag.ox + dx); p.y = Math.max(0, drag.oy + dy);
    drag.wrap.style.left = `${p.x}px`; drag.wrap.style.top = `${p.y}px`;
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { wrap, moved } = drag;
    drag = null;
    if (!moved) return;                                // a plain click: nothing was lifted
    wrap.classList.remove('lifted');
    wrap.classList.add('nailing');
    setTimeout(() => wrap.classList.remove('nailing'), 700);
    const r = wrap.getBoundingClientRect();
    const nx = parseFloat(getComputedStyle(wrap).getPropertyValue('--nx')) || 0;
    FX.burst(r.left + r.width / 2 + nx, r.top + 4, { count: 18, power: 0.6 });
    Sound.nail();
    saveSettings();
    applyLayout();
  }
  boards.addEventListener('toggle', () => { if (settings.layout.mode === 'free') applyLayout(); }, true);   // completed list opened/closed
  // Mouse wheel works anywhere: a quest list scrolls itself while it has room, otherwise the wheel
  // moves the whole board wall (Chromium would otherwise keep the wheel latched on the list).
  boards.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !e.deltaY) return;
    const list = e.target.closest('.quests');
    if (list) {
      const room = e.deltaY > 0 ? list.scrollHeight - list.clientHeight - list.scrollTop : list.scrollTop;
      if (room > 1) return;
    }
    if (e.target.closest('input, textarea, [contenteditable="true"]') && !list) return;
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * boards.clientHeight : e.deltaY;
    e.preventDefault();
    boards.scrollTop += px;
  }, { passive: false });
  boards.addEventListener('pointerup', endDrag);
  boards.addEventListener('pointercancel', endDrag);

  // Gouges live inside #boards, in content coordinates, so they scroll with the wood and the papers.
  // They are all baked into one canvas, so even a wall with well over a thousand cuts costs one
  // bitmap, not a thousand elements. The oldest only start to go after MAX_CUTS.
  const MAX_CUTS = 1500;
  const cutMarks = [];
  const bake = document.createElement('canvas');
  bake.className = 'cut-bake';
  cutLayer.appendChild(bake);
  const bctx = bake.getContext('2d');
  function sizeBake() {
    const w = boards.scrollWidth, h = boards.scrollHeight;
    // the layer clips to the current content so a gouge at the edge never adds scrollbars
    cutLayer.style.width = `${w}px`; cutLayer.style.height = `${h}px`;
    if (bake.width >= w && bake.height >= h) return false;
    bake.width = Math.ceil(Math.max(w, bake.width) / 256) * 256;
    bake.height = Math.ceil(Math.max(h, bake.height) / 512) * 512;
    return true;                                                   // resizing wiped it: redraw
  }
  function redrawCuts() { bctx.clearRect(0, 0, bake.width, bake.height); for (const c of cutMarks) FX.drawCutOn(bctx, c); }
  function clearCuts() { cutMarks.length = 0; bctx.clearRect(0, 0, bake.width, bake.height); signCuts.length = 0; sctx.clearRect(0, 0, signBake.width, signBake.height); }
  // The guild sign takes cuts too, on a canvas of its own.
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
      const m = { ...c, x: c.x - hr.left, y: c.y - hr.top, len: c.len * 0.75, w: c.w * 0.85 };
      signCuts.push(m);
      if (signCuts.length > 400) { signCuts.splice(0, 50); redrawSign(); } else FX.drawCutOn(sctx, m);
      return;
    }
    if (cutLayer.parentNode !== boards) boards.prepend(cutLayer);
    const r = boards.getBoundingClientRect();
    const m = { ...c, x: c.x - r.left - boards.clientLeft + boards.scrollLeft, y: c.y - r.top - boards.clientTop + boards.scrollTop };
    cutMarks.push(m);
    if (cutMarks.length > MAX_CUTS) { cutMarks.splice(0, 100); redrawCuts(); }   // fade out the oldest hundred at once
    if (sizeBake()) redrawCuts(); else FX.drawCutOn(bctx, m);
  });

  // Clicking bare wood (or open water) leaves a mark: a sword cut in Tavern, a splash in Abyss.
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    const onSign = !!t.closest('#hero') && !t.closest('button, .stat, .crest-wrap, .xp-bar');
    if (!(onSign || t === boards || t === document.body || t.id === 'app' || t.classList.contains('canvas-spacer'))) return;
    Sound.unlock();
    beginGesture(e);
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
    rune.addEventListener('click', (e) => { e.stopPropagation(); toggle(g, q, li, rune); });
    rune.addEventListener('mouseenter', () => Sound.hover());
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); removeQuest(g, q, li); });
    if (!isDaily(g) && !q.done) {
      const st = corruption(q);
      if (st) { li.classList.add(`corrupt-${st}`); li.title = ['', 'This quest has been waiting a week. It is starting to rot.', 'Two weeks untouched: it is turning into something.', 'A month old: it has become a monster. Clear it to purify it.'][st]; }
      if (progress.enchant && progress.enchant.key && progress.enchant.key === norm(q.text)) li.classList.add('enchanted');
      if (learned('enchant')) {
        const en = document.createElement('button'); en.className = 'enchant-btn'; en.title = 'Enchant: double XP (one quest at a time)'; en.textContent = '✧';
        en.addEventListener('click', (e) => { e.stopPropagation(); enchantQuest(q, li); });
        li.appendChild(en);
      }
    }
    const textEl = $('.quest-text', li);
    textEl.addEventListener('dblclick', (e) => { e.stopPropagation(); editQuestText(g, q, textEl); });
    const edit = document.createElement('button'); edit.className = 'edit'; edit.title = 'Edit quest'; edit.textContent = '✎';
    edit.addEventListener('click', (e) => { e.stopPropagation(); editQuestText(g, q, textEl); });
    li.appendChild(edit);
    const del = document.createElement('button'); del.className = 'del'; del.title = 'Remove quest'; del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeQuest(g, q, li); });
    li.appendChild(del);
    return li;
  }

  function wireAdd(el, g) {
    const btn = $('.add-btn', el), form = $('.add-form', el), input = $('.add-input', el);
    btn.addEventListener('click', () => { btn.hidden = true; form.hidden = false; input.focus(); });
    const close = () => { form.hidden = true; btn.hidden = false; input.value = ''; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    input.addEventListener('blur', () => { if (!input.value.trim()) close(); });
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
      input.value = ''; input.focus();
      Sound.add();
      const r = li.getBoundingClientRect();
      FX.burst(r.left + 18, r.top + 14, { count: 14, power: 0.5 });
      changed();
    });
  }

  // ---------- actions ----------
  function changed() { saveLocal(); renderHero(); scheduleSync(); }

  function toggle(g, q, li, rune) {
    if (busy) return;
    Sound.unlock();
    const r = rune.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const daily = isDaily(g);
    const isDone = daily ? !!dailyEntry(q) : q.done;
    if (!isDone) {
      busy = true;
      if (!daily) q.done = true;
      const before = levelInfo(totalXp()).level;
      const { xp, notes } = questXp(g, q);
      const entry = { text: q.text, at: new Date().toISOString(), device: info.device };
      if (xp !== XP_PER_QUEST) entry.xp = xp;
      progress.log.push(entry);
      if (progress.enchant && progress.enchant.key === norm(q.text)) progress.enchant = { key: null, at: entry.at };
      const comboHit = checkCombo();
      const after = levelInfo(totalXp()).level;
      if (spellOn('lightning')) { Magic.bolt(cx, cy); Sound.thunder(); }
      if (li.className.includes('corrupt-')) { Sound.purify(); FX.burst(cx, cy, { count: 60, power: 1, colors: ['#c58cff', '#7a2dd6', '#ffffff', '#e6d0ff'] }); }
      li.classList.add('completing');
      FX.burst(cx, cy, { count: 90, power: 1.1 });
      FX.shake($('#app'));
      Sound.complete();
      floatText(cx + 40, cy, `+${xp} XP`);
      banner(notes.length ? notes.join(' · ') : pick(['Quest complete!', 'Done and dusted!', 'Slain!', 'Another one!', 'Cleared!', 'Victory!']), q.text);
      if (comboHit) setTimeout(comboHit, 900);
      const crest = $('#rank-crest'); crest.classList.remove('pulse'); void crest.offsetWidth; crest.classList.add('pulse');
      changed();
      setTimeout(() => {
        if (after > before) levelUp(after);
        li.classList.remove('completing');
        if (daily) { busy = false; render(); return; }      // daily quests stay on the board, ticked
        li.classList.add('leaving');
        setTimeout(() => { busy = false; render(); }, 480);
      }, 750);
    } else {
      if (!daily) q.done = false;
      let idx = -1; progress.log.forEach((e, i) => { if (e.text === q.text) idx = i; });
      let lost = XP_PER_QUEST;
      if (idx >= 0) { const e = progress.log.splice(idx, 1)[0]; lost = Number(e.xp) || XP_PER_QUEST; progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`); }
      FX.poof(cx, cy);
      Sound.undo();
      floatText(cx + 40, cy, `-${lost} XP`, true);
      changed();
      render();
    }
  }

  // ---------- inline editing ----------
  function inlineEdit(host, value, onSave) {
    if (editing) return;
    const input = document.createElement('input');
    input.className = 'inline-edit'; input.value = value; input.spellcheck = false;
    const prev = host.innerHTML;
    host.innerHTML = ''; host.appendChild(input); host.classList.add('editing');
    editing = input;
    input.focus(); input.select();
    let closed = false;
    const finish = (save) => {
      if (closed) return; closed = true;
      editing = null; host.classList.remove('editing');
      const v = input.value.replace(/\s+/g, ' ').trim();
      if (save && v && v !== value && onSave(v) !== false) { render(); return; }
      host.innerHTML = prev;
      if (renderLater) { renderLater = false; render(); }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    for (const t of ['pointerdown', 'click', 'dblclick', 'contextmenu']) input.addEventListener(t, (e) => e.stopPropagation());
  }
  function editQuestText(g, q, host) {
    inlineEdit(host, q.text, (text) => {
      const k = norm(text);
      if (doc.groups.some((x) => x.items.some((i) => i !== q && i.type === 'quest' && norm(i.text) === k))) { toast('There is already a quest with that name.'); return false; }
      const old = norm(q.text);
      q.text = text;
      // ticks and XP follow the quest: re-file its log entries under the new name
      progress.log = progress.log.map((e) => {
        if (norm(e.text) !== old) return e;
        progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`);
        return { ...e, text };
      });
      changed();
      Sound.add();
      return true;
    });
  }
  // ---------- pin a new paper to the board ----------
  function blankPaper() {
    const b = document.createElement('div');
    b.className = 'new-paper';
    b.innerHTML = '<span class="np-label"><b>+</b> Pin a new paper</span>';
    b.title = 'Add a new board for a new group of quests';
    b.addEventListener('click', (e) => { e.stopPropagation(); namePaper(b); });
    return b;
  }
  function namePaper(b) {
    if (editing || b.classList.contains('naming')) return;
    b.classList.add('naming');
    const label = $('.np-label', b);
    label.textContent = '';
    inlineEdit(label, '', (name) => {
      const title = name.replace(/^#+\s*/, '');
      if (!title) return false;
      if (doc.groups.some((x) => norm(groupKey(x)) === norm(title))) { toast('There is already a paper with that name.'); return false; }
      doc.groups.push({ title, items: [] });
      // free layout: the new paper is nailed up exactly where the blank one was
      if (settings.layout.mode === 'free' && b.style.left) {
        settings.layout.pos[groupKey(doc.groups[doc.groups.length - 1])] = { x: parseFloat(b.style.left) || 0, y: parseFloat(b.style.top) || 0, w: parseFloat(b.style.width) || 320 };
        saveSettings();
      }
      changed();
      Sound.add();
      setTimeout(() => {
        const w = $$('.board-wrap', boards).find((x) => x.dataset.group === groupKey(doc.groups[doc.groups.length - 1]));
        if (!w) return;
        w.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        w.classList.add('nailing'); setTimeout(() => w.classList.remove('nailing'), 600);
        const r = w.getBoundingClientRect();
        FX.burst(r.left + r.width / 2, r.top + 10, { count: 26, power: 0.6 });
        if (settings.theme === 'tavern') Sound.cut();
        const add = $('.add-btn', w); if (add) add.click();
      }, 30);
      return true;
    });
    const input = $('input', label);
    if (input) input.placeholder = 'Name the paper, then Enter';
    // inlineEdit puts the old label back on cancel; keep the ghost usable again
    const obs = new MutationObserver(() => { if (!$('input', label)) { b.classList.remove('naming'); label.innerHTML = '<b>+</b> Pin a new paper'; obs.disconnect(); } });
    obs.observe(label, { childList: true });
  }
  function newPaper() {
    const b = $('.new-paper', boards);
    if (!b) return;
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    namePaper(b);
  }
  function takeDownPaper(g, wrap) {
    const i = doc.groups.indexOf(g);
    if (i < 0 || g.items.length) return;
    doc.groups.splice(i, 1);
    const r = wrap.getBoundingClientRect();
    FX.poof(r.left + r.width / 2, r.top + 20);
    wrap.classList.add('leaving');
    toast(`Took down: ${groupKey(g).slice(0, 60)}`);
    changed();
    setTimeout(render, 400);
  }

  function editBoardTitle(g, host, shown) {
    inlineEdit(host, shown, (name) => {
      const prefix = (/^active:\s*/i.exec(g.title) || [''])[0];
      const key = `${prefix}${name}`;
      if (doc.groups.some((x) => x !== g && norm(groupKey(x)) === norm(key))) { toast('There is already a board with that name.'); return false; }
      const oldKey = groupKey(g);
      g.title = isDaily(g) ? `${key} [daily]` : key;
      const pos = settings.layout && settings.layout.pos;
      if (pos && pos[oldKey]) { pos[groupKey(g)] = pos[oldKey]; delete pos[oldKey]; saveSettings(); }
      changed();
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
    toast(`Removed: ${q.text.replace(/\*\*/g, '').slice(0, 60)}`);
    changed();
    setTimeout(render, 450);
  }

  function levelUp(level) {
    const ti = tierIndex(level), t = TIERS[ti], cols = tierColors(t);
    const ascended = ti > tierIndex(level - 1);
    banner(ascended ? `${t.name} rank!` : 'Level up!', `${level} — ${rankName(level)}`, true);
    const newSpell = SPELLS.find((s) => s.level === level);
    if (newSpell) setTimeout(() => { banner(`New spell: ${newSpell.name}`, newSpell.how); refreshMagicUi(); }, 2600);
    Sound.levelUp();
    const app = $('#app');
    app.classList.remove('quaking'); void app.offsetWidth; app.classList.add('quaking');
    setTimeout(() => app.classList.remove('quaking'), 1100);
    $$('.board-wrap').forEach((w) => { w.style.setProperty('--jolt-d', `${Math.random() * 160}ms`); w.style.setProperty('--jolt-r', `${(Math.random() * 2 - 1) * 4}deg`); w.classList.remove('jolt'); void w.offsetWidth; w.classList.add('jolt'); setTimeout(() => w.classList.remove('jolt'), 1200); });
    const flash = $('#flash'); flash.style.setProperty('--flash', t.glow); flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    const cr = $('#rank-crest').getBoundingClientRect();
    const crest = $('#rank-crest'); crest.classList.remove('pulse', 'ascend'); void crest.offsetWidth; crest.classList.add(ascended ? 'ascend' : 'pulse');
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    FX.nova(cx, cy, cols);
    FX.burst(cx, cy, { count: 200, power: 2.2, long: true, colors: cols });
    FX.nova(cr.left + cr.width / 2, cr.top + cr.height / 2, cols);
    setTimeout(() => FX.rain(ascended ? 320 : 200, cols), 200);
    const shots = ascended ? 12 : 7;
    for (let i = 0; i < shots; i++) {
      setTimeout(() => {
        const x = window.innerWidth * (0.12 + Math.random() * 0.76), y = window.innerHeight * (0.15 + Math.random() * 0.5);
        FX.burst(x, y, { count: 70, power: 1.3, colors: cols });
        FX.sparkle(x, y, { count: 8, spread: 60, colors: cols, big: true });
        if (i % 2 === 0) Sound.cut && Sound.add();
      }, 300 + i * 190);
    }
  }

  // ---------- secrets: little treasures hidden on the wall, on a random schedule ----------
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
  const secretLayer = document.createElement('div');
  secretLayer.className = 'secret-layer';
  const now = () => Date.now();
  const rndIn = (a, b) => a + Math.random() * (b - a);
  function secretsState() {
    if (!settings.secrets || typeof settings.secrets !== 'object') settings.secrets = {};
    const s = settings.secrets;
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
    const rects = $$('.board-wrap', boards).map((w) => { const r = w.getBoundingClientRect(); return { l: r.left - br.left + boards.scrollLeft - 24, t: r.top - br.top + boards.scrollTop - 24, r: r.right - br.left + boards.scrollLeft + 24, b: r.bottom - br.top + boards.scrollTop + 24 }; });
    for (let i = 0; i < 60; i++) {
      const x = rndIn(16, W - 44), y = rndIn(30, H - 44);
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
    saveSettings();
    return true;
  }
  function tickSecrets() {
    const s = secretsState();
    const before = s.active.length;
    s.active = s.active.filter((x) => x.until > now());
    if (now() >= s.next && s.active.length < 1) {
      if (spawnSecret()) s.next = now() + rndIn(8, 36) * 3600e3;    // the next one: somewhere between 8 h and a day and a half
    }
    if (s.active.length !== before) saveSettings();
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
    saveSettings();
    progress.log.push({ text: `Secret: ${k.name}`, at: new Date().toISOString(), device: info.device, xp: 0, secret: true, kind: k.id });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.classList.add('found');
    setTimeout(() => el.remove(), 600);
    FX.burst(x, y, { count: 60, power: 1, colors: ['#fff4b0', '#ffd36b', '#ffffff', '#9be7ff'] });
    FX.sparkle(x, y, { count: 14, spread: 40, colors: ['#ffffff', '#fff4b0', '#9be7ff'], big: true });
    Sound.secret();
    floatText(x + 20, y, k.name);
    secretFun(k, x, y, s);
    refreshMagicUi();
    changed();
  }

  // What each secret does: nothing useful, all of it silly. Secrets never give XP.
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
        rainOf(['🪙'], 36);
        for (let i = 0; i < 6; i++) setTimeout(() => Sound.add(), 120 * i);
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
        rainOf(['✨', '💎', '✦', '⭐'], 44); potionEffect('fx-disco', 9000);
        banner('A glittering gem', 'Disco in the tavern');
        break;
      case 'rune': {
        const pick = ['bolt', 'meteor', 'circle', 'rain', 'starfall', 'hearts'][(Math.random() * 6) | 0];
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        if (pick === 'bolt') { Magic.bolt(x, y); Sound.thunder(); }
        if (pick === 'meteor') Magic.meteor(cx, cy, () => { Sound.boom(); FX.shake($('#app'), 600); });
        if (pick === 'circle') { Magic.circle(x, y, 260, '#7df9ff'); Sound.cast(); }
        if (pick === 'rain') Magic.rainfall(8000);
        if (pick === 'starfall') { Magic.starfall(); Sound.cast(); }
        if (pick === 'hearts') { Magic.hearts(x, y); Sound.cast(); }
        banner('A glowing rune stone', 'It cast a spell all by itself');
        break;
      }
      case 'egg':
        walkAcross('🐉', 'Dragonling');
        banner('A dragon egg!', 'It hatched: a dragonling lives in your garden now');
        break;
      case 'gatekey': banner('The garden gate key!', 'A secret garden opens: "garden" at the bottom'); break;
      case 'spellscroll': banner('You learned Enchant!', 'Hover a quest and press ✧ to enchant it'); break;
      default: banner('Secret found!', `${k.name} · ${s.found} found so far`);
    }
  }

  // ---------- sync ----------
  let syncing = false, syncTimer = null;
  function setSyncStatus(state, detail) {
    const b = $('#btn-sync'), l = $('#sync-label');
    b.classList.remove('on', 'err', 'busy');
    if (state === 'off') { l.textContent = 'Sync off'; b.title = 'Click to connect to the devbox'; }
    else if (state === 'busy') { b.classList.add('busy'); l.textContent = 'Syncing…'; }
    else if (state === 'ok') { b.classList.add('on'); l.textContent = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; b.title = `Synced with ${Sync.baseUrl}. Click for settings, Shift+click to sync now.`; }
    else { b.classList.add('err'); l.textContent = 'Sync error'; b.title = detail || 'Sync failed'; }
  }
  function scheduleSync(ms = 2500) { if (!Sync.ready) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync('change'), ms); }

  // What a brand-new install shows before it has ever synced. It must never be merged into
  // an existing devbox board, or every fresh device would add a stray "Today / Add a quest".
  const DEFAULT_QUESTS = '# Quests\n\n## Active: Today\n- [ ] Add a quest\n';
  // The installed app starts from assets/QUESTS.starter.md ("First steps", "Someday"...), older builds
  // and the browser from DEFAULT_QUESTS; either one untouched means "nothing of mine here yet".
  const isUntouchedDefault = (text) => text === serialize(parse(DEFAULT_QUESTS)) || (!!(info && info.starter) && text === serialize(parse(info.starter)));

  async function runSync(reason) {
    if (!Sync.ready || syncing || busy) { if (busy) scheduleSync(1500); return; }
    syncing = true; setSyncStatus('busy');
    try {
      // --- quests ---
      const remote = await Sync.get('QUESTS.md');
      const localText = serialize(doc);
      const baseText = settings.base.questsText || '';
      let merged = localText;
      if (remote.text !== null && !baseText && isUntouchedDefault(localText)) merged = remote.text;   // first sync on a fresh device: adopt the board
      else if (remote.text !== null && remote.text !== baseText) merged = window.Merge.merge(baseText, localText, remote.text);
      if (merged !== localText) { doc = parse(merged); render(); saveLocal(); if (reason !== 'boot') toast('Board updated from the devbox.'); }
      if (remote.text === null || merged !== remote.text) {
        let res = await Sync.put('QUESTS.md', merged, remote.etag);
        if (res.conflict) {
          merged = window.Merge.merge(baseText, merged, res.text);
          doc = parse(merged); render(); saveLocal();
          res = await Sync.put('QUESTS.md', merged, res.etag);
          if (res.conflict) throw new Error('The devbox copy keeps changing; will retry.');
        }
        settings.base = { ...settings.base, questsText: merged, questsEtag: res.etag };
      } else {
        settings.base = { ...settings.base, questsText: merged, questsEtag: remote.etag };
      }
      // --- progress ---
      const rp = await Sync.get('progress.json');
      let remoteDoc = { log: [], removed: [] };
      try { if (rp.text) remoteDoc = JSON.parse(rp.text); } catch { /* ignore bad remote */ }
      const mergedDoc = window.Merge.mergeProgressDoc(progress, remoteDoc);
      const mergedText = JSON.stringify(mergedDoc, null, 2);
      if (JSON.stringify(mergedDoc.log) !== JSON.stringify(progress.log) || (mergedDoc.resetAt || '') !== (progress.resetAt || '')) { progress = mergedDoc; renderHero(); saveLocal(); }
      else progress = mergedDoc;
      if (!rp.text || JSON.stringify(mergedDoc.log) !== JSON.stringify(remoteDoc.log || []) || JSON.stringify(mergedDoc.removed) !== JSON.stringify(remoteDoc.removed || []) || (mergedDoc.resetAt || '') !== (remoteDoc.resetAt || '')) {
        let res = await Sync.put('progress.json', mergedText, rp.etag);
        if (res.conflict) {
          let again = {}; try { again = JSON.parse(res.text); } catch { /* ignore */ }
          progress = window.Merge.mergeProgressDoc(mergedDoc, again); renderHero(); saveLocal();
          res = await Sync.put('progress.json', JSON.stringify(progress, null, 2), res.etag);
          if (res.conflict) throw new Error('Progress conflict; will retry.');
        }
        settings.base.progressEtag = res.etag;
      }
      saveSettings();
      setSyncStatus('ok');
    } catch (e) {
      console.warn('sync', e);
      setSyncStatus('error', e.message);
    } finally { syncing = false; }
  }

  // ---------- settings modal ----------
  function openSettings() {
    const m = $('#modal');
    $('#sync-url').value = settings.sync.baseUrl || '';
    $('#sync-token').value = settings.sync.token || '';
    $('#modal-status').textContent = '';
    m.hidden = false;
    $('#sync-url').focus();
  }
  function closeSettings() { $('#modal').hidden = true; }
  async function testSettings() {
    const baseUrl = $('#sync-url').value.trim(), token = $('#sync-token').value.trim();
    const st = $('#modal-status');
    if (!baseUrl || !token) { st.textContent = 'Both fields are needed.'; return false; }
    st.textContent = 'Testing…';
    try {
      Sync.configure({ baseUrl, token });
      const r = await Sync.check();
      st.textContent = r.hasQuests ? 'Connected. The devbox already has a quest file; it will be merged with yours.' : 'Connected. Your quests will be uploaded.';
      return true;
    } catch (e) { st.textContent = `Failed: ${e.message}`; Sync.configure(settings.sync); return false; }
  }
  async function saveSettingsFromModal() {
    const ok = await testSettings();
    if (!ok) return;
    settings.sync = { baseUrl: $('#sync-url').value.trim(), token: $('#sync-token').value.trim() };
    Sync.configure(settings.sync);
    saveSettings();
    closeSettings();
    toast('Sync connected.');
    runSync('settings');
  }
  function disconnectSync() {
    settings.sync = { baseUrl: '', token: '' };
    settings.base = defaultSettings().base;
    Sync.configure(settings.sync);
    saveSettings(); closeSettings(); setSyncStatus('off'); toast('Sync disconnected. Quests stay on this PC.');
  }

  // ---------- ui helpers ----------
  const pick = (a) => a[(Math.random() * a.length) | 0];
  function banner(text, sub, big) {
    const el = document.createElement('div');
    el.className = 'banner' + (big ? ' levelup' : '');
    el.textContent = text;
    if (sub) { const s = document.createElement('small'); s.textContent = sub.replace(/\*\*/g, '').slice(0, 70); el.appendChild(s); }
    $('#banner-layer').appendChild(el);
    setTimeout(() => el.remove(), big ? 2400 : 1500);
  }
  function floatText(x, y, text, neg) {
    const el = document.createElement('div');
    el.className = 'float-xp' + (neg ? ' neg' : '');
    el.textContent = text; el.style.left = `${x}px`; el.style.top = `${y - 10}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }
  function toast(text) {
    $$('.toast').forEach((t) => t.remove());
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // the wall behind the sign uses the same planks as the board wall, lined up with it
  function alignWood() {
    const y = boards.getBoundingClientRect().top;
    document.documentElement.style.setProperty('--wood-y', `${Math.round(y)}px`);
  }

  // ---------- magic ----------
  const SPELLS = [
    { id: 'ember', name: 'Ember trail', level: 5, how: 'Passive: your cursor leaves a trail of fire.', toggle: true },
    { id: 'circle', name: 'Arcane circle', level: 5, shape: 'circle', how: 'Draw a circle.' },
    { id: 'fireball', name: 'Fireball', level: 6, shape: 'triangle', how: 'Draw a triangle.' },
    { id: 'hearts', name: 'Heartbloom', level: 8, shape: 'heart', how: 'Draw a heart.' },
    { id: 'lightning', name: 'Lightning', level: 10, shape: 'zigzag', how: 'Draw a zigzag. Also strikes every quest you clear.', toggle: true },
    { id: 'ward', name: 'Ward', level: 12, shape: 'square', how: 'Draw a square.' },
    { id: 'rain', name: 'Rainfall', level: 15, shape: 'down', how: 'Swipe straight down.' },
    { id: 'starfall', name: 'Starfall', level: 18, shape: 'star', how: 'Draw a five-pointed star in one stroke.' },
    { id: 'meteor', name: 'Meteor', level: 20, shape: 'diagonal', how: 'Slash diagonally.' },
    { id: 'vortex', name: 'Vortex', level: 25, shape: 'spiral', how: 'Draw a spiral.' },
    { id: 'enchant', name: 'Enchant', scroll: true, how: 'Learned from a secret scroll. Hover a quest and press ✧: it glows and gives double XP. One at a time.' },
  ];
  const level = () => levelInfo(totalXp()).level;
  const secretKinds = () => new Set(progress.log.filter((e) => e.secret && e.kind).map((e) => e.kind));
  function learned(id) {
    const sp = SPELLS.find((s) => s.id === id);
    if (!sp) return false;
    if (sp.scroll) return secretKinds().has('spellscroll');
    // spells are knowledge: an XP reset doesn't make you forget them
    const best = levelInfo(progress.log.reduce((n, e) => n + entryXp(e), 0)).level;
    return Math.max(level(), best) >= sp.level;
  }
  const spellOn = (id) => learned(id) && (settings.spells || {})[id] !== false;
  const gardenOpen = () => secretKinds().has('gatekey');
  function familiars() {
    const k = secretKinds(), out = [];
    for (const f of Object.keys(Magic.FAMILIARS)) if (k.has(`fam-${f}`)) out.push(f);
    if (k.has('egg')) out.push('dragon');
    return out;
  }
  function refreshMagicUi() {
    $('#btn-garden').hidden = !gardenOpen();
    FX.setTrail(spellOn('ember') ? 'ember' : 'normal');
  }

  // XP for clearing a quest, with its bonuses
  function nightNow() { const h = new Date().getHours(); return h < 5; }
  function morningNow() { const h = new Date().getHours(); return h >= 6 && h < 11; }
  function questXp(g, q) {
    let xp = XP_PER_QUEST; const notes = [];
    if (progress.enchant && progress.enchant.key === norm(q.text)) { xp *= 2; notes.push('Enchanted ×2'); }
    const st = isDaily(g) ? 0 : corruption(q);
    if (st) { xp += [0, 10, 20, 40][st]; notes.push(st === 3 ? 'Monster slain!' : 'Purified!'); }
    if (nightNow()) { xp += 10; notes.push('Night owl'); }
    else if (morningNow()) { xp += 15; notes.push('Early bird'); }
    return { xp, notes };
  }

  // corruption: quests nobody touched for a long time rot, then turn into monsters
  function ensureBorn() {
    if (!progress.born) progress.born = {};
    let added = false;
    const now = new Date().toISOString();
    for (const g of doc.groups) for (const it of g.items) {
      if (it.type !== 'quest' || it.done) continue;
      const k = norm(it.text);
      if (!progress.born[k]) { progress.born[k] = now; added = true; }
    }
    if (added) { saveLocal(); scheduleSync(4000); }
  }
  function corruption(q) {
    const b = progress.born && progress.born[norm(q.text)];
    if (!b) return 0;
    const days = (Date.now() - Date.parse(b)) / 86400e3;
    return days >= 30 ? 3 : days >= 14 ? 2 : days >= 7 ? 1 : 0;
  }

  // enchant one quest at a time
  function enchantQuest(q, li) {
    const k = norm(q.text);
    const same = progress.enchant && progress.enchant.key === k;
    progress.enchant = { key: same ? null : k, at: new Date().toISOString() };
    const r = li.getBoundingClientRect();
    if (!same) { FX.sparkle(r.left + 30, r.top + r.height / 2, { count: 14, spread: 30, colors: ['#e6d0ff', '#c58cff', '#ffffff', '#ffd36b'], big: true }); Sound.cast(); toast('Enchanted: this quest gives double XP.'); }
    else toast('Enchantment lifted.');
    changed(); render();
  }

  // rune circle: three quests inside an hour
  function checkCombo() {
    const hour = Date.now() - 3600e3;
    const lastCombo = progress.log.filter((e) => e.bonus === 'combo').map((e) => Date.parse(e.at)).sort().pop() || 0;
    const recent = questLog().filter((e) => Date.parse(e.at) > Math.max(hour, lastCombo));
    if (recent.length < 3) return null;
    progress.log.push({ text: 'Combo: rune circle', at: new Date().toISOString(), device: info.device, xp: 30, bonus: 'combo' });
    return () => {
      const br = boards.getBoundingClientRect();
      Magic.circle(br.left + br.width / 2, br.top + Math.min(br.height / 2, 300), 300, TIERS[tierIndex(level())].a, 4200);
      Sound.cast();
      banner('Rune circle!', 'Three quests within an hour · +30 XP');
      renderHero();
    };
  }

  // casting: hold on the wall (or the sign), then draw
  let gesture = null;
  function castAt(kind, pts) {
    const end = pts[pts.length - 1];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const sp0 = SPELLS.find((x) => x.shape === kind);
    const id = sp0 && sp0.id;
    if (!id) { Sound.fizzle(); FX.poof(end.x, end.y); return false; }
    const sp = SPELLS.find((s) => s.id === id);
    if (!learned(id)) { Sound.fizzle(); FX.poof(end.x, end.y); toast(`You don't know ${sp.name} yet: it unlocks at level ${sp.level}.`); return false; }
    if (id === 'circle') { Magic.circle(cx, cy, Math.max(160, Math.max(...xs) - Math.min(...xs) + 60), TIERS[tierIndex(level())].a); FX.burst(cx, cy, { count: 70, power: 1, colors: tierColors(TIERS[tierIndex(level())]) }); Sound.cast(); }
    if (id === 'lightning') { Magic.bolt(end.x, end.y); Sound.thunder(); FX.cut(end.x, end.y); }
    if (id === 'rain') { Magic.rainfall(15000); Sound.cast(); toast('Rainfall: the tavern roof is leaking again.'); }
    const col = TIERS[tierIndex(level())].a;
    if (id === 'fireball') { Magic.fireball(cx, cy); Sound.boom(); FX.shake($('#app'), 300); }
    if (id === 'hearts') { Magic.hearts(cx, cy); Sound.cast(); }
    if (id === 'ward') { Magic.ward(cx, cy, col); Sound.cast(); }
    if (id === 'starfall') { Magic.starfall(); Sound.cast(); }
    if (id === 'vortex') { Magic.vortex(cx, cy); Sound.cast(); }
    if (id === 'meteor') { Magic.meteor(end.x, end.y, () => { Sound.boom(); FX.shake($('#app'), 600); for (let i = 0; i < 3; i++) FX.cut(end.x + (Math.random() - 0.5) * 60, end.y + (Math.random() - 0.5) * 40); }); }
    return true;
  }
  function beginGesture(e) {
    gesture = { x: e.clientX, y: e.clientY, t: performance.now(), pts: [{ x: e.clientX, y: e.clientY }], drawing: false, id: e.pointerId, stroke: null };
    gesture.timer = setTimeout(() => { if (gesture && !gesture.drawing) startDrawing(); }, 220);
  }
  function startDrawing() {
    gesture.drawing = true;
    gesture.stroke = Magic.startStroke(TIERS[tierIndex(level())].a);
    for (const p of gesture.pts) gesture.stroke.add(p.x, p.y);
    document.documentElement.classList.add('casting');
  }
  window.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const p = { x: e.clientX, y: e.clientY };
    gesture.pts.push(p);
    if (!gesture.drawing && Math.hypot(p.x - gesture.x, p.y - gesture.y) > 14) startDrawing();
    if (gesture.drawing) { gesture.stroke.add(p.x, p.y); if (Math.random() < 0.3) { FX.sparkle(p.x, p.y, { count: 1, spread: 4, colors: tierColors(TIERS[tierIndex(level())]) }); Sound.draw(); } }
  });
  function endGesture(e) {
    if (!gesture || (e && e.pointerId !== gesture.id)) return;
    const g = gesture; gesture = null; clearTimeout(g.timer);
    document.documentElement.classList.remove('casting');
    if (!g.drawing) {           // a plain click: a sword cut (Tavern) or a splash (Abyss), as before
      if (settings.theme === 'abyss') { FX.splash(g.x, g.y); Sound.splash(); }
      else { FX.cut(g.x, g.y); Sound.cut(); }
      return;
    }
    const kind = Magic.recognize(g.pts);
    g.stroke.end(castAt(kind, g.pts));
  }
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', (e) => { if (gesture && gesture.stroke) gesture.stroke.end(false); gesture = null; document.documentElement.classList.remove('casting'); });

  function openSpellbook() {
    const wrap = document.createElement('div'); wrap.className = 'modal-wrap spellbook-wrap';
    const lv = level();
    wrap.innerHTML = `<div class="modal-card spellbook"><h3>Spellbook</h3><p>You learn new spells as you level up. To cast, hold still on bare wall (or the sign) for a moment, then draw the shape in one stroke.</p><ol class="spell-list"></ol><div class="modal-row"><span class="status">Level ${lv}</span><button class="btn" type="button">Close</button></div></div>`;
    const list = $('.spell-list', wrap);
    for (const sp of SPELLS) {
      const ok = learned(sp.id);
      const li = document.createElement('li'); li.className = ok ? 'known' : 'locked';
      li.innerHTML = `<b></b><span class="req"></span><small></small>`;
      $('b', li).textContent = ok ? sp.name : `${sp.name}`;
      $('.req', li).textContent = ok ? 'learned' : sp.scroll ? 'find its scroll' : `level ${sp.level}`;
      $('small', li).textContent = sp.how;
      if (ok && sp.toggle) {
        const t = document.createElement('button'); t.type = 'button'; t.className = 'btn seg' + (spellOn(sp.id) ? ' on' : '');
        t.textContent = spellOn(sp.id) ? 'on' : 'off';
        t.addEventListener('click', () => { settings.spells = settings.spells || {}; settings.spells[sp.id] = !spellOn(sp.id); saveSettings(); refreshMagicUi(); t.textContent = spellOn(sp.id) ? 'on' : 'off'; t.classList.toggle('on', spellOn(sp.id)); });
        li.appendChild(t);
      }
      list.appendChild(li);
    }
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    $('.modal-row .btn', wrap).addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  }

  // ---------- the hidden XP reset: Shift + double-click the version number, then survive ten questions ----------
  const RESET_STEPS = [
    ['Reset your XP?', 'Your level and rank go back to 1. Quests and history stay.', 'Yes, reset', 'No'],
    ['Are you sure?', 'All of it. Every level you climbed.', 'I am sure', 'Keep my XP'],
    ['Really sure?', 'The crest goes back to plain bronze.', 'Really sure', 'Never mind'],
    ['The guild master raises an eyebrow.', '"You want to start over, adventurer?"', 'I do', 'I misspoke'],
    ['Think of the fireworks.', 'All those level-ups. Gone.', 'Gone it is', 'Wait, no'],
    ['Last chance?', 'Not really, there are five more.', 'Continue', 'Stop'],
    ['The tavern goes quiet.', 'Even the cat looks at you.', 'Do it', 'Pet the cat instead'],
    ['Are you sure you are sure?', 'Double-sure. Triple-sure.', 'Triple-sure', 'Single-unsure'],
    ['One more.', 'This is the second to last one. Honestly.', 'Onward', 'Retreat'],
    ['Type RESET to burn it all.', 'This is the tenth question.', 'Burn it', 'Cancel'],
  ];
  function resetRitual() {
    let step = 0;
    const wrap = document.createElement('div'); wrap.className = 'modal-wrap ritual';
    const card = document.createElement('div'); card.className = 'modal-card';
    wrap.appendChild(card); document.body.appendChild(wrap);
    const close = () => wrap.remove();
    const show = () => {
      const [title, text, yes, no] = RESET_STEPS[step];
      const last = step === RESET_STEPS.length - 1;
      card.innerHTML = `<h3></h3><p></p>${last ? '<input class="ritual-input" placeholder="RESET" spellcheck="false" />' : ''}<div class="modal-row"><span class="status">${step + 1} / ${RESET_STEPS.length}</span><span class="ritual-btns"></span></div>`;
      $('h3', card).textContent = title; $('p', card).textContent = text;
      const b = $('.ritual-btns', card);
      const y = document.createElement('button'); y.className = 'btn danger'; y.textContent = yes;
      const n = document.createElement('button'); n.className = 'btn'; n.textContent = no;
      if (Math.random() < 0.5) b.append(y, n); else b.append(n, y);     // the buttons swap sides now and then
      n.addEventListener('click', () => { close(); toast('Your XP is safe.'); });
      y.addEventListener('click', () => {
        if (last) {
          if ($('.ritual-input', card).value.trim().toUpperCase() !== 'RESET') { $('.status', card).textContent = 'Type RESET first.'; return; }
          close(); doReset(); return;
        }
        step += 1; show(); FX.shake(card, 300);
      });
      if (last) $('.ritual-input', card).focus();
    };
    wrap.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    show();
  }
  function doReset() {
    progress.resetAt = new Date().toISOString();
    lastToday = null;
    const r = $('#rank-crest').getBoundingClientRect();
    FX.poof(r.left + r.width / 2, r.top + r.height / 2);
    FX.burst(r.left + r.width / 2, r.top + r.height / 2, { count: 40, power: 0.6, colors: ['#9a9a9a', '#6b6b6b', '#ffb347'] });
    Sound.undo();
    changed();
    banner('A fresh start', 'Level 1 · your quest history is kept');
  }

  // ---------- theme / prefs ----------
  function applyTheme(name) {
    if (settings.theme !== name) clearCuts();
    settings.theme = name;
    document.documentElement.setAttribute('data-theme', name);
    FX.setTheme(name);
    renderHero();
  }
  // wall textures (tavern): planks, weathered, cracked, charred, or the classic wood
  const WALLS = [['planks', 'Planks'], ['weathered', 'Weathered'], ['cracked', 'Cracked'], ['charred', 'Charred'], ['classic', 'Classic']];
  function applyWall() {
    const w = WALLS.find((x) => x[0] === settings.wall) ? settings.wall : 'planks';
    document.documentElement.setAttribute('data-wall', w);
    const b = $('#btn-wall'); if (b) b.textContent = 'wall: ' + WALLS.find((x) => x[0] === w)[1].toLowerCase();
  }
  function cycleWall() {
    const i = WALLS.findIndex((x) => x[0] === (settings.wall || 'planks'));
    settings.wall = WALLS[(i + 1) % WALLS.length][0];
    applyWall(); saveSettings();
    if (settings.theme !== 'tavern') banner('Wall: ' + WALLS.find((x) => x[0] === settings.wall)[1], 'shows in the Tavern theme');
  }
  function toggleTheme() {
    applyTheme(settings.theme === 'abyss' ? 'tavern' : 'abyss');
    FX.burst(window.innerWidth - 220, 24, { count: 40, power: 0.9 });
    saveSettings();
  }
  function applySound() {
    Sound.enabled = settings.sound;
    $('#btn-sound').classList.toggle('off', !settings.sound);
    $('#btn-sound').classList.toggle('on', settings.sound);
  }
  async function refreshAutostart() {
    const a = await api.getAutostart();
    const b = $('#btn-autostart');
    b.classList.toggle('on', a.enabled);
    b.disabled = !a.available;
    b.title = a.available ? (a.enabled ? 'Launches when Windows starts (click to turn off)' : 'Click to launch when Windows starts') : 'Startup registration works in the installed app only';
    $('#autostart-label').textContent = a.enabled ? 'Startup on' : 'Startup off';
  }

  // ---------- updates (footer button) ----------
  let updateUi = { state: 'idle' };
  let updateReset = null;
  function showUpdateState(u) {
    if (!u) return;
    const prev = updateUi.state;
    updateUi = u;
    const b = $('#btn-update');
    clearTimeout(updateReset);
    b.classList.toggle('hot', u.state === 'ready');
    b.disabled = u.state === 'checking' || u.state === 'downloading';
    const label = {
      idle: 'check for updates',
      checking: 'checking…',
      downloading: `downloading v${u.version || ''} ${u.percent ? u.percent + '%' : ''}`.trim(),
      ready: `restart to update to v${u.version}`,
      none: 'up to date ✓',
      error: 'update check failed',
      unavailable: 'check for updates',
    }[u.state] || 'check for updates';
    b.textContent = label;
    b.title = u.state === 'error' ? (u.message || 'Could not reach GitHub') : (u.state === 'ready' ? 'Installs now and reopens Questboard. Hiding to the tray also installs it.' : 'Look for a new version on GitHub');
    if (u.state === 'none' || u.state === 'error' || u.state === 'unavailable') updateReset = setTimeout(() => showUpdateState({ state: 'idle' }), 4000);
    if (u.manual) {
      if (u.state === 'none') toast(`You have the latest version (v${info.version}).`);
      if (u.state === 'error') toast(`Update check failed: ${u.message || 'could not reach GitHub'}`);
      if (u.state === 'unavailable') toast(u.message);
    }
    if (u.state === 'ready' && prev !== 'ready') toast(`Update v${u.version} is ready. Click "restart to update", or just hide the window and it installs itself.`);
  }

  // ---------- backups ----------
  // Lists saved versions of the quest list (devbox history or this device's backups folder), newest
  // first, with what changed compared to the version after it. Restoring makes that version the
  // current board and syncs it like any other edit.
  let backupSource = 'devbox';
  const questTexts = (text) => { const d = parse(text || ''); const s = new Set(); d.groups.forEach((g) => g.items.forEach((it) => { if (it.type === 'quest') s.add(norm(it.text)); })); return s; };
  const counts = (text) => { const d = parse(text || ''); let open = 0, done = 0; d.groups.forEach((g) => g.items.forEach((it) => { if (it.type === 'quest') (it.done ? done++ : open++); })); return { open, done, boards: d.groups.length }; };
  function fmtWhen(iso) {
    const d = new Date(iso), now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = d.toDateString() === now.toDateString() ? 'Today' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    const mins = Math.round((now - d) / 60000);
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    return { label: `${day} ${time}`, ago };
  }
  async function loadBackups() {
    const list = $('#backup-list'), status = $('#backup-status');
    list.innerHTML = '<li><span class="empty">Loading…</span></li>';
    $('#bk-src-devbox').classList.toggle('on', backupSource === 'devbox');
    $('#bk-src-local').classList.toggle('on', backupSource === 'local');
    let items = [];
    try {
      if (backupSource === 'devbox') {
        if (!Sync.ready) throw new Error('Not connected to the devbox (title bar → Sync).');
        const meta = await Sync.history('QUESTS.md');
        items = meta.map((m) => ({ id: m.id, at: m.at, fetch: () => Sync.historyGet('QUESTS.md', m.id), text: null }));
        // fetch bodies lazily but in small batches so the diff column can be shown
        const firstBodies = await Promise.all(items.slice(0, 60).map((it) => it.fetch().catch(() => null)));
        firstBodies.forEach((t, i) => { items[i].text = t; });
      } else {
        items = (api.listBackups ? await api.listBackups('QUESTS.md') : []).map((b) => ({ id: b.id, at: b.at, text: b.text, fetch: async () => b.text }));
      }
    } catch (e) {
      list.innerHTML = '';
      const li = document.createElement('li'); const sp = document.createElement('span'); sp.className = 'empty'; sp.textContent = e.message; li.appendChild(sp); list.appendChild(li);
      return;
    }
    list.innerHTML = '';
    if (!items.length) { const li = document.createElement('li'); li.innerHTML = '<span class="empty">No backups yet. They appear after the next change.</span>'; list.appendChild(li); return; }
    const current = serialize(doc);
    items.forEach((it, i) => {
      const li = document.createElement('li');
      const w = fmtWhen(it.at);
      const when = document.createElement('div'); when.className = 'when'; when.textContent = w.label;
      const small = document.createElement('small'); small.textContent = w.ago; when.appendChild(small);
      const what = document.createElement('div'); what.className = 'what';
      if (it.text != null) {
        const c = counts(it.text);
        let line = `${c.open} open · ${c.done} done · ${c.boards} boards`;
        const newer = items[i - 1] && items[i - 1].text;
        if (newer != null) {
          const a = questTexts(it.text), b = questTexts(newer);
          const removedLater = [...a].filter((q) => !b.has(q)).length, addedLater = [...b].filter((q) => !a.has(q)).length;
          if (removedLater) line += ` · has ${removedLater} quest${removedLater > 1 ? 's' : ''} later removed`;
          if (addedLater && !removedLater) line += ` · before ${addedLater} new`;
        }
        what.textContent = line;
        if (serialize(parse(it.text)) === current) what.textContent += ' · same as now';
      }
      const btn = document.createElement('button'); btn.className = 'btn'; btn.type = 'button'; btn.textContent = 'Restore';
      btn.addEventListener('click', () => restoreBackup(it, btn));
      li.append(when, what, btn);
      list.appendChild(li);
    });
  }
  async function restoreBackup(it, btn) {
    const status = $('#backup-status');
    try {
      btn.disabled = true;
      const text = it.text != null ? it.text : await it.fetch();
      const next = parse(text);
      if (!next.groups.length) throw new Error('That version is empty; not restoring it.');
      await api.writeFile('QUESTS.md', serialize(doc));      // current board goes into the backups first
      doc = next; render(); saveLocal(); scheduleSync(300);
      Sound.levelUp && Sound.levelUp();
      FX.burst(window.innerWidth / 2, window.innerHeight / 2, { count: 50, power: 1 });
      status.textContent = `Restored the board from ${fmtWhen(it.at).label}.`;
      toast(`Board restored from ${fmtWhen(it.at).label}. The previous board is in the backups too.`);
      setTimeout(loadBackups, 1200);
    } catch (e) {
      status.textContent = e.message;
    } finally { btn.disabled = false; }
  }
  function openBackups() { $('#backups').hidden = false; $('#backup-status').textContent = ''; backupSource = Sync.ready ? 'devbox' : 'local'; loadBackups(); }
  function closeBackups() { $('#backups').hidden = true; }

  // ---------- boot ----------
  async function boot() {
    info = await api.appInfo();
    $('#version').textContent = `v${info.version}`;

    const readJson = async (name) => { try { const t = await api.readFile(name); return t ? JSON.parse(t) : null; } catch { return null; } };
    settings = Object.assign(defaultSettings(), (await readJson('settings.json')) || {});
    settings.sync = Object.assign({ baseUrl: '', token: '' }, settings.sync || {});
    settings.base = Object.assign(defaultSettings().base, settings.base || {});
    settings.layout = Object.assign({ mode: 'grid', pos: {} }, settings.layout || {});
    progress = Object.assign({ log: [], removed: [] }, (await readJson('progress.json')) || {});
    // migrate v0.2 state.json (xp counter + log + prefs)
    const legacy = await readJson('state.json');
    if (legacy && !(await api.readFile('progress.json'))) {
      progress.log = (legacy.log || []).map((e) => ({ ...e, device: e.device || info.device }));
      if (legacy.theme) settings.theme = legacy.theme;
      if (typeof legacy.sound === 'boolean') settings.sound = legacy.sound;
    }
    const questsText = await api.readFile('QUESTS.md');
    doc = parse(questsText || DEFAULT_QUESTS);
    saveLocal();

    api.onQuestsChanged((fresh) => {
      if (busy) return;
      const next = parse(fresh);
      if (serialize(next) === serialize(doc)) return;
      doc = next; render();
      Sound.add();
      FX.burst(window.innerWidth / 2, 120, { count: 40, power: 0.9 });
      toast('Board updated from the quest file.');
      scheduleSync();
    });
    api.onUpdateStatus(showUpdateState);
    showUpdateState(await api.updateState());
    api.onIdle((idle) => FX.setIdle(idle));

    applyTheme(settings.theme || 'tavern');
    applyWall();
    applySound();
    render();
    refreshAutostart();

    Sync.configure(settings.sync);
    setSyncStatus(Sync.ready ? 'ok' : 'off');
    if (Sync.ready) runSync('boot');
    setInterval(() => { if (Sync.ready) runSync('timer'); }, 90 * 1000);
    let dailyStamp = '';
    setInterval(() => {
      const stamp = doc.groups.filter(isDaily).flatMap((g) => g.items.filter((i) => i.type === 'quest').map((q) => (dailyEntry(q) ? '1' : '0'))).join('');
      if (stamp !== dailyStamp) { if (dailyStamp && !busy) render(); dailyStamp = stamp; }
      else if (stamp.includes('1') && !busy && !document.hidden) $$('.quest .resets').length && render();
    }, 60 * 1000);
    window.addEventListener('focus', () => { if (Sync.ready) runSync('focus'); });
    $('#version').addEventListener('dblclick', (e) => { if (e.shiftKey) resetRitual(); });
    $('#btn-spellbook').addEventListener('click', openSpellbook);
    $('#btn-garden').addEventListener('click', () => Magic.openGarden(familiars()));
    refreshMagicUi();
    Magic.setNight(nightNow());
    setInterval(() => { Magic.setNight(nightNow()); refreshMagicUi(); }, 60 * 1000);
    if (!info.packaged) window.__forceSecret = (kind) => { const s = secretsState(), sp = bareSpot() || { x: 120, y: 120 }; s.active = [{ id: `t${now()}`, kind, x: Math.round(sp.x), y: Math.round(sp.y), until: now() + 3600e3, tilt: 0 }]; drawSecrets(); };   // dev builds only, for tests
    tickSecrets();
    setInterval(tickSecrets, 30 * 1000);
    setInterval(() => {
      if (document.hidden) return;
      const ti = tierIndex(levelInfo(totalXp()).level);
      if (ti >= 1) {
        const r = $('#rank-crest').getBoundingClientRect(), t = TIERS[ti];
        FX.sparkle(r.left + r.width / 2, r.top + r.height / 2, { count: Math.min(5, ti), spread: 34, colors: tierColors(t), big: ti >= 6 });
      }
      const heat = Number($('#stat-today-box').dataset.heat);
      if (heat >= 3) {
        const r = $('#stat-today-box').getBoundingClientRect();
        FX.embers(r.left + r.width / 2, r.top + 6, { count: heat * 2 - 3, w: r.width / 2 - 6, colors: HEAT_COLORS[heat] });
      }
    }, 900);
    new ResizeObserver(() => { alignWood(); if (signBake.parentNode) redrawSign(); }).observe($('#hero'));
    window.addEventListener('resize', alignWood);
    alignWood();

    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-wall').addEventListener('click', cycleWall);
    $('#btn-new-paper').addEventListener('click', newPaper);
    $('#btn-sound').addEventListener('click', () => { settings.sound = !settings.sound; applySound(); if (settings.sound) { Sound.unlock(); Sound.add(); } saveSettings(); });
    $('#btn-autostart').addEventListener('click', async () => {
      const a = await api.getAutostart();
      if (!a.available) return toast('Startup registration only works in the installed app.');
      await api.setAutostart(!a.enabled);
      await refreshAutostart();
      toast(!a.enabled ? 'Questboard will open when Windows starts.' : 'Startup launch turned off.');
    });
    $('#btn-sync').addEventListener('click', (e) => { if (e.shiftKey && Sync.ready) runSync('manual'); else openSettings(); });
    $('#btn-sync-now').addEventListener('click', () => { if (Sync.ready) runSync('manual'); else openSettings(); });
    $('#modal-test').addEventListener('click', testSettings);
    $('#modal-save').addEventListener('click', saveSettingsFromModal);
    $('#modal-cancel').addEventListener('click', closeSettings);
    $('#modal-disconnect').addEventListener('click', disconnectSync);
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeSettings(); });
    $('#btn-min').addEventListener('click', () => api.minimize());
    $('#btn-hide').addEventListener('click', () => api.hide());
    $('#btn-open-data').addEventListener('click', () => api.openDataDir());
    $('#btn-backups').addEventListener('click', openBackups);
    $('#backup-close').addEventListener('click', closeBackups);
    $('#backups').addEventListener('click', (e) => { if (e.target.id === 'backups') closeBackups(); });
    $('#bk-src-devbox').addEventListener('click', () => { backupSource = 'devbox'; loadBackups(); });
    $('#bk-src-local').addEventListener('click', () => { backupSource = 'local'; loadBackups(); });
    $('#btn-tidy').addEventListener('click', tidyBoards);
    $('#btn-update').addEventListener('click', () => {
      if (updateUi.state === 'ready') api.installUpdate();
      else if (updateUi.state !== 'checking' && updateUi.state !== 'downloading') api.checkUpdate();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) { if (e.key === 'Escape') closeSettings(); return; }
      if (e.key === 'Escape') { closeSettings(); closeBackups(); Magic.closeGarden(); document.querySelectorAll('.spellbook-wrap').forEach((w) => w.remove()); }
      if (e.key === 't' || e.key === 'T') toggleTheme();
      if (e.key === 'm' || e.key === 'M') $('#btn-sound').click();
    });
    window.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

    if (info.launchedAtStartup) setTimeout(() => banner(pick(['A new day, adventurer.', 'The board awaits.', 'Rise and quest.']), rankName(levelInfo(totalXp()).level)), 600);
  }

  boot().catch((e) => { console.error(e); toast('Something broke on load: ' + e.message); });
})();
