// Visual effects: ambient particles, cursor trail, bursts, shockwaves.
(function () {
  const ambient = document.getElementById('ambient');
  const marks = document.getElementById('marks');
  const fx = document.getElementById('fx');
  const actx = ambient.getContext('2d');
  const mctxMain = marks.getContext('2d');
  const fctx = fx.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let theme = 'tavern';
  const palette = {
    tavern: { trail: ['#ffb347', '#ffd36b', '#ff6a2b', '#fff1c2'], burst: ['#ffd36b', '#ffb347', '#ff6a2b', '#ffffff', '#ffe9a8'], ambient: ['#ff8a2b', '#ffb347', '#ffd36b'] },
    abyss:  { trail: ['#3cf0ff', '#8df8ff', '#b36bff', '#ffffff'], burst: ['#3cf0ff', '#b36bff', '#ffffff', '#7df9d6', '#c8f9ff'], ambient: ['#3cf0ff', '#7fd7ff', '#b36bff'] },
  };

  function resize() {
    dpr = 1; // effects stay at 1x: crisp enough, and a quarter of the memory of 2x backing stores
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [ambient, marks, fx]) {
      c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr);
    }
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctxMain.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawMarks();
  }

  // ---------- cut marks (session only: cleared on restart or theme switch) ----------
  const cuts = [];
  // A sword gouge in the planks: a tapered V-cut with a lit lip and a shadowed lip,
  // a dark bottom, wood fibres torn up along the edges and a hairline where the tip skidded.
  function drawCut(c, ctx) {
    const mctx = ctx || mctxMain;
    const n = 26, L = c.len, half = L / 2;
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = -half + t * L;
      const yc = -c.bow * 4 * t * (1 - t);                       // slight curve of the swing
      const w = c.w * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.75) * (t > 0.87 ? (1 - t) / 0.13 : 1);
      const j = c.jit[i];
      top.push([x, yc - w * (0.55 + j * 0.25)]);
      bot.push([x, yc + w * (0.45 + j * 0.2)]);
    }
    const poly = (a, b) => { mctx.beginPath(); mctx.moveTo(a[0][0], a[0][1]); for (const p of a) mctx.lineTo(p[0], p[1]); for (let i = b.length - 1; i >= 0; i--) mctx.lineTo(b[i][0], b[i][1]); mctx.closePath(); };
    const mid = top.map((p, i) => [p[0], (p[1] + bot[i][1]) / 2 + 0.4]);
    mctx.save();
    mctx.translate(c.x, c.y); if (c.flip) mctx.scale(-1, 1); mctx.rotate(c.a);   // mirror keeps the light from above
    // dent around the cut (soft shadow)
    mctx.shadowColor = 'rgba(20, 8, 2, .45)'; mctx.shadowBlur = 3; mctx.shadowOffsetY = 1;
    // shadowed upper wall of the V
    mctx.fillStyle = '#2a1206'; poly(top, mid); mctx.fill();
    mctx.shadowColor = 'transparent';
    // lit lower wall: fresh, pale raw wood
    const g = mctx.createLinearGradient(0, -c.w, 0, c.w);
    g.addColorStop(0, '#8a4c22'); g.addColorStop(0.5, '#e7b47a'); g.addColorStop(1, '#f6d4a0');
    mctx.fillStyle = g; poly(mid, bot); mctx.fill();
    // the dark bottom line of the V
    mctx.strokeStyle = 'rgba(18, 7, 2, .95)'; mctx.lineWidth = 1.1; mctx.lineJoin = 'round';
    mctx.beginPath(); mid.forEach((p, i) => (i ? mctx.lineTo(p[0], p[1]) : mctx.moveTo(p[0], p[1]))); mctx.stroke();
    // crisp outline of the lips
    mctx.strokeStyle = 'rgba(40, 16, 4, .8)'; mctx.lineWidth = 0.8;
    mctx.beginPath(); top.forEach((p, i) => (i ? mctx.lineTo(p[0], p[1]) : mctx.moveTo(p[0], p[1]))); mctx.stroke();
    mctx.strokeStyle = 'rgba(255, 226, 180, .55)'; mctx.lineWidth = 0.9;
    mctx.beginPath(); bot.forEach((p, i) => (i ? mctx.lineTo(p[0], p[1] + 0.6) : mctx.moveTo(p[0], p[1] + 0.6))); mctx.stroke();
    // torn fibres curling up from the edges, pointing along the swing
    for (const f of c.fibres) {
      const e = (f.side < 0 ? top : bot)[f.i];
      mctx.strokeStyle = f.side < 0 ? 'rgba(60, 26, 8, .85)' : 'rgba(240, 198, 140, .9)';
      mctx.lineWidth = f.th;
      mctx.beginPath(); mctx.moveTo(e[0], e[1]);
      mctx.quadraticCurveTo(e[0] + f.len * 0.6, e[1] + f.side * f.lift * 0.3, e[0] + f.len, e[1] + f.side * f.lift);
      mctx.stroke();
    }
    // hairline skid past the tip, and a faint parallel scratch from the blade's edge
    mctx.strokeStyle = 'rgba(30, 12, 3, .55)'; mctx.lineWidth = 0.7;
    mctx.beginPath(); mctx.moveTo(half - 2, 0); mctx.lineTo(half + c.skid, c.skidDy); mctx.stroke();
    mctx.strokeStyle = 'rgba(30, 12, 3, .28)'; mctx.lineWidth = 0.6;
    mctx.beginPath(); mctx.moveTo(-half * 0.6, c.w + 3); mctx.quadraticCurveTo(0, c.w + 3 - c.bow * 0.6, half * 0.5, c.w + 2.5); mctx.stroke();
    mctx.restore();
  }
  function redrawMarks() { mctxMain.clearRect(0, 0, W, H); if (theme === 'tavern') cuts.forEach((c) => drawCut(c)); }
  function cut(x, y) {
    if (theme !== 'tavern') return splash(x, y);
    const c = {
      x, y, a: -(Math.PI / 4) + rnd(-0.45, 0.45), flip: Math.random() < 0.5,   // flip: mirrored, leaning the other way
      len: rnd(70, 140), bow: rnd(-3, 3), w: rnd(3.4, 5.4),
      jit: Array.from({ length: 27 }, () => rnd(-1, 1)),
      fibres: Array.from({ length: 5 + (Math.random() * 6 | 0) }, () => ({ i: 3 + (Math.random() * 20 | 0), side: Math.random() < 0.5 ? -1 : 1, len: rnd(3, 9), lift: rnd(1, 3.5), th: rnd(0.6, 1.2) })),
      skid: rnd(4, 14), skidDy: rnd(-1.5, 1.5),
    };
    // wood chips fly off the cut
    for (let i = 0; i < 8; i++) {
      const ang = c.a + Math.PI / 2 + rnd(-0.8, 0.8) * (Math.random() < 0.5 ? 1 : -1), sp = rnd(1.5, 4);
      parts.push({ x: x + rnd(-10, 10), y: y + rnd(-6, 6), vx: Math.cos(ang) * sp * (c.flip ? -1 : 1), vy: Math.sin(ang) * sp - 2, life: 0, max: rnd(400, 800), size: rnd(1.2, 2.4), c: pick(['#e7b47a', '#c8874a', '#f6d4a0']), kind: 'dot', g: 0.22 });
    }
    if (markHook) markHook(c);                       // the app pins the gouge into the scrolling board
    else { cuts.push(c); if (cuts.length > 400) cuts.shift(); drawCut(c); }
    // sparks along the blade
    for (let i = 0; i < 8; i++) {
      const t = rnd(-c.len / 2, c.len / 2), ang = c.a + rnd(-0.6, 0.6) + (Math.random() < 0.5 ? Math.PI : 0), sp = rnd(2, 6);
      parts.push({ x: x + Math.cos(c.a) * t, y: y + Math.sin(c.a) * t, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1, life: 0, max: rnd(250, 550), size: rnd(1.5, 3), c: pick(['#fff6d5', '#ffd36b', '#ffb347']), kind: 'dot', g: 0.18 });
    }
    rings.push({ x, y, r: 2, max: 40, life: 0, c: '#ffe9a8' });
  }
  function splash(x, y) {
    const cols = palette.abyss;
    rings.push({ x, y, r: 3, max: 70, life: 0, c: cols.burst[0] });
    rings.push({ x, y, r: 2, max: 110, life: -140, c: '#ffffff' });
    for (let i = 0; i < 22; i++) {
      const ang = rnd(-Math.PI * 0.9, -Math.PI * 0.1), sp = rnd(0.8, 3.2);
      parts.push({ x: x + rnd(-6, 6), y, vx: Math.cos(ang) * sp * 0.6, vy: Math.sin(ang) * sp, life: 0, max: rnd(900, 2200), size: rnd(2, 6), c: pick(cols.trail), kind: 'bubble', g: -0.03, wob: rnd(0, 6) });
    }
    for (let i = 0; i < 10; i++) {
      const ang = rnd(0, Math.PI * 2), sp = rnd(1, 4);
      parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1.5, life: 0, max: rnd(300, 600), size: rnd(1.5, 3), c: '#dffbff', kind: 'dot', g: 0.08 });
    }
  }
  window.addEventListener('resize', resize);
  resize();

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // ---------- ambient (embers / bubbles) ----------
  const amb = [];
  function spawnAmbient() {
    const n = theme === 'abyss' ? 28 : 30;
    amb.length = 0;
    for (let i = 0; i < n; i++) amb.push(newAmbient(true));
  }
  function newAmbient(anywhere) {
    const isAbyss = theme === 'abyss';
    return {
      x: rnd(0, W),
      y: anywhere ? rnd(0, H) : H + 10,
      r: isAbyss ? rnd(1.5, 6) : rnd(1, 2.6),
      vx: rnd(-0.15, 0.15),
      vy: isAbyss ? -rnd(0.12, 0.42) : -rnd(0.15, 0.6),
      a: rnd(0.15, 0.6),
      c: pick(palette[theme].ambient),
      wob: rnd(0, Math.PI * 2),
    };
  }
  function drawAmbient(t, k = 1) {
    actx.clearRect(0, 0, W, H);
    const isAbyss = theme === 'abyss';
    for (let i = 0; i < amb.length; i++) {
      const p = amb[i];
      p.wob += 0.02 * k;
      p.x += (p.vx + Math.sin(p.wob) * (isAbyss ? 0.3 : 0.25)) * k;
      p.y += p.vy * k;
      if (p.y < -12 || p.x < -12 || p.x > W + 12) amb[i] = newAmbient(false);
      const flicker = isAbyss ? 1 : 0.7 + 0.3 * Math.sin(t / 150 + p.wob * 3);
      actx.globalAlpha = p.a * flicker;
      if (isAbyss) {
        actx.strokeStyle = p.c; actx.lineWidth = 1;
        actx.beginPath(); actx.arc(p.x, p.y, p.r, 0, Math.PI * 2); actx.stroke();
        actx.fillStyle = '#fff'; actx.globalAlpha = p.a * 0.5;
        actx.beginPath(); actx.arc(p.x - p.r * 0.35, p.y - p.r * 0.35, Math.max(0.5, p.r * 0.25), 0, Math.PI * 2); actx.fill();
      } else {
        actx.fillStyle = p.c;
        actx.shadowColor = p.c; actx.shadowBlur = 8;
        actx.beginPath(); actx.arc(p.x, p.y, p.r, 0, Math.PI * 2); actx.fill();
        actx.shadowBlur = 0;
      }
    }
    actx.globalAlpha = 1;
  }

  // ---------- trail + bursts ----------
  const parts = [];   // {x,y,vx,vy,life,max,size,c,kind,g,rot,vr}
  const rings = [];   // {x,y,r,max,life,c}
  let mouse = { x: -100, y: -100, px: -100, py: -100 };
  let trailMode = 'normal';
  const EMBER = ['#ffb347', '#ff6a2b', '#ffd36b', '#fff1c2', '#ff3b1f'];
  let lastTrail = 0;

  window.addEventListener('mousemove', (e) => {
    mouse.px = mouse.x; mouse.py = mouse.y;
    mouse.x = e.clientX; mouse.y = e.clientY;
    const now = performance.now();
    const speed = Math.hypot(mouse.x - mouse.px, mouse.y - mouse.py);
    if (now - lastTrail > 12) {
      lastTrail = now;
      const ember = trailMode === 'ember' && theme === 'tavern';
      const n = Math.min(ember ? 7 : 4, (ember ? 2 : 1) + (speed / 12) | 0);
      for (let i = 0; i < n; i++) {
        parts.push({
          x: mouse.x + rnd(-2, 2), y: mouse.y + rnd(-2, 2),
          vx: rnd(-0.4, 0.4) - (mouse.x - mouse.px) * 0.03,
          vy: rnd(-0.4, 0.4) - (mouse.y - mouse.py) * 0.03 + (theme === 'abyss' ? -0.3 : ember ? -0.9 : -0.15),
          life: 0, max: rnd(350, ember ? 900 : 700),
          size: rnd(1.5, theme === 'abyss' ? 4.5 : ember ? 4.6 : 3.2),
          c: pick(ember ? EMBER : palette[theme].trail), kind: 'trail', g: ember ? -0.02 : 0,
        });
      }
    }
  });

  function burst(x, y, opts = {}) {
    const n = opts.count || 70;
    const power = opts.power || 1;
    const cols = opts.colors || palette[theme].burst;
    for (let i = 0; i < n; i++) {
      const ang = rnd(0, Math.PI * 2);
      const sp = rnd(1.5, 7.5) * power;
      const kind = Math.random() < 0.35 ? 'shard' : (Math.random() < 0.5 ? 'coin' : 'dot');
      parts.push({
        x, y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 2 * power,
        life: 0, max: rnd(700, 1400) * (opts.long ? 1.6 : 1),
        size: rnd(2, 6) * (kind === 'coin' ? 1.3 : 1),
        c: pick(cols), kind,
        g: theme === 'abyss' ? -0.04 : 0.14,
        rot: rnd(0, Math.PI * 2), vr: rnd(-0.25, 0.25),
      });
    }
    rings.push({ x, y, r: 4, max: 90 * power, life: 0, c: cols[0] });
    if (power > 1.4) rings.push({ x, y, r: 2, max: 200 * power, life: -120, c: '#ffffff' });
  }

  function poof(x, y) {
    for (let i = 0; i < 16; i++) {
      const ang = rnd(0, Math.PI * 2), sp = rnd(0.5, 2.5);
      parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: rnd(300, 600), size: rnd(2, 5), c: '#9a9a9a', kind: 'dot', g: 0 });
    }
  }

  function rain(count, colors) {
    // confetti from the top edge, used on level-up
    for (let i = 0; i < count; i++) {
      parts.push({
        x: rnd(0, W), y: rnd(-40, -5),
        vx: rnd(-1, 1), vy: rnd(1, 4),
        life: 0, max: rnd(1800, 3200),
        size: rnd(3, 7), c: pick(colors || palette[theme].burst), kind: 'shard',
        g: 0.05, rot: rnd(0, Math.PI * 2), vr: rnd(-0.2, 0.2),
      });
    }
  }

  let last = performance.now();
  let running = true;
  document.addEventListener('visibilitychange', () => {
    const vis = !document.hidden;
    if (vis && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    else if (!vis) running = false;
  });
  function frame(t) {
    if (!running) return;
    const dt = Math.min(48, t - last); last = t;
    const k = dt / 16.67;
    drawAmbient(t, k);

    fctx.clearRect(0, 0, W, H);
    fctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      const u = p.life / p.max;
      p.vy += (p.g || 0) * k;
      if (p.kind !== 'trail' && !p.keep) { const f = p.kind === 'streak' ? 0.94 : 0.985; p.vx *= Math.pow(f, k); p.vy *= Math.pow(f, k); }
      p.x += p.vx * k; p.y += p.vy * k;
      if (p.rot !== undefined) p.rot += p.vr * k;
      const alpha = p.kind === 'trail' ? (1 - u) * 0.9 : (u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3);
      fctx.globalAlpha = Math.max(0, alpha);
      fctx.fillStyle = p.c;
      fctx.shadowColor = p.c; fctx.shadowBlur = p.kind === 'trail' ? 0 : 6;
      if (p.kind === 'star') {
        const s = p.size * (u < 0.3 ? u / 0.3 : 1 - (u - 0.3) / 0.7);
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot || 0);
        fctx.beginPath();
        for (let j = 0; j < 8; j++) { const rr = j % 2 ? s * 0.22 : s; const aa = (j * Math.PI) / 4; fctx.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr); }
        fctx.closePath(); fctx.fill(); fctx.restore();
      } else if (p.kind === 'streak') {
        fctx.strokeStyle = p.c; fctx.lineWidth = p.size * (1 - u);
        const tl = p.keep ? 1.4 : 6;
        fctx.beginPath(); fctx.moveTo(p.x, p.y); fctx.lineTo(p.x - p.vx * tl, p.y - p.vy * tl); fctx.stroke();
      } else if (p.kind === 'shard') {
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot);
        fctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        fctx.restore();
      } else if (p.kind === 'bubble') {
        p.wob = (p.wob || 0) + 0.08; p.x += Math.sin(p.wob) * 0.4;
        fctx.strokeStyle = p.c; fctx.lineWidth = 1;
        fctx.beginPath(); fctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); fctx.stroke();
        fctx.beginPath(); fctx.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, Math.max(0.4, p.size * 0.22), 0, Math.PI * 2); fctx.fill();
      } else if (p.kind === 'coin') {
        const sx = Math.abs(Math.cos(p.rot));
        fctx.beginPath(); fctx.ellipse(p.x, p.y, p.size * 0.6 * Math.max(0.15, sx), p.size * 0.6, 0, 0, Math.PI * 2); fctx.fill();
      } else {
        const s = p.kind === 'trail' ? p.size * (1 - u * 0.6) : p.size * 0.5;
        fctx.beginPath(); fctx.arc(p.x, p.y, Math.max(0.3, s), 0, Math.PI * 2); fctx.fill();
      }
    }
    fctx.shadowBlur = 0;
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life += dt;
      if (r.life < 0) continue;
      const u = r.life / (r.dur || 520);
      if (u >= 1) { rings.splice(i, 1); continue; }
      fctx.globalAlpha = (1 - u) * 0.8;
      fctx.strokeStyle = r.c; fctx.lineWidth = (r.w || 3) * (1 - u) + 0.5;
      fctx.beginPath(); fctx.arc(r.x, r.y, r.r + (r.max - r.r) * Math.sqrt(u), 0, Math.PI * 2); fctx.stroke();
    }
    fctx.globalAlpha = 1;
    fctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- the Abyss sea floor: kelp, corals and fish, behind everything ----------
  let sea = null;
  function buildSea() {
    if (sea) return;
    sea = document.createElement('div');
    sea.id = 'sea'; sea.setAttribute('aria-hidden', 'true');
    const W0 = 1600, H0 = 420;
    const kelp = [];
    for (let i = 0; i < 26; i++) {
      const x = rnd(0, W0), hgt = rnd(150, 400), wv = rnd(14, 34), seg = 5;
      let d = `M${x.toFixed(0)} ${H0}`;
      for (let k = 1; k <= seg; k++) { const y = H0 - (hgt * k) / seg; const cx = x + (k % 2 ? wv : -wv); d += ` Q${cx.toFixed(0)} ${(y + hgt / seg / 2).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)}`; }
      const g = ['#1f6b4a', '#2e7d4f', '#3f8f3a', '#1b5e52', '#4a8a2c'][(Math.random() * 5) | 0];
      kelp.push(`<path class="kelp" d="${d}" stroke="${g}" stroke-width="${rnd(7, 15).toFixed(1)}" style="transform-origin:${x.toFixed(0)}px ${H0}px;animation-duration:${rnd(5, 10).toFixed(1)}s;animation-delay:-${rnd(0, 8).toFixed(1)}s"/>`);
    }
    const corals = [];
    const CC = ['#ff6f91', '#ff9f5a', '#c77dff', '#ffd36b', '#ff5e7e', '#7ee8d3'];
    for (let i = 0; i < 16; i++) {
      const x = rnd(20, W0 - 20), base = H0 - rnd(4, 22), c = CC[(Math.random() * CC.length) | 0], kind = (Math.random() * 3) | 0;
      if (kind === 0) {           // branching coral
        let br = ''; const grow = (x0, y0, a, len, depth) => { const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len; br += `M${x0.toFixed(0)} ${y0.toFixed(0)} L${x1.toFixed(0)} ${y1.toFixed(0)} `; if (depth > 0) { grow(x1, y1, a - rnd(0.3, 0.6), len * 0.72, depth - 1); grow(x1, y1, a + rnd(0.3, 0.6), len * 0.72, depth - 1); } };
        grow(x, base, -Math.PI / 2 + rnd(-0.2, 0.2), rnd(40, 70), 3);
        corals.push(`<path class="coral" d="${br}" stroke="${c}" stroke-width="${rnd(5, 9).toFixed(1)}"/>`);
      } else if (kind === 1) {    // sea fan
        const r = rnd(60, 110); let fan = '';
        for (let k = 0; k <= 10; k++) { const a = -Math.PI + 0.25 + (k / 10) * (Math.PI - 0.5); fan += `M${x.toFixed(0)} ${base.toFixed(0)} Q${(x + Math.cos(a) * r * 0.5 + rnd(-6, 6)).toFixed(0)} ${(base + Math.sin(a) * r * 0.5).toFixed(0)} ${(x + Math.cos(a) * r).toFixed(0)} ${(base + Math.sin(a) * r).toFixed(0)} `; }
        corals.push(`<path class="coral fan" d="${fan}" stroke="${c}" stroke-width="2.4"/>`);
      } else {                    // brain coral / sponge
        const rx = rnd(30, 55), ry = rx * rnd(0.5, 0.75);
        corals.push(`<ellipse class="coral blob" cx="${x.toFixed(0)}" cy="${(base - ry * 0.6).toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}" fill="${c}"/><path class="coral" d="M${(x - rx * 0.7).toFixed(0)} ${(base - ry * 0.6).toFixed(0)} q${(rx * 0.35).toFixed(0)} -10 ${(rx * 0.7).toFixed(0)} 0 t${(rx * 0.7).toFixed(0)} 0" stroke="rgba(0,0,0,.25)" stroke-width="2"/>`);
      }
    }
    const rocks = [];
    for (let i = 0; i < 9; i++) { const x = rnd(0, W0), rw = rnd(40, 110), rh = rw * rnd(0.35, 0.6); rocks.push(`<ellipse cx="${x.toFixed(0)}" cy="${H0 - 6}" rx="${rw.toFixed(0)}" ry="${rh.toFixed(0)}" fill="#0a2a3a"/>`); }
    const sand = `<path d="M0 ${H0} L0 ${H0 - 40} Q200 ${H0 - 70} 420 ${H0 - 46} T860 ${H0 - 50} T1260 ${H0 - 38} T1600 ${H0 - 52} L1600 ${H0} Z" fill="#0b3346"/><path d="M0 ${H0} L0 ${H0 - 18} Q300 ${H0 - 36} 640 ${H0 - 20} T1600 ${H0 - 24} L1600 ${H0} Z" fill="#0d3d50"/>`;
    sea.innerHTML = `<svg class="seabed" viewBox="0 0 ${W0} ${H0}" preserveAspectRatio="xMidYMax slice">${rocks.join('')}<g class="kelps">${kelp.join('')}</g>${corals.join('')}${sand}</svg>`;
    // fish: a few loners and a small school, at different depths and speeds
    const FISH = [
      ['#ffd23f', '#ff9f1c'], ['#ff7b39', '#ffffff'], ['#4cc9f0', '#3a86ff'], ['#c77dff', '#7b2cbf'], ['#80ffdb', '#48bfe3'], ['#ff5d8f', '#ffd6e0'],
    ];
    const fishSvg = (a, b, stripes) => `<svg viewBox="0 0 60 32"><path d="M50 16 L60 5 L58 16 L60 27 Z" fill="${b}"/><ellipse cx="28" cy="16" rx="24" ry="12" fill="${a}"/>${stripes ? `<path d="M22 5 q-4 11 0 22 M34 6 q-3 10 0 20" stroke="${b}" stroke-width="3" fill="none"/>` : ''}<path d="M24 5 q6 -6 14 0" fill="${b}" opacity=".8"/><circle cx="12" cy="13" r="3.2" fill="#fff"/><circle cx="11.2" cy="13" r="1.7" fill="#04121c"/></svg>`;
    const addFish = (y, size, dur, delay, rtl, col, stripes) => {
      const f = document.createElement('div');
      f.className = 'fish' + (rtl ? ' rtl' : '');
      f.style.top = `${y}%`; f.style.width = `${size}px`; f.style.height = `${(size * 32 / 60).toFixed(0)}px`;
      f.style.animationDuration = `${dur}s`; f.style.animationDelay = `-${delay}s`;
      f.innerHTML = `<div class="fish-body" style="animation-delay:-${rnd(0, 3).toFixed(1)}s">${fishSvg(col[0], col[1], stripes)}</div>`;
      sea.appendChild(f);
    };
    for (let i = 0; i < 7; i++) addFish(rnd(18, 82), rnd(26, 58), rnd(38, 80), rnd(0, 80), Math.random() < 0.5, FISH[i % FISH.length], i % 3 === 1);
    const sy = rnd(30, 60), sd = rnd(50, 70), sdel = rnd(0, 60), rtl = Math.random() < 0.5;   // a little school
    for (let i = 0; i < 6; i++) addFish(sy + rnd(-5, 5), rnd(14, 20), sd, sdel + i * rnd(0.5, 1.1), rtl, FISH[4], false);
    document.body.insertBefore(sea, document.body.firstChild);
  }
  function setTheme(name) {
    theme = palette[name] ? name : 'tavern';
    if (theme === 'abyss') buildSea();
    spawnAmbient();
    cuts.length = 0;
    redrawMarks();
  }
  setTheme(document.documentElement.getAttribute('data-theme') || 'tavern');

  function shake(el, ms = 450) {
    el.classList.remove('shaking');
    // force reflow so the animation restarts
    void el.offsetWidth;
    el.classList.add('shaking');
    setTimeout(() => el.classList.remove('shaking'), ms);
  }

  function setIdle(idle) {
    if (idle) { running = false; parts.length = 0; rings.length = 0; }
    else if (!running && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(frame); }
  }
  // Mark layer: when set, each new gouge is passed to fn(c) instead of the fixed #marks canvas,
  // and paintCut() renders it onto a small canvas of its own, centred on the cut.
  let markHook = null;
  function setMarkLayer(fn) { markHook = fn; }
  function paintCut(canvas, c) {
    const size = Math.ceil(c.len + 48);
    canvas.width = size; canvas.height = size;
    drawCut({ ...c, x: size / 2, y: size / 2 }, canvas.getContext('2d'));
    return size;
  }
  // twinkling stars around a point (rank crest, secrets)
  function sparkle(x, y, opts = {}) {
    const n = opts.count || 3, spread = opts.spread || 30, cols = opts.colors || palette[theme].burst;
    for (let i = 0; i < n; i++) {
      parts.push({ x: x + rnd(-spread, spread), y: y + rnd(-spread, spread), vx: rnd(-0.2, 0.2), vy: rnd(-0.5, -0.1), life: 0, max: rnd(500, 1100), size: rnd(3, opts.big ? 9 : 6), c: pick(cols), kind: 'star', g: 0, rot: rnd(0, 1), vr: rnd(-0.03, 0.03) });
    }
  }
  // rising embers from a point (the "cleared today" fire)
  function embers(x, y, opts = {}) {
    const n = opts.count || 4, cols = opts.colors || ['#ffb347', '#ff6a2b', '#ffd36b'];
    for (let i = 0; i < n; i++) {
      parts.push({ x: x + rnd(-(opts.w || 30), opts.w || 30), y: y + rnd(-4, 4), vx: rnd(-0.3, 0.3), vy: -rnd(0.6, 1.8), life: 0, max: rnd(600, 1300), size: rnd(1.5, 3.5), c: pick(cols), kind: 'dot', g: -0.01 });
    }
  }
  // level-up nova: stacked shockwaves and light rays from one point
  function nova(x, y, cols) {
    cols = cols || palette[theme].burst;
    [0, 120, 260, 420].forEach((d, i) => rings.push({ x, y, r: 6, max: 260 + i * 160, life: -d, c: i % 2 ? '#ffffff' : cols[i % cols.length], w: 7 - i, dur: 900 }));
    for (let i = 0; i < 48; i++) {
      const ang = (i / 48) * Math.PI * 2 + rnd(-0.05, 0.05), sp = rnd(9, 16);
      parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: rnd(500, 800), size: rnd(2, 4), c: pick(cols), kind: 'streak', g: 0 });
    }
  }
  // raindrops falling over the whole window (the Rainfall spell)
  function drops(n) {
    for (let i = 0; i < n; i++) {
      parts.push({ x: rnd(-40, W), y: rnd(-30, -5), vx: 2.2, vy: rnd(13, 18), life: 0, max: rnd(900, 1400), size: rnd(1, 1.8), c: pick(['#cfe6ff', '#9fc8ff', '#ffffff']), kind: 'streak', g: 0.2, keep: true });
    }
  }
  function setTrail(mode) { trailMode = mode; }
  window.FX = { burst, poof, rain, cut, splash, setTheme, shake, setIdle, setMarkLayer, paintCut, drawCutOn: (ctx, c) => drawCut(c, ctx), sparkle, embers, nova, drops, setTrail, get theme() { return theme; } };
})();
