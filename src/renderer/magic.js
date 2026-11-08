// Magic: drawn spell gestures, lightning, meteors, rainfall, rune circles, night candles and the garden.
// Pure effects and UI pieces; the app decides when they happen (see app.js "magic").
(function () {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const layer = document.createElement('div');
  layer.id = 'magic-layer';
  document.body.appendChild(layer);
  // Spell results cast at a spot (rune circle, the burned-in shape, hearts) are pinned to the wall:
  // they live in `anchored`, which moves with the board's scroll, so they scroll with the papers.
  const anchored = document.createElement('div');
  anchored.className = 'magic-anchored';
  layer.appendChild(anchored);
  let scroller = null;
  const scrollX = () => (scroller ? scroller.scrollLeft : 0);
  const scrollY = () => (scroller ? scroller.scrollTop : 0);
  function syncScroll() { anchored.style.transform = `translate(${-scrollX()}px, ${-scrollY()}px)`; }
  function setScroller(el) {
    if (scroller) scroller.removeEventListener('scroll', syncScroll);
    scroller = el || null;
    if (scroller) scroller.addEventListener('scroll', syncScroll, { passive: true });
    syncScroll();
  }
  // places el at screen point (x, y) on the wall
  function pin(el, x, y) {
    syncScroll();
    el.style.left = `${x + scrollX()}px`; el.style.top = `${y + scrollY()}px`;
    anchored.appendChild(el);
  }
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- gesture recognition ----------
  // Returns 'circle', 'triangle', 'square', 'star', 'heart', 'spiral', 'zigzag', 'down', 'diagonal' or null.
  // Shapes are matched against templates (any start point, either direction, a little tilt is fine);
  // straight strokes and loose zigzags fall back to simple rules.
  const N = 64;
  function resample(raw, n = N) {
    let L = 0;
    for (let i = 1; i < raw.length; i++) L += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    const step = L / (n - 1), pts = [{ x: raw[0].x, y: raw[0].y }];
    let acc = 0;
    for (let i = 1; i < raw.length && pts.length < n; i++) {
      let a = raw[i - 1]; const b = raw[i]; let d = Math.hypot(b.x - a.x, b.y - a.y);
      while (acc + d >= step && d > 0 && pts.length < n) {
        const t = (step - acc) / d;
        a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        pts.push(a); d = Math.hypot(b.x - a.x, b.y - a.y); acc = 0;
      }
      acc += d;
    }
    while (pts.length < n) pts.push({ x: raw[raw.length - 1].x, y: raw[raw.length - 1].y });
    return { pts, L };
  }
  function normalize(pts) {
    const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length, cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
    return pts.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size }));
  }
  const poly = (vs, close) => { const out = vs.map(([x, y]) => ({ x, y })); if (close) out.push({ ...out[0] }); return out; };
  const TEMPLATES = (() => {
    const t = [];
    const add = (name, raw, closed) => t.push({ name, closed, pts: normalize(resample(raw).pts) });
    const circ = []; for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; circ.push({ x: Math.cos(a), y: Math.sin(a) }); }
    add('circle', circ, true);
    add('triangle', poly([[0, -1], [0.87, 0.5], [-0.87, 0.5]], true), true);
    add('square', poly([[-1, -1], [1, -1], [1, 1], [-1, 1]], true), true);
    const star = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * (4 * Math.PI / 5); star.push([Math.cos(a), Math.sin(a)]); }
    add('star', poly(star, true), true);
    const heart = []; for (let i = 0; i <= 80; i++) { const a = (i / 80) * Math.PI * 2; heart.push({ x: 16 * Math.sin(a) ** 3, y: -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) }); }
    add('heart', heart, true);
    for (const dir of [1, -1]) { const sp = []; for (let i = 0; i <= 120; i++) { const a = (i / 120) * Math.PI * 5; const r = 0.1 + i / 120; sp.push({ x: dir * r * Math.cos(a), y: r * Math.sin(a) }); } add('spiral', sp, false); }
    return t;
  })();
  function pathDist(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y); return d / a.length; }
  function rotate(pts, ang) { const c = Math.cos(ang), s = Math.sin(ang); return pts.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })); }
  function shapeMatch(cand, skip) {
    let best = { name: null, d: Infinity };
    const variants = [cand, cand.slice().reverse()];
    for (const T of TEMPLATES) {
      if (T.name === 'spiral' || (skip && skip.includes(T.name))) continue;
      for (const v0 of variants) {
        for (const ang of [-0.3, 0, 0.3]) {
          const v = ang ? rotate(v0, ang) : v0;
          if (T.closed) {
            // a closed shape can be started anywhere: try every start point
            const ring = v.slice(0, N - 1);
            for (let k = 0; k < N - 1; k += 2) {
              const shifted = ring.slice(k).concat(ring.slice(0, k)); shifted.push(shifted[0]);
              const d = pathDist(normalize(shifted), T.pts);
              if (d < best.d) best = { name: T.name, d };
            }
          } else {
            const d = pathDist(v, T.pts);
            if (d < best.d) best = { name: T.name, d };
          }
        }
      }
    }
    return best;
  }
  function recognize(input) {
    if (input.length < 5) return null;
    // smooth out hand jitter first
    const raw = input.map((p, i) => {
      let x = 0, y = 0, c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(input.length - 1, i + 2); j++) { x += input[j].x; y += input[j].y; c++; }
      return { x: x / c, y: y / c };
    });
    const { pts, L } = resample(raw);
    if (L < 90) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys), size = Math.max(w, h);
    const s = pts[0], e = pts[N - 1], chord = Math.hypot(e.x - s.x, e.y - s.y);
    // heading changes, total winding, and corners (a big turn within a few samples)
    const head = []; for (let i = 1; i < N; i++) head.push(Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x));
    const dturn = []; let turn = 0;
    for (let i = 1; i < head.length; i++) { let d = head[i] - head[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; dturn.push(d); turn += d; }
    let corners = 0; const csign = [];
    const winAt = (i) => { let v = 0; for (let j = Math.max(0, i - 2); j <= Math.min(dturn.length - 1, i + 2); j++) v += dturn[j]; return v; };
    for (let i = 3; i < dturn.length - 3; i++) {   // the very ends wobble when you press and let go
      const v = winAt(i);
      if (Math.abs(v) > 1.05) {
        const sg = Math.sign(v);
        corners++; csign.push(sg);
        while (i + 1 < dturn.length - 3 && Math.sign(winAt(i + 1)) === sg && Math.abs(winAt(i + 1)) > 0.4) i++;   // one bend, counted once
        i += 1;
      }
    }
    if (chord / L > 0.8) {
      const dx = e.x - s.x, dy = e.y - s.y;
      if (dy > 0 && Math.abs(dy) > 2.2 * Math.abs(dx)) return 'down';
      if (Math.abs(dx) > 0.45 * Math.abs(dy) && Math.abs(dy) > 0.45 * Math.abs(dx)) return 'diagonal';
      return null;
    }
    if (size < 40) return null;
    const same = dturn.filter((d) => Math.sign(d) === Math.sign(turn) || Math.abs(d) < 0.05).length / dturn.length;
    if (Math.abs(turn) > 9 && chord > 0.3 * size && same > 0.8) return 'spiral';
    const closed = chord < 0.25 * size;
    if (closed && w > 0.3 * h && h > 0.3 * w) {
      const m = shapeMatch(normalize(pts), corners <= 1 ? null : ['circle']);
      if (m.d < 0.14) return m.name;
    }
    const alternating = csign.every((c, i) => i === 0 || c !== csign[i - 1]);   // a zigzag turns left, right, left...
    if (corners >= 2 && corners <= 8 && alternating && !closed && chord / L > 0.3) return 'zigzag';
    return null;
  }

  // outline of a shape, for the glow it leaves behind
  function shapePoints(name) { const T = TEMPLATES.find((t) => t.name === name); return T ? T.pts : null; }

  // ---------- the glowing line you draw ----------
  function startStroke(color) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'stroke-svg');
    const path = document.createElementNS(SVGNS, 'polyline');
    path.setAttribute('style', `stroke:${color}`);
    svg.appendChild(path);
    layer.appendChild(svg);
    const pts = [];
    return {
      add(x, y) { pts.push(`${x.toFixed(0)},${y.toFixed(0)}`); path.setAttribute('points', pts.join(' ')); },
      end(ok) { svg.classList.add(ok ? 'cast' : 'fizzle'); setTimeout(() => svg.remove(), 700); },
    };
  }

  // ---------- rune circle ----------
  const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
  function circle(x, y, size = 240, color = '#ffd36b', ms = 3800) {
    const el = document.createElement('div');
    el.className = 'rune-circle';
    el.style.width = el.style.height = `${size}px`;
    el.style.setProperty('--rc', color); el.style.setProperty('--life', `${ms}ms`);
    let runes = ''; for (let i = 0; i < 24; i++) runes += RUNES[(Math.random() * RUNES.length) | 0];
    const id = `rc${Math.random().toString(36).slice(2, 8)}`;
    const star = [0, 1, 2, 3, 4, 5].map((i) => { const a = -Math.PI / 2 + i * Math.PI / 3; return `${50 + 34 * Math.cos(a)},${50 + 34 * Math.sin(a)}`; });
    el.innerHTML = `<svg viewBox="0 0 100 100">
      <defs><path id="${id}" d="M50,50 m-41,0 a41,41 0 1,1 82,0 a41,41 0 1,1 -82,0"/></defs>
      <circle class="rc-draw" cx="50" cy="50" r="47"/><circle class="rc-draw" cx="50" cy="50" r="36"/>
      <polygon class="rc-draw" points="${star[0]} ${star[2]} ${star[4]}"/><polygon class="rc-draw" points="${star[1]} ${star[3]} ${star[5]}"/>
      <circle class="rc-draw" cx="50" cy="50" r="12"/>
      <text class="rc-runes"><textPath href="#${id}">${runes}</textPath></text></svg>`;
    pin(el, x, y);
    setTimeout(() => el.remove(), ms + 100);
  }

  // ---------- lightning ----------
  function bolt(x, y) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'bolt-svg');
    const mk = (x0, y0, x1, y1, spread) => {
      const pts = [[x0, y0]]; const steps = 12;
      for (let i = 1; i < steps; i++) { const t = i / steps; pts.push([x0 + (x1 - x0) * t + rnd(-spread, spread), y0 + (y1 - y0) * t]); }
      pts.push([x1, y1]); return pts;
    };
    const main = mk(x + rnd(-120, 120), -10, x, y, 26);
    const paths = [main];
    for (let i = 0; i < 3; i++) { const p = main[3 + ((Math.random() * 7) | 0)]; paths.push(mk(p[0], p[1], p[0] + rnd(-90, 90), p[1] + rnd(40, 120), 14)); }
    svg.innerHTML = paths.map((p, i) => `<polyline class="${i ? 'branch' : 'main'}" points="${p.map((q) => q.join(',')).join(' ')}"/>`).join('');
    layer.appendChild(svg);
    setTimeout(() => svg.remove(), 520);
    const flash = document.getElementById('flash');
    if (flash) { flash.style.setProperty('--flash', 'rgba(190,220,255,.7)'); flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on'); }
    if (window.FX) { FX.burst(x, y, { count: 50, power: 1.1, colors: ['#ffffff', '#cfe6ff', '#8fd0ff', '#fff4b0'] }); FX.sparkle(x, y, { count: 10, spread: 40, colors: ['#ffffff', '#cfe6ff'], big: true }); }
  }

  // ---------- the shape you drew, burned into the air for a moment ----------
  function shapeGlow(name, x, y, size, color) {
    const pts = shapePoints(name);
    if (!pts) return;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'shape-glow');
    svg.setAttribute('viewBox', '-0.6 -0.6 1.2 1.2');
    svg.style.width = svg.style.height = `${size}px`;
    svg.style.color = color;
    svg.innerHTML = `<polyline points="${pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')}"/>`;
    pin(svg, x, y);
    setTimeout(() => svg.remove(), 1700);
  }

  // ---------- triangle: fireball ----------
  function fireball(x, y) {
    shapeGlow('triangle', x, y, 220, '#ff8a2b');
    if (window.FX) {
      FX.nova(x, y, ['#ff6a2b', '#ffb347', '#ffd36b']);
      FX.burst(x, y, { count: 120, power: 1.5, colors: ['#ff3b1f', '#ff6a2b', '#ffb347', '#ffd36b', '#fff1c2'] });
      for (let i = 0; i < 8; i++) setTimeout(() => FX.embers(x + rnd(-60, 60), y + rnd(-30, 30), { count: 10, w: 40, colors: ['#ffb347', '#ff6a2b', '#ffd36b'] }), i * 70);
    }
  }

  // ---------- square: a shield ward over the whole wall ----------
  function ward(x, y, color = '#9be7ff') {
    shapeGlow('square', x, y, 200, color);
    const el = document.createElement('div');
    el.className = 'ward'; el.style.setProperty('--wc', color);
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2600);
    if (window.FX) FX.sparkle(x, y, { count: 24, spread: 120, colors: ['#ffffff', color, '#cfe6ff'], big: true });
  }

  // ---------- star: shooting stars ----------
  function starfall(n = 16) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const s = document.createElement('div');
        s.className = 'shooting-star';
        const x0 = rnd(window.innerWidth * 0.2, window.innerWidth * 1.1), y0 = rnd(-40, window.innerHeight * 0.35);
        const len = rnd(380, 700);
        s.style.left = `${x0}px`; s.style.top = `${y0}px`;
        layer.appendChild(s);
        const a = s.animate([{ transform: 'translate(0,0) rotate(-35deg)', opacity: 0 }, { opacity: 1, offset: 0.15 }, { transform: `translate(${-len}px, ${len * 0.7}px) rotate(-35deg)`, opacity: 0 }], { duration: rnd(700, 1200), easing: 'ease-in' });
        a.onfinish = () => s.remove();
      }, i * rnd(80, 160));
    }
  }

  // ---------- heart: hearts float up ----------
  function hearts(x, y, n = 18) {
    shapeGlow('heart', x, y, 180, '#ff6fa8');
    for (let i = 0; i < n; i++) {
      const h = document.createElement('span');
      h.className = 'float-heart';
      h.textContent = ['💖', '💗', '💕', '❤️'][(Math.random() * 4) | 0];
      h.style.fontSize = `${rnd(16, 34) | 0}px`;
      h.style.setProperty('--dx', `${rnd(-60, 60) | 0}px`);
      h.style.animationDelay = `${rnd(0, 0.6).toFixed(2)}s`;
      pin(h, x + rnd(-80, 80), y + rnd(-20, 40));
      setTimeout(() => h.remove(), 3200);
    }
  }

  // ---------- spiral: a vortex pulls the room around ----------
  function vortex(x, y) {
    shapeGlow('spiral', x, y, 220, '#c58cff');
    const html = document.documentElement;
    html.style.setProperty('--vx', `${x}px`); html.style.setProperty('--vy', `${y}px`);
    html.classList.remove('vortex'); void html.offsetWidth; html.classList.add('vortex');
    setTimeout(() => html.classList.remove('vortex'), 1600);
    if (window.FX) for (let i = 0; i < 24; i++) setTimeout(() => { const a = i * 0.7, r = 140 - i * 5; FX.sparkle(x + Math.cos(a) * r, y + Math.sin(a) * r, { count: 3, spread: 8, colors: ['#c58cff', '#e6d0ff', '#ffffff'] }); }, i * 35);
  }

  // ---------- meteor ----------
  function meteor(x, y, onImpact) {
    const el = document.createElement('div');
    el.className = 'meteor';
    layer.appendChild(el);
    const sx = x + 420, sy = -80;
    const anim = el.animate([{ transform: `translate(${sx}px, ${sy}px) scale(.6)` }, { transform: `translate(${x}px, ${y}px) scale(1.2)` }], { duration: 520, easing: 'cubic-bezier(.5,0,.9,.6)', fill: 'forwards' });
    const trail = setInterval(() => { const r = el.getBoundingClientRect(); if (window.FX) FX.embers(r.left + r.width / 2, r.top + r.height / 2, { count: 6, w: 8, colors: ['#ffb347', '#ff6a2b', '#ffd36b', '#fff1c2'] }); }, 24);
    anim.onfinish = () => {
      clearInterval(trail); el.remove();
      if (window.FX) { FX.nova(x, y, ['#ff6a2b', '#ffb347', '#ffd36b']); FX.burst(x, y, { count: 160, power: 1.8, colors: ['#ff6a2b', '#ffb347', '#ffd36b', '#ffffff'] }); }
      if (onImpact) onImpact();
    };
  }

  // ---------- rainfall over the wall ----------
  let rainTimer = null;
  function rainfall(ms = 15000) {
    clearInterval(rainTimer);
    const until = performance.now() + ms;
    document.documentElement.classList.add('raining');
    rainTimer = setInterval(() => {
      if (performance.now() > until) { clearInterval(rainTimer); document.documentElement.classList.remove('raining'); return; }
      if (window.FX) FX.drops(18);
    }, 60);
  }

  // ---------- night candles ----------
  let candles = null;
  function setNight(on) {
    document.documentElement.toggleAttribute('data-night', !!on);
    if (on && !candles) {
      candles = document.createElement('div'); candles.className = 'candles';
      [[6, 30], [94, 34], [3, 78], [97, 82], [50, 98]].forEach(([x, y], i) => { const c = document.createElement('span'); c.style.left = `${x}%`; c.style.top = `${y}%`; c.style.animationDelay = `${i * -0.37}s`; candles.appendChild(c); });
      document.body.appendChild(candles);
    } else if (!on && candles) { candles.remove(); candles = null; }
  }

  // ---------- the garden ----------
  const FAMILIARS = {
    cat: { e: '🐈', name: 'Tavern cat' }, owl: { e: '🦉', name: 'Night owl' }, fox: { e: '🦊', name: 'Sly fox' },
    frog: { e: '🐸', name: 'Pond frog' }, bunny: { e: '🐇', name: 'Dust bunny' }, hedgehog: { e: '🦔', name: 'Hedgehog' },
    dragon: { e: '🐉', name: 'Dragonling' },
  };
  let gardenTimer = null;
  function openGarden(owned) {
    closeGarden();
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap garden-wrap';
    wrap.innerHTML = `<div class="modal-card garden-card"><h3>The hidden garden</h3>
      <div class="garden-scene"><div class="garden-pond"></div><div class="garden-flowers"></div></div>
      <p class="garden-note"></p><div class="modal-row"><span class="status"></span><button class="btn" type="button">Close</button></div></div>`;
    document.body.appendChild(wrap);
    const scene = wrap.querySelector('.garden-scene');
    const fl = wrap.querySelector('.garden-flowers');
    for (let i = 0; i < 26; i++) { const f = document.createElement('i'); f.style.left = `${rnd(2, 96)}%`; f.style.top = `${rnd(48, 94)}%`; f.style.setProperty('--h', `${(Math.random() * 360) | 0}deg`); fl.appendChild(f); }
    const pets = owned.map((id) => {
      const f = FAMILIARS[id] || FAMILIARS.cat;
      const p = document.createElement('span'); p.className = 'pet'; p.textContent = f.e; p.title = f.name;
      p.style.left = `${rnd(8, 88)}%`; p.style.top = `${rnd(52, 86)}%`;
      p.addEventListener('click', () => { p.classList.remove('hop'); void p.offsetWidth; p.classList.add('hop'); if (window.Sound) Sound.add(); });
      scene.appendChild(p); return p;
    });
    wrap.querySelector('.garden-note').textContent = owned.length
      ? `${owned.length} familiar${owned.length > 1 ? 's' : ''} live here: ${owned.map((id) => (FAMILIARS[id] || {}).name).join(', ')}. More turn up as secrets on the wall.`
      : 'The garden is quiet. Familiars turn up as secrets on the wall; when you find one, it moves in here.';
    const wander = () => pets.forEach((p) => {
      if (Math.random() < 0.45) return;
      const x = Math.max(4, Math.min(90, parseFloat(p.style.left) + rnd(-18, 18)));
      p.classList.toggle('flip', x < parseFloat(p.style.left));
      p.style.left = `${x}%`; p.style.top = `${Math.max(50, Math.min(88, parseFloat(p.style.top) + rnd(-8, 8)))}%`;
    });
    setTimeout(wander, 300);
    gardenTimer = setInterval(wander, 2600);
    const close = () => closeGarden();
    wrap.querySelector('.btn').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  function closeGarden() { clearInterval(gardenTimer); document.querySelectorAll('.garden-wrap').forEach((w) => w.remove()); }

  window.Magic = { setScroller, recognize, startStroke, circle, bolt, meteor, rainfall, fireball, ward, starfall, hearts, vortex, shapeGlow, setNight, openGarden, closeGarden, FAMILIARS };
})();
