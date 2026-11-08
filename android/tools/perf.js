// Frame-time profile of the phone board in headless Chromium, phone-sized and CPU-throttled.
// Run: node android/tools/perf.js [outDir] [--throttle 4]
// For each scenario (Tavern / Abyss, idle / scrolling, night) it reports rAF frame times and the
// busiest trace events on the main and compositor/raster threads, so the costly part is named.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..', '..');
const www = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
const outDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(process.env.TMPDIR || '/tmp', 'questboard-perf');
const ti = process.argv.indexOf('--throttle');
const THROTTLE = ti > 0 ? Number(process.argv[ti + 1]) : 4;
const ci = process.argv.indexOf('--css');
const EXTRA_CSS = ci > 0 ? fs.readFileSync(process.argv[ci + 1], 'utf8') : '';
const PORT = 18199;
fs.mkdirSync(outDir, { recursive: true });

const QUESTS = ['# Quests', '',
  ...['Experiment Echo', 'Money', 'Skills', 'Owed to others', 'Life [daily]', 'Meta'].flatMap((b, i) => [
    `## ${b}`, ...Array.from({ length: 6 }, (_, j) => `- [${j === 5 ? 'x' : ' '}] ${b} quest number ${j + 1} with a longer name`), '']),
].join('\n');

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(www, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
      if (!p.startsWith(www) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  // old quests rot (corruption 1-3), as on a real board that has been used for weeks
  const born = {};
  ['Experiment Echo', 'Money', 'Skills', 'Owed to others', 'Life', 'Meta'].forEach((b, i) => [1, 2, 3].forEach((j) => {
    born[`${b} quest number ${j} with a longer name`.toLowerCase()] = new Date(Date.now() - [9, 20, 40][j - 1] * 86400e3).toISOString();
  }));
  await ctx.addInitScript(([q, b]) => {
    if (!localStorage.getItem('qb.file.QUESTS.md')) localStorage.setItem('qb.file.QUESTS.md', q);
    if (!localStorage.getItem('qb.file.progress.json')) localStorage.setItem('qb.file.progress.json', JSON.stringify({ log: [], removed: [], born: b }));
    Date.prototype.getHours = function () { return 13; };
  }, [QUESTS, born]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForSelector('.board-wrap');
  if (EXTRA_CSS) await page.addStyleTag({ content: EXTRA_CSS });
  await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('DOM.getDocument', { depth: -1 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  async function measure(name, setup, action, ms = 4000) {
    await page.evaluate(setup || (() => {}));
    await page.waitForTimeout(800);
    const events = [];
    cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,cc,viz,blink', transferMode: 'ReportEvents' });
    const framesP = page.evaluate((dur) => new Promise((res) => {
      const out = []; let last = performance.now(); const end = last + dur;
      const f = (t) => { out.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(out); };
      requestAnimationFrame(f);
    }), ms);
    if (action) await action();
    const frames = await framesP;
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    cdp.removeAllListeners('Tracing.dataCollected');
    // busiest event names per thread (complete events only, self time approximated by total)
    const threads = {};
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name;
    const agg = {};
    for (const e of events) {
      if (e.ph !== 'X' || !e.dur) continue;
      const th = threads[`${e.pid}:${e.tid}`] || '?';
      if (!/CrRendererMain|Compositor|Raster|VizCompositor|CrGpuMain/.test(th)) continue;
      const k = `${th.replace(/\d+$/, '')} :: ${e.name}`;
      agg[k] = (agg[k] || 0) + e.dur / 1000;
    }
    const top = Object.entries(agg).filter(([k]) => !/ThreadControllerImpl::RunTask|RunTask|TaskGraphRunner|SequenceManager|Scheduler::|MessageLoop/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (process.argv.includes('--paints')) {
      const pa = {};
      for (const e of events) if ((e.name === 'Paint' || e.name === 'PaintImage' || e.name === 'RasterTask' || e.name === 'Layerize' || e.name === 'UpdateLayer') && e.args && e.args.data) {
        const d = e.args.data; const k = `${e.name} node=${d.nodeId || '-'} layer=${d.layerId || '-'} clip=${d.clip ? Math.round(Math.abs(d.clip[2] - d.clip[0])) + 'x' + Math.round(Math.abs(d.clip[5] - d.clip[1])) : '-'}`;
        pa[k] = pa[k] || { n: 0, ms: 0, node: d.nodeId }; pa[k].n++; pa[k].ms += (e.dur || 0) / 1000;
      }
      const tops = Object.entries(pa).sort((a, b) => b[1].ms - a[1].ms || b[1].n - a[1].n).slice(0, 6);
      for (const [k, v] of tops) {
        let desc = '';
        if (v.node) { try { const r = await cdp.send('DOM.describeNode', { backendNodeId: v.node }); desc = `${r.node.localName}#${(r.node.attributes || []).join(' ').slice(0, 80)}`; } catch { desc = '?'; } }
        console.log(`   paint: ${v.n}x ${v.ms.toFixed(0)}ms ${k} ${desc}`);
      }
    }
    const fps = (frames.length / (ms / 1000)).toFixed(0);
    const r = { name, fps: Number(fps), p50: +pct(frames, 0.5).toFixed(1), p95: +pct(frames, 0.95).toFixed(1), janky: frames.filter((d) => d > 25).length, top: top.map(([k, v]) => `${v.toFixed(0)}ms ${k}`) };
    console.log(`\n== ${name}: ${r.fps} fps, frame p50 ${r.p50} ms, p95 ${r.p95} ms, ${r.janky} frames > 25 ms`);
    r.top.forEach((t) => console.log('   ' + t));
    return r;
  }
  const scroll = async () => {
    for (let i = 0; i < 14; i++) { await page.mouse.move(195, 600); await page.mouse.wheel(0, i % 7 < 4 ? 260 : -260); await page.waitForTimeout(250); }
  };
  const results = [];
  results.push(await measure('tavern idle', () => { document.documentElement.removeAttribute('data-night'); }));
  results.push(await measure('tavern scroll', null, scroll));
  results.push(await measure('tavern night idle', () => { document.documentElement.setAttribute('data-night', ''); }));
  await page.evaluate(() => document.documentElement.removeAttribute('data-night'));
  await page.click('#btn-theme'); await page.waitForTimeout(7000);   // let the theme switch settle
  results.push(await measure('abyss idle', null));
  results.push(await measure('abyss scroll', null, scroll));
  fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify({ throttle: THROTTLE, results, errors }, null, 1));
  if (errors.length) console.log('page errors:', errors.join(' // ').slice(0, 300));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
