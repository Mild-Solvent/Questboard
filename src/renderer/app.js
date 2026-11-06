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
  function seeded(str, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function tornEdge(key) {
    const pts = [], steps = 14;
    const j = (i) => Math.round(seeded(key, 100 + i) * 7);
    for (let i = 0; i <= steps; i++) pts.push(`calc(${(i / steps * 100).toFixed(1)}% + 0px) ${j(i)}px`);
    for (let i = 1; i < steps; i++) pts.push(`calc(100% - ${j(50 + i)}px) ${(i / steps * 100).toFixed(1)}%`);
    for (let i = steps; i >= 0; i--) pts.push(`${(i / steps * 100).toFixed(1)}% calc(100% - ${j(100 + i)}px)`);
    for (let i = steps - 1; i > 0; i--) pts.push(`${j(150 + i)}px ${(i / steps * 100).toFixed(1)}%`);
    return `polygon(${pts.join(', ')})`;
  }

  function render() {
    const scroll = boards.scrollTop;
    boards.innerHTML = '';
    const ordered = [...doc.groups].sort((a, b) => (isFeatured(b) ? 1 : 0) - (isFeatured(a) ? 1 : 0));
    ordered.forEach((g, i) => {
      const wrap = tplGroup.content.firstElementChild.cloneNode(true);
      const el = $('.board', wrap);
      wrap.style.setProperty('--i', i);
      wrap.style.setProperty('--rot', `${seeded(g.title, 1) * 3 - 1.5}deg`);
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
      if (done.length) { $('.done-count', el).textContent = `(${done.length})`; done.forEach((q) => $('.done-list', el).appendChild(questEl(g, q))); }
      else dw.hidden = true;
      wireAdd(el, g);
      boards.appendChild(wrap);
    });
    boards.scrollTop = scroll;
    renderHero();
  }

  function questEl(g, q) {
    const li = tplQuest.content.firstElementChild.cloneNode(true);
    li.classList.toggle('done', q.done);
    $('.quest-text', li).innerHTML = inline(q.text);
    const rune = $('.rune', li);
    rune.addEventListener('click', (e) => { e.stopPropagation(); toggle(g, q, li, rune); });
    rune.addEventListener('mouseenter', () => Sound.hover());
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); removeQuest(g, q, li); });
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
    if (!q.done) {
      busy = true;
      q.done = true;
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
        li.classList.remove('completing'); li.classList.add('leaving');
        setTimeout(() => { busy = false; render(); }, 480);
      }, 750);
    } else {
      q.done = false;
      let idx = -1; progress.log.forEach((e, i) => { if (e.text === q.text) idx = i; });
      if (idx >= 0) { const e = progress.log.splice(idx, 1)[0]; progress.removed = (progress.removed || []).concat(`${e.text}@@${e.at}`); }
      FX.poof(cx, cy);
      Sound.undo();
      floatText(cx + 40, cy, `-${XP_PER_QUEST} XP`, true);
      changed();
      render();
    }
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

  async function runSync(reason) {
    if (!Sync.ready || syncing || busy) { if (busy) scheduleSync(1500); return; }
    syncing = true; setSyncStatus('busy');
    try {
      // --- quests ---
      const remote = await Sync.get('QUESTS.md');
      const localText = serialize(doc);
      const baseText = settings.base.questsText || '';
      let merged = localText;
      if (remote.text !== null && remote.text !== baseText) merged = window.Merge.merge(baseText, localText, remote.text);
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

  // ---------- boot ----------
  async function boot() {
    info = await api.appInfo();
    $('#version').textContent = `v${info.version}`;

    const readJson = async (name) => { try { const t = await api.readFile(name); return t ? JSON.parse(t) : null; } catch { return null; } };
    settings = Object.assign(defaultSettings(), (await readJson('settings.json')) || {});
    settings.sync = Object.assign({ baseUrl: '', token: '' }, settings.sync || {});
    settings.base = Object.assign(defaultSettings().base, settings.base || {});
    progress = Object.assign({ log: [], removed: [] }, (await readJson('progress.json')) || {});
    // migrate v0.2 state.json (xp counter + log + prefs)
    const legacy = await readJson('state.json');
    if (legacy && !(await api.readFile('progress.json'))) {
      progress.log = (legacy.log || []).map((e) => ({ ...e, device: e.device || info.device }));
      if (legacy.theme) settings.theme = legacy.theme;
      if (typeof legacy.sound === 'boolean') settings.sound = legacy.sound;
    }
    const questsText = await api.readFile('QUESTS.md');
    doc = parse(questsText || '# Quests\n\n## Active: Today\n- [ ] Add a quest\n');
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
    api.onUpdateStatus((u) => { if (u.state === 'ready') { $('#btn-update').hidden = false; toast(`Update v${u.version} downloaded. Restart when you like.`); } });
    if (info.updateReady) $('#btn-update').hidden = false;

    applyTheme(settings.theme || 'tavern');
    applySound();
    render();
    refreshAutostart();

    Sync.configure(settings.sync);
    setSyncStatus(Sync.ready ? 'ok' : 'off');
    if (Sync.ready) runSync('boot');
    setInterval(() => { if (Sync.ready) runSync('timer'); }, 90 * 1000);
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
    $('#btn-update').addEventListener('click', () => api.installUpdate());

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) { if (e.key === 'Escape') closeSettings(); return; }
      if (e.key === 'Escape') closeSettings();
      if (e.key === 't' || e.key === 'T') toggleTheme();
      if (e.key === 'm' || e.key === 'M') $('#btn-sound').click();
    });
    window.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

    if (info.launchedAtStartup) setTimeout(() => banner(pick(['A new day, adventurer.', 'The board awaits.', 'Rise and quest.']), rankName(levelInfo(totalXp()).level)), 600);
  }

  boot().catch((e) => { console.error(e); toast('Something broke on load: ' + e.message); });
})();
