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
  const totalXp = () => progress.log.length * XP_PER_QUEST;
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
    $('#xp-fill').style.width = `${Math.round((li.into / li.need) * 100)}%`;
    $('#xp-label').textContent = `${li.into} / ${li.need} XP`;
    const today = new Date().toDateString();
    $('#stat-today').textContent = progress.log.filter((e) => new Date(e.at).toDateString() === today).length;
    $('#stat-total').textContent = progress.log.length;
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
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
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
      wireAdd(el, g);
      boards.appendChild(wrap);
    });
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
    if (!free) { $$('.board-wrap', boards).forEach((w) => { w.style.left = w.style.top = w.style.width = ''; }); return; }
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
  FX.setMarkLayer((c) => {
    if (cutLayer.parentNode !== boards) boards.prepend(cutLayer);
    const r = boards.getBoundingClientRect();
    const x = c.x - r.left - boards.clientLeft + boards.scrollLeft;
    const y = c.y - r.top - boards.clientTop + boards.scrollTop;
    const cv = document.createElement('canvas');
    cv.className = 'cut-mark';
    const size = FX.paintCut(cv, c);
    cv.style.left = `${Math.round(x - size / 2)}px`;
    cv.style.top = `${Math.round(y - size / 2)}px`;
    // the layer clips to the current content so a gouge at the edge never adds scrollbars
    cutLayer.style.width = `${boards.scrollWidth}px`;
    cutLayer.style.height = `${boards.scrollHeight}px`;
    cutLayer.appendChild(cv);
    while (cutLayer.children.length > 80) cutLayer.firstChild.remove();
  });

  // Clicking bare wood (or open water) leaves a mark: a sword cut in Tavern, a splash in Abyss.
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t === boards || t === document.body || t.id === 'app' || t.classList.contains('canvas-spacer'))) return;
    Sound.unlock();
    if (settings.theme === 'abyss') { FX.splash(e.clientX, e.clientY); Sound.splash(); }
    else { FX.cut(e.clientX, e.clientY); Sound.cut(); }
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
      progress.log.push({ text: q.text, at: new Date().toISOString(), device: info.device });
      const after = levelInfo(totalXp()).level;
      li.classList.add('completing');
      FX.burst(cx, cy, { count: 90, power: 1.1 });
      FX.shake($('#app'));
      Sound.complete();
      floatText(cx + 40, cy, `+${XP_PER_QUEST} XP`);
      banner(pick(['Quest complete!', 'Done and dusted!', 'Slain!', 'Another one!', 'Cleared!', 'Victory!']), q.text);
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
      if (idx >= 0) { const e = progress.log.splice(idx, 1)[0]; progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`); }
      FX.poof(cx, cy);
      Sound.undo();
      floatText(cx + 40, cy, `-${XP_PER_QUEST} XP`, true);
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
    banner('Level up!', `${level} — ${rankName(level)}`, true);
    Sound.levelUp();
    FX.shake($('#app'), 600);
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    FX.burst(cx, cy, { count: 160, power: 2, long: true });
    setTimeout(() => FX.rain(140), 200);
    setTimeout(() => FX.burst(cx * 0.5, cy * 0.7, { count: 60, power: 1.2 }), 350);
    setTimeout(() => FX.burst(cx * 1.5, cy * 0.7, { count: 60, power: 1.2 }), 500);
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
      if (JSON.stringify(mergedDoc.log) !== JSON.stringify(progress.log)) { progress = mergedDoc; renderHero(); saveLocal(); }
      else progress = mergedDoc;
      if (!rp.text || JSON.stringify(mergedDoc.log) !== JSON.stringify(remoteDoc.log || []) || JSON.stringify(mergedDoc.removed) !== JSON.stringify(remoteDoc.removed || [])) {
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

  // ---------- theme / prefs ----------
  function applyTheme(name) {
    if (settings.theme !== name) cutLayer.innerHTML = '';
    settings.theme = name;
    document.documentElement.setAttribute('data-theme', name);
    FX.setTheme(name);
    renderHero();
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

    $('#btn-theme').addEventListener('click', toggleTheme);
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
      if (e.key === 'Escape') { closeSettings(); closeBackups(); }
      if (e.key === 't' || e.key === 'T') toggleTheme();
      if (e.key === 'm' || e.key === 'M') $('#btn-sound').click();
    });
    window.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

    if (info.launchedAtStartup) setTimeout(() => banner(pick(['A new day, adventurer.', 'The board awaits.', 'Rise and quest.']), rankName(levelInfo(totalXp()).level)), 600);
  }

  boot().catch((e) => { console.error(e); toast('Something broke on load: ' + e.message); });
})();
