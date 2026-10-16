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

  // Captions follow the data, so a negative result can never be labelled "cheaper".
  const lightMax = data.files.filter((f) => f.lane === "light").reduce((m, f) => Math.max(m, f.pages), 0);
  const captions = {
    "light.processing": [`processing for PDFs of up to ${lightMax} pages, which take the ${data.lanes.light} MB light lane`],
    "heavy.processing": [`processing for larger PDFs, which take the ${data.lanes.heavy} MB heavy lane`],
    "all.processing": ["processing across an even mix of sizes"],
    "all.total": ["end to end, once queueing, orchestration and storage are included"],
  };
  document.querySelectorAll("[data-figure-label]").forEach((node) => {
    const value = get(data.savings, node.dataset.figureLabel);
    const caption = captions[node.dataset.figureLabel];
    if (value == null || !caption) return;
    node.textContent = `${value >= 0 ? "cheaper" : "dearer"} ${caption[0]}`;
  });

  // Headline figures count up once when they scroll into view. A saving shows as a
  // plain percentage; a loss would show its magnitude, with the caption saying "dearer".
  const figures = document.querySelectorAll("[data-count]");
  const countUp = (node) => {
    const target = Math.abs(get(data.savings, node.dataset.count) * 100);
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
  renderTuning(data);
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

// Power Tuning grid: each document size against each memory setting, as cost relative to
// the cheapest setting for that size. The cheapest cell and the lane's chosen setting are marked.
function renderTuning(data) {
  const table = document.querySelector("[data-tuning-table]");
  const panel = document.querySelector("[data-tuning]");
  if (!table || !panel) return;
  const extractor = (data.tuning || []).filter((t) => t.function.startsWith("extract"));
  if (!extractor.length) {
    panel.hidden = true;
    return;
  }
  const memories = [...new Set(extractor.flatMap((t) => t.settings.map((s) => s.memoryMb)))].sort((a, b) => a - b);
  const lightMax = data.files.filter((f) => f.lane === "light").reduce((m, f) => Math.max(m, f.pages), 0);

  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = "Document";
  headRow.append(corner, ...memories.map((mb) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "num";
    th.textContent = `${mb} MB`;
    return th;
  }));
  table.tHead.replaceChildren(headRow);

  table.tBodies[0].replaceChildren(...extractor.map((t) => {
    const tr = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = pagesLabel(t.pages);
    tr.append(label);
    const cheapest = Math.min(...t.settings.map((s) => s.usd));
    const laneMb = t.pages <= lightMax ? data.lanes.light : data.lanes.heavy;
    for (const mb of memories) {
      const td = document.createElement("td");
      td.className = "num";
      td.dataset.label = `${mb} MB`;
      const s = t.settings.find((x) => x.memoryMb === mb);
      if (!s) {
        td.textContent = "not run";
        td.classList.add("is-empty");
      } else {
        const ratio = s.usd / cheapest;
        const value = document.createElement("span");
        value.className = "ratio";
        value.textContent = `${ratio.toFixed(2)}×`;
        const ms = document.createElement("span");
        ms.className = "ms";
        ms.textContent = s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${Math.round(s.ms)} ms`;
        td.append(value, ms);
        if (s.usd === cheapest) td.classList.add("is-cheapest");
        if (mb === laneMb) td.classList.add("is-chosen");
        const notes = [s.usd === cheapest && "cheapest", mb === laneMb && "lane setting"].filter(Boolean);
        if (notes.length) {
          const hidden = document.createElement("span");
          hidden.className = "visually-hidden";
          hidden.textContent = ` (${notes.join(", ")})`;
          td.append(hidden);
        }
      }
      tr.append(td);
    }
    return tr;
  }));

  const before = document.querySelector("[data-before-after]");
  if (before && data.previous) {
    const items = [
      [`Original lanes, ${data.previous.lanes.light} MB and ${data.previous.lanes.heavy} MB`, data.previous.savings.all.processing],
      [`Tuned lanes, ${data.lanes.light} MB and ${data.lanes.heavy} MB`, data.savings.all.processing],
    ];
    before.replaceChildren(...items.map(([label, value]) => {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = `${(value * 100).toFixed(1)}%`;
      div.append(dt, dd);
      return div;
    }));
  } else if (before) {
    before.hidden = true;
  }
}

function drawDumbbell(container, tooltip, data, width) {
  const narrow = width < 560;
  const m = { left: narrow ? 70 : 104, right: narrow ? 48 : 76, top: 8, bottom: 34 };
  const rowH = narrow ? 32 : 36;
  const groupH = 34;
  const groups = [
    { lane: "light", name: `Light lane · ${data.lanes.light} MB` },
    { lane: "heavy", name: `Heavy lane · ${data.lanes.heavy} MB` },
  ].filter((g) => data.files.some((f) => f.lane === g.lane));
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

    const show = () => showTooltip(tooltip, container, f, change, { x: x(Math.max(a, b)), y: row.y }, data.lanes);
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    g.addEventListener("blur", () => { tooltip.hidden = true; });
    svg.append(g);
  }
  container.replaceChildren(svg);
}

function showTooltip(tooltip, container, f, change, anchor, lanes) {
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
  const laneMb = lanes[f.lane];
  foot.textContent = `${Math.abs(change * 100).toFixed(1)}% ${change < 0 ? "cheaper" : "dearer"}. Extraction took ${f.adaptive.extractMs} ms at ${laneMb} MB and ${f.baseline.extractMs} ms at ${lanes.baseline} MB.`;
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
