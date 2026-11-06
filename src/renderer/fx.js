// Visual effects: ambient particles, cursor trail, bursts, shockwaves.
(function () {
  const ambient = document.getElementById('ambient');
  const fx = document.getElementById('fx');
  const actx = ambient.getContext('2d');
  const fctx = fx.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let theme = 'tavern';
  const palette = {
    tavern: { trail: ['#ffb347', '#ffd36b', '#ff6a2b', '#fff1c2'], burst: ['#ffd36b', '#ffb347', '#ff6a2b', '#ffffff', '#ffe9a8'], ambient: ['#ff8a2b', '#ffb347', '#ffd36b'] },
    abyss:  { trail: ['#3cf0ff', '#8df8ff', '#b36bff', '#ffffff'], burst: ['#3cf0ff', '#b36bff', '#ffffff', '#7df9d6', '#c8f9ff'], ambient: ['#3cf0ff', '#7fd7ff', '#b36bff'] },
  };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [ambient, fx]) {
      c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr);
    }
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // ---------- ambient (embers / bubbles) ----------
  const amb = [];
  function spawnAmbient() {
    const n = theme === 'abyss' ? 60 : 45;
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
      vy: isAbyss ? -rnd(0.25, 0.9) : -rnd(0.15, 0.6),
      a: rnd(0.15, 0.6),
      c: pick(palette[theme].ambient),
      wob: rnd(0, Math.PI * 2),
    };
  }
  function drawAmbient(t) {
    actx.clearRect(0, 0, W, H);
    const isAbyss = theme === 'abyss';
    for (let i = 0; i < amb.length; i++) {
      const p = amb[i];
      p.wob += 0.02;
      p.x += p.vx + Math.sin(p.wob) * (isAbyss ? 0.4 : 0.25);
      p.y += p.vy;
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
  let lastTrail = 0;

  window.addEventListener('mousemove', (e) => {
    mouse.px = mouse.x; mouse.py = mouse.y;
    mouse.x = e.clientX; mouse.y = e.clientY;
    const now = performance.now();
    const speed = Math.hypot(mouse.x - mouse.px, mouse.y - mouse.py);
    if (now - lastTrail > 12) {
      lastTrail = now;
      const n = Math.min(4, 1 + (speed / 12) | 0);
      for (let i = 0; i < n; i++) {
        parts.push({
          x: mouse.x + rnd(-2, 2), y: mouse.y + rnd(-2, 2),
          vx: rnd(-0.4, 0.4) - (mouse.x - mouse.px) * 0.03,
          vy: rnd(-0.4, 0.4) - (mouse.y - mouse.py) * 0.03 + (theme === 'abyss' ? -0.3 : -0.15),
          life: 0, max: rnd(350, 700),
          size: rnd(1.5, theme === 'abyss' ? 4.5 : 3.2),
          c: pick(palette[theme].trail), kind: 'trail', g: 0,
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

  function rain(count) {
    // confetti from the top edge, used on level-up
    for (let i = 0; i < count; i++) {
      parts.push({
        x: rnd(0, W), y: rnd(-40, -5),
        vx: rnd(-1, 1), vy: rnd(1, 4),
        life: 0, max: rnd(1800, 3200),
        size: rnd(3, 7), c: pick(palette[theme].burst), kind: 'shard',
        g: 0.05, rot: rnd(0, Math.PI * 2), vr: rnd(-0.2, 0.2),
      });
    }
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(48, t - last); last = t;
    const k = dt / 16.67;
    drawAmbient(t);

    fctx.clearRect(0, 0, W, H);
    fctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      const u = p.life / p.max;
      p.vy += (p.g || 0) * k;
      if (p.kind !== 'trail') { p.vx *= Math.pow(0.985, k); p.vy *= Math.pow(0.985, k); }
      p.x += p.vx * k; p.y += p.vy * k;
      if (p.rot !== undefined) p.rot += p.vr * k;
      const alpha = p.kind === 'trail' ? (1 - u) * 0.9 : (u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3);
      fctx.globalAlpha = Math.max(0, alpha);
      fctx.fillStyle = p.c;
      fctx.shadowColor = p.c; fctx.shadowBlur = p.kind === 'trail' ? 10 : 6;
      if (p.kind === 'shard') {
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot);
        fctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        fctx.restore();
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
      const u = r.life / 520;
      if (u >= 1) { rings.splice(i, 1); continue; }
      fctx.globalAlpha = (1 - u) * 0.8;
      fctx.strokeStyle = r.c; fctx.lineWidth = 3 * (1 - u) + 0.5;
      fctx.beginPath(); fctx.arc(r.x, r.y, r.r + (r.max - r.r) * Math.sqrt(u), 0, Math.PI * 2); fctx.stroke();
    }
    fctx.globalAlpha = 1;
    fctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function setTheme(name) {
    theme = palette[name] ? name : 'tavern';
    spawnAmbient();
  }
  setTheme(document.documentElement.getAttribute('data-theme') || 'tavern');

  function shake(el, ms = 450) {
    el.classList.remove('shaking');
    // force reflow so the animation restarts
    void el.offsetWidth;
    el.classList.add('shaking');
    setTimeout(() => el.classList.remove('shaking'), ms);
  }

  window.FX = { burst, poof, rain, setTheme, shake, get theme() { return theme; } };
})();
