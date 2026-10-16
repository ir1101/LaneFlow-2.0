// LaneFlow website: talks to the pipeline API, tracks uploads stage by stage, shows the
// live feed, and runs the page's motion (hero simulation, reveals, diagram packet).
import { createHero } from "./hero.js";
import { renderResults } from "./results.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MAX_BYTES = 25 * 1024 * 1024;
const API = apiBase();
let results = null;
let hero = null;

// ---------- API ----------
// On CloudFront the API shares the site's address. For local development, open the
// page with ?api=https://<api-id>.execute-api.<region>.amazonaws.com once.
function apiBase() {
  const fromQuery = new URLSearchParams(location.search).get("api");
  try {
    if (fromQuery) sessionStorage.setItem("laneflow-api", fromQuery);
    if (location.hostname === "localhost") return (fromQuery || sessionStorage.getItem("laneflow-api") || "").replace(/\/$/, "");
  } catch {
    /* storage can be unavailable; fall back to the same origin */
  }
  return "";
}

async function api(path, { method = "GET", body, timeout = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(API + path, {
      method,
      body,
      signal: controller.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `The pipeline API answered ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The pipeline API took too long to answer.");
    if (error instanceof TypeError) throw new Error("The pipeline API could not be reached. Check your connection.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Formatting ----------
const usd = (v, digits = 7) => (v == null ? "·" : `$${Number(v).toFixed(digits)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
function ago(epochSeconds) {
  const diff = Math.round(epochSeconds - Date.now() / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return relative.format(diff, "second");
  if (abs < 3600) return relative.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(diff / 3600), "hour");
  return relative.format(Math.round(diff / 86400), "day");
}
const LANE_NAMES = { light: "Light lane", heavy: "Heavy lane", baseline: "Baseline" };
const COMPONENT_NAMES = {
  validator: "Validator", dispatcher: "Dispatcher", classifier: "Classifier",
  "extract-light": "Light lane", "extract-heavy": "Heavy lane", "extract-baseline": "Baseline",
};
const STATUS_NAMES = { QUEUED: "Queued", STARTED: "Running", COMPLETED: "Completed", FAILED: "Failed", REJECTED: "Rejected" };

// ---------- Header ----------
function initHeader() {
  const header = document.querySelector("[data-header]");
  const heroEl = document.querySelector("[data-hero]");
  const themed = [...document.querySelectorAll("[data-theme]")];
  const links = [...document.querySelectorAll(".site-nav a")];
  let ticking = false;
  const update = () => {
    ticking = false;
    const probe = header.offsetHeight / 2;
    const under = themed.find((s) => {
      const box = s.getBoundingClientRect();
      return box.top <= probe && box.bottom > probe;
    });
    header.classList.toggle("is-dark", under?.dataset.theme === "dark");
    header.classList.toggle("is-scrolled", window.scrollY >= heroEl.offsetHeight - 120);
    const middle = window.innerHeight * 0.4;
    for (const link of links) {
      const target = document.querySelector(link.getAttribute("href"));
      const box = target.getBoundingClientRect();
      if (box.top <= middle && box.bottom > middle) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
}

async function checkHealth() {
  const status = document.querySelector("[data-status]");
  const text = status.querySelector("[data-status-text]");
  try {
    await api("/api/health", { timeout: 6000 });
    status.dataset.state = "online";
    text.textContent = "Pipeline online · Sydney";
  } catch {
    status.dataset.state = "offline";
    text.textContent = "Pipeline offline";
  }
}

// ---------- Motion helpers ----------
function splitTitle() {
  document.querySelectorAll("[data-split]").forEach((word, w) => {
    const letters = [...word.textContent.trim()];
    word.textContent = "";
    letters.forEach((letter, i) => {
      const span = document.createElement("span");
      span.className = "char";
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("--i", i + w * 3);
      span.textContent = letter;
      word.append(span);
    });
  });
}

function initReveal() {
  const items = document.querySelectorAll("[data-reveal]");
  if (reducedMotion || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  items.forEach((item) => io.observe(item));
}

function initHero() {
  const heroEl = document.querySelector("[data-hero]");
  const canvas = heroEl.querySelector("[data-hero-canvas]");
  const out = {
    count: heroEl.querySelector('[data-sim="count"]'),
    adaptive: heroEl.querySelector('[data-sim="adaptive"]'),
    baseline: heroEl.querySelector('[data-sim="baseline"]'),
    saved: heroEl.querySelector('[data-sim="saved"]'),
  };
  hero = createHero({
    canvas,
    hero: heroEl,
    titleEl: heroEl.querySelector(".hero-title"),
    results,
    reducedMotion,
    onStats(s) {
      out.count.textContent = s.count.toLocaleString("en-GB");
      out.adaptive.textContent = usd(s.adaptive, 6);
      out.baseline.textContent = usd(s.baseline, 6);
      out.saved.textContent = s.baseline ? `${((1 - s.adaptive / s.baseline) * 100).toFixed(1)}%` : "0.0%";
    },
  });
  const toggle = heroEl.querySelector("[data-motion-toggle]");
  if (reducedMotion) {
    toggle.hidden = true;
    return;
  }
  toggle.addEventListener("click", () => {
    const paused = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "Play motion" : "Pause motion";
    hero.setPaused(paused);
  });
}

// Architecture diagram: a packet travels the route a document takes.
const diagram = { play() {} };
function initDiagram() {
  const svg = document.querySelector(".diagram");
  if (!svg || reducedMotion) return;
  const packet = svg.querySelector("[data-packet]");
  let frame = 0;
  let turn = 0;
  diagram.play = (lane) => {
    const route = svg.querySelector(`#route-${lane}`);
    if (!route) return;
    cancelAnimationFrame(frame);
    const length = route.getTotalLength();
    const start = performance.now();
    const duration = 3600;
    packet.style.opacity = "1";
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const point = route.getPointAtLength(eased * length);
      packet.setAttribute("cx", point.x);
      packet.setAttribute("cy", point.y);
      if (t < 1) frame = requestAnimationFrame(step);
      else packet.style.opacity = "0";
    };
    frame = requestAnimationFrame(step);
  };
  const lanes = ["light", "heavy", "baseline"];
  const card = svg.closest("[data-diagram]");
  new IntersectionObserver(([entry], io) => {
    if (entry.isIntersecting) {
      diagram.play("light");
      io.disconnect();
    }
  }, { threshold: 0.5 }).observe(card);
  card.addEventListener("pointerenter", () => diagram.play(lanes[++turn % lanes.length]));
}

// ---------- Tracker ----------
const STAGES = ["uploaded", "validated", "dispatched", "classified", "extracted", "stored", "costed"];

function createTracker() {
  const root = document.querySelector("[data-tracker]");
  const fileLabel = root.querySelector("[data-tracker-file]");
  const announce = root.querySelector("[data-announce]");
  const receipt = root.querySelector("[data-receipt]");
  const viewText = root.querySelector("[data-view-text]");
  const stages = Object.fromEntries(STAGES.map((name) => {
    const li = root.querySelector(`[data-stage="${name}"]`);
    return [name, { li, detail: li.querySelector(".stage-detail"), time: li.querySelector(".stage-time"), initial: li.querySelector(".stage-detail").textContent }];
  }));
  let current = null;

  function setStage(name, status, detail) {
    const stage = stages[name];
    if (stage.li.dataset.status === status && (!detail || stage.detail.textContent === detail)) return;
    stage.li.dataset.status = status;
    if (detail) stage.detail.textContent = detail;
    if ((status === "done" || status === "failed") && !stage.time.textContent && current) {
      stage.time.textContent = `+${((performance.now() - current.started) / 1000).toFixed(1)} s`;
    }
  }

  function say(message) {
    announce.textContent = message;
  }

  function reset(file, mode) {
    current = { file, mode, docId: null, started: performance.now(), timer: 0, finalSince: 0, done: false };
    root.dataset.state = "active";
    fileLabel.textContent = `${file} · ${mode === "baseline" ? "baseline" : "adaptive"}`;
    fileLabel.title = file;
    for (const name of STAGES) {
      stages[name].li.dataset.status = "pending";
      stages[name].detail.textContent = stages[name].initial;
      stages[name].time.textContent = "";
    }
    receipt.hidden = true;
    viewText.hidden = true;
  }

  function nearestMeasured(pages) {
    if (!results || !pages) return null;
    return results.files.reduce((best, f) =>
      Math.abs(Math.log(f.pages) - Math.log(pages)) < Math.abs(Math.log(best.pages) - Math.log(pages)) ? f : best);
  }

  function fillBreakdown(doc) {
    const body = receipt.querySelector("[data-breakdown] tbody");
    body.replaceChildren(...doc.components.map((c) => {
      const tr = document.createElement("tr");
      const cells = [
        COMPONENT_NAMES[c.component] || c.component,
        `${c.memoryMb} MB`,
        c.billedMs != null ? `${Math.round(c.billedMs)} ms${c.coldStart ? " · cold" : ""}` : "pending",
        c.costUsd != null ? Number(c.costUsd).toFixed(7) : "pending",
      ];
      cells.forEach((value, i) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (i > 0) td.className = "num";
        tr.append(td);
      });
      return tr;
    }));
  }

  function showReceipt(doc, outcome) {
    const label = receipt.querySelector("[data-receipt-label]");
    const value = receipt.querySelector("[data-receipt-value]");
    const note = receipt.querySelector("[data-receipt-note]");
    const compare = receipt.querySelector("[data-receipt-compare]");
    receipt.dataset.outcome = outcome;
    const invocations = doc.components.length;
    const billed = Math.round(doc.components.reduce((t, c) => t + (c.billedMs || 0), 0));
    const cold = doc.components.some((c) => c.coldStart);
    compare.textContent = "";

    if (outcome === "completed") {
      label.textContent = "Actual billed cost";
      value.textContent = usd(doc.costUsd);
      note.textContent = `${plural(doc.pages, "page")} through the ${LANE_NAMES[doc.lane].toLowerCase()}, ${plural(invocations, "Lambda invocation")} and ${billed} ms billed in all. That is about $${(doc.costUsd * 1e6).toFixed(2)} per million documents like it.`;
      const measured = nearestMeasured(doc.pages);
      if (measured) {
        compare.textContent = `Measured medians for ${plural(measured.pages, "page")} (warm runs): adaptive ${usd(measured.adaptive.totalUsd)}, baseline ${usd(measured.baseline.totalUsd)}.${cold ? " This run included a cold start: a fresh copy of a function had to start up, and that time is billed too." : ""}`;
      }
      viewText.hidden = false;
    } else if (outcome === "failed") {
      label.textContent = "Processing failed";
      value.textContent = doc.error || "Unknown error";
      note.textContent = `Step Functions caught the error, marked the job as failed, moved it to the dead letter queue and raised the failure alarm. The attempt still cost ${usd(doc.costUsd)} across ${plural(invocations, "invocation")}.`;
    } else {
      label.textContent = "Rejected at the door";
      value.textContent = doc.error ? doc.error.charAt(0).toUpperCase() + doc.error.slice(1) : "Not accepted";
      note.textContent = `The validator read the first five bytes, found no PDF signature and queued nothing. Checking it cost ${usd(doc.costUsd)}.`;
    }
    fillBreakdown(doc);
    // Sampled runs carry an X-Ray trace ID: paste it into CloudWatch traces to see the
    // whole journey, with every S3 and DynamoDB call.
    const trace = receipt.querySelector("[data-receipt-trace]");
    trace.querySelector("[data-trace-id]").textContent = doc.traceId || "";
    trace.hidden = !doc.traceId;
    receipt.hidden = false;
  }

  function apply(doc) {
    const comps = Object.fromEntries(doc.components.map((c) => [c.component, c]));
    const extractor = doc.components.find((c) => c.component.startsWith("extract-"));
    const final = ["COMPLETED", "FAILED", "REJECTED"].includes(doc.status);
    if (final && !current.finalSince) current.finalSince = performance.now();

    if (doc.status === "REJECTED") {
      setStage("validated", "failed", `Rejected: ${doc.error || "not a PDF"}`);
    } else {
      setStage("validated", "done", "The file starts with a genuine PDF signature");
      if (doc.status === "QUEUED") setStage("dispatched", "active");
      else setStage("dispatched", "done", "SQS delivered the job and an Express run started");

      if (doc.mode === "baseline") {
        setStage("classified", "skipped", "Skipped: baseline runs always use the 3008 MB function");
      } else if (comps.classifier?.failed) {
        setStage("classified", "failed", `The classifier could not read the file (${doc.error || "error"})`);
      } else if (comps.classifier && comps.classifier.lane) {
        setStage("classified", "done", `Score ${comps.classifier.score} from pages and size, so the ${comps.classifier.lane} lane`);
      } else if (doc.status === "STARTED") {
        setStage("classified", "active");
      }

      if (extractor?.failed) {
        setStage("extracted", "failed", `${COMPONENT_NAMES[extractor.component]} could not extract text (${doc.error || "error"})`);
      } else if (extractor && doc.pages != null) {
        const ms = extractor.billedMs != null ? `${Math.round(extractor.billedMs)} ms billed` : "billing pending";
        setStage("extracted", "done", `${COMPONENT_NAMES[extractor.component]} · ${extractor.memoryMb} MB · ${ms} · ${plural(doc.pages, "page")}, ${plural(doc.words ?? 0, "word")}`);
      } else if (doc.status === "STARTED" && (doc.mode === "baseline" || comps.classifier)) {
        setStage("extracted", "active");
      }

      if (doc.status === "COMPLETED") setStage("stored", "done", "Result in DynamoDB, text in the curated bucket, SNS message sent");
      else if (doc.status === "FAILED") setStage("stored", "failed", "Marked failed, moved to the dead letter queue, alarm raised");
    }

    if (final) {
      const reconciled = doc.components.filter((c) => c.reconciled).length;
      const all = reconciled === doc.components.length && doc.costUsd != null;
      if (all) {
        setStage("costed", "done", `${plural(reconciled, "invocation")} reconciled against CloudWatch Logs`);
      } else {
        setStage("costed", "active", `Reading billed durations: ${reconciled} of ${doc.components.length}`);
      }
      const waitedTooLong = performance.now() - current.finalSince > 45000;
      if (all || waitedTooLong) {
        const outcome = doc.status.toLowerCase();
        showReceipt(doc, outcome);
        if (!all) setStage("costed", "active", "Billed durations are still arriving. The live feed will show the final figure.");
        finish(doc, outcome);
        return true;
      }
    }
    return false;
  }

  function finish(doc, outcome) {
    current.done = true;
    clearTimeout(current.timer);
    root.dataset.state = outcome;
    say(outcome === "completed"
      ? `${current.file} completed in the ${LANE_NAMES[doc.lane].toLowerCase()}. Billed cost ${usd(doc.costUsd)}.`
      : outcome === "failed" ? `${current.file} failed and was moved to the dead letter queue.` : `${current.file} was rejected: ${doc.error}.`);
    document.dispatchEvent(new CustomEvent("laneflow:finished", { detail: { doc, outcome } }));
  }

  async function poll() {
    if (!current || current.done) return;
    const tracked = current;
    try {
      const doc = await api(`/api/documents/${tracked.docId}`, { timeout: 8000 });
      if (tracked !== current) return;
      if (apply(doc)) return;
    } catch (error) {
      if (tracked !== current) return;
      if (error.status !== 404) setStage("validated", "active", "Waiting for the pipeline to answer");
    }
    if (performance.now() - tracked.started > 180000) {
      setStage("costed", "failed", "No answer after three minutes. Check the live feed below.");
      tracked.done = true;
      return;
    }
    tracked.timer = setTimeout(poll, 1200);
  }

  const copyTrace = receipt.querySelector("[data-copy-trace]");
  copyTrace.addEventListener("click", async () => {
    const id = receipt.querySelector("[data-trace-id]").textContent;
    try {
      await navigator.clipboard.writeText(id);
      copyTrace.textContent = "Copied";
      say("Trace ID copied.");
      setTimeout(() => { copyTrace.textContent = "Copy"; }, 1600);
    } catch {
      say("Copying is not available here. Select the trace ID and copy it instead.");
    }
  });

  viewText.addEventListener("click", async () => {
    if (!current?.docId) return;
    viewText.setAttribute("aria-busy", "true");
    try {
      const { url } = await api(`/api/documents/${current.docId}/text`);
      window.open(url, "_blank", "noopener");
    } catch (error) {
      say(error.message);
    } finally {
      viewText.removeAttribute("aria-busy");
    }
  });

  return {
    start(file, mode) {
      if (current) clearTimeout(current.timer);
      reset(file, mode);
      setStage("uploaded", "active", "Sending to the upload bucket");
      say(`Uploading ${file}.`);
    },
    uploaded(docId) {
      current.docId = docId;
      setStage("uploaded", "done", "Stored in the upload bucket, encrypted with KMS");
      setStage("validated", "active");
      document.dispatchEvent(new CustomEvent("laneflow:uploaded", { detail: { docId, mode: current.mode } }));
      poll();
    },
    failUpload(message) {
      setStage("uploaded", "failed", message);
      root.dataset.state = "failed";
      current.done = true;
    },
  };
}

// ---------- Sender ----------
function initSender(tracker) {
  const form = document.querySelector("[data-sender]");
  const input = form.querySelector("[data-file]");
  const dropzone = form.querySelector("[data-dropzone]");
  const chips = [...form.querySelectorAll("[data-sample]")];
  const errorBox = form.querySelector("[data-form-error]");
  const modes = [...form.querySelectorAll('input[name="mode"]')];
  let busy = false;

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };
  const setBusy = (state) => {
    busy = state;
    dropzone.classList.toggle("is-busy", state);
    input.disabled = state;
    chips.forEach((chip) => { chip.disabled = state; });
    modes.forEach((m) => { m.disabled = state; });
  };

  async function send(file, name) {
    if (busy) return;
    errorBox.hidden = true;
    if (!/\.pdf$/i.test(name)) return showError("Only PDF files can be sent. Choose a file whose name ends in .pdf.");
    if (file.size === 0) return showError("That file is empty, so there is nothing to process.");
    if (file.size > MAX_BYTES) return showError(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 25 MB.`);

    const mode = form.querySelector('input[name="mode"]:checked').value;
    setBusy(true);
    tracker.start(name, mode);
    try {
      const { docId, upload } = await api("/api/uploads", { method: "POST", body: JSON.stringify({ filename: name, mode }) });
      const data = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) data.append(key, value);
      data.append("file", file, name); // S3 requires the file to be the last field
      const response = await fetch(upload.url, { method: "POST", body: data });
      if (!response.ok) throw new Error(`The upload bucket refused the file (${response.status}).`);
      tracker.uploaded(docId);
    } catch (error) {
      tracker.failUpload(error.message);
      showError(`${error.message} Nothing was processed, so you can simply try again.`);
    } finally {
      setBusy(false);
    }
  }

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) send(file, file.name);
    input.value = "";
  });

  let depth = 0;
  dropzone.addEventListener("dragenter", (e) => { e.preventDefault(); depth += 1; dropzone.classList.add("is-over"); });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  dropzone.addEventListener("dragleave", () => { depth -= 1; if (depth <= 0) { depth = 0; dropzone.classList.remove("is-over"); } });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    dropzone.classList.remove("is-over");
    const file = e.dataTransfer.files?.[0];
    if (file) send(file, file.name);
  });
  // A file dropped anywhere else must not navigate away from the page.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  for (const chip of chips) {
    chip.addEventListener("click", async () => {
      const name = chip.dataset.sample;
      chip.setAttribute("aria-busy", "true");
      try {
        const response = await fetch(`samples/${name}`);
        if (!response.ok) throw new Error("That sample file is missing from the site.");
        const blob = await response.blob();
        await send(new File([blob], name, { type: "application/pdf" }), name);
      } catch (error) {
        showError(error.message);
      } finally {
        chip.removeAttribute("aria-busy");
      }
    });
  }

  document.querySelector("[data-send-another]").addEventListener("click", () => {
    form.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    input.focus({ preventScroll: true });
  });
}

// ---------- Live feed ----------
function initFeed() {
  const section = document.querySelector("[data-live]");
  const feed = section.querySelector("[data-feed]");
  const rows = section.querySelector("[data-feed-rows]");
  const message = section.querySelector("[data-feed-message]");
  const updated = section.querySelector("[data-feed-updated]");
  const refreshButton = section.querySelector("[data-feed-refresh]");
  const kpi = (name) => section.querySelector(`[data-kpi="${name}"]`);
  const known = new Set();
  let loaded = false, inView = false, timer = 0, lastOk = 0, failing = false;

  const average = (list) => (list.length ? list.reduce((t, v) => t + v, 0) / list.length : null);

  function cell(label, content, className) {
    const td = document.createElement("td");
    td.dataset.label = label;
    if (className) td.className = className;
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  }

  function render(docs) {
    const costed = docs.filter((d) => d.costUsd != null);
    const completed = docs.filter((d) => d.status === "COMPLETED");
    kpi("count").textContent = docs.length.toLocaleString("en-GB");
    kpi("completed").textContent = completed.length.toLocaleString("en-GB");
    kpi("problems").textContent = docs.filter((d) => d.status === "FAILED" || d.status === "REJECTED").length.toLocaleString("en-GB");
    const lightAvg = average(completed.filter((d) => d.lane === "light" && d.costUsd != null).map((d) => d.costUsd));
    const heavyAvg = average(completed.filter((d) => d.lane === "heavy" && d.costUsd != null).map((d) => d.costUsd));
    kpi("light").textContent = lightAvg == null ? "None yet" : usd(lightAvg);
    kpi("heavy").textContent = heavyAvg == null ? "None yet" : usd(heavyAvg);
    kpi("total").textContent = usd(costed.reduce((t, d) => t + d.costUsd, 0), 6);

    const fresh = [];
    rows.replaceChildren(...docs.slice(0, 15).map((doc) => {
      const tr = document.createElement("tr");
      if (loaded && !known.has(doc.docId)) tr.classList.add("is-new");
      const time = document.createElement("time");
      time.dateTime = new Date(doc.createdAt * 1000).toISOString();
      time.title = new Date(doc.createdAt * 1000).toLocaleString("en-GB");
      time.textContent = ago(doc.createdAt);
      const name = document.createElement("span");
      name.className = "doc-name";
      name.textContent = doc.file;
      name.title = doc.file;
      const lane = document.createElement("span");
      lane.className = "lane-tag";
      lane.dataset.lane = doc.lane || "none";
      lane.textContent = doc.lane ? LANE_NAMES[doc.lane] : "None";
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.dataset.status = doc.status;
      badge.textContent = STATUS_NAMES[doc.status] || doc.status;
      if (doc.error) badge.title = doc.error;
      tr.append(
        cell("When", time),
        cell("Document", name),
        cell("Mode", doc.mode === "baseline" ? "Baseline" : "Adaptive"),
        cell("Lane", lane),
        cell("Pages", doc.pages ?? "·", "num"),
        cell("Status", badge),
        cell("Billed cost (USD)", doc.costUsd != null ? Number(doc.costUsd).toFixed(7) : "pending", "num"),
      );
      return tr;
    }));
    for (const doc of docs) {
      if (!known.has(doc.docId)) {
        if (loaded && doc.status === "COMPLETED") fresh.push(doc);
        known.add(doc.docId);
      }
    }
    // Newly completed documents join the hero's stream.
    fresh.slice(0, 4).forEach((doc, i) => setTimeout(() => hero?.addRealDoc({
      pages: doc.pages, lane: doc.lane, label: `${doc.file.length > 18 ? doc.file.slice(0, 16) + "…" : doc.file} · ${doc.pages} p`,
    }), i * 700));

    if (docs.length === 0) {
      message.textContent = "No documents yet. Send one above and it will appear here within seconds.";
      message.hidden = false;
    } else {
      message.hidden = true;
    }
    loaded = true;
  }

  function stamp() {
    if (!lastOk) return;
    const seconds = Math.round((Date.now() - lastOk) / 1000);
    updated.textContent = failing
      ? `Latest 50 documents · could not refresh, retrying`
      : `Latest 50 documents · updated ${seconds < 2 ? "just now" : `${seconds} s ago`}`;
  }

  async function refresh() {
    feed.dataset.state = loaded ? "refreshing" : "loading";
    refreshButton.setAttribute("aria-busy", "true");
    try {
      const { documents } = await api("/api/documents?limit=50");
      render(documents);
      lastOk = Date.now();
      failing = false;
    } catch (error) {
      failing = true;
      if (!loaded) {
        message.textContent = `The live feed could not reach the pipeline API. ${error.message} It will keep trying while this section is on screen.`;
        message.hidden = false;
      }
    } finally {
      feed.dataset.state = "ready";
      refreshButton.removeAttribute("aria-busy");
      stamp();
    }
  }

  function schedule() {
    clearInterval(timer);
    if (inView && document.visibilityState === "visible") {
      refresh();
      timer = setInterval(() => { refresh(); }, 5000);
    }
  }

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    schedule();
  }, { rootMargin: "200px 0px" }).observe(section);
  document.addEventListener("visibilitychange", schedule);
  refreshButton.addEventListener("click", refresh);
  setInterval(stamp, 1000);
  document.addEventListener("laneflow:finished", refresh);
  refresh();
}

// ---------- Start ----------
async function start() {
  splitTitle();
  initHeader();
  initReveal();
  checkHealth();
  const tracker = createTracker();
  initSender(tracker);
  initFeed();
  initDiagram();
  document.addEventListener("laneflow:finished", (e) => {
    const lane = e.detail.doc.mode === "baseline" ? "baseline" : e.detail.doc.lane;
    if (lane) diagram.play(lane);
  });

  try {
    results = await fetch("data/results.json").then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  } catch {
    document.querySelector("[data-results-intro]").textContent = "The measured results could not be loaded. Refresh the page to try again.";
    return;
  }
  if (document.fonts?.ready) await document.fonts.ready;
  initHero();
  renderResults(results, { reducedMotion });
}

start();
