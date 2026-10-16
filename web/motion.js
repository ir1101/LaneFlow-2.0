// Page-wide motion: the opening curtain, the cursor lens, controls that lean towards the
// pointer, word-by-word titles, odometer section numbers, kinetic word bands, hero parallax
// and the torn footer title. Everything honours prefers-reduced-motion and the one global
// pause control, so moving content can always be stopped.

const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

// ---------- One pause for all continuous motion ----------
const listeners = new Set();
let paused = false;
export const motion = {
  get paused() {
    return paused;
  },
  set(value) {
    paused = value;
    document.documentElement.classList.toggle("motion-paused", value);
    listeners.forEach((fn) => fn(value));
  },
  onChange(fn) {
    listeners.add(fn);
  },
};

// ---------- Opening curtain ----------
// A coral panel counts to 100 while fonts and data load, then lifts. Shown once a visit.
export function playCurtain({ reducedMotion, ready }) {
  const curtain = document.querySelector("[data-curtain]");
  const root = document.documentElement;
  let seen = false;
  try {
    seen = sessionStorage.getItem("laneflow-intro") === "1";
    sessionStorage.setItem("laneflow-intro", "1");
  } catch {
    /* storage unavailable: show the curtain */
  }
  if (!curtain || reducedMotion || seen) {
    curtain?.remove();
    root.classList.add("is-ready");
    return Promise.resolve();
  }
  const count = curtain.querySelector("[data-curtain-count]");
  let loaded = false;
  Promise.resolve(ready).finally(() => { loaded = true; });
  const start = performance.now();
  let shown = 0;
  return new Promise((resolve) => {
    const tick = (now) => {
      const t = now - start;
      const target = loaded && t > 900 ? 100 : Math.min(88, (t / 900) * 88);
      shown = Math.min(100, shown + Math.max(0.6, (target - shown) * 0.16));
      count.textContent = String(Math.floor(shown)).padStart(3, "0");
      if (shown >= 100 || t > 3200) {
        count.textContent = "100";
        curtain.classList.add("is-lifting");
        root.classList.add("is-ready");
        setTimeout(() => {
          curtain.remove();
          resolve();
        }, 1100);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ---------- Cursor lens ----------
// A small dot follows the mouse; over links it becomes a ring, over the big titles a lens
// that inverts what it covers. Mouse only: touch and pen keep the native behaviour.
export function initCursor() {
  const cursor = document.querySelector("[data-cursor]");
  if (!finePointer || !cursor) return;
  let x = -200, y = -200, cx = x, cy = y, frame = 0;
  const follow = () => {
    cx += (x - cx) * 0.22;
    cy += (y - cy) * 0.22;
    cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    frame = Math.abs(x - cx) + Math.abs(y - cy) > 0.2 ? requestAnimationFrame(follow) : 0;
  };
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    x = e.clientX;
    y = e.clientY;
    cursor.classList.add("is-visible");
    if (!frame) frame = requestAnimationFrame(follow);
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => cursor.classList.remove("is-visible"));
  document.addEventListener("pointerover", (e) => {
    const lens = e.target.closest?.("[data-cursor-lens]");
    const hot = e.target.closest?.("a, button, label, summary, input, .row");
    cursor.dataset.mode = lens ? "lens" : hot ? "hot" : "";
  });
}

// ---------- Controls that lean towards the pointer ----------
export function initMagnetic({ reducedMotion }) {
  if (!finePointer || reducedMotion) return;
  document.querySelectorAll(".chip, .btn, .motion-switch").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const box = el.getBoundingClientRect();
      const dx = (e.clientX - (box.left + box.width / 2)) / box.width;
      const dy = (e.clientY - (box.top + box.height / 2)) / box.height;
      el.style.translate = `${(dx * 10).toFixed(1)}px ${(dy * 8).toFixed(1)}px`;
    });
    el.addEventListener("pointerleave", () => { el.style.translate = ""; });
  });
}

// ---------- Section titles word by word, numbers as odometers ----------
// The reveal itself is CSS, triggered when the section head scrolls in (.is-in).
export function initHeadings() {
  document.querySelectorAll(".section-title").forEach((title) => {
    const text = title.textContent.trim();
    title.setAttribute("aria-label", text);
    title.textContent = "";
    text.split(/\s+/).forEach((word, i) => {
      const outer = document.createElement("span");
      outer.className = "w";
      outer.setAttribute("aria-hidden", "true");
      const inner = document.createElement("span");
      inner.style.setProperty("--wi", i);
      inner.textContent = word;
      outer.append(inner);
      title.append(outer, " ");
    });
  });
  document.querySelectorAll(".section-index .num").forEach((num) => {
    const digits = [...num.textContent.trim()];
    num.textContent = "";
    digits.forEach((digit, i) => {
      const slot = document.createElement("span");
      slot.className = "digit";
      const reel = document.createElement("span");
      reel.className = "reel";
      reel.style.setProperty("--to", digit);
      reel.style.setProperty("--di", i);
      for (let d = 0; d <= 9; d++) {
        const n = document.createElement("span");
        n.textContent = String(d);
        reel.append(n);
      }
      slot.append(reel);
      num.append(slot);
    });
  });
}

// ---------- Kinetic word bands ----------
// Giant words drift sideways; scrolling speeds them up and leans them, then they settle.
export function initBands({ reducedMotion }) {
  const bands = [...document.querySelectorAll("[data-band]")].map((band) => {
    const track = band.querySelector(".band-track");
    const count = track.children.length;
    // Two more copies of the words, so the band never runs out while it loops.
    for (let copy = 0; copy < 2; copy++) {
      for (let i = 0; i < count; i++) track.append(track.children[i].cloneNode(true));
    }
    return { band, track, count, period: 0, x: 0, dir: Number(band.dataset.band) || 1, visible: false };
  });
  if (!bands.length || reducedMotion) return;
  // One loop = the distance from the first word to its first copy, gaps included.
  const measure = () => bands.forEach((b) => {
    b.period = b.track.children[b.count].offsetLeft - b.track.children[0].offsetLeft;
  });
  measure();
  new ResizeObserver(measure).observe(document.documentElement);
  let velocity = 0, lastY = window.scrollY, last = 0, frame = 0;
  window.addEventListener("scroll", () => {
    velocity += window.scrollY - lastY;
    lastY = window.scrollY;
  }, { passive: true });
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    velocity *= 0.88;
    const push = Math.max(-14, Math.min(14, velocity * 0.12));
    for (const b of bands) {
      if (!b.visible || !b.period) continue;
      b.x += b.dir * (50 + Math.abs(push) * 45) * dt;
      const offset = ((b.x % b.period) + b.period) % b.period;
      b.track.style.transform = `translate3d(${-offset}px, 0, 0) skewX(${(-push * 0.7).toFixed(2)}deg)`;
    }
    frame = requestAnimationFrame(step);
  };
  const sync = () => {
    const run = !paused && document.visibilityState === "visible" && bands.some((b) => b.visible);
    if (run && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(step);
    } else if (!run && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const b = bands.find((x) => x.band === entry.target);
      if (b) b.visible = entry.isIntersecting;
    }
    sync();
  });
  bands.forEach((b) => io.observe(b.band));
  motion.onChange(sync);
  document.addEventListener("visibilitychange", sync);
}

// ---------- Hero parallax ----------
// The title drifts against the pointer and the halftone with it, for a sense of depth.
export function initParallax({ reducedMotion }) {
  const hero = document.querySelector("[data-hero]");
  if (!finePointer || reducedMotion || !hero) return;
  const layers = [
    [hero.querySelector(".hero-title"), -14, -9],
    [hero.querySelector(".hero-halftone"), 26, 18],
    [hero.querySelector(".hero-stamp"), 18, -12],
  ].filter(([el]) => el);
  let tx = 0, ty = 0, cx = 0, cy = 0, frame = 0;
  const step = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    for (const [el, kx, ky] of layers) el.style.translate = `${(cx * kx).toFixed(2)}px ${(cy * ky).toFixed(2)}px`;
    frame = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001 ? requestAnimationFrame(step) : 0;
  };
  hero.addEventListener("pointermove", (e) => {
    const box = hero.getBoundingClientRect();
    tx = (e.clientX - box.left) / box.width - 0.5;
    ty = (e.clientY - box.top) / box.height - 0.5;
    if (!frame) frame = requestAnimationFrame(step);
  });
  hero.addEventListener("pointerleave", () => {
    tx = 0;
    ty = 0;
    if (!frame) frame = requestAnimationFrame(step);
  });
}

// ---------- Torn footer title ----------
// Two copies of the words share one jagged edge; the lower half slips once it is in view.
export function initTorn() {
  const torn = document.querySelector("[data-torn]");
  if (!torn) return;
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const edge = [];
  for (let i = 0; i <= 40; i++) edge.push(`${((i / 40) * 100).toFixed(2)}% ${(54 + (rnd() - 0.5) * 9).toFixed(2)}%`);
  torn.querySelector(".torn-top").style.clipPath = `polygon(0 0, 100% 0, ${[...edge].reverse().join(", ")})`;
  torn.querySelector(".torn-bottom").style.clipPath = `polygon(${edge.join(", ")}, 100% 100%, 0 100%)`;
}
