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

    startAt: 0,
    now: 0,

    strikes: 0,
    maxStrikes: 3,

    controlMode: "mouse", // "mouse" or "keys"
    keys: new Set(),
    mouse: { x: 0, y: 0, movedAt: 0 },

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

    // ✅ NEW: input gating + countdown
    inputEnabled: false,
    countdownUntil: 0,     // performance.now() timestamp
    countdownSeconds: 5
  };

  const player = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,

    outerR: 20,
    innerR: 13,

    // ✅ FAIRER CONTROLS (still hard, just less unfair)
    accel: 1450,     // was 1800
    maxSpeed: 720,   // was 900
    drag: 3.2,       // was 2.1 (more drag = less skating)
    jitter: 14,      // was 28 (less chaos)
    lag: 0.08,       // was 0.11 (slightly more responsive)

    mouseDeadzone: 14 // ✅ NEW: ignore tiny cursor offsets
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

  function normToPx(p) {
    return { x: p.x * state.w, y: p.y * state.h };
  }

  function makeHellWire(seed = 1337) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

    const pts = [];
    let x = 0.08, y = 0.55;
    pts.push({ x, y });

    const n = 140;
    for (let i = 1; i < n; i++) {
      const forward = 0.006 + rnd() * 0.008;
      const backChance = (i % 17 === 0) ? 0.45 : 0.12;
      const dx = (rnd() < backChance) ? -forward * (0.2 + rnd() * 0.5) : forward;
      const dy = (rnd() - 0.5) * (0.08 + rnd() * 0.09);

      x = clamp(x + dx, 0.06, 0.94);
      y = clamp(y + dy, 0.08, 0.92);

      if (i % 19 === 0) {
        y = clamp(y + (rnd() < 0.5 ? -1 : 1) * (0.18 + rnd() * 0.22), 0.08, 0.92);
      }
      pts.push({ x, y });
    }
    pts[pts.length - 1] = { x: 0.92, y: 0.52 };

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
          x: clamp(c.x + Math.cos(a) * r * (0.7 + rnd() * 0.7), 0.06, 0.94),
          y: clamp(c.y + Math.sin(a) * r * (0.7 + rnd() * 0.7), 0.08, 0.92),
        });
      }
      pts.splice(idx, 0, ...loop);
    }
    return pts;
  }

  function rebuildWireSamples() {
    const cps = wire.curr;
    const samples = [];
    const cum = [0];
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
  }

  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    state.w = window.innerWidth;
    state.h = window.innerHeight;

    canvas.width = Math.floor(state.w * dpr);
    canvas.height = Math.floor(state.h * dpr);
    canvas.style.width = state.w + "px";
    canvas.style.height = state.h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    rebuildWireSamples();
    if (!state.running) startPosition();
  }

  // -------------------------
  // ✅ Input gating
  // -------------------------
  function setInputEnabled(on) {
    state.inputEnabled = on;
    if (!on) {
      // Clear any “stuck” inputs so nothing carries over from the menu
      state.keys.clear();
      // Reset mouse target to ring position so it doesn't jump
      state.mouse.x = player.x;
      state.mouse.y = player.y;
      state.mouse.movedAt = performance.now();
      // Also kill motion
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
    const dt = 8000 + Math.random() * 6500; // slightly less frequent now
    state.nextSabotageAt = t + dt;
  }
  function scheduleNextMorph(t) {
    const dt = 24000 + Math.random() * 22000;
    state.nextMorphAt = t + dt;
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

    const k = 6 + Math.floor(Math.random() * 7);
    for (let i = 0; i < k; i++) {
      const idx = 2 + Math.floor(Math.random() * (wire.to.length - 4));
      const p = wire.to[idx];
      p.x = clamp(p.x + (Math.random() - 0.5) * 0.14, 0.06, 0.94);
      p.y = clamp(p.y + (Math.random() - 0.5) * 0.18, 0.08, 0.92);
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
  function computeControlAccel(dt, t) {
    if (!state.inputEnabled) return { ax: 0, ay: 0 };

    const mode = state.controlMode === "mouse" ? "mouse" : "keys";
    ui.mode.textContent = mode === "mouse" ? "Mouse" : "Keyboard";

    let ax = 0, ay = 0;

    if (mode === "mouse") {
      const dx = state.mouse.x - player.x;
      const dy = state.mouse.y - player.y;
      const len = Math.hypot(dx, dy) || 1;

      // ✅ Deadzone: prevents tiny cursor jitter from causing movement
      if (len > player.mouseDeadzone) {
        const ux = dx / len;
        const uy = dy / len;
        ax += ux * player.accel;
        ay += uy * player.accel;
      }

      // smaller wobble than before
      const wob = (t * 0.0065);
      ax += Math.sin(wob * 1.9) * 160;
      ay += Math.cos(wob * 1.4) * 160;

    } else {
      const up = state.keys.has("ArrowUp") || state.keys.has("KeyW");
      const down = state.keys.has("ArrowDown") || state.keys.has("KeyS");
      const left = state.keys.has("ArrowLeft") || state.keys.has("KeyA");
      const right = state.keys.has("ArrowRight") || state.keys.has("KeyD");

      let ix = (right ? 1 : 0) - (left ? 1 : 0);
      let iy = (down ? 1 : 0) - (up ? 1 : 0);

      const len = Math.hypot(ix, iy) || 1;
      ix /= len; iy /= len;

      ax += ix * player.accel;
      ay += iy * player.accel;

      // smaller tremor
      ax += (Math.random() - 0.5) * 80;
      ay += (Math.random() - 0.5) * 80;
    }

    // Lag smoothing (more responsive than original)
    computeControlAccel._lax ??= 0;
    computeControlAccel._lay ??= 0;
    computeControlAccel._lax = lerp(computeControlAccel._lax, ax, 1 - Math.exp(-dt / player.lag));
    computeControlAccel._lay = lerp(computeControlAccel._lay, ay, 1 - Math.exp(-dt / player.lag));
    ax = computeControlAccel._lax;
    ay = computeControlAccel._lay;

    // sabotage modifiers
    if (t < state.invertUntil) { ax *= -1; ay *= -1; }
    if (t < state.windUntil) {
      const w = (t * 0.002);
      ax += Math.sin(w) * 780;
      ay += Math.cos(w * 1.3) * 780;
    }
    if (t < state.wobbleUntil) {
      const w = t * 0.01;
      ax += Math.sin(w * 2.7) * 1050;
      ay += Math.cos(w * 2.2) * 1050;
      state.shake = Math.max(state.shake, 5);
    }

    // baseline jitter reduced
    ax += (Math.random() - 0.5) * player.jitter * 18;
    ay += (Math.random() - 0.5) * player.jitter * 18;

    return { ax, ay };
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

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    wire.slitherPhase += 0.015;
    const sl = Math.sin(wire.slitherPhase) * 0.9;

    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      const y = p.y + sl * Math.sin(i * 0.12);
      if (i === 0) ctx.moveTo(p.x, y);
      else ctx.lineTo(p.x, y);
    }

    ctx.strokeStyle = "rgba(240,240,255,0.22)";
    ctx.lineWidth = 14;
    ctx.stroke();

    ctx.strokeStyle = "rgba(240,240,255,0.65)";
    ctx.lineWidth = 6;
    ctx.stroke();

    const start = normToPx(wire.curr[0]);
    const end = normToPx(wire.curr[wire.curr.length - 1]);

    ctx.beginPath();
    ctx.arc(start.x, start.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(60,255,154,0.85)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(end.x, end.y, 12, 0, Math.PI * 2);
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

  // Draw countdown as big text in the middle
  function drawCountdown(t) {
    if (!state.countdownUntil || t >= state.countdownUntil) return;

    const msLeft = state.countdownUntil - t;
    const secLeft = Math.ceil(msLeft / 1000);
    ui.eventPill.textContent = `Get ready… ${secLeft}`;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = "700 64px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(233,238,252,0.9)";
    ctx.fillText(String(secLeft), state.w / 2, state.h / 2);
    ctx.font = "600 18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = "rgba(233,238,252,0.7)";
    ctx.fillText("Controls enable at 0. Don’t touch anything. (Just kidding.)", state.w / 2, state.h / 2 + 58);
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

    // Update morph + rebuild samples
    updateMorph(t);
    rebuildWireSamples();

    // Countdown logic
    if (state.running && state.countdownUntil) {
      if (t >= state.countdownUntil) {
        state.countdownUntil = 0;
        setInputEnabled(true);
        state.startAt = performance.now(); // start timer when controls go live
        showToast("GO!", 700);
        ui.eventPill.textContent = "No sabotage… yet.";
      }
    }

    // Timer display
    if (state.running && state.inputEnabled && !state.over && !state.won) {
      const elapsed = (t - state.startAt) / 1000;
      ui.time.textContent = elapsed.toFixed(2);
    }

    // Sabotage/morph triggers only when input is live (prevents chaos during countdown)
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

      player.x = clamp(player.x, 10, state.w - 10);
      player.y = clamp(player.y, 10, state.h - 10);

      nearest = nearestOnWire(player.x, player.y);
      const d = Math.sqrt(nearest.d2);

      const wireRadius = 3;
      const margin = 1.2; // tiny bit more mercy
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
      const nearEnd = Math.sqrt(dist2(player.x, player.y, end.x, end.y)) < 22;
      const farEnough = state.bestProgress > (state.wireTotalLen * 0.985);

      if (nearEnd && farEnough) win();

      if (t > state.sabotageUntil && !state.inRecatch && !wire.morphing && state.inputEnabled) {
        ui.eventPill.textContent = "No sabotage… yet.";
      }
    }

    // Draw
    clearAndCamera();
    drawWire();
    drawRing(nearest);
    drawCountdown(t);
    endCamera();

    requestAnimationFrame(tick);
  }

  // -------------------------
  // Input listeners
  // -------------------------
  window.addEventListener("mousemove", (e) => {
    // ✅ Ignore mouse input when menu is up or countdown is active
    if (!state.inputEnabled) return;
    state.mouse.x = e.clientX;
    state.mouse.y = e.clientY;
    state.mouse.movedAt = performance.now();
  });

  window.addEventListener("keydown", (e) => {
    // Always allow M + Escape while menu is up (quality-of-life)
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

    // ✅ Ignore key controls when input disabled
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

    // hide overlay
    ui.overlay.style.display = "none";

    // Start/resume
    if (!state.running) state.running = true;

    // Always begin a fresh 5-second countdown when Start/Resume is pressed
    const now = performance.now();
    beginCountdown(now);

    // Make sure future chaos isn't scheduled too early
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
  wire.base = makeHellWire(1337);
  wire.curr = wire.base.map(p => ({ ...p }));

  window.addEventListener("resize", resize);
  resize();

  ui.maxStrikes.textContent = String(state.maxStrikes);

  // Start with overlay open and input disabled
  setInputEnabled(false);

  requestAnimationFrame(tick);
})();
