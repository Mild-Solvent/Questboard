// Synthesized sounds via WebAudio. No audio files needed.
(function () {
  let ctx = null;
  let enabled = true;
  let master = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    return ctx;
  }

  function tone({ freq = 440, type = 'sine', t0 = 0, dur = 0.25, gain = 0.5, slide = 0, attack = 0.005 }) {
    const c = ensure(); if (!c) return;
    const now = c.currentTime + t0;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(master);
    o.start(now); o.stop(now + dur + 0.02);
  }

  function noise({ t0 = 0, dur = 0.2, gain = 0.2, hp = 1200, bp = 0, q = 1 }) {
    const c = ensure(); if (!c) return;
    const now = c.currentTime + t0;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter();
    if (bp) { f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q; } else { f.type = 'highpass'; f.frequency.value = hp; }
    const g = c.createGain(); g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(now);
  }

  // Real blade-on-wood recordings for the sword cuts: one picked at random each time,
  // slightly re-pitched so a row of cuts never sounds copy-pasted.
  const SFX_BASE = '../../assets/sfx/';
  const CUT_SAMPLES = ['axe-1', 'axe-2', 'axe-3a', 'axe-3b', 'axe-4', 'knife-4a', 'knife-4b', 'sword-3'];
  const cutPool = CUT_SAMPLES.map((n) => { const a = new Audio(`${SFX_BASE}cut/${n}.ogg`); a.preload = 'auto'; return a; });
  let lastCut = -1;
  function playCut() {
    const ready = cutPool.filter((a) => a.readyState >= 2);
    if (!ready.length) return false;
    let i; do { i = (Math.random() * cutPool.length) | 0; } while (cutPool.length > 1 && i === lastCut);
    lastCut = i;
    const a = (cutPool[i].readyState >= 2 ? cutPool[i] : ready[0]).cloneNode();
    a.volume = 0.55 + Math.random() * 0.15;
    a.preservesPitch = false;
    a.playbackRate = 0.92 + Math.random() * 0.16;
    a.play().catch(() => {});
    return true;
  }

  const S = {
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (enabled) ensure(); },
    unlock() { const c = ensure(); if (c && c.state === 'suspended') c.resume(); },
    hover() { if (!enabled) return; tone({ freq: 1200, type: 'sine', dur: 0.05, gain: 0.05 }); },
    complete() {
      if (!enabled) return;
      const theme = (window.FX && window.FX.theme) || 'tavern';
      if (theme === 'abyss') {
        // watery chime: soft sines with slight slides
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, type: 'sine', t0: i * 0.07, dur: 0.5, gain: 0.35, slide: 40 }));
        tone({ freq: 220, type: 'triangle', dur: 0.6, gain: 0.2, slide: 120 });
        noise({ dur: 0.35, gain: 0.08, hp: 3000 });
      } else {
        // coin/bell chime
        tone({ freq: 659.25, type: 'triangle', dur: 0.18, gain: 0.4 });
        tone({ freq: 987.77, type: 'triangle', t0: 0.09, dur: 0.22, gain: 0.4 });
        tone({ freq: 1318.5, type: 'sine', t0: 0.18, dur: 0.5, gain: 0.45 });
        tone({ freq: 1975.5, type: 'sine', t0: 0.18, dur: 0.5, gain: 0.15 });
        noise({ dur: 0.12, gain: 0.12, hp: 2000 });
      }
    },
    cut() {
      if (!enabled) return;
      if (playCut()) return;
      // fallback until the recordings have loaded: the synthesized swish and knock
      noise({ dur: 0.09, gain: 0.2, hp: 3500 });
      tone({ freq: 3200, type: 'sine', dur: 0.16, gain: 0.1, slide: -1400 });
      // ...then the bite into the plank: a dull knock with a few short wooden body modes.
      // Pitched a little differently each time so a row of cuts doesn't sound copy-pasted.
      const v = 0.88 + Math.random() * 0.24, hit = 0.014;
      noise({ t0: hit, dur: 0.06, gain: 0.55, bp: 700 * v, q: 1.3 });
      noise({ t0: hit, dur: 0.025, gain: 0.25, bp: 2600 * v, q: 0.8 });
      tone({ freq: 190 * v, type: 'sine', t0: hit, dur: 0.13, gain: 0.34, slide: -45 });
      tone({ freq: 437 * v, type: 'sine', t0: hit, dur: 0.075, gain: 0.2, slide: -30 });
      tone({ freq: 811 * v, type: 'triangle', t0: hit, dur: 0.045, gain: 0.11 });
      tone({ freq: 1290 * v, type: 'sine', t0: hit, dur: 0.03, gain: 0.06 });
    },
    splash() {
      if (!enabled) return;
      tone({ freq: 420, type: 'sine', dur: 0.18, gain: 0.3, slide: -300 });
      tone({ freq: 900, type: 'sine', t0: 0.05, dur: 0.12, gain: 0.1, slide: 500 });
      noise({ dur: 0.2, gain: 0.08, hp: 1500 });
    },
    lift() { if (!enabled) return; noise({ dur: 0.08, gain: 0.12, hp: 2500 }); tone({ freq: 320, type: 'triangle', dur: 0.12, gain: 0.12, slide: 180 }); },
    nail() {
      if (!enabled) return;
      const theme = (window.FX && window.FX.theme) || 'tavern';
      if (theme === 'abyss') { tone({ freq: 900, type: 'sine', dur: 0.12, gain: 0.25, slide: -300 }); tone({ freq: 1400, type: 'sine', t0: 0.08, dur: 0.2, gain: 0.15 }); return; }
      [0, 0.13].forEach((t) => { noise({ t0: t, dur: 0.07, gain: 0.35, hp: 900 }); tone({ freq: 140, type: 'square', t0: t, dur: 0.09, gain: 0.25, slide: -60 }); tone({ freq: 2400, type: 'sine', t0: t, dur: 0.05, gain: 0.08 }); });
    },
    secret() {
      if (!enabled) return;
      [783.99, 987.77, 1174.66, 1567.98, 1975.53].forEach((f, i) => tone({ freq: f, type: 'sine', t0: i * 0.06, dur: 0.5, gain: 0.22 }));
      tone({ freq: 2637, type: 'triangle', t0: 0.32, dur: 0.6, gain: 0.08 });
      noise({ t0: 0.02, dur: 0.4, gain: 0.05, hp: 6000 });
    },
    heat() {
      if (!enabled) return;
      noise({ dur: 0.35, gain: 0.18, bp: 500, q: 0.7 });
      tone({ freq: 220, type: 'sawtooth', dur: 0.3, gain: 0.05, slide: 220 });
      tone({ freq: 880, type: 'triangle', t0: 0.12, dur: 0.25, gain: 0.12, slide: 300 });
    },
    undo() { if (!enabled) return; tone({ freq: 440, type: 'triangle', dur: 0.2, gain: 0.25, slide: -220 }); },
    add() { if (!enabled) return; tone({ freq: 880, type: 'sine', dur: 0.12, gain: 0.25 }); tone({ freq: 1320, type: 'sine', t0: 0.06, dur: 0.15, gain: 0.2 }); },
    levelUp() {
      if (!enabled) return;
      const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
      seq.forEach((f, i) => { tone({ freq: f, type: 'square', t0: i * 0.09, dur: 0.22, gain: 0.12 }); tone({ freq: f, type: 'sine', t0: i * 0.09, dur: 0.4, gain: 0.3 }); });
      tone({ freq: 1046.5, type: 'sine', t0: 0.6, dur: 1.2, gain: 0.35 });
      tone({ freq: 1318.5, type: 'sine', t0: 0.6, dur: 1.2, gain: 0.3 });
      tone({ freq: 1567.98, type: 'sine', t0: 0.6, dur: 1.4, gain: 0.3 });
      tone({ freq: 130.8, type: 'triangle', t0: 0.6, dur: 1.2, gain: 0.3 });
      noise({ t0: 0.6, dur: 0.6, gain: 0.15, hp: 1500 });
    },
  };
  window.Sound = S;
})();
