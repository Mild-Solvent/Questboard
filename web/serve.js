#!/usr/bin/env node
// Tiny static server + token-adding proxy for the browser build. No dependencies.
//   node web/serve.js [--port 7072] [--host 127.0.0.1] [--dir web/out]
//                     [--upstream http://127.0.0.1:8787/questboard] [--token-file ~/questboard-data/token]
// Serves <dir> and forwards /api/<file> to <upstream>/<file> with "Authorization: Bearer <token>".
// Bind it to localhost or a tailnet address only: anyone who can open the page can edit the board.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const port = Number(opt('--port', process.env.QB_WEB_PORT || 7072));
const host = opt('--host', process.env.QB_WEB_HOST || '127.0.0.1');
const dir = path.resolve(opt('--dir', path.join(__dirname, 'out')));
const upstream = new URL(opt('--upstream', process.env.QB_UPSTREAM || 'http://127.0.0.1:8787/questboard'));
const tokenFile = opt('--token-file', process.env.QB_TOKEN_FILE || path.join(os.homedir(), 'questboard-data', 'token'));
const prefix = opt('--prefix', process.env.QB_WEB_PREFIX || '');   // e.g. "/questboard" when mounted under a path

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown' };
const ALLOWED = new Set(['QUESTS.md', 'progress.json', 'health']);
const token = () => fs.readFileSync(tokenFile, 'utf8').trim();

function proxy(req, res, file) {
  if (!ALLOWED.has(file) && !/^history\/(QUESTS\.md|progress\.json)(\/\d{8}T\d{12}Z\.(md|json))?$/.test(file)) { res.writeHead(404); return res.end('no such file'); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // Buffer the body and send Content-Length: the Python sync server does not read chunked bodies.
    const headers = { Authorization: `Bearer ${token()}`, 'Content-Length': body.length };
    for (const h of ['content-type', 'if-match']) if (req.headers[h]) headers[h] = req.headers[h];
    const up = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: req.method, path: `${upstream.pathname.replace(/\/$/, '')}/${file}`, headers }, (r) => {
      const out = { 'Cache-Control': 'no-store' };
      for (const h of ['content-type', 'etag']) if (r.headers[h]) out[h] = r.headers[h];
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`sync server unreachable: ${e.message}`); });
    up.end(body);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\/+/, '')) || 'index.html';
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep) && file !== path.join(dir, 'index.html')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length) || '/';
  if (p === '') p = '/';
  if (p.startsWith('/api/')) return proxy(req, res, p.slice(5));
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, p);
}).listen(port, host, () => console.log(`questboard web: http://${host}:${port}${prefix}/  (proxy -> ${upstream.href}, token from ${tokenFile})`));
