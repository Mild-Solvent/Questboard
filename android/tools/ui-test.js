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
