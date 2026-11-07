// Magic: drawn spell gestures, lightning, meteors, rainfall, rune circles, night candles and the garden.
// Pure effects and UI pieces; the app decides when they happen (see app.js "magic").
(function () {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const layer = document.createElement('div');
  layer.id = 'magic-layer';
  document.body.appendChild(layer);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- gesture recognition ----------
  // Returns 'circle', 'zigzag', 'down', 'diagonal' or null for a list of {x, y} points.
  function recognize(raw) {
    if (raw.length < 5) return null;
    let L = 0;
    for (let i = 1; i < raw.length; i++) L += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    if (L < 90) return null;
    // resample to evenly spaced points so speed doesn't matter
    const n = 32, step = L / (n - 1), pts = [raw[0]];
    let acc = 0;
    for (let i = 1; i < raw.length && pts.length < n; i++) {
      let a = raw[i - 1], b = raw[i], d = Math.hypot(b.x - a.x, b.y - a.y);
      while (acc + d >= step && pts.length < n) {
        const t = (step - acc) / d;
        a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        pts.push(a); d = Math.hypot(b.x - a.x, b.y - a.y); acc = 0;
      }
      acc += d;
    }
    while (pts.length < n) pts.push(raw[raw.length - 1]);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const s = pts[0], e = pts[n - 1], chord = Math.hypot(e.x - s.x, e.y - s.y);
    let turn = 0, sharp = 0;
    for (let i = 2; i < n; i++) {
      const a1 = Math.atan2(pts[i - 1].y - pts[i - 2].y, pts[i - 1].x - pts[i - 2].x);
      const a2 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      turn += d; if (Math.abs(d) > 1.6) sharp++;
    }
    if (chord / L < 0.3 && Math.abs(turn) > 4.2 && w > 40 && h > 40 && w / h < 3 && h / w < 3) return 'circle';
    if (sharp >= 2) return 'zigzag';
    if (chord / L > 0.8) {
      const dx = e.x - s.x, dy = e.y - s.y;
      if (dy > 0 && Math.abs(dy) > 2.2 * Math.abs(dx)) return 'down';
      if (Math.abs(dx) > 0.45 * Math.abs(dy) && Math.abs(dy) > 0.45 * Math.abs(dx)) return 'diagonal';
    }
    return null;
  }

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
    el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.width = el.style.height = `${size}px`;
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
    layer.appendChild(el);
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

  window.Magic = { recognize, startStroke, circle, bolt, meteor, rainfall, setNight, openGarden, closeGarden, FAMILIARS };
})();
