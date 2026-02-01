(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const ui = {
    overlay: document.getElementById("overlay"),
    startBtn: document.getElementById("startBtn"),
    resetBtn: document.getElementById("resetBtn"),
    time: document.getElementById("time"),
    strikes: document.getElementById("strikes"),
    maxStrikes: document.getElementById("maxStrikes"),
    mode: document.getElementById("mode"),
    eventPill: document.getElementById("eventPill"),
    recatchPill: document.getElementById("recatchPill"),
    toast: document.getElementById("toast"),
  };

  // -------------------------
  // Helpers
  // -------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist2 = (ax, ay, bx, by) => {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  };

  function showToast(msg, ms = 900) {
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => ui.toast.classList.remove("show"), ms);
  }

  // WebAudio buzz
  let audio = null;
  function initAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    audio = new AC();
  }
  function buzz() {
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "square";
    o.frequency.value = 95;
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(audio.destination);
    const now = audio.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.28, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    o.start(now);
    o.stop(now + 0.22);
  }

  function closestPointSeg(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby || 1e-9;
    let t = (apx * abx + apy * aby) / ab2;
    t = clamp(t, 0, 1);
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    return { cx, cy, t, d2: dist2(px, py, cx, cy) };
  }

  // Catmull-Rom (desktop only; mobile uses linear to avoid spline loops)
  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      ),
      y: 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      )
    };
  }

  // -------------------------
  // Game state
  // -------------------------
  const state = {
    w: 0,
    h: 0,
    running: false,
    won: false,
    over: false,

    // playfield rectangle (keeps the wire out of the HUD area)
    play: { x: 0, y: 0, w: 0, h: 0 },
    uiScale: 1,

    // device profile
    device: { kind: "desktop", isMobile: false },

    startAt: 0,
    now: 0,

    strikes: 0,
    maxStrikes: 3,

    controlMode: "mouse", // "mouse" or "keys"
    keys: new Set(),

    mouse: {
      x: 0, y: 0,           // smoothed
      rawX: 0, rawY: 0,     // raw cursor/target
      movedAt: 0
    },

    pointer: {
      active: false,
      id: null,
      type: "mouse" // "touch" | "pen" | "mouse"
    },

    // Touch-relative steering (feels way better on phones)
    touch: {
      relative: true,   // auto enabled for touch/pen
      originX: 0, originY: 0,   // where finger first touched
      anchorX: 0, anchorY: 0,   // ring position at touch start (target anchor)
      maxRadius: 230,           // pixels, scaled by uiScale
      gain: 1.25,               // sensitivity multiplier
      deadzone: 6               // pixels, scaled by uiScale
    },

    sabotageText: "No sabotage… yet.",
    sabotageUntil: 0,
    invertUntil: 0,
    windUntil: 0,
    wobbleUntil: 0,
    pinchUntil: 0,

    nextSabotageAt: 0,
    nextMorphAt: 0,

    shake: 0,

    recatchUntil: 0,
    inRecatch: false,

    bestProgress: 0,

    wireSamples: [],
    wireCumLen: [],
    wireTotalLen: 1,

    // input gating + countdown
    inputEnabled: false,
    countdownUntil: 0,
    countdownSeconds: 5
  };

  const player = {
    x: 0, y: 0,
    vx: 0, vy: 0,

    outerR: 20,
    innerR: 13,

    // base tuning (device profile adjusts these)
    maxSpeed: 650,
    drag: 4.2,
    lag: 0.06,

    mouseSmooth: 0.16,
    arriveRadius: 120,
    steering: 14.0,

    accelKeys: 1200,
    jitterKeys: 70
  };

  const wire = {
    base: [],
    curr: [],
    from: [],
    to: [],
    morphing: false,
    morphStart: 0,
    morphDur: 950,
    slitherPhase: 0
  };

  // -------------------------
  // Device profile
  // -------------------------
  function detectDeviceKind() {
    // Prefer capability detection over UA.
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const small = Math.min(state.w || window.innerWidth, state.h || window.innerHeight) <= 700;
    const mobile = coarse || small;
    return mobile ? "mobile" : "desktop";
  }

  function applyDeviceTuning(kind) {
    const mobile = (kind === "mobile");
    state.device.kind = kind;
    state.device.isMobile = mobile;

    if (mobile) {
      // more stable + slightly slower (still hard)
      player.maxSpeed = 540;
      player.arriveRadius = 175;
      player.steering = 12.2;
      player.mouseSmooth = 0.20;
      player.drag = 4.9;
      player.lag = 0.05;

      player.accelKeys = 1050;
      player.jitterKeys = 55;

      // touch relative tuning scales with uiScale later
      state.touch.maxRadius = 250;
      state.touch.gain = 1.30;
      state.touch.deadzone = 7;
    } else {
      player.maxSpeed = 650;
      player.arriveRadius = 120;
      player.steering = 14.0;
      player.mouseSmooth = 0.16;
      player.drag = 4.2;
      player.lag = 0.06;

      player.accelKeys = 1200;
      player.jitterKeys = 70;

      state.touch.maxRadius = 230;
      state.touch.gain = 1.25;
      state.touch.deadzone = 6;
    }
  }

  // -------------------------
  // Coordinate mapping
  // -------------------------
  function normToPx(p) {
    return {
      x: state.play.x + p.x * state.play.w,
      y: state.play.y + p.y * state.play.h
    };
  }

  function pxToPlayClamped(x, y) {
    const pad = 10 * (state.uiScale || 1);
    return {
      x: clamp(x, state.play.x + pad, state.play.x + state.play.w - pad),
      y: clamp(y, state.play.y + pad, state.play.y + state.play.h - pad),
    };
  }

  // -------------------------
  // Mobile wire: monotone-x curve (no self-crossings)
  // -------------------------
  function makeHellWireMobile(seed = 7331) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

    const pts = [];
    const x0 = 0.05, x1 = 0.95;
    const n = 85; // shorter course

    // smooth noise (keeps it curvy but not insane)
    let y = 0.55;
    let vy = 0;

    for (let i = 0; i < n; i++) {
      const x = lerp(x0, x1, i / (n - 1));

      // random acceleration with damping
      const acc = (rnd() - 0.5) * 0.09;
      vy = (vy + acc) * 0.72;
      y += vy;

      // occasional spike/dip (still monotone-x, so no self-cross)
      if (i % 17 === 0 && i > 0 && i < n - 1) {
        y += (rnd() < 0.5 ? -1 : 1) * (0.10 + rnd() * 0.10);
      }

      y = clamp(y, 0.06, 0.94);
      pts.push({ x, y });
    }

    // Add 1–2 "tight knots" without crossings: local wiggles in y only
    const knots = [Math.floor(n * 0.35), Math.floor(n * 0.62)];
    for (const k of knots) {
      if (k < 3 || k > n - 4) continue;
      const base = pts[k].y;
      pts[k - 1].y = clamp(base + (rnd() - 0.5) * 0.18, 0.06, 0.94);
      pts[k].y = clamp(base + (rnd() - 0.5) * 0.20, 0.06, 0.94);
      pts[k + 1].y = clamp(base + (rnd() - 0.5) * 0.18, 0.06, 0.94);
    }

    // Ensure endpoints are nice
    pts[0].y = clamp(pts[0].y, 0.30, 0.75);
    pts[n - 1].y = clamp(pts[n - 1].y, 0.30, 0.75);
    return pts;
  }

  // Desktop wire: gnarly + loops allowed
  function makeHellWireDesktop(seed = 1337) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

    const pts = [];
    let x = 0.03, y = 0.55;
    pts.push({ x, y });

    const n = 140;
    for (let i = 1; i < n; i++) {
      const forward = 0.006 + rnd() * 0.008;
      const backChance = (i % 17 === 0) ? 0.45 : 0.12;
      const dx = (rnd() < backChance) ? -forward * (0.2 + rnd() * 0.5) : forward;
      const dy = (rnd() - 0.5) * (0.08 + rnd() * 0.09);

      x = clamp(x + dx, 0.02, 0.98);
      y = clamp(y + dy, 0.02, 0.98);

      if (i % 19 === 0) {
        y = clamp(y + (rnd() < 0.5 ? -1 : 1) * (0.18 + rnd() * 0.22), 0.02, 0.98);
      }
      pts.push({ x, y });
    }
    pts[pts.length - 1] = { x: 0.97, y: 0.52 };

    // gnarly loops
    const injectAt = [32, 64, 101];
    for (const idx of injectAt) {
      if (idx <= 2 || idx >= pts.length - 3) continue;
      const c = pts[idx];
      const r = 0.06;
      const loop = [];
      const steps = 10;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2.0;
        loop.push({
          x: clamp(c.x + Math.cos(a) * r * (0.7 + rnd() * 0.7), 0.02, 0.98),
          y: clamp(c.y + Math.sin(a) * r * (0.7 + rnd() * 0.7), 0.02, 0.98),
        });
      }
      pts.splice(idx, 0, ...loop);
    }
    return pts;
  }

  function buildWireForDevice(kind) {
    const pts = (kind === "mobile") ? makeHellWireMobile(7331) : makeHellWireDesktop(1337);

    wire.base = pts;
    wire.curr = pts.map(p => ({ ...p }));
    wire.morphing = false;

    state.recatchUntil = 0;
    state.inRecatch = false;
    ui.recatchPill.style.display = "none";

    rebuildWireSamples();
    startPosition();
  }

  // -------------------------
  // Sampling (mobile linear, desktop spline)
  // -------------------------
  function rebuildWireSamples() {
    const cps = wire.curr;
    const samples = [];
    const cum = [0];

    if (state.device.isMobile) {
      // Linear interpolation (prevents Catmull-Rom overshoot loops)
      const segSamples = 14; // smoother line on phones
      for (let i = 0; i < cps.length - 1; i++) {
        const a = cps[i], b = cps[i + 1];
        for (let j = 0; j < segSamples; j++) {
          const t = j / segSamples;
          samples.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
        }
      }
      samples.push(cps[cps.length - 1]);
    } else {
      const segSamples = 10;
      for (let i = 0; i < cps.length - 1; i++) {
        const p0 = cps[Math.max(0, i - 1)];
        const p1 = cps[i];
        const p2 = cps[i + 1];
        const p3 = cps[Math.min(cps.length - 1, i + 2)];
        for (let j = 0; j < segSamples; j++) {
          const t = j / segSamples;
          samples.push(catmullRom(p0, p1, p2, p3, t));
        }
      }
      samples.push(cps[cps.length - 1]);
    }

    const px = samples.map(normToPx);
    let total = 0;
    for (let i = 1; i < px.length; i++) {
      total += Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
      cum.push(total);
    }

    state.wireSamples = px;
    state.wireCumLen = cum;
    state.wireTotalLen = Math.max(1, total);
  }

  function startPosition() {
    const p = normToPx(wire.curr[0]);
    player.x = p.x;
    player.y = p.y;
    player.vx = 0;
    player.vy = 0;
    state.bestProgress = 0;

    // reset targets to ring so we never jump
    state.mouse.rawX = player.x;
    state.mouse.rawY = player.y;
    state.mouse.x = player.x;
    state.mouse.y = player.y;
    state.mouse.movedAt = performance.now();
  }

  // -------------------------
  // Layout / resize
  // -------------------------
  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const vv = window.visualViewport;

    state.w = Math.round(vv ? vv.width : window.innerWidth);
    state.h = Math.round(vv ? vv.height : window.innerHeight);

    canvas.width = Math.floor(state.w * dpr);
    canvas.height = Math.floor(state.h * dpr);
    canvas.style.width = state.w + "px";
    canvas.style.height = state.h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scale up on small screens so the wire doesn't look tiny
    state.uiScale = clamp(Math.min(state.w, state.h) / 520, 1.0, 1.45);

    // Measure the HUD so we don't guess padding
    const hudEl = document.querySelector(".hud");
    const hudRect = hudEl ? hudEl.getBoundingClientRect() : { bottom: 0 };

    const sidePad = 10 * state.uiScale;
    const topPad = hudRect.bottom + (10 * state.uiScale);
    const bottomPad = 18 * state.uiScale;

    state.play.x = sidePad;
    state.play.y = topPad;
    state.play.w = Math.max(1, state.w - sidePad * 2);
    state.play.h = Math.max(1, state.h - topPad - bottomPad);

    // ring scales with UI
    player.outerR = 20 * state.uiScale;
    player.innerR = 13 * state.uiScale;

    // device detection + wire profile swap
    const kind = detectDeviceKind();
    const changed = (kind !== state.device.kind);
    applyDeviceTuning(kind);

    if (changed || wire.curr.length === 0) {
      buildWireForDevice(kind);
    } else {
      rebuildWireSamples();
      if (!state.running) startPosition();
    }
  }

  // -------------------------
  // Input gating + countdown
  // -------------------------
  function setInputEnabled(on) {
    state.inputEnabled = on;
    if (!on) {
      state.keys.clear();
      // freeze target to ring
      state.mouse.rawX = player.x;
      state.mouse.rawY = player.y;
      state.mouse.x = player.x;
      state.mouse.y = player.y;
      state.mouse.movedAt = performance.now();
      player.vx = 0;
      player.vy = 0;
    }
  }

  function beginCountdown(t) {
    state.countdownUntil = t + state.countdownSeconds * 1000;
    setInputEnabled(false);
    ui.eventPill.textContent = `Get ready… ${state.countdownSeconds}`;
  }

  // -------------------------
  // Sabotage / Morphing
  // -------------------------
  function scheduleNextSabotage(t) {
    const mobile = state.device.isMobile;
    const base = mobile ? 11000 : 8000;
    const jitter = mobile ? 9000 : 6500;
    state.nextSabotageAt = t + base + Math.random() * jitter;
  }

  function scheduleNextMorph(t) {
    const mobile = state.device.isMobile;
    const base = mobile ? 32000 : 24000;
    const jitter = mobile ? 28000 : 22000;
    state.nextMorphAt = t + base + Math.random() * jitter;
  }

  function triggerSabotage(t) {
    const roll = Math.random();
    const dur = 1200 + Math.random() * 1500;

    state.sabotageText = "Something feels… wrong.";
    state.sabotageUntil = t + dur;

    if (roll < 0.25) {
      state.invertUntil = t + dur;
      state.sabotageText = "Controls inverted. (Sorry.)";
    } else if (roll < 0.50) {
      state.windUntil = t + dur;
      state.sabotageText = "A mysterious wind pushes you.";
    } else if (roll < 0.72) {
      state.wobbleUntil = t + dur;
      state.sabotageText = "Wobble mode: enabled (unfortunately).";
    } else {
      state.pinchUntil = t + dur;
      state.sabotageText = "Tolerance shrinks. Breathe carefully.";
    }

    if (Math.random() < 0.18) state.shake = Math.max(state.shake, 8);

    ui.eventPill.textContent = state.sabotageText;
    scheduleNextSabotage(t);
  }

  function triggerMorph(t) {
    wire.morphing = true;
    wire.morphStart = t;

    wire.from = wire.curr.map(p => ({ ...p }));
    wire.to = wire.curr.map(p => ({ ...p }));

    const mobile = state.device.isMobile;
    const k = mobile ? (3 + Math.floor(Math.random() * 3)) : (6 + Math.floor(Math.random() * 7));

    for (let i = 0; i < k; i++) {
      const idx = 2 + Math.floor(Math.random() * (wire.to.length - 4));
      const p = wire.to[idx];

      if (mobile) {
        // Mobile: adjust Y only to keep monotone-x shape (prevents crossings)
        p.y = clamp(p.y + (Math.random() - 0.5) * 0.18, 0.06, 0.94);
      } else {
        p.x = clamp(p.x + (Math.random() - 0.5) * 0.14, 0.02, 0.98);
        p.y = clamp(p.y + (Math.random() - 0.5) * 0.18, 0.02, 0.98);
      }
    }

    state.recatchUntil = t + 1600;
    state.inRecatch = true;
    ui.recatchPill.style.display = "inline-block";
    ui.eventPill.textContent = "WIRE SHIFT! Recatch it!";
    state.shake = Math.max(state.shake, 14);

    scheduleNextMorph(t);
  }

  function updateMorph(t) {
    if (!wire.morphing) return;
    const u = (t - wire.morphStart) / wire.morphDur;
    const tt = clamp(u, 0, 1);
    const e = tt < 0.5 ? 2 * tt * tt : 1 - Math.pow(-2 * tt + 2, 2) / 2;

    for (let i = 0; i < wire.curr.length; i++) {
      wire.curr[i].x = lerp(wire.from[i].x, wire.to[i].x, e);
      wire.curr[i].y = lerp(wire.from[i].y, wire.to[i].y, e);
    }
    if (tt >= 1) wire.morphing = false;
  }

  // -------------------------
  // Controls
  // -------------------------
  function setPointerTargetFromClient(clientX, clientY) {
    // Desktop mouse = absolute target.
    // Touch/pen = relative joystick-like target (more usable; doesn't require perfect finger steadiness).
    const isTouchLike = (state.pointer.type === "touch" || state.pointer.type === "pen");
    const useRelative = isTouchLike && state.touch.relative;

    if (!useRelative) {
      state.mouse.rawX = clientX;
      state.mouse.rawY = clientY;

      // allow pre-aim during countdown
      if (!state.inputEnabled) {
        state.mouse.x = clientX;
        state.mouse.y = clientY;
      }
      state.mouse.movedAt = performance.now();
      return;
    }

    const sUI = state.uiScale || 1;
    const maxR = state.touch.maxRadius * sUI;
    const dead = state.touch.deadzone * sUI;
    const gain = state.touch.gain;

    let dx = (clientX - state.touch.originX);
    let dy = (clientY - state.touch.originY);

    const mag = Math.hypot(dx, dy);
    if (mag < dead) {
      dx = 0; dy = 0;
    } else if (mag > maxR) {
      const k = maxR / mag;
      dx *= k; dy *= k;
    }

    // target is anchor + joystick delta
    const tx = state.touch.anchorX + dx * gain;
    const ty = state.touch.anchorY + dy * gain;

    const cl = pxToPlayClamped(tx, ty);
    state.mouse.rawX = cl.x;
    state.mouse.rawY = cl.y;

    // pre-aim during countdown: keep smoothed in sync
    if (!state.inputEnabled) {
      state.mouse.x = state.mouse.rawX;
      state.mouse.y = state.mouse.rawY;
    }

    state.mouse.movedAt = performance.now();
  }

  function computeControlAccel(dt, t) {
    if (!state.inputEnabled) return { ax: 0, ay: 0 };

    const mode = state.controlMode === "mouse" ? "mouse" : "keys";

    if (mode === "keys") {
      ui.mode.textContent = "Keyboard";
    } else {
      const p = state.pointer.type;
      ui.mode.textContent = (p === "touch") ? "Touch" : (p === "pen") ? "Pen" : "Mouse";
    }

    let ax = 0, ay = 0;

    if (mode === "mouse") {
      // Smooth target to avoid jitter
      const s = 1 - Math.exp(-dt / player.mouseSmooth);
      state.mouse.x = lerp(state.mouse.x, state.mouse.rawX, s);
      state.mouse.y = lerp(state.mouse.y, state.mouse.rawY, s);

      const dx = state.mouse.x - player.x;
      const dy = state.mouse.y - player.y;
      const dist = Math.hypot(dx, dy) || 1;

      // Desired speed ramps up with distance (arrive)
      const ramp = clamp(dist / player.arriveRadius, 0, 1);
      const desiredSpeed = player.maxSpeed * ramp;

      const desiredVx = (dx / dist) * desiredSpeed;
      const desiredVy = (dy / dist) * desiredSpeed;

      ax = (desiredVx - player.vx) * player.steering;
      ay = (desiredVy - player.vy) * player.steering;

      // sabotage effects
      if (t < state.invertUntil) { ax *= -1; ay *= -1; }

      if (t < state.windUntil) {
        const w = t * 0.002;
        ax += Math.sin(w) * 650;
        ay += Math.cos(w * 1.3) * 650;
      }

      if (t < state.wobbleUntil) {
        const w = t * 0.01;
        ax += Math.sin(w * 2.7) * 900;
        ay += Math.cos(w * 2.2) * 900;
        state.shake = Math.max(state.shake, 5);
      }

    } else {
      // Keyboard
      const up = state.keys.has("ArrowUp") || state.keys.has("KeyW");
      const down = state.keys.has("ArrowDown") || state.keys.has("KeyS");
      const left = state.keys.has("ArrowLeft") || state.keys.has("KeyA");
      const right = state.keys.has("ArrowRight") || state.keys.has("KeyD");

      let ix = (right ? 1 : 0) - (left ? 1 : 0);
      let iy = (down ? 1 : 0) - (up ? 1 : 0);

      const len = Math.hypot(ix, iy) || 1;
      ix /= len; iy /= len;

      ax += ix * player.accelKeys;
      ay += iy * player.accelKeys;

      ax += (Math.random() - 0.5) * player.jitterKeys;
      ay += (Math.random() - 0.5) * player.jitterKeys;

      if (t < state.invertUntil) { ax *= -1; ay *= -1; }
      if (t < state.windUntil) {
        const w = t * 0.002;
        ax += Math.sin(w) * 650;
        ay += Math.cos(w * 1.3) * 650;
      }
      if (t < state.wobbleUntil) {
        const w = t * 0.01;
        ax += Math.sin(w * 2.7) * 900;
        ay += Math.cos(w * 2.2) * 900;
        state.shake = Math.max(state.shake, 5);
      }
    }

    // lag smoothing
    computeControlAccel._lax ??= 0;
    computeControlAccel._lay ??= 0;
    const lagBlend = 1 - Math.exp(-dt / player.lag);
    computeControlAccel._lax = lerp(computeControlAccel._lax, ax, lagBlend);
    computeControlAccel._lay = lerp(computeControlAccel._lay, ay, lagBlend);

    return { ax: computeControlAccel._lax, ay: computeControlAccel._lay };
  }

  // -------------------------
  // Collision / progress
  // -------------------------
  function nearestOnWire(px, py) {
    const s = state.wireSamples;
    let best = { d2: Infinity, cx: 0, cy: 0, idx: 0, segT: 0 };
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      const hit = closestPointSeg(px, py, a.x, a.y, b.x, b.y);
      if (hit.d2 < best.d2) best = { d2: hit.d2, cx: hit.cx, cy: hit.cy, idx: i, segT: hit.t };
    }
    return best;
  }

  function progressAt(nearest) {
    const i = nearest.idx;
    const cum = state.wireCumLen;
    const segLen = (cum[i + 1] - cum[i]) || 1;
    return cum[i] + segLen * nearest.segT;
  }

  function strike(reason = "BUZZ!") {
    if (!state.running || state.over || state.won) return;

    state.strikes += 1;
    ui.strikes.textContent = String(state.strikes);
    state.shake = Math.max(state.shake, 16);

    buzz();
    showToast(reason, 900);

    if (state.strikes >= state.maxStrikes) {
      state.over = true;
      state.running = false;
      setInputEnabled(false);
      ui.eventPill.textContent = "Game over. The wire wins.";
      ui.overlay.style.display = "grid";
      ui.startBtn.textContent = "Try Again";
      return;
    }

    state.running = false;
    setInputEnabled(false);
    setTimeout(() => {
      startPosition();
      state.running = true;
      beginCountdown(performance.now());
    }, 260);
  }

  function win() {
    state.won = true;
    state.running = false;
    setInputEnabled(false);
    ui.eventPill.textContent = "You did it. Somehow.";
    ui.overlay.style.display = "grid";
    ui.startBtn.textContent = "Play Again";
    showToast("Victory! (The wire is furious.)", 1300);

    const panel = ui.overlay.querySelector(".panel");
    const existing = panel.querySelector(".winmsg");
    if (existing) existing.remove();
    const msg = document.createElement("p");
    msg.className = "winmsg";
    msg.innerHTML =
      `<b style="color:#3cff9a;">You won.</b> Congratulations. ` +
      `Now please explain to the wire why it still feels like it won.`;
    panel.appendChild(msg);
  }

  // -------------------------
  // Drawing
  // -------------------------
  function drawWire() {
    const s = state.wireSamples;
    const sUI = state.uiScale || 1;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // subtle slither (less on mobile)
    wire.slitherPhase += state.device.isMobile ? 0.012 : 0.015;
    const sl = Math.sin(wire.slitherPhase) * (state.device.isMobile ? 0.65 : 0.9);

    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      const y = p.y + sl * Math.sin(i * 0.12);
      if (i === 0) ctx.moveTo(p.x, y);
      else ctx.lineTo(p.x, y);
    }

    ctx.strokeStyle = "rgba(240,240,255,0.22)";
    ctx.lineWidth = 20 * sUI;
    ctx.stroke();

    ctx.strokeStyle = "rgba(240,240,255,0.65)";
    ctx.lineWidth = 8 * sUI;
    ctx.stroke();

    const start = normToPx(wire.curr[0]);
    const end = normToPx(wire.curr[wire.curr.length - 1]);

    ctx.beginPath();
    ctx.arc(start.x, start.y, 10 * sUI, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(60,255,154,0.85)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(end.x, end.y, 12 * sUI, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,107,107,0.9)";
    ctx.fill();
  }

  function drawRing(nearest) {
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.outerR, 0, Math.PI * 2);
    ctx.moveTo(player.x + player.innerR, player.y);
    ctx.arc(player.x, player.y, player.innerR, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(167,215,255,0.18)";
    ctx.fill("evenodd");

    ctx.beginPath();
    ctx.arc(player.x, player.y, player.outerR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(167,215,255,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(player.x, player.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(233,238,252,0.9)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(nearest.cx, nearest.cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
  }

  function clearAndCamera() {
    ctx.clearRect(0, 0, state.w, state.h);
    if (state.shake > 0.01) {
      const mag = state.shake;
      state.shake *= 0.88;
      const ox = (Math.random() - 0.5) * mag;
      const oy = (Math.random() - 0.5) * mag;
      ctx.save();
      ctx.translate(ox, oy);
      clearAndCamera._restore = true;
    } else clearAndCamera._restore = false;
  }
  function endCamera() {
    if (clearAndCamera._restore) ctx.restore();
  }

  function drawCountdown(t) {
    if (!state.countdownUntil || t >= state.countdownUntil) return;

    const msLeft = state.countdownUntil - t;
    const secLeft = Math.ceil(msLeft / 1000);
    ui.eventPill.textContent = `Get ready… ${secLeft}`;

    const cx = state.play.x + state.play.w / 2;
    const cy = state.play.y + state.play.h / 2;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = `700 ${64 * (state.uiScale || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(233,238,252,0.9)";
    ctx.fillText(String(secLeft), cx, cy);
    ctx.font = `600 ${18 * (state.uiScale || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillStyle = "rgba(233,238,252,0.7)";
    ctx.fillText("Controls enable at 0. Don’t touch anything. (Just kidding.)", cx, cy + 58 * (state.uiScale || 1));
    ctx.restore();
  }

  // -------------------------
  // Main loop
  // -------------------------
  let lastT = performance.now();

  function tick(t) {
    const dt = Math.min(0.033, (t - lastT) / 1000);
    lastT = t;
    state.now = t;

    updateMorph(t);
    rebuildWireSamples();

    // Countdown logic
    if (state.running && state.countdownUntil) {
      if (t >= state.countdownUntil) {
        state.countdownUntil = 0;
        setInputEnabled(true);
        state.startAt = performance.now();
        showToast("GO!", 700);
        ui.eventPill.textContent = "No sabotage… yet.";
      }
    }

    // Timer display
    if (state.running && state.inputEnabled && !state.over && !state.won) {
      const elapsed = (t - state.startAt) / 1000;
      ui.time.textContent = elapsed.toFixed(2);
    }

    // Sabotage/morph triggers only when input is live
    if (state.running && state.inputEnabled && t >= state.nextSabotageAt) triggerSabotage(t);
    if (state.running && state.inputEnabled && t >= state.nextMorphAt) triggerMorph(t);

    // Recatch display
    state.inRecatch = (t < state.recatchUntil);
    ui.recatchPill.style.display = state.inRecatch ? "inline-block" : "none";
    if (!state.inRecatch && ui.eventPill.textContent.startsWith("WIRE SHIFT")) {
      ui.eventPill.textContent = "No sabotage… yet.";
    }

    // Physics + collision
    let nearest = nearestOnWire(player.x, player.y);

    if (state.running && !state.over && !state.won) {
      const { ax, ay } = computeControlAccel(dt, t);

      player.vx += ax * dt;
      player.vy += ay * dt;

      const drag = Math.exp(-player.drag * dt);
      player.vx *= drag;
      player.vy *= drag;

      const sp = Math.hypot(player.vx, player.vy);
      if (sp > player.maxSpeed) {
        const k = player.maxSpeed / sp;
        player.vx *= k;
        player.vy *= k;
      }

      player.x += player.vx * dt;
      player.y += player.vy * dt;

      // Clamp to playfield
      const pad = 10 * (state.uiScale || 1);
      player.x = clamp(player.x, state.play.x + pad, state.play.x + state.play.w - pad);
      player.y = clamp(player.y, state.play.y + pad, state.play.y + state.play.h - pad);

      nearest = nearestOnWire(player.x, player.y);
      const d = Math.sqrt(nearest.d2);

      const sUI = state.uiScale || 1;
      const wireRadius = 3 * sUI;
      const margin = 1.2 * sUI;
      let allowed = player.innerR - wireRadius - margin;

      if (t < state.pinchUntil) allowed *= 0.72;

      if (state.inRecatch) {
        if (d <= allowed) {
          state.recatchUntil = 0;
          ui.recatchPill.style.display = "none";
          ui.eventPill.textContent = "Recaught. Don’t blink.";
          showToast("RECATCHED!", 700);
        }
      } else if (state.inputEnabled) {
        if (d > allowed) strike("BUZZ! You touched the wire.");
      }

      if (t >= state.recatchUntil && state.recatchUntil !== 0) {
        if (d > allowed) strike("RECATCH failed. The wire ate you.");
        state.recatchUntil = 0;
      }

      const prog = progressAt(nearest);
      state.bestProgress = Math.max(state.bestProgress, prog);

      const end = normToPx(wire.curr[wire.curr.length - 1]);
      const nearEnd = Math.sqrt(dist2(player.x, player.y, end.x, end.y)) < (22 * sUI);
      const farEnough = state.bestProgress > (state.wireTotalLen * 0.985);

      if (nearEnd && farEnough) win();

      if (t > state.sabotageUntil && !state.inRecatch && !wire.morphing && state.inputEnabled) {
        ui.eventPill.textContent = "No sabotage… yet.";
      }
    }

    clearAndCamera();
    drawWire();
    drawRing(nearest);
    drawCountdown(t);
    endCamera();

    requestAnimationFrame(tick);
  }

  // -------------------------
  // Input listeners (Pointer Events)
  // -------------------------
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();

    state.pointer.active = true;
    state.pointer.id = e.pointerId;
    state.pointer.type = e.pointerType || "mouse";

    canvas.setPointerCapture?.(e.pointerId);

    // Touch/pen always uses mouse mode
    if (state.pointer.type !== "mouse") state.controlMode = "mouse";

    // Initialize touch-relative anchor/origin
    if (state.pointer.type === "touch" || state.pointer.type === "pen") {
      state.touch.originX = e.clientX;
      state.touch.originY = e.clientY;
      state.touch.anchorX = player.x;
      state.touch.anchorY = player.y;
    }

    setPointerTargetFromClient(e.clientX, e.clientY);
  }, { passive: false });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.pointer.active) return;
    if (state.pointer.id !== null && e.pointerId !== state.pointer.id) return;

    e.preventDefault();
    setPointerTargetFromClient(e.clientX, e.clientY);
  }, { passive: false });

  function endPointer(e) {
    if (!state.pointer.active) return;
    if (state.pointer.id !== null && e.pointerId !== state.pointer.id) return;

    e.preventDefault();

    state.pointer.active = false;
    state.pointer.id = null;

    // Freeze target to ring
    state.mouse.rawX = player.x;
    state.mouse.rawY = player.y;
    state.mouse.x = player.x;
    state.mouse.y = player.y;
    state.mouse.movedAt = performance.now();
  }

  canvas.addEventListener("pointerup", endPointer, { passive: false });
  canvas.addEventListener("pointercancel", endPointer, { passive: false });
  canvas.addEventListener("pointerout", endPointer, { passive: false });
  canvas.addEventListener("pointerleave", endPointer, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyM") {
      state.controlMode = (state.controlMode === "mouse") ? "keys" : "mouse";
      showToast(`Mode: ${state.controlMode === "mouse" ? "Mouse" : "Keyboard"}`, 850);
      return;
    }

    if (e.code === "Escape") {
      if (state.running) {
        state.running = false;
        setInputEnabled(false);
        ui.overlay.style.display = "grid";
        ui.startBtn.textContent = "Resume";
      }
      return;
    }

    if (!state.inputEnabled) return;
    state.keys.add(e.code);
  });

  window.addEventListener("keyup", (e) => {
    if (!state.inputEnabled) return;
    state.keys.delete(e.code);
  });

  // -------------------------
  // Buttons
  // -------------------------
  function resetAll() {
    state.running = false;
    state.over = false;
    state.won = false;
    state.strikes = 0;
    ui.strikes.textContent = "0";
    ui.maxStrikes.textContent = String(state.maxStrikes);
    ui.time.textContent = "0.00";

    state.sabotageUntil = 0;
    state.invertUntil = 0;
    state.windUntil = 0;
    state.wobbleUntil = 0;
    state.pinchUntil = 0;
    state.recatchUntil = 0;
    state.inRecatch = false;
    ui.recatchPill.style.display = "none";
    ui.eventPill.textContent = "No sabotage… yet.";

    state.countdownUntil = 0;
    setInputEnabled(false);

    startPosition();
    showToast("Reset. The wire is still mad.", 900);
  }

  ui.startBtn.addEventListener("click", () => {
    initAudio();

    if (state.over || state.won) resetAll();

    ui.overlay.style.display = "none";

    if (!state.running) state.running = true;

    const now = performance.now();
    beginCountdown(now);

    scheduleNextSabotage(now + state.countdownSeconds * 1000);
    scheduleNextMorph(now + state.countdownSeconds * 1000);

    showToast("Get ready…", 900);
  });

  ui.resetBtn.addEventListener("click", () => {
    initAudio();
    resetAll();
  });

  // -------------------------
  // Init
  // -------------------------
  wire.base = [];
  wire.curr = [];

  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);

  resize();

  ui.maxStrikes.textContent = String(state.maxStrikes);

  setInputEnabled(false);
  requestAnimationFrame(tick);
})();