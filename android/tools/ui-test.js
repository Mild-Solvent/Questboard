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

function staticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
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
    const marked = await page.$$eval('#boards .cut-layer .cut-mark', (els) => els.length);
    check('tap on wood leaves a cut mark', marked === 1, marked);
    check('wood scrolls with the quests', (await page.$eval('#boards', (e) => getComputedStyle(e).backgroundAttachment)).includes('local'));
    const moved = await page.$eval('#boards', async (b) => {
      const m = b.querySelector('.cut-mark');
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
    await page.click('.quest');
    await sleep(300);
    check('XP after one quest', (await page.textContent('#xp-label')) === '25 / 100 XP', await page.textContent('#xp-label'));
    await sleep(1500);
    check('completed quest left the open list', !(await page.$$eval('.quests:not(.done-list) .quest-text', (els) => els.map((e) => e.textContent))).includes(firstText));

    // settings: test + save → first sync merges local starter edits with remote board
    await page.click('#btn-settings');
    await page.waitForSelector('#sheet:not([hidden])');
    check('settings prefilled with devbox URL', (await page.inputValue('#set-url')).startsWith('https://devbox.'));
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
    await page.click('.board.daily .quest:has-text("Buy milk")');
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
    await page.click('.board.daily .quest:has-text("Buy milk")');
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
      await page.waitForSelector('.inline-edit', { timeout: 2000 });
    };
    await page.click('.board.daily .quest:has-text("Clean room")');
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
