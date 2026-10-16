// Results section: headline figures, the adaptive-against-baseline dumbbell chart,
// its table twin, and the orchestration ratios. Every number comes from results.json.

const SVG = "http://www.w3.org/2000/svg";
const MINUS = "−";

const usd = (v) => `$${v.toFixed(7)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const signed = (change) => `${change < 0 ? MINUS : "+"}${Math.abs(change * 100).toFixed(1)}%`;
const pagesLabel = (n) => `${n} page${n === 1 ? "" : "s"}`;

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

export function renderResults(data, { reducedMotion }) {
  const intro = document.querySelector("[data-results-intro]");
  if (intro) {
    intro.textContent = `${data.rounds} rounds of ${data.files.length} document sizes in both modes (${data.documents} documents), using warm-run medians and AWS's own billed durations at Sydney prices.`;
  }

  // Headline figures count up once when they scroll into view.
  const figures = document.querySelectorAll("[data-count]");
  const countUp = (node) => {
    const target = get(data.savings, node.dataset.count) * 100;
    if (reducedMotion) {
      node.textContent = `${target.toFixed(1)}%`;
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 1300);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = `${(target * eased).toFixed(1)}%`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      countUp(entry.target);
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.6 });
  figures.forEach((f) => seen.observe(f));

  for (const mode of ["adaptive", "baseline"]) {
    const node = document.querySelector(`[data-ratio="${mode}"]`);
    if (node) node.textContent = `${data.orchestration[mode].ratio.toFixed(1)}×`;
  }
  const method = document.querySelector("[data-method]");
  if (method) {
    const cold = data.coldStarts.adaptive + data.coldStarts.baseline;
    method.textContent = `Method: ${data.rounds} rounds × ${data.files.length} sizes × 2 modes (${data.documents} documents). The ${cold} runs that paid a cold start are reported separately, and cost-record writes and detailed logs are treated as measurement overhead, not running cost.`;
  }

  renderTable(data);
  const container = document.querySelector("[data-chart]");
  const tooltip = document.querySelector("[data-chart-tooltip]");
  if (!container) return;
  let width = 0;
  new ResizeObserver(() => {
    const next = Math.round(container.clientWidth);
    if (next && next !== width) {
      width = next;
      drawDumbbell(container, tooltip, data, width);
    }
  }).observe(container);
}

function renderTable(data) {
  const body = document.querySelector("[data-chart-table] tbody");
  if (!body) return;
  body.replaceChildren(...data.files.map((f) => {
    const tr = document.createElement("tr");
    const change = f.adaptive.processingUsd / f.baseline.processingUsd - 1;
    const labels = ["Document", "Lane", "Adaptive (USD)", "Baseline (USD)", "Change"];
    [pagesLabel(f.pages), f.lane === "light" ? "Light" : "Heavy", usd(f.adaptive.processingUsd),
      usd(f.baseline.processingUsd), signed(change)].forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value;
      td.dataset.label = labels[i];
      if (i >= 2) td.className = "num";
      tr.append(td);
    });
    return tr;
  }));
}

function drawDumbbell(container, tooltip, data, width) {
  const narrow = width < 560;
  const m = { left: narrow ? 70 : 104, right: narrow ? 48 : 76, top: 8, bottom: 34 };
  const rowH = narrow ? 32 : 36;
  const groupH = 34;
  const groups = [
    { lane: "light", name: "Light lane · 512 MB" },
    { lane: "heavy", name: "Heavy lane · 1769 MB" },
  ];
  const rows = [];
  let y = m.top;
  for (const group of groups) {
    rows.push({ type: "group", y, ...group });
    y += groupH;
    for (const f of data.files.filter((file) => file.lane === group.lane)) {
      rows.push({ type: "row", y, file: f });
      y += rowH;
    }
  }
  const height = y + m.bottom;

  const max = Math.max(...data.files.map((f) => Math.max(f.adaptive.processingUsd, f.baseline.processingUsd)));
  const step = 0.00002;
  const domainMax = Math.ceil((max * 1.08) / step) * step;
  const plotW = width - m.left - m.right;
  const x = (v) => m.left + (v / domainMax) * plotW;
  const ticks = [];
  for (let v = 0; v <= domainMax + 1e-12; v += narrow ? step * 1.5 : step) ticks.push(v);

  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "group",
    "aria-label": "Processing cost per document by size, adaptive against baseline. Use Tab to move through the rows." });

  // Gridlines and axis
  const grid = el("g", { class: "grid" });
  const axis = el("g", { class: "axis" });
  for (const v of ticks) {
    grid.append(el("line", { x1: x(v), x2: x(v), y1: m.top, y2: height - m.bottom + 4 }));
    axis.append(el("text", { x: x(v), y: height - 12, "text-anchor": "middle" },
      v === 0 ? "$0" : `$${v.toFixed(5)}`));
  }
  svg.append(grid, axis);
  svg.append(el("text", { class: "group-name", x: width - 2, y: m.top + 14, "text-anchor": "end" }, "Change"));

  for (const row of rows) {
    if (row.type === "group") {
      const g = el("g");
      g.append(el("text", { class: "group-name", x: 0, y: row.y + 20 }, row.name));
      g.append(el("line", { class: "group-rule", x1: 0, x2: width, y1: row.y + 28, y2: row.y + 28 }));
      svg.append(g);
      continue;
    }
    const f = row.file;
    const a = f.adaptive.processingUsd;
    const b = f.baseline.processingUsd;
    const change = a / b - 1;
    const cy = row.y + rowH / 2;
    const label = `${pagesLabel(f.pages)}, ${f.lane} lane: adaptive ${usd(a)}, baseline ${usd(b)}, ${Math.abs(change * 100).toFixed(1)}% ${change < 0 ? "cheaper" : "dearer"}`;
    const g = el("g", { class: "row", tabindex: "0", role: "img", "aria-label": label });
    g.append(el("rect", { class: "row-hit", x: 0, y: row.y + 2, width, height: rowH - 4, rx: 3 }));
    g.append(el("text", { class: "row-label", x: 0, y: cy + 4.5 }, pagesLabel(f.pages)));
    g.append(el("line", { class: "connector", x1: x(Math.min(a, b)), x2: x(Math.max(a, b)), y1: cy, y2: cy }));
    g.append(el("circle", { class: "dot-baseline", cx: x(b), cy, r: 5.5 }));
    g.append(el("circle", { class: "dot-adaptive", cx: x(a), cy, r: 6 }));
    g.append(el("text", { class: `delta${Math.abs(change) >= 0.1 ? " is-strong" : ""}`, x: width - 2, y: cy + 4.5, "text-anchor": "end" }, signed(change)));

    const show = () => showTooltip(tooltip, container, f, change, { x: x(Math.max(a, b)), y: row.y });
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    g.addEventListener("blur", () => { tooltip.hidden = true; });
    svg.append(g);
  }
  container.replaceChildren(svg);
}

function showTooltip(tooltip, container, f, change, anchor) {
  const head = document.createElement("p");
  head.className = "tt-head";
  head.textContent = `${pagesLabel(f.pages)} · ${f.lane} lane`;
  const line = (value, name, baseline) => {
    const p = document.createElement("p");
    p.className = "tt-row";
    const key = document.createElement("span");
    key.className = `tt-key${baseline ? " tt-key--baseline" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = value;
    p.append(key, strong, document.createTextNode(` ${name}`));
    return p;
  };
  const foot = document.createElement("p");
  foot.className = "tt-foot";
  const laneMb = f.lane === "light" ? 512 : 1769;
  foot.textContent = `${Math.abs(change * 100).toFixed(1)}% ${change < 0 ? "cheaper" : "dearer"}. Extraction took ${f.adaptive.extractMs} ms at ${laneMb} MB and ${f.baseline.extractMs} ms at 3008 MB.`;
  tooltip.replaceChildren(head, line(usd(f.adaptive.processingUsd), "adaptive", false),
    line(usd(f.baseline.processingUsd), "baseline", true), foot);
  tooltip.hidden = false;

  // Position next to the row, inside the chart card.
  const card = container.closest(".chart-card");
  const cardBox = card.getBoundingClientRect();
  const chartBox = container.getBoundingClientRect();
  const tipW = tooltip.offsetWidth;
  let left = chartBox.left - cardBox.left + anchor.x + 18;
  if (left + tipW > cardBox.width - 12) left = Math.max(12, chartBox.left - cardBox.left + anchor.x - tipW - 18);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${chartBox.top - cardBox.top + anchor.y - 6}px`;
}
