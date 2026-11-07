// End-to-end check of the Android web layer in headless Chromium at phone size, against the
// real sync server (sync-server/server.py). Run: node android/tools/ui-test.js [outDir]
// Needs: playwright + chromium (preinstalled on the devbox/cloud), python3.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..', '..');
const www = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
const outDir = process.argv[2] || path.join(process.env.TMPDIR || '/tmp', 'questboard-ui-test');
const dataDir = path.join(outDir, 'server-data');
fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(path.join(dataDir, 'QUESTS.md'), { force: true });
fs.rmSync(path.join(dataDir, 'progress.json'), { force: true });

const SYNC_PORT = 18787, WWW_PORT = 18099;
const SYNC_URL = `http://127.0.0.1:${SYNC_PORT}/questboard`;
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fake GitHub release feed for the in-app updater (0.6.0); off (404) until the updater test turns it on
const feed = { mode: 'off' };
const FAKE_APK = Buffer.alloc(300 * 1024, 7);

function staticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/__feed.json')) {
        if (feed.mode === 'off') { res.writeHead(404); return res.end('{}'); }
        const assets = [{ name: 'SHA256SUMS', browser_download_url: `http://127.0.0.1:${WWW_PORT}/__sums`, size: 10 }];
        if (feed.mode === 'apk') assets.push({ name: 'Questboard-9.9.9-android.apk', browser_download_url: `http://127.0.0.1:${WWW_PORT}/__fake.apk`, size: FAKE_APK.length });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ tag_name: 'v9.9.9', assets }));
      }
      if (req.url.startsWith('/__fake.apk')) { res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive' }); return res.end(FAKE_APK); }
      const p = path.join(www, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
      if (!p.startsWith(www) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(WWW_PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${SYNC_URL}/health`); if (r.ok) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}

(async () => {
  const py = spawn('python3', [path.join(root, 'sync-server', 'server.py')], { env: { ...process.env, QB_DATA_DIR: dataDir, QB_PORT: String(SYNC_PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
  const srv = await staticServer();
  let browser;
  try {
    check('sync server up', await waitHealth());
    const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
    // Pretend Claude already wrote the real board on the devbox.
    const remoteQuests = '# Quests\n\n## Active: Experiment Echo\n- [ ] Bugfix the demo\n- [ ] Make the trailer\n- Investor: Luke\n\n## Life\n- [ ] Clean room\n- [ ] Go outside\n';
    let r = await fetch(`${SYNC_URL}/QUESTS.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: remoteQuests });
    check('seed remote QUESTS.md', r.status === 201, `status ${r.status}`);

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // pin the clock to 13:xx so the night-owl / early-bird bonuses (0.6.0) don't change the expected XP
    await ctx.addInitScript(() => { Date.prototype.getHours = function () { return 13; }; });
    await ctx.addInitScript((u) => { try { const p = JSON.parse(localStorage.getItem('qb.prefs') || '{}'); if (!p.updateFeed) { p.updateFeed = u; localStorage.setItem('qb.prefs', JSON.stringify(p)); } } catch { /* ignore */ } }, `http://127.0.0.1:${WWW_PORT}/__feed.json`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${WWW_PORT}/index.html`);
    await page.waitForSelector('.board');
    await page.evaluate(() => window.__qbInsets(24, 16, 0, 0));
    await sleep(900);
    check('starter board renders', (await page.$$('.quest')).length >= 3);
    await page.screenshot({ path: path.join(outDir, 'phone-tavern-start.png') });

    // theme toggle
    await page.click('#btn-theme');
    await sleep(500);
    check('theme switches to abyss', (await page.getAttribute('html', 'data-theme')) === 'abyss');
    await page.screenshot({ path: path.join(outDir, 'phone-abyss-start.png') });
    await page.click('#btn-theme');

    // tapping bare wood leaves a sword cut, pinned inside #boards so it scrolls with the quests (0.4.5)
    const box = await page.$eval('#boards', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 6, y: r.bottom - 6 }; });
    await page.mouse.click(box.x, box.y);
    await sleep(200);
    const marked = await page.$eval('#boards .cut-layer .cut-bake', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
    check('tap on wood leaves a cut mark', marked > 20, marked);
    check('wood scrolls with the quests', (await page.$eval('#boards', (e) => getComputedStyle(e).backgroundAttachment)).includes('local'));
    const moved = await page.$eval('#boards', async (b) => {
      const m = b.querySelector('.cut-layer');
      const pad = document.createElement('div'); pad.style.height = '900px'; b.appendChild(pad);   // starter board is too short to scroll
      const before = m.getBoundingClientRect().top;
      const want = Math.min(120, b.scrollHeight - b.clientHeight);
      if (want <= 0) return 'no-scroll';
      b.scrollTop += want;
      await new Promise((r) => setTimeout(r, 100));
      const delta = before - m.getBoundingClientRect().top;
      b.scrollTop = 0; pad.remove();
      return Math.abs(delta - want) < 2 ? 'ok' : `moved ${delta} of ${want}`;
    });
    check('cut mark scrolls with the quests', moved === 'ok', moved);

    // complete a quest by tapping its row
    const firstText = await page.textContent('.quest .quest-text');
    // a tap on the quest text does nothing: only the rune completes (scroll safety, 0.5.1)
    await page.click('.quest .quest-text');
    await sleep(900);
    check('tap on quest text does not complete it', (await page.textContent('#xp-label')) === '0 / 100 XP' && (await page.locator('#ask:not([hidden])').count()) === 0, await page.textContent('#xp-label'));
    // the rune completes instantly
    await page.click('.quest .rune');
    await sleep(300);
    check('XP after one quest', (await page.textContent('#xp-label')) === '25 / 100 XP', await page.textContent('#xp-label'));
    await sleep(1500);
    check('completed quest left the open list', !(await page.$$eval('.quests:not(.done-list) .quest-text', (els) => els.map((e) => e.textContent))).includes(firstText));

    // settings: test + save → first sync merges local starter edits with remote board
    await page.click('#btn-settings');
    await page.waitForSelector('#sheet:not([hidden])');
    check('no sync address built in (fresh install)', (await page.inputValue('#set-url')) === '');
    await page.fill('#set-url', SYNC_URL);
    await page.fill('#set-token', 'wrong');
    await page.click('#set-test');
    await page.waitForFunction(() => /rejected|Connected/.test(document.querySelector('#set-status').textContent));
    check('wrong token is reported', /rejected/.test(await page.textContent('#set-status')));
    await page.fill('#set-token', token);
    await page.click('#set-test');
    await page.waitForFunction(() => /Connected/.test(document.querySelector('#set-status').textContent));
    check('test connection ok', /2 open|4 open|Connected/.test(await page.textContent('#set-status')), await page.textContent('#set-status'));
    await page.screenshot({ path: path.join(outDir, 'phone-settings.png') });
    await page.click('#set-save');
    await page.waitForFunction(() => /Synced/.test(document.querySelector('#set-status').textContent), null, { timeout: 10000 });
    await sleep(1200);
    const titles = await page.$$eval('.board-title', (els) => els.map((e) => e.textContent.trim()));
    check('remote board replaced starter after first sync', titles.some((t) => /Experiment Echo/.test(t)) && !titles.some((t) => /First steps/.test(t)), titles.join(' | '));
    const remoteProgress = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('progress pushed to server', remoteProgress.log && remoteProgress.log.length === 1, JSON.stringify(remoteProgress).slice(0, 120));

    // Claude edits the devbox file → phone picks it up on resume
    const g = await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } });
    const etag = g.headers.get('etag');
    const edited = (await g.text()).replace('## Life', '## Life\n- [ ] Buy milk');
    r = await fetch(`${SYNC_URL}/QUESTS.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-Match': etag }, body: edited });
    check('remote edit accepted', r.status === 200, `status ${r.status}`);
    await page.evaluate(() => { window.__qbResumeForce = true; });
    await page.evaluate(() => window.Sync.syncNow('test'));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.quest-text')).some((e) => e.textContent === 'Buy milk'), null, { timeout: 8000 });
    check('new remote quest shows on the phone', true);

    // conflict: local add + remote change at the same time → both survive
    await page.click('.board-wrap:not(.featured) .add-btn');
    await page.fill('.board-wrap:not(.featured) .add-input', 'Call grandma');
    await page.press('.board-wrap:not(.featured) .add-input', 'Enter');
    await page.waitForFunction(() => window.Sync.isDirty(), null, { timeout: 3000 });   // local save landed, push pending
    const g2 = await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } });
    const edited2 = (await g2.text()).replace('- [ ] Go outside', '- [x] Go outside');
    r = await fetch(`${SYNC_URL}/QUESTS.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-Match': g2.headers.get('etag') }, body: edited2 });
    check('second remote edit accepted', r.status === 200);
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const serverNow = await (await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } })).text();
    check('conflict merged: local add kept', serverNow.includes('- [ ] Call grandma'), serverNow.replace(/\n/g, '⏎').slice(0, 200));
    check('conflict merged: remote done kept', serverNow.includes('- [x] Go outside'));
    check('conflict merged: phone completion kept', serverNow.includes(`- [x] ${firstText}`) || !serverNow.includes(`- [ ] ${firstText}`), firstText);
    const phoneText = await page.evaluate(() => window.questboard.readFile('QUESTS.md'));
    check('phone copy equals server copy', phoneText === serverNow);

    // daily boards (desktop 0.4.6): "## Life [daily]" ticks live only in progress.json and stay on the board
    const g3 = await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } });
    const edited3 = (await g3.text()).replace('## Life\n', '## Life [daily]\n');
    r = await fetch(`${SYNC_URL}/QUESTS.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-Match': g3.headers.get('etag') }, body: edited3 });
    check('daily: remote rename accepted', r.status === 200, `status ${r.status}`);
    await page.evaluate(() => window.Sync.syncNow('test'));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.board.daily .board-count')).some((e) => /left today/.test(e.textContent)), null, { timeout: 8000 });
    const lifeTitle = await page.$eval('.board.daily .board-title', (e) => e.textContent.trim());
    check('daily: board title hides the [daily] tag', lifeTitle === 'Life', lifeTitle);
    const before = await page.$eval('.board.daily .board-count', (e) => e.textContent);
    await page.click('.board.daily .quest:has-text("Buy milk") .rune');
    await sleep(1600);
    const after = await page.$eval('.board.daily .board-count', (e) => e.textContent);
    const stays = await page.$$eval('.board.daily .quests:not(.done-list) .quest.done .quest-text', (els) => els.map((e) => e.textContent));
    check('daily: ticked quest stays on the board, ticked', stays.some((t) => t.startsWith('Buy milk')) && /resets in/.test(stays.join(' ')), stays.join(' | '));
    check('daily: count goes down', parseInt(after, 10) === parseInt(before, 10) - 1, `${before} -> ${after}`);
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const q3 = await (await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } })).text();
    const p3 = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('daily: QUESTS.md keeps it open', q3.includes('## Life [daily]') && q3.includes('- [ ] Buy milk') && !q3.includes('- [x] Buy milk'));
    check('daily: progress.json has the tick', p3.log.some((e) => e.text === 'Buy milk'));
    await page.click('.board.daily .quest:has-text("Buy milk") .rune');
    await sleep(600);
    const untick = await page.$$eval('.board.daily .quest.done .quest-text', (els) => els.map((e) => e.textContent));
    check('daily: untick clears it', !untick.some((t) => t.startsWith('Buy milk')), untick.join(' | '));
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const p4 = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('daily: untick removes the log entry on the server', !p4.log.some((e) => e.text === 'Buy milk'));
    await page.screenshot({ path: path.join(outDir, 'phone-daily.png') });

    // editing (0.4.7): hold a quest to rename it; its ticks follow it
    const hold = async (sel) => {
      const b = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }; });
      await page.mouse.move(b.x, b.y); await page.mouse.down(); await sleep(700); await page.mouse.up();
      await page.waitForSelector('#ask:not([hidden])', { timeout: 2000 });   // editing asks first
      await page.click('#ask-yes');
      await page.waitForSelector('.inline-edit', { timeout: 2000 });
    };
    await page.click('.board.daily .quest:has-text("Clean room") .rune');
    await sleep(1600);
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    await hold('.board.daily .quest:has-text("Clean room")');
    const stillTicked = await page.$$eval('.board.daily .quest.done .quest-text', (els) => els.length);
    await page.fill('.inline-edit', 'Tidy room');
    await page.press('.inline-edit', 'Enter');
    await sleep(400);
    const rows = await page.$$eval('.board.daily .quest', (els) => els.map((e) => e.className + '|' + e.querySelector('.quest-text').textContent));
    check('edit: hold opens the editor without ticking', stillTicked >= 1, String(stillTicked));
    check('edit: renamed quest keeps its daily tick', rows.some((r) => /\bdone\b/.test(r) && r.includes('|Tidy room')), rows.join(' ; '));
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const q5 = await (await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } })).text();
    const p5 = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('edit: server has the new quest name', q5.includes('- [ ] Tidy room') && !q5.includes('Clean room'));
    check('edit: progress log follows the rename', p5.log.some((e) => e.text === 'Tidy room') && !p5.log.some((e) => e.text === 'Clean room'));

    // hold a board title to rename it; a concurrent devbox edit must not undo the rename (merge titleFor)
    await hold('.board.daily .board-title');
    await page.fill('.inline-edit', 'Home');
    await page.press('.inline-edit', 'Enter');
    await page.waitForFunction(() => window.Sync.isDirty(), null, { timeout: 3000 });
    const g6 = await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } });
    const edited6 = (await g6.text()).replace('## Life [daily]\n', '## Life [daily]\n- [ ] Water plants\n');
    r = await fetch(`${SYNC_URL}/QUESTS.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-Match': g6.headers.get('etag') }, body: edited6 });
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const q6 = await (await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } })).text();
    check('edit: board rename survives a concurrent devbox edit', q6.includes('## Home [daily]') && !q6.includes('## Life') && /## Home \[daily\][^#]*Water plants/.test(q6), q6.replace(/\n/g, '⏎'));
    await page.screenshot({ path: path.join(outDir, 'phone-edit.png') });
    check('open quests grow the board (no inner scroll, 0.4.8)', await page.$eval('.board .quests:not(.done-list)', (e) => getComputedStyle(e).maxHeight === 'none'));

    // 0.5.0: secret entries carry their own xp and do not count as cleared quests; heat and tiers
    const g7 = await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } });
    const prog7 = JSON.parse(await g7.text());
    const nowIso = new Date().toISOString();
    prog7.log.push({ text: 'Secret: Dragon egg', at: nowIso, device: 'pc', xp: 100, secret: true });
    for (const t of ['Heat one', 'Heat two', 'Heat three']) prog7.log.push({ text: t, at: nowIso, device: 'pc' });
    r = await fetch(`${SYNC_URL}/progress.json`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-Match': g7.headers.get('etag') }, body: JSON.stringify(prog7, null, 2) });
    check('0.5.0: remote progress accepted', r.status === 200 || r.status === 201, `status ${r.status}`);
    await page.evaluate(() => window.Sync.syncNow('test'));
    await page.waitForFunction((n) => document.querySelector('#stat-total').textContent === String(n), prog7.log.filter((e) => !e.secret).length, { timeout: 8000 }).catch(() => {});
    const quests7 = prog7.log.filter((e) => !e.secret);
    const xp7 = prog7.log.reduce((n, e) => n + (e.secret ? 0 : Number(e.xp) || 25), 0);   // 0.6.1: old secret entries count 0 too
    let lvl = 1, rem = xp7; while (rem >= 100 + (lvl - 1) * 50) { rem -= 100 + (lvl - 1) * 50; lvl++; }
    const hero7 = await page.evaluate(() => ({ total: document.querySelector('#stat-total').textContent, today: document.querySelector('#stat-today').textContent, lbl: document.querySelector('#stat-today-lbl').textContent, heat: document.querySelector('#stat-today-box').dataset.heat, xp: document.querySelector('#xp-label').textContent, level: document.querySelector('#level-num').textContent, tier: document.querySelector('#tier-name').textContent }));
    check('0.5.0: cleared total skips secrets', hero7.total === String(quests7.length), JSON.stringify(hero7));
    check('0.6.1: XP sums each entry, the old +100 secret counts 0', hero7.level === String(lvl) && hero7.xp === `${rem} / ${100 + (lvl - 1) * 50} XP`, `want L${lvl} ${rem}`);
    const today7 = quests7.filter((e) => new Date(e.at).toDateString() === new Date().toDateString()).length;
    check('0.5.0: heat label on cleared today', hero7.today === String(today7) && (today7 < 3 || hero7.lbl !== 'cleared today'), `${hero7.today} ${hero7.lbl} heat=${hero7.heat}`);
    check('0.5.0: tier pill shown', /^(Bronze|Silver|Gold)$/.test(hero7.tier), hero7.tier);
    await page.screenshot({ path: path.join(outDir, 'phone-050.png') });

    // a tap on bare wood is baked into one canvas inside #boards
    const bakeHas = await page.$eval('#boards .cut-bake', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
    check('0.5.0: sword cut baked into the wall canvas', bakeHas);

    // remove asks; Cancel keeps it
    await page.click('.board.daily .quest:has-text("Buy milk") .del');
    await page.waitForSelector('#ask:not([hidden])', { timeout: 2000 });
    check('remove asks first', /Remove this quest/.test(await page.textContent('#ask-title')));
    await page.click('#ask-no');
    check('cancel keeps the quest', (await page.locator('.board.daily .quest:has-text("Buy milk")').count()) === 1);

    // XP reset (0.5.1): asks twice, sets resetAt, keeps the history, syncs
    const logBefore = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text()).log.length;
    await page.click('#btn-settings');
    await page.waitForSelector('#sheet:not([hidden])');
    await page.click('#set-reset-xp'); await page.waitForSelector('#ask:not([hidden])'); await page.click('#ask-yes');
    await sleep(150); await page.waitForSelector('#ask:not([hidden])'); await page.click('#ask-yes');
    await sleep(400);
    check('XP reset shows level 1, 0 XP', (await page.textContent('#xp-label')) === '0 / 100 XP' && (await page.textContent('#level-num')) === '1', await page.textContent('#xp-label'));
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const p8 = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('XP reset is a resetAt on the server, history kept', !!p8.resetAt && p8.log.length === logBefore, `${p8.resetAt} ${p8.log.length}/${logBefore}`);
    await page.click('#set-prompt');
    const copied = await page.evaluate(() => window.__qbCopied || '');
    check('copy setup prompt puts the agent prompt on the clipboard', /Questboard sync server/.test(copied), copied.slice(0, 60));
    await page.click('#set-close');
    await sleep(300);

    // 0.6.0: born dates sync, combo bonus after three quests within an hour, bonus entries don't count
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const p9a = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    check('0.6.0: born dates pushed for open quests', p9a.born && Object.keys(p9a.born).length >= 3, JSON.stringify(p9a.born || {}).slice(0, 80));
    const totalBefore = await page.textContent('#stat-total');
    await page.click('.board-wrap:not(.featured) .quest:has-text("Call grandma") .rune');
    await sleep(2500);
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const p9 = JSON.parse(await (await fetch(`${SYNC_URL}/progress.json`, { headers: { Authorization: `Bearer ${token}` } })).text());
    const combos = p9.log.filter((e) => e.bonus === 'combo');
    check('0.6.0: three quests within an hour give a +30 combo entry', combos.length === 1 && combos[0].xp === 30, JSON.stringify(combos));
    check('0.6.0: combo is not counted as a cleared quest', (await page.textContent('#stat-total')) === String(Number(totalBefore) + 1), `${totalBefore} -> ${await page.textContent('#stat-total')}`);
    // the Magic section in settings: spellbook lists the spells, wall cycles
    await page.click('#btn-settings');
    await page.waitForSelector('#sheet:not([hidden])');
    await page.click('#btn-spellbook');
    await page.waitForSelector('.spellbook-wrap .spell-list li');
    check('0.6.1: spellbook lists eleven spells', (await page.locator('.spellbook-wrap .spell-list li').count()) === 11, String(await page.locator('.spellbook-wrap .spell-list li').count()));
    await page.evaluate(() => window.__qbBack());
    check('0.6.0: back closes the spellbook', (await page.locator('.spellbook-wrap').count()) === 0);
    await page.click('#btn-wall');
    check('0.6.0: wall button cycles the texture', (await page.getAttribute('html', 'data-wall')) === 'weathered', await page.getAttribute('html', 'data-wall'));
    await page.click('#btn-wall'); await page.click('#btn-wall'); await page.click('#btn-wall'); await page.click('#btn-wall');
    await page.click('#set-close');
    await sleep(300);
    // a still hold on bare wall starts a cast; a drawn stroke on an unlearned spell fizzles instead of cutting/scrolling
    const wall = await page.$eval('#boards', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 6, y: r.bottom - 60 }; });
    await page.mouse.move(wall.x, wall.y); await page.mouse.down(); await sleep(500);
    const casting = await page.evaluate(() => document.documentElement.classList.contains('casting'));
    for (let i = 1; i <= 8; i++) await page.mouse.move(wall.x + i * 6, wall.y - i * 20);
    await page.mouse.up();
    await sleep(300);
    check('0.6.0: hold still on the wall starts casting', casting);
    check('0.6.0: cast leaves casting mode', !(await page.evaluate(() => document.documentElement.classList.contains('casting'))));

    // offline (Father's phone, 0.5.1): sync fails with a long error, the layout must not get wider than
    // the screen, and quests added meanwhile are pushed once the server is reachable again
    await page.evaluate((t) => window.Sync.configure({ baseUrl: 'http://127.0.0.1:9/questboard', token: t, device: 'phone' }), token);
    await page.click('.board-wrap.featured .add-btn');
    await page.fill('.board-wrap.featured .add-input', 'Added while offline');
    await page.press('.board-wrap.featured .add-input', 'Enter');
    await page.evaluate(() => window.Sync.syncNow('test').catch(() => {}));
    await sleep(1500);
    await page.evaluate(() => { document.querySelector('#footer-hint').textContent = 'Sync error: GET QUESTS.md → SSLHandshakeException: connection closed by peer while reading the server hello, please try again later'; });
    await sleep(200);
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, boards: Math.round(document.querySelector('#boards').getBoundingClientRect().right), hero: Math.round(document.querySelector('#hero').getBoundingClientRect().right) }));
    check('long sync error does not widen the layout', widths.doc <= widths.win && widths.boards <= widths.win && widths.hero <= widths.win, JSON.stringify(widths));
    await page.screenshot({ path: path.join(outDir, 'phone-offline.png') });
    await page.evaluate(([u, t]) => window.Sync.configure({ baseUrl: u, token: t, device: 'phone' }), [SYNC_URL, token]);
    await page.evaluate(() => window.Sync.syncNow('test'));
    await page.waitForFunction(() => window.Sync.getStatus().state === 'ok' && !window.Sync.isDirty(), null, { timeout: 12000 });
    const qOff = await (await fetch(`${SYNC_URL}/QUESTS.md`, { headers: { Authorization: `Bearer ${token}` } })).text();
    check('quest added offline is pushed when sync is back', qOff.includes('- [ ] Added while offline'));

    // 0.6.1: secrets give no XP and do something silly; shapes are recognised from finger-sized strokes
    if (!(await page.$eval('#sheet', (e) => e.hidden))) await page.click('#set-close');
    const xpBeforeSecret = await page.textContent('#xp-label');
    await page.evaluate(() => window.__forceSecret('coin'));
    await page.waitForSelector('.secret');
    await page.$eval('.secret', (e) => e.click());
    await sleep(800);
    check('0.6.1: finding a secret gives no XP', (await page.textContent('#xp-label')) === xpBeforeSecret, `${xpBeforeSecret} -> ${await page.textContent('#xp-label')}`);
    check('0.6.1: a coin secret rains coins', (await page.locator('#fun-layer .fun-fall').count()) > 10);
    await page.evaluate(() => window.__forceSecret('potion'));
    await page.$eval('.secret', (e) => e.click());
    await sleep(300);
    check('0.6.1: a potion changes the room', await page.evaluate(() => /fx-(tiny|wobble|rainbow|mirror|giant)/.test(document.documentElement.className)));
    const pw = await page.evaluate(() => document.documentElement.scrollWidth);
    check('0.6.1: potion does not widen the phone page', pw <= 390, String(pw));
    await page.evaluate(() => document.documentElement.classList.remove('fx-tiny', 'fx-wobble', 'fx-rainbow', 'fx-mirror', 'fx-giant'));
    const shapes = await page.evaluate(() => {
      const poly = (pts, n = 24) => { const out = []; for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < n; j++) { const t = j / n; out.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }); } out.push(pts[pts.length - 1]); return out; };
      const c = { x: 195, y: 400 }, r = 90;
      const circle = []; for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; circle.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
      const tri = poly([{ x: 195, y: 310 }, { x: 290, y: 470 }, { x: 100, y: 470 }, { x: 195, y: 310 }]);
      const sq = poly([{ x: 110, y: 320 }, { x: 280, y: 320 }, { x: 280, y: 490 }, { x: 110, y: 490 }, { x: 110, y: 320 }]);
      const star = []; for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5; star.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
      return { circle: Magic.recognize(circle), triangle: Magic.recognize(tri), square: Magic.recognize(sq), star: Magic.recognize(poly(star)) };
    });
    check('0.6.1: recogniser knows circle, triangle, square and star at phone size', shapes.circle === 'circle' && shapes.triangle === 'triangle' && shapes.square === 'square' && shapes.star === 'star', JSON.stringify(shapes));
    await page.click('#btn-theme'); await sleep(700);
    check('0.6.1: Abyss has the sea behind the boards', await page.evaluate(() => { const s = document.getElementById('sea'); return !!s && getComputedStyle(s).display !== 'none' && s.querySelectorAll('.fish').length > 0; }));
    await page.screenshot({ path: path.join(outDir, 'phone-abyss-sea.png') });
    await page.click('#btn-theme'); await sleep(500);

    // 0.6.0 in-app updater: settings checks the release feed, the APK downloads inside the app,
    // a pill offers Install, and Install asks first, then hands the file to Android
    if (!(await page.$eval('#sheet', (e) => e.hidden))) await page.click('#set-close');
    check('updater: no pill while there is no update', await page.$eval('#update-pill', (e) => e.hidden));
    feed.mode = 'noapk';
    await page.click('#btn-settings'); await page.waitForSelector('#sheet:not([hidden])');
    await page.click('#set-releases');
    await page.waitForFunction(() => /newest version/.test((document.querySelector('.toast') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('updater: a release without an Android APK is not offered', /newest version/.test(await page.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')) && await page.$eval('#update-pill', (e) => e.hidden));
    feed.mode = 'apk';
    await page.click('#set-releases');
    await page.waitForFunction(() => { const p = document.querySelector('#update-pill'); return p && !p.hidden && p.classList.contains('ready'); }, null, { timeout: 8000 });
    check('updater: the APK downloads inside the app', (await page.evaluate(() => window.__qbUpdateBytes)) === FAKE_APK.length, String(await page.evaluate(() => window.__qbUpdateBytes)));
    check('updater: pill says the update is ready', /Update v9\.9\.9 ready/.test(await page.textContent('#update-pill')), await page.textContent('#update-pill'));
    check('updater: settings button turns into Install', (await page.textContent('#set-releases')) === 'Install v9.9.9', await page.textContent('#set-releases'));
    await page.click('#set-close'); await sleep(400);
    const pillBox = await page.$eval('#update-pill', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
    check('updater: pill fits on the phone screen', pillBox.l >= 0 && pillBox.r <= pillBox.w, JSON.stringify(pillBox));
    await page.screenshot({ path: path.join(outDir, 'phone-update-ready.png') });
    await page.click('#update-pill');
    await page.waitForSelector('#ask:not([hidden])');
    check('updater: Install asks first', /Install v9\.9\.9\?/.test(await page.textContent('#ask-title')));
    await page.click('#ask-no'); await sleep(200);
    check('updater: Cancel installs nothing', !(await page.evaluate(() => window.__qbInstalled || 0)));
    await page.click('#update-pill');
    await page.waitForSelector('#ask:not([hidden])');
    await page.click('#ask-yes'); await sleep(300);
    check('updater: Yes hands it to the installer', (await page.evaluate(() => window.__qbInstalled || 0)) === 1 && /Installing/.test(await page.textContent('#update-pill')), await page.textContent('#update-pill'));
    await page.evaluate(() => window.__qbUpdate(JSON.stringify({ state: 'cancelled' })));
    await sleep(200);
    check('updater: cancelling Android\'s confirm keeps the download for later', /ready/.test(await page.textContent('#update-pill')));
    await page.evaluate(() => window.__qbUpdate(JSON.stringify({ state: 'installed' })));
    await sleep(200);
    feed.mode = 'off';

    // back button closes the sheet
    await page.click('#btn-settings');
    await page.waitForSelector('#sheet:not([hidden])');
    const handled = await page.evaluate(() => window.__qbBack());
    check('back closes settings', handled === true && (await page.$eval('#sheet', (e) => e.hidden)));
    await sleep(400);
    await page.screenshot({ path: path.join(outDir, 'phone-tavern-synced.png') });
    await page.click('#btn-theme'); await sleep(500);
    await page.screenshot({ path: path.join(outDir, 'phone-abyss-synced.png') });

    check('no page errors', errors.length === 0, errors.join(' // ').slice(0, 300));
  } catch (e) {
    check('test run', false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    srv.close();
    py.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${outDir}`);
  process.exit(failed.length ? 1 : 0);
})();
