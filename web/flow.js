// A generative "long exposure" for the dark results section: particles drift on a Perlin
// noise field as one stream, then split into the light lane (fast, coral) and the heavy lane
// (slower, pale). Fading trails turn their paths into streaks. The noise is seeded, so the
// picture is the same on every visit; with reduced motion a single still is painted.

const BG = [17, 17, 17];

function makeNoise(seed) {
  const perm = Array.from({ length: 256 }, (_, i) => i);
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  return (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(lerp(grad(p[A], x, y), grad(p[B], x - 1, y), u),
      lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u), v);
  };
}

export function createFlow(canvas, { reducedMotion, isPaused }) {
  const ctx = canvas.getContext("2d");
  const noise = makeNoise(11);
  let W = 0, H = 0, mid = 0, gap = 0, splitX = 0, t = 0;
  let particles = [], frame = 0, last = 0, inView = false;
  let rnd = 1;
  const random = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;

  function spawn(p, x) {
    p.x = x ?? -10 - random() * 60;
    p.y = mid + (random() - 0.5) * H * 0.55;
    p.light = random() < 0.64;
    p.speed = p.light ? 1.2 + random() * 0.55 : 0.68 + random() * 0.3;
    p.px = p.x;
    p.py = p.y;
  }

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = box.width;
    H = box.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mid = H * 0.5;
    gap = H * 0.23;
    splitX = W * 0.4;
    rnd = 1;
    const count = Math.round(Math.min(1100, (W * H) / 520));
    particles = Array.from({ length: count }, () => {
      const p = {};
      spawn(p, random() * W);
      return p;
    });
    ctx.fillStyle = `rgb(${BG})`;
    ctx.fillRect(0, 0, W, H);
  }

  function step(dt) {
    t += dt;
    for (const p of particles) {
      p.px = p.x;
      p.py = p.y;
      const n = noise(p.x * 0.0042, p.y * 0.0042 + t * 0.07);
      const lane = p.x < splitX ? mid : p.light ? mid - gap : mid + gap;
      // Past the split the pull towards each lane grows gradually, so the streams curve apart.
      const ramp = Math.min(1, Math.max(0, (p.x - splitX) / (W * 0.16)));
      const pull = 0.6 + 1.6 * ramp * ramp * (3 - 2 * ramp);
      p.x += 62 * p.speed * (1 + n * 0.35) * dt;
      p.y += (n * 58 + (lane - p.y) * pull) * dt;
      if (p.x > W + 12) spawn(p);
    }
  }

  function paint() {
    ctx.fillStyle = `rgba(${BG}, 0.085)`;  // fade old trails a little each frame
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(242, 86, 75, 0.6)";
    ctx.beginPath();
    for (const p of particles) {
      if (!p.light) continue;
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(242, 242, 240, 0.34)";
    ctx.beginPath();
    for (const p of particles) {
      if (p.light) continue;
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    paint();
    frame = requestAnimationFrame(loop);
  };

  function still() {  // a long exposure in one go, for reduced motion
    for (let i = 0; i < 360; i++) {
      step(1 / 60);
      paint();
    }
  }

  function sync() {
    const run = !reducedMotion && !isPaused() && inView && document.visibilityState === "visible";
    if (run && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    } else if (!run && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  new ResizeObserver(() => {
    measure();
    if (reducedMotion) still();
  }).observe(canvas);
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  return { sync };
}
