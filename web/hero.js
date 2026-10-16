// Hero motion graphic: documents stream in from S3, pause at the classifier, and split
// into the light and heavy lanes. The stream replays the measured per-size medians from
// results.json, so the running totals are real measurements, not invented numbers.
// Documents that really pass through the pipeline join the stream, highlighted.

const C = {
  ink: "#0e0e0e",
  ink2: "#4d4d4d",
  rule: "rgba(14, 14, 14, 0.3)",
  coral: "#f2564b",
  card: "#ffffff",
};

const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createHero({ canvas, hero, titleEl, results, onStats, reducedMotion }) {
  const ctx = canvas.getContext("2d");
  const sizes = results.files.map((f) => ({
    pages: f.pages, lane: f.lane, adaptive: f.adaptive.totalUsd, baseline: f.baseline.totalUsd,
  }));
  const docs = [];
  const pulses = [];
  const stats = { count: 0, adaptive: 0, baseline: 0 };
  let W = 0, H = 0, g = null;
  let raf = 0, last = 0, spawnIn = 0, dash = 0;
  let inView = true, userPaused = false;

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = box.width;
    H = box.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The lanes run through the gap between the two words of the title.
    const words = titleEl.querySelectorAll(".hero-word");
    let mid = H * 0.5, wordGap = 80;
    if (words.length === 2) {
      const a = words[0].getBoundingClientRect();
      const b = words[1].getBoundingClientRect();
      mid = (a.bottom + b.top) / 2 - box.top;
      wordGap = Math.max(20, b.top - a.bottom);
    }
    const narrow = W < 640;
    const scale = clamp(W / 1280, 0.6, 1.2);
    const gap = clamp(wordGap * 0.32, 12, 34);
    g = {
      mid, gap, scale, narrow,
      gutter: clamp(W * 0.035, 16, 48),
      gateX: W * (narrow ? 0.3 : 0.34),
      splitX: W * (narrow ? 0.52 : 0.47),
      lightY: mid - gap,
      heavyY: mid + gap,
    };
    hero.style.setProperty("--lane-mid", `${mid}px`);
  }

  function laneY(lane, x) {
    const target = lane === "light" ? g.lightY : g.heavyY;
    if (x <= g.gateX) return g.mid;
    if (x >= g.splitX) return target;
    return g.mid + (target - g.mid) * smooth((x - g.gateX) / (g.splitX - g.gateX));
  }

  function makeDoc(size, real = null) {
    const w = (8 + 4.4 * Math.log10(size.pages)) * clamp(g.scale, 0.75, 1.1);
    return {
      size, real, lane: size.lane, x: -w - 10, w, h: w * 1.32, phase: "ingest", hold: 0,
      ingestSpeed: 150 * g.scale,
      laneSpeed: (size.lane === "light" ? 230 : 135 - 14 * Math.log10(size.pages)) * g.scale,
    };
  }

  function spawn() {
    docs.push(makeDoc(sizes[Math.floor(Math.random() * sizes.length)]));
  }

  function update(dt) {
    dash = (dash + dt * 40) % 12;
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = (0.35 + Math.random() * 0.55) / Math.sqrt(g.scale);
    }
    for (const d of docs) {
      if (d.phase === "ingest") {
        d.x += d.ingestSpeed * dt;
        if (d.x >= g.gateX) {
          d.x = g.gateX;
          d.phase = "classify";
          d.hold = d.real ? 0.5 : 0.22;
          pulses.push({ r: 4, life: 1, real: Boolean(d.real) });
        }
      } else if (d.phase === "classify") {
        d.hold -= dt;
        if (d.hold <= 0) d.phase = "lane";
      } else {
        d.x += d.laneSpeed * dt;
      }
    }
    for (let i = docs.length - 1; i >= 0; i--) {
      const d = docs[i];
      if (d.x > W + 40) {
        docs.splice(i, 1);
        if (!d.real) {
          stats.count += 1;
          stats.adaptive += d.size.adaptive;
          stats.baseline += d.size.baseline;
          onStats({ ...stats });
        }
      }
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.r += dt * 60;
      p.life -= dt * 1.6;
      if (p.life <= 0) pulses.splice(i, 1);
    }
  }

  // Labels carry a paper-coloured halo so they stay readable as documents pass beneath.
  function text(str, x, y, align = "left", colour = C.ink2) {
    const label = str.toUpperCase();
    ctx.textAlign = align;
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(236, 236, 236, 0.92)";
    ctx.strokeText(label, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(label, x, y);
  }

  function drawLabels() {
    ctx.font = `500 ${g.narrow ? 10 : 11}px "Hanken Grotesk", system-ui, sans-serif`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0.9px";
    ctx.textBaseline = "alphabetic";
    text("S3 uploads", g.gutter, g.mid + 22);
    text("Classifier", g.gateX - 12, g.mid - 12, "right", C.ink);
    text(g.narrow ? "Light · 512 MB" : "Light lane · 512 MB", W - g.gutter, g.lightY - 10, "right");
    text(g.narrow ? "Heavy · 1769 MB" : "Heavy lane · 1769 MB", W - g.gutter, g.heavyY + 20, "right");
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  }

  function drawLanes() {
    ctx.lineCap = "round";
    // Ingest: one shared lane from the upload bucket to the classifier.
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, g.mid);
    ctx.lineTo(g.gateX, g.mid);
    ctx.stroke();
    ctx.save();
    ctx.setLineDash([2, 10]);
    ctx.lineDashOffset = -dash;
    ctx.strokeStyle = C.ink;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(0, g.mid);
    ctx.lineTo(g.gateX, g.mid);
    ctx.stroke();
    ctx.restore();

    // The two lanes: thin coral for light, heavy ink for heavy.
    for (const lane of ["light", "heavy"]) {
      ctx.beginPath();
      ctx.moveTo(g.gateX, g.mid);
      for (let x = g.gateX; x <= g.splitX; x += 4) ctx.lineTo(x, laneY(lane, x));
      ctx.lineTo(W, laneY(lane, W));
      ctx.strokeStyle = lane === "light" ? C.coral : C.ink;
      ctx.globalAlpha = lane === "light" ? 0.95 : 0.82;
      ctx.lineWidth = lane === "light" ? 1.5 : 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The classifier gate, with the Choice state as a diamond.
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.gateX, g.mid - g.gap * 1.3);
    ctx.lineTo(g.gateX, g.mid + g.gap * 1.3);
    ctx.stroke();
    ctx.fillStyle = C.coral;
    ctx.beginPath();
    ctx.moveTo(g.gateX, g.mid - 7);
    ctx.lineTo(g.gateX + 7, g.mid);
    ctx.lineTo(g.gateX, g.mid + 7);
    ctx.lineTo(g.gateX - 7, g.mid);
    ctx.closePath();
    ctx.fill();
  }

  function drawDoc(d) {
    const y = d.phase === "lane" ? laneY(d.lane, d.x) : g.mid;
    const x = d.x;
    const { w, h } = d;
    const left = x - w / 2, top = y - h / 2;
    const fold = w * 0.32;
    const routed = d.phase === "lane";
    const heavy = routed && d.lane === "heavy";
    const fade = clamp((W + 30 - x) / 80, 0, 1);

    ctx.save();
    ctx.globalAlpha = fade;
    if (d.real) {
      ctx.fillStyle = "rgba(242, 86, 75, 0.16)";
      ctx.beginPath();
      ctx.arc(x, y, w * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // Page outline with a folded corner
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + w - fold, top);
    ctx.lineTo(left + w, top + fold);
    ctx.lineTo(left + w, top + h);
    ctx.lineTo(left, top + h);
    ctx.closePath();
    ctx.fillStyle = heavy ? C.ink : C.card;
    ctx.fill();
    ctx.lineWidth = d.real ? 1.6 : 1;
    ctx.strokeStyle = routed && d.lane === "light" ? C.coral : C.ink;
    ctx.stroke();
    // Two lines of "text"
    if (w > 9) {
      ctx.strokeStyle = heavy ? "rgba(255, 255, 255, 0.7)" : "rgba(14, 14, 14, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left + w * 0.22, top + h * 0.45);
      ctx.lineTo(left + w * 0.78, top + h * 0.45);
      ctx.moveTo(left + w * 0.22, top + h * 0.65);
      ctx.lineTo(left + w * 0.62, top + h * 0.65);
      ctx.stroke();
    }
    if (d.real) {
      ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif';
      ctx.fillStyle = C.ink;
      ctx.textAlign = "center";
      ctx.fillText(d.real.label, x, top - 8);
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawLanes();
    for (const p of pulses) {
      ctx.strokeStyle = p.real ? `rgba(242, 86, 75, ${p.life})` : `rgba(242, 86, 75, ${p.life * 0.55})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(g.gateX, g.mid, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const d of docs) drawDoc(d);
    drawLabels();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function shouldRun() {
    return !reducedMotion && !userPaused && inView && document.visibilityState === "visible";
  }

  function sync() {
    if (shouldRun() && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!shouldRun() && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  // A still frame for reduced motion: documents placed along both lanes, and totals
  // for a 900-document run (100 of each measured size).
  function stillFrame() {
    docs.length = 0;
    const xs = [0.08, 0.18, 0.26];
    xs.forEach((f, i) => docs.push(Object.assign(makeDoc(sizes[i * 3]), { x: W * f })));
    sizes.forEach((s, i) => {
      const d = makeDoc(s);
      d.phase = "lane";
      d.x = g.splitX + ((W - g.splitX - 60) * (i + 0.5)) / sizes.length;
      docs.push(d);
    });
    draw();
    const n = 100;
    onStats({
      count: n * sizes.length,
      adaptive: n * sizes.reduce((t, s) => t + s.adaptive, 0),
      baseline: n * sizes.reduce((t, s) => t + s.baseline, 0),
    });
  }

  const resize = new ResizeObserver(() => {
    measure();
    if (reducedMotion) stillFrame();
    else draw();
  });
  resize.observe(canvas);

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  }).observe(hero);
  document.addEventListener("visibilitychange", sync);

  measure();
  if (reducedMotion) stillFrame();
  else {
    for (let i = 0; i < 6; i++) { // start mid-stream rather than empty
      const d = makeDoc(sizes[i % sizes.length]);
      d.x = g.gateX * (i / 6);
      docs.push(d);
    }
    sync();
  }

  return {
    setPaused(paused) {
      userPaused = paused;
      sync();
    },
    // A real document finished: send it down its lane with a label.
    addRealDoc({ pages, lane, label }) {
      if (reducedMotion || !g || !pages) return;
      const size = { pages, lane: lane === "heavy" ? "heavy" : "light", adaptive: 0, baseline: 0 };
      docs.push(makeDoc(size, { label }));
    },
  };
}
