(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------
  const W = 320, HS = 180, OY = 90;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  canvas.width = W;
  canvas.height = HS;
  ctx.imageSmoothingEnabled = false;

  const stage = document.getElementById('stage');
  const $ = (id) => document.getElementById(id);
  const hud = {
    attempt: $('hud-attempt'), alt: $('hud-alt'), best: $('hud-best'),
    total: $('hud-total'),
  };
  const hintEl = $('hint');
  const msgEl = $('message');
  const msgTitle = $('msg-title');
  const msgSub = $('msg-sub');
  const titleEl = $('title');

  function fit() {
    const k = Math.min(innerWidth / W, innerHeight / HS);
    const ks = k >= 2 ? Math.floor(k) : k;
    stage.style.width = W * ks + 'px';
    stage.style.height = HS * ks + 'px';
    stage.style.setProperty('--k', ks);
  }
  addEventListener('resize', fit);
  fit();

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  function hash(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const css = (c, a) => a === undefined
    ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
    : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  // ---------------------------------------------------------------------------
  // Terrain: slope steepens toward the summit
  // ---------------------------------------------------------------------------
  const L = 2400, PLATEAU = 40, FLAG_X = L + 20;
  const heights = new Float32Array(L + 1);
  // Max ~33 deg: steeper than that a human cannot stand and push a boulder.
  const slopeFn = (t) => Math.max(0.06,
    0.12 + 0.46 * t * t + 0.04 * Math.sin(t * 37) + 0.03 * Math.sin(t * 91 + 1.3));
  for (let i = 0; i < L; i++) heights[i + 1] = heights[i] + slopeFn((i + 0.5) / L);
  const TOP = heights[L];

  function groundH(x) {
    if (x <= 0) return 0;
    if (x < L) {
      const i = Math.floor(x), f = x - i;
      return heights[i] + (heights[i + 1] - heights[i]) * f;
    }
    if (x <= L + PLATEAU) return TOP;
    return TOP - (x - L - PLATEAU) * 0.9;
  }
  const slopeAt = (x) => (groundH(x + 1) - groundH(x - 1)) / 2;

  const M_PER_PX = 0.85;
  const SUMMIT_M = Math.round(TOP * M_PER_PX);
  $('title-summit').textContent = SUMMIT_M;

  // ---------------------------------------------------------------------------
  // Persistent stats
  // ---------------------------------------------------------------------------
  const KEY = 'sisyphus-stats';
  function loadStats() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY));
      if (o && typeof o.attempts === 'number') {
        return { attempts: o.attempts | 0, best: +o.best || 0, total: +o.total || 0 };
      }
    } catch (e) { /* ignore corrupt storage */ }
    return { attempts: 0, best: 0, total: 0 };
  }
  const stats = loadStats();
  function saveStats() {
    try { localStorage.setItem(KEY, JSON.stringify(stats)); } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // Audio (all synthesized)
  // ---------------------------------------------------------------------------
  const audio = {
    ctx: null, acc: 0,
    init() {
      if (this.ctx) { this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = this.ctx = new AC();
      this.master = c.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(c.destination);

      const len = c.sampleRate * 2;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      // wind
      this.windGain = this.gain(0, this.master);
      this.windFilter = this.filter('bandpass', 400, this.windGain);
      this.windFilter.Q.value = 0.8;
      this.loopNoise().connect(this.windFilter);

      // rolling rumble
      this.rumbleGain = this.gain(0, this.master);
      this.loopNoise().connect(this.filter('lowpass', 160, this.rumbleGain));

      // hopeful pad + arpeggio
      this.musicGain = this.gain(0, this.master);
      this.padFilter = this.filter('lowpass', 600, this.musicGain);
      [0, 7, 12, 16].forEach((s) => {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 110 * 2 ** (s / 12);
        o.connect(this.gain(0.1, this.padFilter));
        o.start();
      });
      this.nextNote = c.currentTime;
      this.step = 0;
    },
    gain(v, dest) { const g = this.ctx.createGain(); g.gain.value = v; g.connect(dest); return g; },
    filter(type, f, dest) {
      const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.connect(dest); return b;
    },
    loopNoise() {
      const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true; s.start(); return s;
    },
    to(param, v, tc) { param.setTargetAtTime(v, this.ctx.currentTime, tc); },

    update(dt, phase, p, speedFrac) {
      if (!this.ctx) return;
      const c = this.ctx;
      if (phase === 'climb' && p > 0.04) {
        const now = c.currentTime;
        if (this.nextNote < now) this.nextNote = now + 0.02;
        const iv = lerp(0.6, 0.15, smooth(0.05, 1, p));
        const SC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];
        const PAT = [0, 2, 1, 3, 2, 4, 3, 5];
        while (this.nextNote < now + 0.12) {
          const idx = Math.min(SC.length - 1, Math.floor(p * 7) + PAT[this.step % 8]);
          this.note(this.nextNote, 220 * 2 ** (SC[idx] / 12), 0.18 + 0.14 * p);
          this.nextNote += iv;
          this.step++;
        }
      }

      this.acc += dt;
      if (this.acc < 0.08) return;
      this.acc = 0;

      let wind = 0.04, wf = 350, music = 0, rumble = 0, tc = 0.3;
      const w = smooth(0.35, 1, p);
      if (phase === 'climb') {
        wind = 0.03 + 0.25 * w; wf = 300 + 900 * w;
        music = 0.06 + 0.32 * smooth(0.05, 1, p);
        rumble = Math.min(0.12, speedFrac * 0.25);
      } else if (phase === 'teeter') {
        wind = 0; tc = 0.05;
      } else if (phase === 'fall') {
        wind = 0.1; wf = 1300; rumble = 0.15 + 0.4 * speedFrac; tc = 0.1;
      } else if (phase === 'settle') {
        wind = 0; tc = 0.15;
      }
      this.to(this.windGain.gain, wind, tc);
      this.to(this.windFilter.frequency, wf * rand(0.85, 1.15), 0.3);
      this.to(this.musicGain.gain, music, tc);
      this.to(this.rumbleGain.gain, rumble, 0.08);
      this.to(this.padFilter.frequency, 500 + 1800 * p, 0.5);
    },

    note(t, freq, vol) {
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = freq;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(this.filter('lowpass', 1800, g));
      g.connect(this.musicGain);
      o.start(t);
      o.stop(t + 0.35);
    },
    thump(t, f0, f1, dur, vol, type = 'sine', dest = this.master) {
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    },
    burst(t, dur, vol, type, freq) {
      const c = this.ctx;
      const s = c.createBufferSource();
      s.buffer = this.noise;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(this.master);
      s.connect(this.filter(type, freq, g));
      s.start(t, Math.random() * 1.5, dur + 0.05);
    },
    heartbeat(v) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + 0.01;
      this.thump(t, 70, 35, 0.15, 0.5 * v);
      this.thump(t + 0.2, 65, 32, 0.15, 0.35 * v);
    },
    impact(I) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + 0.005;
      this.burst(t, 0.5, Math.min(0.9, 0.5 * I), 'lowpass', 300 + 500 * I);
      this.thump(t, 100, 30, 0.4, Math.min(0.9, 0.6 * I));
    },
    doom() {
      if (!this.ctx) return;
      const c = this.ctx, t = c.currentTime + 0.01;
      this.burst(t, 0.25, 0.35, 'highpass', 1800);
      const lp = this.filter('lowpass', 400, this.master);
      this.thump(t, 98, 36, 2.8, 0.3, 'sawtooth', lp);
      this.thump(t, 49, 24, 2.8, 0.4);
    },
    bell() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + 0.01;
      [196, 293.66, 392].forEach((f, i) => this.thump(t, f, f * 0.995, 3.5, 0.12 / (i + 1)));
    },
  };

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  const R = 11;
  const GRAV = 75, PUSH = 110, DAMP = 2, MAXFALL = 520;

  const st = {
    phase: 'title', time: 0, t: 0,
    s: 0, v: 0, z: 0, zv: 0, angle: 0, tremble: 0,
    manX: 0, manFrozen: false, walk: 0, pushing: false,
    pushTimer: 0, idle: 0,
    curseFrac: 0.97, curseS: 0, curseAlt: 0, teeterT: 2, nextBump: 0, cueDone: false,
    camX: 0, camY: 0, lead: 120, offY: 25, prevCamX: 0, prevCamY: 0,
    trauma: 0, redFlash: 0, whiteFlash: 0, fade: 0, flashTimer: 2,
    mood: 0, dread: 0, beacon: 1, p: 0, lastAlt: 0, saveTimer: 0, msgShown: false,
  };

  const parts = [];
  const rings = [];
  const streaks = [];

  function boulderCenter() {
    const th = Math.atan(slopeAt(st.s));
    return { x: st.s - Math.sin(th) * R, y: groundH(st.s) + Math.cos(th) * R + st.z };
  }

  function snapCamera() {
    const c = boulderCenter();
    st.lead = 120; st.offY = 25;
    st.camX = st.prevCamX = c.x - st.lead;
    st.camY = st.prevCamY = c.y + st.offY;
  }

  function beginAttempt() {
    stats.attempts++;
    saveStats();
    Object.assign(st, {
      phase: 'climb', s: 0, v: 0, z: 0, zv: 0, t: 0, idle: 0, pushTimer: 0, tremble: 0,
      curseFrac: rand(0.955, 0.988), teeterT: rand(1.4, 2.4),
      manFrozen: false, lastAlt: 0, flashTimer: 2, msgShown: false, cueDone: false,
    });
    snapCamera();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const held = new Set();
  const PUSH_KEYS = ['ArrowUp', 'KeyW', 'Space'];
  addEventListener('keydown', (e) => {
    if (PUSH_KEYS.includes(e.code) && st.phase !== 'title') {
      held.add(e.code);
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

  function addPush(x) {
    st.pushTimer = Math.min(0.4, st.pushTimer + 0.1 * clamp(x, 0.4, 2));
  }
  addEventListener('wheel', (e) => {
    e.preventDefault();
    if (st.phase === 'title') return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    if (dy < 0) addPush(Math.min(-dy, 150) / 60);
  }, { passive: false });

  let touchY = null;
  addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (st.phase === 'title') return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    if (touchY !== null && touchY - y > 0) addPush((touchY - y) / 15);
    touchY = y;
  }, { passive: false });
  addEventListener('touchend', () => { touchY = null; });

  $('start').addEventListener('click', (e) => {
    e.currentTarget.blur();
    titleEl.classList.add('hidden');
    audio.init();
    beginAttempt();
    st.fade = 1;
  });

  // ---------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------
  const ROCK_COLS = ['#8f877c', '#6e675e', '#a39a8c', '#544d45'];
  const DUST_COLS = ['#b49c7c', '#9c8668', '#cbb79a'];

  function addPart(o) { if (parts.length < 700) parts.push(o); }

  function spawnDust(x, y, n, power) {
    for (let i = 0; i < n; i++) {
      const life = rand(0.5, 1.3);
      addPart({
        x: x + rand(-4, 4), y: y + rand(0, 3), vx: rand(-30, 30) * power, vy: rand(5, 35) * power,
        life, max: life, col: DUST_COLS[(Math.random() * 3) | 0], size: Math.random() < 0.3 ? 2 : 1,
        grav: -8, drag: 2.5, bounce: false, fade: true,
      });
    }
  }
  function spawnDebris(x, y, n, power, bias = 0) {
    for (let i = 0; i < n; i++) {
      const life = rand(1, 2.2);
      addPart({
        x: x + rand(-3, 3), y: y + rand(1, 5),
        vx: rand(-60, 60) * power + bias, vy: rand(40, 130) * power,
        life, max: life, col: ROCK_COLS[(Math.random() * 4) | 0], size: Math.random() < 0.4 ? 2 : 1,
        grav: 320, drag: 0.3, bounce: true, fade: false,
      });
    }
  }
  function spawnSparks(x, y, n, power) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI), sp = rand(60, 200) * power, life = rand(0.2, 0.6);
      addPart({
        x, y: y + 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life, max: life, col: Math.random() < 0.5 ? '#ff2a2a' : '#ffffff',
        col2: Math.random() < 0.5 ? '#ffffff' : '#ff2a2a',
        size: Math.random() < 0.3 ? 2 : 1, grav: 160, drag: 3, bounce: false, fade: false,
      });
    }
  }

  function contactPoint() {
    const c = boulderCenter();
    return { x: c.x, y: groundH(c.x) };
  }

  function impact(I) {
    const cp = contactPoint();
    st.trauma = Math.min(1, st.trauma + 0.35 * I);
    st.whiteFlash = Math.max(st.whiteFlash, 0.16 * I);
    st.redFlash = Math.max(st.redFlash, 0.12 * I);
    spawnSparks(cp.x, cp.y, (12 + 20 * I) | 0, 0.6 + 0.5 * I);
    spawnDebris(cp.x, cp.y, (5 + 10 * I) | 0, 0.6 + 0.6 * I, st.v * 0.3);
    spawnDust(cp.x, cp.y, (6 + 10 * I) | 0, 1 + I);
    rings.push({ x: cp.x, y: cp.y + 2, r: 2, vr: 70 + 60 * I, life: 0.35, max: 0.35, col: '#ff2a2a' });
    if (I > 0.6) rings.push({ x: cp.x, y: cp.y + 2, r: 1, vr: 45 + 40 * I, life: 0.3, max: 0.3, col: '#ffffff' });
    audio.impact(I);
  }

  // ---------------------------------------------------------------------------
  // Phase updates
  // ---------------------------------------------------------------------------
  function trackAltitude() {
    const alt = groundH(st.s) * M_PER_PX;
    if (alt > st.lastAlt) stats.total += alt - st.lastAlt;
    st.lastAlt = alt;
    if (alt > stats.best) stats.best = alt;
  }

  function updateClimb(dt) {
    const pushing = held.size > 0 || st.pushTimer > 0;
    st.pushing = pushing;
    st.pushTimer = Math.max(0, st.pushTimer - dt);
    st.idle = pushing ? 0 : st.idle + dt;

    const sl = slopeAt(st.s);
    const sin = sl / Math.sqrt(1 + sl * sl);
    let a = -GRAV * sin;
    if (pushing) a += PUSH;
    st.v += a * dt;
    st.v *= Math.exp(-DAMP * dt);
    st.s += st.v * dt;
    if (st.s < 0) { st.s = 0; if (st.v < 0) st.v = 0; }
    st.walk += Math.abs(st.v) * dt * 0.3;

    st.p = clamp(groundH(st.s) / TOP, 0, 1);
    trackAltitude();

    // dislodged pebbles: more frequent on steeper ground
    if (Math.abs(st.v) > 3 && Math.random() < dt * (1 + 8 * st.p)) {
      const cp = contactPoint();
      spawnDebris(cp.x - 2, cp.y, 1, 0.4, -25);
    }

    // heartbeat + red flashes near the summit
    const q = smooth(0.8, 1, st.p);
    if (q > 0) {
      st.flashTimer -= dt;
      if (st.flashTimer <= 0) {
        st.redFlash = Math.max(st.redFlash, 0.06 + 0.14 * q);
        audio.heartbeat(0.4 + 0.6 * q);
        st.flashTimer = lerp(2.4, 0.6, q) * rand(0.8, 1.25);
      }
    }

    st.saveTimer += dt;
    if (st.saveTimer > 3) { st.saveTimer = 0; saveStats(); }

    if (st.p >= st.curseFrac) {
      st.phase = 'teeter';
      st.t = 0;
      st.curseS = st.s;
      saveStats();
    }
  }

  function updateTeeter(dt) {
    st.t += dt;
    st.pushing = true;
    const T = st.teeterT;
    if (st.t < 0.5) {
      st.v *= Math.exp(-7 * dt);
      st.curseS += st.v * dt;
    } else {
      st.v = 0;
    }
    st.curseAlt = groundH(st.curseS) * M_PER_PX;
    trackAltitude();

    const k = clamp((st.t - 0.4) / (T - 0.9), 0, 1);
    const still = st.t > T - 0.45;
    const rock = still ? 0.8 : Math.sin(st.t * 13) * 1.6 * k;
    st.s = st.curseS + rock;
    st.tremble = still ? 0 : k * 1.3;
    st.p = clamp(groundH(st.s) / TOP, 0, 1);

    if (!st.cueDone && st.t > T * 0.45) {
      st.cueDone = true;
      audio.heartbeat(1);
    }
    if (!still && Math.random() < dt * 4) {
      const cp = contactPoint();
      spawnDebris(cp.x, cp.y, 1, 0.3, -20);
    }

    if (st.t >= T) {
      st.phase = 'fall';
      st.t = 0;
      st.tremble = 0;
      st.manFrozen = true;
      st.pushing = false;
      st.v = -rand(8, 18);
      st.nextBump = st.s - rand(40, 120);
      st.trauma = Math.min(1, st.trauma + 0.3);
      st.redFlash = 0.25;
      const cp = contactPoint();
      spawnDebris(cp.x, cp.y, 8, 0.7, -30);
      spawnDust(cp.x, cp.y, 10, 1);
      audio.doom();
    }
  }

  function updateFall(dt) {
    st.t += dt;
    const sl = slopeAt(st.s);
    const sin = sl / Math.sqrt(1 + sl * sl);
    st.v -= (GRAV * 1.5 * sin + 25) * dt;
    st.v = Math.max(st.v, -MAXFALL);
    st.s += st.v * dt;
    const speedFrac = -st.v / MAXFALL;

    if (st.z > 0 || st.zv > 0) {
      st.zv -= 420 * dt;
      st.z += st.zv * dt;
      if (st.z <= 0) {
        const I = clamp(-st.zv / 150, 0.2, 1);
        st.z = 0; st.zv = 0;
        impact(I);
      }
    } else if (st.s < st.nextBump) {
      st.zv = clamp(-st.v * rand(0.25, 0.5), 30, 170);
      st.z = 0.01;
      st.nextBump = st.s - rand(70, 220);
    }

    if (st.z === 0) {
      const cp = contactPoint();
      if (Math.random() < speedFrac * 2.5) spawnDust(cp.x + 6, cp.y, 1, 0.6);
      if (Math.random() < dt * 10 * speedFrac) spawnDebris(cp.x, cp.y, 1, 0.6, st.v * 0.4);
    }

    st.trauma = Math.max(st.trauma, 0.12 + 0.28 * speedFrac);
    st.p = clamp(groundH(st.s) / TOP, 0, 1);

    if (st.s <= 0) {
      st.s = 0; st.z = 0; st.zv = 0;
      st.phase = 'settle';
      st.t = 0;
      impact(1.6);
      const cp = contactPoint();
      spawnDebris(cp.x, cp.y, 25, 1.3, 40);
      spawnDust(cp.x, cp.y, 30, 1.6);
      rings.push({ x: cp.x, y: cp.y + 2, r: 4, vr: 160, life: 0.5, max: 0.5, col: '#ffffff' });
      st.trauma = 1;
      st.whiteFlash = 0.55;
      st.redFlash = 0.35;
    }
  }

  const TITLES = ['SO CLOSE.', 'AGAIN.', 'ALMOST.', 'SO CLOSE.', 'AGAIN.', 'ONE MORE.'];

  function updateSettle(dt) {
    st.t += dt;
    st.s = -9 * Math.exp(-3 * st.t) * Math.abs(Math.sin(st.t * 6));
    st.p = 0;

    if (!st.msgShown && st.t > 1.4) {
      st.msgShown = true;
      msgTitle.textContent = TITLES[(Math.random() * TITLES.length) | 0];
      const rem = Math.max(1, Math.round(SUMMIT_M - st.curseAlt));
      msgSub.textContent = `${rem} M FROM THE SUMMIT.`;
      msgEl.classList.add('show');
      audio.bell();
      saveStats();
    }
    if (st.t > 4.4) {
      msgEl.classList.remove('show');
      st.fade = clamp((st.t - 4.4) / 0.6, 0, 1);
    }
    if (st.t > 5.1) beginAttempt();
  }

  function updateCamera(dt) {
    const c = boulderCenter();
    const falling = st.phase === 'fall';
    const lead = falling ? 200 : st.phase === 'settle' ? 160 : 120;
    st.lead = lerp(st.lead, lead, 1 - Math.exp(-2 * dt));
    st.offY = lerp(st.offY, falling ? -5 : 25, 1 - Math.exp(-2 * dt));
    const k = 1 - Math.exp(-(falling ? 9 : 4) * dt);
    st.prevCamX = st.camX;
    st.prevCamY = st.camY;
    st.camX += (c.x - st.lead - st.camX) * k;
    st.camY += (c.y + st.offY - st.camY) * k;
  }

  function spawnStreak(vx, vy, a) {
    const sp = Math.hypot(vx, vy) || 1;
    let x, y;
    if (Math.abs(vx) > Math.abs(vy)) {
      x = vx < 0 ? W + 10 : -10; y = rand(-10, HS + 10);
    } else {
      y = vy < 0 ? HS + 10 : -10; x = rand(-10, W + 10);
    }
    if (Math.random() < 0.5) { x = rand(0, W); y = rand(0, HS); }
    streaks.push({ x, y, vx, vy, len: clamp(sp * 0.04, 3, 18) | 0, a, life: 2.5 });
  }

  function updateEffects(dt) {
    // mood: hope grows as summit nears, dread takes over during the fall
    let moodT = st.mood, dreadT = 0;
    if (st.phase === 'climb' || st.phase === 'title') moodT = smooth(0.15, 1, st.p);
    else if (st.phase === 'fall' || st.phase === 'settle') { moodT = 0; dreadT = 1; }
    st.mood = lerp(st.mood, moodT, 1 - Math.exp(-(st.phase === 'fall' ? 1.5 : 2) * dt));
    st.dread = lerp(st.dread, dreadT, 1 - Math.exp(-(dreadT ? 3 : 1.2) * dt));
    st.beacon = lerp(st.beacon, st.phase === 'fall' || st.phase === 'settle' ? 0.25 : 1, 1 - Math.exp(-2 * dt));

    st.redFlash = Math.max(0, st.redFlash - dt * 0.8);
    st.whiteFlash = Math.max(0, st.whiteFlash - dt * 1.6);
    if (st.phase === 'climb' && st.fade > 0) st.fade = Math.max(0, st.fade - dt * 1.4);

    let floor = 0;
    if (st.phase === 'climb') floor = smooth(0.72, 1, st.p) * 0.45;
    st.trauma = Math.max(floor, st.trauma - dt * 1.3);

    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life -= dt;
      if (q.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      q.vy -= q.grav * dt;
      const d = Math.exp(-q.drag * dt);
      q.vx *= d; q.vy *= d;
      q.x += q.vx * dt; q.y += q.vy * dt;
      if (q.bounce) {
        const gh = groundH(q.x);
        if (q.y < gh) {
          q.y = gh;
          if (q.vy < 0) q.vy = -q.vy * 0.35;
          q.vx *= 0.75;
        }
      }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= dt; r.r += r.vr * dt;
      if (r.life <= 0) rings.splice(i, 1);
    }

    // wind streaks while climbing, speed lines while falling
    if (st.phase === 'climb' || st.phase === 'title') {
      const w = smooth(0.35, 1, st.p);
      if (Math.random() < dt * (6 + 90 * w)) {
        spawnStreak(-(120 + 260 * w) * rand(0.8, 1.2), rand(10, 40) * (1 + w), 0.2 + 0.4 * w);
      }
    } else if (st.phase === 'fall' && dt > 0) {
      const cvx = -(st.camX - st.prevCamX) / dt;
      const cvy = (st.camY - st.prevCamY) / dt;
      const sp = Math.hypot(cvx, cvy);
      if (sp > 60 && Math.random() < dt * sp * 0.35) spawnStreak(cvx * 1.3, cvy * 1.3, 0.35);
    }
    for (let i = streaks.length - 1; i >= 0; i--) {
      const s = streaks[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0 || s.x < -40 || s.x > W + 40 || s.y < -40 || s.y > HS + 40) streaks.splice(i, 1);
    }
    if (streaks.length > 200) streaks.splice(0, streaks.length - 200);
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const hudCache = {};
  function setText(key, el, v) {
    if (hudCache[key] !== v) { hudCache[key] = v; el.textContent = v; }
  }
  function updateHud() {
    const alt = Math.round(groundH(st.s) * M_PER_PX);
    setText('a', hud.attempt, String(stats.attempts));
    setText('b', hud.alt, String(alt));
    setText('c', hud.best, String(Math.round(stats.best)));
    setText('d', hud.total, String(Math.round(stats.total)));
    hintEl.classList.toggle('show', st.phase === 'climb' && st.idle > 2.5);
  }

  // ---------------------------------------------------------------------------
  // Sprites
  // ---------------------------------------------------------------------------
  const SPR = 2 * R + 2;
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  const rockTex = makeCanvas(SPR, SPR);
  const rockShade = makeCanvas(SPR, SPR);
  (() => {
    const tx = rockTex.getContext('2d');
    const sx = rockShade.getContext('2d');
    const cracks = new Set();
    const line = (x0, y0, x1, y1) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i++) {
        cracks.add(`${Math.round(lerp(x0, x1, i / n))},${Math.round(lerp(y0, y1, i / n))}`);
      }
    };
    line(-6, -4, -1, 1); line(-1, 1, 3, 0); line(2, 4, 5, 8); line(4, -7, 7, -3);
    for (let y = 0; y < SPR; y++) {
      for (let x = 0; x < SPR; x++) {
        const dx = x + 0.5 - SPR / 2, dy = y + 0.5 - SPR / 2;
        const d = Math.hypot(dx, dy);
        if (d > R + 0.5) continue;
        const key = `${Math.round(dx - 0.5)},${Math.round(dy - 0.5)}`;
        let col;
        if (d > R - 0.6) col = '#3a332d';
        else if (cracks.has(key)) col = '#4e4740';
        else if (Math.hypot(dx + 3, dy - 4) < 2.5) col = '#a8a092';
        else col = ['#8f877c', '#857d72', '#9a9286', '#7a7268', '#8a8276'][hash(x, y) % 5];
        tx.fillStyle = col;
        tx.fillRect(x, y, 1, 1);

        if (d <= R - 0.6) {
          const light = (-dx * 0.55 - dy * 0.75) / R;
          if (light < -0.4) sx.fillStyle = 'rgba(20,10,10,0.45)';
          else if (light < -0.05) sx.fillStyle = (x + y) % 2 ? 'rgba(20,10,10,0.25)' : 'rgba(0,0,0,0)';
          else if (light > 0.55) sx.fillStyle = 'rgba(255,240,210,0.3)';
          else continue;
          sx.fillRect(x, y, 1, 1);
        }
      }
    }
  })();

  function makeVignette(color, alpha) {
    const c = makeCanvas(W, HS);
    const x = c.getContext('2d');
    const img = x.createImageData(W, HS);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < HS; y++) {
      for (let px = 0; px < W; px++) {
        const dx = (px - W / 2) / (W / 2), dy = (y - HS / 2) / (HS / 2);
        const v = clamp((Math.sqrt(dx * dx * 0.8 + dy * dy) - 0.7) / 0.6, 0, 1);
        if (v > (bayer[(y & 3) * 4 + (px & 3)] + 0.5) / 16) {
          const i = (y * W + px) * 4;
          img.data[i] = color[0]; img.data[i + 1] = color[1]; img.data[i + 2] = color[2];
          img.data[i + 3] = alpha;
        }
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  const vigDark = makeVignette([0, 0, 0], 150);
  const vigRed = makeVignette([200, 10, 10], 255);

  const stars = Array.from({ length: 70 }, () => ({ x: rand(0, W), y: rand(0, 120), b: rand(0.3, 1) }));

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const PAL = {
    duskTop: hex('#140c26'), duskBot: hex('#5b2c4f'),
    hopeTop: hex('#3a5fa8'), hopeBot: hex('#ffd58a'),
    dreadTop: hex('#0d0408'), dreadBot: hex('#6a1414'),
    farA: hex('#3a2343'), farB: hex('#c98d6a'),
    nearA: hex('#24162c'), nearB: hex('#8a5a4a'),
    dreadMtn: hex('#2a0c10'),
    edgeA: hex('#d8b88a'), edgeB: hex('#fff0b0'),
    top: hex('#9c7a58'), mid: hex('#6e523e'), deep: hex('#4a3529'), speck: hex('#3a2a20'),
  };

  function pixelDisk(cx, cy, r) {
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1);
    }
  }

  function drawSky() {
    const top = mix(mix(PAL.duskTop, PAL.hopeTop, st.mood), PAL.dreadTop, st.dread * 0.8);
    const bot = mix(mix(PAL.duskBot, PAL.hopeBot, st.mood), PAL.dreadBot, st.dread * 0.8);
    const bands = 12, bh = HS / bands;
    for (let i = 0; i < bands; i++) {
      ctx.fillStyle = css(mix(top, bot, i / (bands - 1)));
      ctx.fillRect(0, Math.floor(i * bh), W, Math.ceil(bh));
    }
    const sa = (1 - st.mood) * 0.8;
    if (sa > 0.02) {
      for (const s of stars) {
        ctx.fillStyle = `rgba(255,245,230,${(sa * s.b).toFixed(2)})`;
        ctx.fillRect(s.x | 0, s.y | 0, 1, 1);
      }
    }
    // the sun of hope rises as the summit nears
    if (st.mood > 0.02) {
      const sy = Math.round(lerp(170, 36, st.mood));
      ctx.fillStyle = `rgba(255,230,160,${(0.18 * st.mood).toFixed(2)})`;
      pixelDisk(240, sy, 18);
      ctx.fillStyle = `rgba(255,241,194,${st.mood.toFixed(2)})`;
      pixelDisk(240, sy, 12);
    }
  }

  function drawRange(par, base, amp, freqs, col) {
    ctx.fillStyle = css(col);
    const yo = base + st.camY * par * 0.25;
    for (let x = -8; x < W + 8; x++) {
      const wx = x + st.camX * par;
      const h = amp * (0.55 + 0.25 * Math.sin(wx * freqs[0]) + 0.15 * Math.sin(wx * freqs[1] + 1) + 0.05 * Math.sin(wx * freqs[2]));
      const y = Math.round(yo - h);
      if (y < HS + 8) ctx.fillRect(x, y, 1, HS + 8 - y);
    }
  }

  function drawTerrain(cx, cy) {
    const edge = mix(PAL.edgeA, PAL.edgeB, st.mood * 0.8);
    const layers = [
      [css(PAL.deep), 40, 400], [css(PAL.mid), 12, 30], [css(PAL.top), 2, 10], [css(edge), 0, 2],
    ];
    const ys = new Int32Array(W + 16);
    for (let x = -8; x < W + 8; x++) ys[x + 8] = Math.round(OY - groundH(cx + x) + cy);
    for (const [col, off, h] of layers) {
      ctx.fillStyle = col;
      for (let x = -8; x < W + 8; x++) {
        const y = ys[x + 8] + off;
        if (y < HS + 8) ctx.fillRect(x, y, 1, Math.min(h, HS + 8 - y));
      }
    }
    ctx.fillStyle = css(PAL.speck);
    for (let x = -8; x < W + 8; x++) {
      const wx = cx + x;
      for (let k = 0; k < 4; k++) {
        if ((hash(wx, k + 7) & 3) !== 0) continue;
        const y = ys[x + 8] + 4 + (hash(wx, k) % 70);
        if (y < HS + 8) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  function drawSummit(cx, cy) {
    const x = FLAG_X - cx, y = Math.round(OY - TOP + cy);
    if (x < -40 || x > W + 40) return;
    const b = st.beacon;
    // light beam
    ctx.fillStyle = `rgba(255,230,150,${(0.07 * b * (0.6 + st.mood)).toFixed(3)})`;
    ctx.fillRect(x - 3, -10, 7, y + 10);
    ctx.fillRect(x - 1, -10, 3, y + 10);
    // glow
    const pulse = Math.round(Math.sin(st.time * 3) * 1.5);
    ctx.fillStyle = `rgba(255,220,120,${(0.22 * b).toFixed(3)})`;
    pixelDisk(x, y - 10, 11 + pulse);
    // pole + flag
    ctx.fillStyle = '#e8e2d6';
    ctx.fillRect(x, y - 16, 1, 16);
    const wave = Math.floor(st.time * 6) % 2;
    ctx.fillStyle = b > 0.5 ? '#ffd24a' : '#8a6a2a';
    ctx.fillRect(x + 1, y - 16, 6, 2);
    ctx.fillRect(x + 1, y - 14 + wave, 7, 2);
  }

  // Articulated pusher (world units, y up).
  // Balance: forces on the man are gravity (0,-mg) and the boulder's reaction
  // F*(-cos t, -sin t). The ground reaction (F cos t, mg + F sin t) must pass
  // through the centre of mass, so the lean from vertical is
  //   tan(phi) = F cos t / (mg + F sin t),  F = k*mg*(sin t + Crr cos t).
  const LEG = 5, TORSO = 7, ARM = 4, REACH = 6, HIP_H = 8.5;
  const MASS_RATIO = 1.2, C_RR = 0.08;

  function ik(ax, ay, bx, by, L, px, py) {
    let dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1e-6;
    const maxd = 2 * L - 0.01;
    if (d > maxd) { bx = ax + dx / d * maxd; by = ay + dy / d * maxd; dx = bx - ax; dy = by - ay; d = maxd; }
    const h = Math.sqrt(Math.max(0, L * L - d * d / 4));
    let nx = -dy / d, ny = dx / d;
    if (nx * px + ny * py < 0) { nx = -nx; ny = -ny; }
    return { jx: ax + dx / 2 + nx * h, jy: ay + dy / 2 + ny * h, ex: bx, ey: by };
  }

  function placeMan() {
    const c = boulderCenter();
    const th = Math.atan(slopeAt(st.s));
    const k = MASS_RATIO * (st.pushing ? 1 : 0.6) * (Math.sin(th) + C_RR * Math.cos(th));
    const target = clamp(Math.atan2(k * Math.cos(th), 1 + k * Math.sin(th)), 0.26, 0.9);
    st.manLean = lerp(st.manLean || target, target, 0.15);
    const phi = st.manLean, tp = phi + 0.25;  // hips flex: torso leans a bit more than legs
    const lx = Math.sin(phi), ly = Math.cos(phi), tx = Math.sin(tp), ty = Math.cos(tp);
    const body = (f) => {
      const gy = groundH(f), hx = f + HIP_H * lx, hy = gy + HIP_H * ly;
      return { f, gy, hx, hy, sx: hx + TORSO * tx, sy: hy + TORSO * ty };
    };
    // Bisection: slide the stance point until shoulder-to-boulder gap equals arm reach.
    let lo = c.x - 60, hi = c.x;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2, b = body(m);
      if (Math.hypot(b.sx - c.x, b.sy - c.y) - R > REACH) lo = m; else hi = m;
    }
    const b = body(lo);
    st.manX = lo;

    // Hands on the boulder surface, on the shoulder-facing side.
    const a0 = Math.atan2(b.sy - c.y, b.sx - c.x);
    const hand = (da) => ({ x: c.x + Math.cos(a0 + da) * R, y: c.y + Math.sin(a0 + da) * R });
    const ux = Math.cos(th), uy = Math.sin(th);
    const arm = (h) => ik(b.sx, b.sy, h.x, h.y, ARM, 0, -1);           // elbows bend down
    // Feet: stance centred under the balance line, stepping with walk phase.
    const sw = Math.sin(st.walk), cw = Math.cos(st.walk);
    const foot = (off, lift) => {
      const fx = lo - 1.5 + off * ux;
      return { x: fx, y: groundH(fx) + lift };
    };
    const fa = foot(3.5 * sw, Math.max(0, cw) * 1.5);
    const fb = foot(-3.5 * sw, Math.max(0, -cw) * 1.5);
    const leg = (ft) => ik(b.hx, b.hy, ft.x, ft.y, LEG, ux, uy);        // knees bend forward

    st.pose = {
      ...b, tx, ty,
      armB: arm(hand(0.12)), armF: arm(hand(-0.08)),
      legB: leg(fb), legF: leg(fa),
      headX: b.sx + 3 * Math.sin(tp - 0.5), headY: b.sy + 3 * Math.cos(tp - 0.5),
    };
  }

  function drawMan(cx, cy) {
    const fx = st.manX, fy = groundH(fx);
    const sx = Math.round(fx - cx), sy = Math.round(OY - fy + cy);
    if (sx < -30 || sx > W + 30 || sy < -30 || sy > HS + 30) return;
    const SKIN = '#c98b5e', SKIN_D = '#9a6440', CLOTH = '#e8e0d0', HAIR = '#2a1a12';
    ctx.save();
    ctx.translate(sx, sy);
    if (st.manFrozen) {
      ctx.scale(-1, 1);
      ctx.fillStyle = SKIN_D; ctx.fillRect(-2, -6, 2, 6); ctx.fillRect(1, -6, 2, 6);
      ctx.fillStyle = CLOTH; ctx.fillRect(-2, -8, 5, 2);
      ctx.fillStyle = SKIN; ctx.fillRect(-2, -13, 5, 5);
      ctx.fillStyle = SKIN_D; ctx.fillRect(3, -13, 1, 6); ctx.fillRect(-3, -13, 1, 6);
      ctx.fillStyle = SKIN; ctx.fillRect(0, -16, 4, 3);
      ctx.fillStyle = HAIR; ctx.fillRect(0, -17, 4, 1);
    }
    ctx.restore();
    if (st.manFrozen || !st.pose) return;

    const p = st.pose;
    const seg = (ax, ay, bx, by, w, col) => {
      ctx.fillStyle = col;
      const x0 = ax - cx, y0 = OY - ay + cy, x1 = bx - cx, y1 = OY - by + cy;
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
      const o = w >> 1;
      for (let i = 0; i <= n; i++) {
        ctx.fillRect(Math.round(lerp(x0, x1, i / n)) - o, Math.round(lerp(y0, y1, i / n)) - o, w, w);
      }
    };
    const limb = (rx, ry, j, col) => {
      seg(rx, ry, j.jx, j.jy, 2, col);
      seg(j.jx, j.jy, j.ex, j.ey, 2, col);
    };
    limb(p.sx, p.sy, p.armB, SKIN_D);
    limb(p.hx, p.hy, p.legB, SKIN_D);
    seg(p.hx, p.hy, p.sx, p.sy, 3, SKIN);
    seg(p.hx - p.tx, p.hy - p.ty, p.hx + 2 * p.tx, p.hy + 2 * p.ty, 4, CLOTH);
    limb(p.hx, p.hy, p.legF, SKIN);
    const hx = Math.round(p.headX - cx), hy = Math.round(OY - p.headY + cy);
    ctx.fillStyle = HAIR; pixelDisk(hx, hy, 2);
    ctx.fillStyle = SKIN; pixelDisk(hx + 1, hy, 2);
    limb(p.sx, p.sy, p.armF, SKIN);
  }

  function drawBoulder(cx, cy) {
    const c = boulderCenter();
    const j = st.tremble;
    const sx = Math.round(c.x - cx + (j ? rand(-j, j) : 0));
    const sy = Math.round(OY - c.y + cy + (j ? rand(-j * 0.5, j * 0.5) : 0));
    // contact shadow
    if (st.z > 1) {
      const gy = Math.round(OY - groundH(c.x) + cy);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(sx - 6, gy - 1, 13, 2);
    }
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(st.angle);
    ctx.drawImage(rockTex, -SPR / 2, -SPR / 2);
    ctx.restore();
    ctx.drawImage(rockShade, sx - SPR / 2, sy - SPR / 2);
  }

  function drawParticles(cx, cy) {
    const flick = ((st.time * 30) | 0) % 2;
    for (const q of parts) {
      const x = Math.round(q.x - cx), y = Math.round(OY - q.y + cy);
      if (x < -4 || x > W + 4 || y < -4 || y > HS + 4) continue;
      ctx.globalAlpha = q.fade ? clamp(q.life / q.max, 0, 1) * 0.8 : 1;
      ctx.fillStyle = q.col2 && flick ? q.col2 : q.col;
      ctx.fillRect(x, y, q.size, q.size);
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      const x = r.x - cx, y = OY - r.y + cy;
      ctx.fillStyle = r.col;
      ctx.globalAlpha = clamp(r.life / r.max, 0, 1);
      const n = Math.max(12, Math.round(r.r * 3));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        ctx.fillRect(Math.round(x + Math.cos(a) * r.r), Math.round(y + Math.sin(a) * r.r * 0.6), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawStreaks() {
    for (const s of streaks) {
      const sp = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / sp, uy = s.vy / sp;
      ctx.fillStyle = `rgba(255,255,255,${s.a.toFixed(2)})`;
      for (let i = 0; i < s.len; i++) ctx.fillRect(Math.round(s.x - ux * i), Math.round(s.y - uy * i), 1, 1);
    }
  }

  function drawAltitudeBar() {
    const bx = 306, y0 = 30, y1 = 152, hgt = y1 - y0;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 1, y0 - 1, 5, hgt + 2);
    const fh = Math.round(hgt * st.p);
    ctx.fillStyle = css(mix(hex('#b8a58c'), hex('#ffd24a'), st.mood));
    ctx.fillRect(bx, y1 - fh, 3, fh);
    const by = y1 - Math.round(hgt * clamp(stats.best / SUMMIT_M, 0, 1));
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(bx - 2, by, 7, 1);
    // summit flag
    const glow = 0.4 + 0.6 * st.beacon * (0.5 + 0.5 * Math.sin(st.time * 4));
    ctx.fillStyle = `rgba(255,220,120,${(0.3 * glow).toFixed(2)})`;
    pixelDisk(bx + 2, y0 - 6, 5);
    ctx.fillStyle = '#e8e2d6';
    ctx.fillRect(bx + 1, y0 - 11, 1, 9);
    ctx.fillStyle = '#ffd24a';
    ctx.fillRect(bx + 2, y0 - 11, 4, 3);
    // boulder marker
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx - 2, y1 - fh - 1, 7, 3);
  }

  function render() {
    drawSky();

    const shake = st.trauma * st.trauma;
    const ox = Math.round((Math.random() * 2 - 1) * 7 * shake);
    const oy = Math.round((Math.random() * 2 - 1) * 5 * shake);
    const cx = Math.round(st.camX), cy = Math.round(st.camY);

    ctx.save();
    ctx.translate(ox, oy);
    const far = mix(mix(PAL.farA, PAL.farB, st.mood * 0.55), PAL.dreadMtn, st.dread * 0.6);
    const near = mix(mix(PAL.nearA, PAL.nearB, st.mood * 0.45), PAL.dreadMtn, st.dread * 0.6);
    drawRange(0.12, 128, 60, [0.021, 0.053, 0.13], far);
    drawRange(0.35, 158, 50, [0.034, 0.081, 0.21], near);
    drawSummit(cx, cy);
    drawTerrain(cx, cy);
    drawBoulder(cx, cy);
    drawMan(cx, cy);
    drawParticles(cx, cy);
    ctx.restore();

    drawStreaks();
    drawAltitudeBar();

    ctx.drawImage(vigDark, 0, 0);
    if (st.redFlash > 0.005) {
      ctx.fillStyle = `rgba(190,0,0,${(st.redFlash * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, W, HS);
      ctx.globalAlpha = clamp(st.redFlash * 2.5, 0, 1);
      ctx.drawImage(vigRed, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (st.dread > 0.02) {
      ctx.globalAlpha = st.dread * 0.35;
      ctx.drawImage(vigRed, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (st.whiteFlash > 0.005) {
      ctx.fillStyle = `rgba(255,255,255,${st.whiteFlash.toFixed(3)})`;
      ctx.fillRect(0, 0, W, HS);
    }
    if (st.fade > 0.005) {
      ctx.fillStyle = `rgba(7,6,11,${st.fade.toFixed(3)})`;
      ctx.fillRect(0, 0, W, HS);
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  function update(dt) {
    st.time += dt;
    const prevS = st.s;
    switch (st.phase) {
      case 'climb': updateClimb(dt); break;
      case 'teeter': updateTeeter(dt); break;
      case 'fall': updateFall(dt); break;
      case 'settle': updateSettle(dt); break;
      default: break;
    }
    st.angle += (st.s - prevS) / R;
    if (!st.manFrozen) placeMan();
    updateCamera(dt);
    updateEffects(dt);
    const speedFrac = st.phase === 'fall' ? -st.v / MAXFALL : Math.abs(st.v) / 60;
    audio.update(dt, st.phase, st.p, clamp(speedFrac, 0, 1));
    updateHud();
  }

  snapCamera();
  placeMan();
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
