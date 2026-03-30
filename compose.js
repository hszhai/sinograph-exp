// ---------------------------------------------------------------------------
// Sinograph Lab - Compose Tool
// Renders text using character designs from a scene file.
// ---------------------------------------------------------------------------
import {
  mulberry32, modifyMedian, trimMedian, transformMedian, smoothMedian, densityScale,
  classifyStroke, parseStrokeType,
  createStrokeEnvelope, smoothClosedPath,
} from "./engine.js";

const CDN_BASE = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1";
const medianCache = {};

async function fetchMedians(ch) {
  if (medianCache[ch]) return medianCache[ch];
  const url = `${CDN_BASE}/${encodeURIComponent(ch)}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.medians) {
      medianCache[ch] = data.medians;
      return data.medians;
    }
  } catch {}
  return null;
}

const DEFAULT_PARAMS = {
  style: "calligraphic",
  radius: 30,
  taper: 0.55,
  entryPressure: 0.8,
  exitSharpness: 0.2,
  brushAngle: -30,
  angleVar: 0,
  tremor: 0,
  jitter: 3,
  weightMul: 1,
  inkLevel: 0.9,
  asymmetry: 0,
  curvatureWeight: 0.5,
  sampleStep: 5,
  normalBias: 0,
  dryness: 0.12,
  warp: 0,
  smoothness: 0.45,
  widthCurve: null,
  offsetCurve: null,
};

// --- Scene ---
const SCENE_KEY = "charDesignScene";
const COMPOSE_STATE_KEY = "composeState";
let scene = null;
let variantCounters = {};

function loadSceneFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCENE_KEY));
    if (raw) {
      // Multi-set format: merge all sets into a flat scene for compose
      if (raw.sets) {
        const merged = { chars: [], designs: {} };
        for (const s of raw.sets) {
          const designs = migrateDesigns(s.designs);
          for (const ch of (s.chars || [])) {
            if (!merged.chars.includes(ch)) merged.chars.push(ch);
            // Later set's designs override earlier ones
            if (designs[ch]) merged.designs[ch] = designs[ch];
          }
        }
        scene = merged;
        updateSceneInfo();
        return true;
      }
      // Legacy single-set format
      if (raw.chars && raw.designs) {
        scene = raw;
        scene.designs = migrateDesigns(scene.designs);
        updateSceneInfo();
        return true;
      }
    }
  } catch {}
  return false;
}

function updateSceneInfo() {
  if (!scene) {
    sceneInfoEl.textContent = "No project loaded";
    return;
  }
  const charCount = scene.chars.length;
  const varCount = Object.values(scene.designs)
    .reduce((sum, vs) => sum + (Array.isArray(vs) ? vs.filter(v => v).length : 0), 0);
  sceneInfoEl.textContent = charCount > 0 ? `${charCount} chars, ${varCount} variants` : "No project loaded";
}

function migrateDesigns(designs) {
  if (!designs) return {};
  for (const ch of Object.keys(designs)) {
    if (designs[ch] && !Array.isArray(designs[ch])) {
      designs[ch] = [designs[ch]];
    }
  }
  return designs;
}

function getVariant(ch, explicitIdx) {
  if (!scene || !scene.designs[ch]) return null;
  const variants = scene.designs[ch].filter(v => v != null);
  if (!variants.length) return null;
  // Explicit variant selection (from tuning)
  if (explicitIdx >= 0 && explicitIdx < variants.length) return variants[explicitIdx];
  // Auto round-robin
  if (!variantCounters[ch]) variantCounters[ch] = 0;
  const idx = variantCounters[ch] % variants.length;
  variantCounters[ch]++;
  return variants[idx];
}

function getVariantCount(ch) {
  if (!scene || !scene.designs[ch]) return 0;
  return scene.designs[ch].filter(v => v != null).length;
}

// ---------------------------------------------------------------------------
// Per-instance tuning keyed by position index in allChars.
// { "0": { size: 0.95, ... }, "3": { strokeScale: 1.2, ... }, ... }
// ---------------------------------------------------------------------------
const TUNING_KEY = "composeTuning";
let charTuning = {};

function loadTuning() {
  try {
    const raw = JSON.parse(localStorage.getItem(TUNING_KEY));
    if (raw && typeof raw === "object") charTuning = raw;
  } catch {}
}

function saveTuning() {
  localStorage.setItem(TUNING_KEY, JSON.stringify(charTuning));
}

const TUNING_DEFAULTS = { size: 1, offsetX: 0, offsetY: 0, spacing: 0, strokeScale: 1, variantIdx: -1 }; // -1 = auto round-robin

function tuningKey(idx) { return String(idx); }

function getTuningByIdx(idx) {
  return charTuning[tuningKey(idx)] || { ...TUNING_DEFAULTS };
}

function setTuningByIdx(idx, key, value) {
  const k = tuningKey(idx);
  if (!charTuning[k]) charTuning[k] = { ...TUNING_DEFAULTS };
  charTuning[k][key] = value;
  const t = charTuning[k];
  const isDefault = Object.keys(TUNING_DEFAULTS).every(dk => t[dk] === TUNING_DEFAULTS[dk]);
  if (isDefault) {
    delete charTuning[k];
  }
  saveTuning();
}

// ---------------------------------------------------------------------------
// Tuning UI
// ---------------------------------------------------------------------------
let tuningSelectedIdx = -1;
let tuningAllChars = [];

// Cache from last smart render for dynamic bbox
let lastSmartCache = null; // { allChars, settings, renderedChars, snapshot }

function cacheSmartRender(allChars, settings, renderedChars) {
  // Snapshot the rendered canvas as an image for fast bbox overlay
  const snapshot = new Image();
  snapshot.src = composeCanvas.toDataURL();
  lastSmartCache = { allChars, settings, renderedChars, snapshot };
}

function drawBboxOverlay(highlightIdx) {
  if (!lastSmartCache) return;
  const { allChars, settings, renderedChars, snapshot } = lastSmartCache;

  // Recompute layout with current tuning
  const charSizes = computeCharSizes(allChars, settings.cellSize, settings.sizeVar, settings.complexShrink);
  const layout = settings.direction === "smart-h"
    ? computeSmartHLayout(allChars, settings, renderedChars, charSizes)
    : computeSmartLayout(allChars, settings, renderedChars, charSizes);

  // Redraw snapshot
  const draw = () => {
    composeCtx.clearRect(0, 0, composeCanvas.width, composeCanvas.height);
    composeCtx.drawImage(snapshot, 0, 0);

    // Draw bounding boxes for all characters of the same type
    const selCh = highlightIdx >= 0 ? allChars[highlightIdx] : null;
    layout.positions.forEach((pos) => {
      const fi = pos.flatIdx ?? -1;
      const sz = charSizes[fi] ?? settings.cellSize;
      const isSelected = (fi === highlightIdx);
      const isSameChar = (pos.ch === selCh && fi !== highlightIdx);

      if (isSelected) {
        composeCtx.strokeStyle = "rgba(159, 63, 23, 0.7)";
        composeCtx.lineWidth = 2;
        composeCtx.setLineDash([]);
        composeCtx.strokeRect(pos.x, pos.y, sz, sz);
      } else if (isSameChar) {
        composeCtx.strokeStyle = "rgba(159, 63, 23, 0.25)";
        composeCtx.lineWidth = 1;
        composeCtx.setLineDash([4, 3]);
        composeCtx.strokeRect(pos.x, pos.y, sz, sz);
      }
    });
    composeCtx.setLineDash([]);
  };

  if (snapshot.complete) {
    draw();
  } else {
    snapshot.onload = draw;
  }
}

function buildTuningUI(chars) {
  tuningAllChars = chars;
  const section = document.getElementById("tuning-section");
  const container = document.getElementById("tuning-chars");
  const panel = document.getElementById("tuning-panel");

  if (!chars.length) {
    section.classList.add("tuning-hidden");
    return;
  }
  section.classList.remove("tuning-hidden");

  container.innerHTML = "";
  chars.forEach((ch, idx) => {
    if (ch === "\n" || ch === "\r" || ch === " ") return; // skip sentinels
    const btn = document.createElement("button");
    btn.className = "tuning-char" + (charTuning[tuningKey(idx)] ? " has-tuning" : "");
    btn.dataset.idx = idx;

    // Render mini preview thumbnail
    const medians = medianCache[ch];
    const t = getTuningByIdx(idx);
    const designData = getVariant(ch, t.variantIdx);
    if (medians && designData) {
      const thumb = renderCharacter(medians, designData, 40, 1);
      thumb.style.cssText = "width:26px; height:26px; pointer-events:none;";
      btn.appendChild(thumb);
    } else {
      btn.textContent = ch;
    }

    // Variant indicator superscript
    const vc = getVariantCount(ch);
    if (vc > 1) {
      const sup = document.createElement("span");
      sup.className = "tuning-variant-count";
      const vi = t.variantIdx;
      sup.textContent = vi >= 0 ? (vi + 1) : vc;
      if (vi >= 0) sup.classList.add("variant-picked");
      btn.appendChild(sup);
    }

    btn.addEventListener("click", () => {
      if (tuningSelectedIdx === idx) { deselectTuning(); } else { selectTuningIdx(idx); }
    });
    container.appendChild(btn);
  });

  if (tuningSelectedIdx >= 0 && tuningSelectedIdx < chars.length) {
    selectTuningIdx(tuningSelectedIdx);
  } else {
    panel.innerHTML = "";
    tuningSelectedIdx = -1;
    document.getElementById("tuning-design-btn").classList.add("tuning-hidden");
  }
}

function buildTuningPreview(idx) {
  const container = document.getElementById("tuning-preview");
  container.innerHTML = "";
  if (idx < 0 || idx >= tuningAllChars.length) return;

  const ch = tuningAllChars[idx];
  const medians = medianCache[ch];
  if (!medians) return;

  const vc = getVariantCount(ch);
  if (vc === 0) return;

  const t = getTuningByIdx(idx);
  const variants = scene.designs[ch].filter(v => v != null);

  // Show "Auto" option if multiple variants
  if (vc > 1) {
    const autoSlot = document.createElement("div");
    autoSlot.className = "tuning-preview-slot" + (t.variantIdx < 0 ? " active" : "");
    autoSlot.title = "Auto (round-robin)";
    autoSlot.style.cssText = "font-size:9px; color:var(--ink-soft); font-family:Menlo,monospace;";
    autoSlot.textContent = "Auto";
    autoSlot.addEventListener("click", () => {
      setTuningByIdx(idx, "variantIdx", -1);
      updateTuningHighlights();
      buildTuningPreview(idx);
      doRender();
    });
    container.appendChild(autoSlot);
  }

  variants.forEach((v, vi) => {
    const slot = document.createElement("div");
    slot.className = "tuning-preview-slot" + (t.variantIdx === vi ? " active" : (vc === 1 ? " active" : ""));
    slot.title = `Variant ${vi + 1}`;

    const thumb = renderCharacter(medians, v, 64, 1);
    slot.appendChild(thumb);

    const num = document.createElement("span");
    num.className = "preview-num";
    num.textContent = vi + 1;
    slot.appendChild(num);

    if (vc > 1) {
      slot.addEventListener("click", () => {
        setTuningByIdx(idx, "variantIdx", vi);
        updateTuningHighlights();
        buildTuningPreview(idx);
        doRender();
      });
    }
    container.appendChild(slot);
  });
}

function deselectTuning() {
  tuningSelectedIdx = -1;
  document.querySelectorAll(".tuning-char").forEach(btn => btn.classList.remove("active"));
  document.getElementById("tuning-panel").innerHTML = "";
  document.getElementById("tuning-preview").innerHTML = "";
  document.getElementById("tuning-design-btn").classList.add("tuning-hidden");
  // Restore clean canvas from snapshot
  if (lastSmartCache && lastSmartCache.snapshot.complete) {
    composeCtx.clearRect(0, 0, composeCanvas.width, composeCanvas.height);
    composeCtx.drawImage(lastSmartCache.snapshot, 0, 0);
  }
  saveComposeState();
}

function selectTuningIdx(idx) {
  tuningSelectedIdx = idx;
  const ch = tuningAllChars[idx];

  document.querySelectorAll(".tuning-char").forEach(btn => {
    const btnIdx = Number(btn.dataset.idx);
    btn.classList.toggle("active", btnIdx === idx);
  });

  // Show bbox on canvas
  drawBboxOverlay(idx);

  // Show variant preview
  buildTuningPreview(idx);

  const panel = document.getElementById("tuning-panel");
  const t = getTuningByIdx(idx);
  panel.innerHTML = "";

  const controls = [
    { key: "size", label: "Size", min: 0.7, max: 1.3, step: 0.01, val: t.size },
    { key: "strokeScale", label: "Stroke W", min: 0.3, max: 3, step: 0.05, val: t.strokeScale },
    { key: "offsetX", label: "Offset X", min: -40, max: 40, step: 1, val: t.offsetX },
    { key: "offsetY", label: "Offset Y", min: -40, max: 40, step: 1, val: t.offsetY },
    { key: "spacing", label: "Spacing", min: -30, max: 30, step: 1, val: t.spacing },
  ];

  controls.forEach(c => {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = c.label;

    const range = document.createElement("input");
    range.type = "range";
    range.min = c.min;
    range.max = c.max;
    range.step = c.step;
    range.value = c.val;

    const num = document.createElement("input");
    num.type = "number";
    num.className = "num-input";
    num.step = c.step;
    num.value = c.val;

    range.addEventListener("input", () => {
      num.value = range.value;
      setTuningByIdx(idx, c.key, Number(range.value));
      updateTuningHighlights();
      drawBboxOverlay(tuningSelectedIdx);
    });
    num.addEventListener("change", () => {
      let v = Number(num.value);
      v = Math.max(Number(range.min), Math.min(Number(range.max), v));
      range.value = v;
      num.value = v;
      setTuningByIdx(idx, c.key, v);
      updateTuningHighlights();
      drawBboxOverlay(tuningSelectedIdx);
    });

    label.appendChild(span);
    label.appendChild(range);
    label.appendChild(num);
    panel.appendChild(label);
  });

  const resetRow = document.createElement("div");
  resetRow.style.cssText = "display:flex; justify-content:space-between; margin-top:4px;";

  const resetBtn = document.createElement("button");
  resetBtn.className = "tuning-reset";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => {
    delete charTuning[tuningKey(idx)];
    saveTuning();
    selectTuningIdx(idx);
    updateTuningHighlights();
  });

  const resetAllBtn = document.createElement("button");
  resetAllBtn.className = "tuning-reset";
  resetAllBtn.textContent = "Reset all";
  resetAllBtn.addEventListener("click", () => {
    charTuning = {};
    saveTuning();
    updateTuningHighlights();
    selectTuningIdx(idx);
    setStatus("All character tuning reset");
  });

  resetRow.appendChild(resetBtn);
  resetRow.appendChild(resetAllBtn);
  panel.appendChild(resetRow);

  // Show header "Send to Design" button for selected character
  const headerBtn = document.getElementById("tuning-design-btn");
  headerBtn.classList.remove("tuning-hidden");
  headerBtn.onclick = () => {
    localStorage.setItem("composeToDesignChar", ch);
    const vi = getTuningByIdx(idx).variantIdx;
    if (vi >= 0) localStorage.setItem("composeToDesignVariant", String(vi));
    window.location.href = "./index.html";
  };

  saveComposeState();
}

function updateTuningHighlights() {
  document.querySelectorAll(".tuning-char").forEach(btn => {
    const idx = Number(btn.dataset.idx);
    btn.classList.toggle("has-tuning", !!charTuning[tuningKey(idx)]);
    // Update variant superscript
    const sup = btn.querySelector(".tuning-variant-count");
    if (sup) {
      const ch = tuningAllChars[idx];
      const t = getTuningByIdx(idx);
      const vc = getVariantCount(ch);
      sup.textContent = t.variantIdx >= 0 ? (t.variantIdx + 1) : vc;
      sup.classList.toggle("variant-picked", t.variantIdx >= 0);
    }
  });
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
function saveComposeState() {
  const state = {
    text: document.getElementById("poem-input").value,
    direction: document.querySelector('input[name="dir"]:checked').value,
    cellSize: document.getElementById("s-cellSize").value,
    strokeScale: document.getElementById("s-strokeScale").value,
    spacing: document.getElementById("s-spacing").value,
    lineGap: document.getElementById("s-lineGap").value,
    padding: document.getElementById("s-padding").value,
    flowW: document.getElementById("s-flowW").value,
    flowH: document.getElementById("s-flowH").value,
    sizeVar: document.getElementById("s-sizeVar").value,
    complexShrink: document.getElementById("s-complexShrink").value,
    classical: document.getElementById("classical-mode").checked,
    tuningIdx: tuningSelectedIdx,
  };
  localStorage.setItem(COMPOSE_STATE_KEY, JSON.stringify(state));
}

function restoreComposeState() {
  try {
    const state = JSON.parse(localStorage.getItem(COMPOSE_STATE_KEY));
    if (!state) return;
    if (state.text != null) document.getElementById("poem-input").value = state.text;
    if (state.direction) {
      const radio = document.querySelector(`input[name="dir"][value="${state.direction}"]`);
      if (radio) radio.checked = true;
    }
    // Restore sliders (have paired .num-input)
    const sliders = { cellSize: "s-cellSize", strokeScale: "s-strokeScale", spacing: "s-spacing", lineGap: "s-lineGap",
      padding: "s-padding", sizeVar: "s-sizeVar", complexShrink: "s-complexShrink" };
    for (const [key, id] of Object.entries(sliders)) {
      if (state[key] != null) {
        const el = document.getElementById(id);
        el.value = state[key];
        const num = el.parentElement.querySelector(".num-input");
        if (num) num.value = state[key];
      }
    }
    // Restore plain number inputs (paper)
    if (state.flowW != null) document.getElementById("s-flowW").value = state.flowW;
    if (state.flowH != null) document.getElementById("s-flowH").value = state.flowH;
    // Restore classical mode checkbox
    if (state.classical != null) document.getElementById("classical-mode").checked = state.classical;
    // Restore tuning selection
    if (state.tuningIdx != null) tuningSelectedIdx = state.tuningIdx;
  } catch {}
}

// --- Rendering helpers (mirror main.js) ---
function paramsToOpts(params) {
  return {
    strokeStyle: params.style,
    radius: params.radius,
    taper: params.taper,
    sampleStep: params.sampleStep,
    jitter: params.jitter,
    normalBias: params.normalBias,
    brushAngle: params.brushAngle,
    angleVar: params.angleVar,
    dryness: params.dryness,
    tremor: params.tremor,
    warp: params.warp,
    curvatureWeight: params.curvatureWeight,
    strokeVariation: 0,
    inkDepletion: 0,
  };
}

function paramsToTrait(params, median) {
  const rawType = classifyStroke(median);
  const { type: strokeType, turnProgress } = parseStrokeType(rawType);
  return {
    strokeType,
    turnProgress,
    weightMul: params.weightMul,
    speedBias: 1,
    entryPressure: params.entryPressure,
    exitSharpness: params.exitSharpness,
    tremor: params.tremor > 0 ? 0.5 : 0,
    inkLevel: params.inkLevel,
    asymmetry: params.asymmetry,
    pressurePeakPos: 0.45,
    widthCurve: params.widthCurve || null,
    offsetCurve: params.offsetCurve || null,
  };
}

function resolveParams(designData, strokeIndex) {
  const base = { ...DEFAULT_PARAMS, ...(designData.global || {}) };
  const over = (designData.overrides || {})[strokeIndex];
  if (over) Object.keys(over).forEach(k => { if (k !== "medianMod") base[k] = over[k]; });
  return base;
}

function resolveMedianMod(designData, strokeIndex) {
  const over = (designData.overrides || {})[strokeIndex];
  if (over && over.medianMod) return over.medianMod;
  return designData.medianMod || null;
}

function prepareMedian(median, mod, params) {
  let m = mod ? modifyMedian(median, mod) : median;
  const t0 = params.strokeStart ?? 0;
  const t1 = params.strokeEnd   ?? 1;
  if (t0 > 0 || t1 < 1) m = trimMedian(m, t0, t1);
  return m;
}

// Render a single character into an offscreen canvas
function renderCharacter(medians, designData, cellSize, strokeScale) {
  const canvas = document.createElement("canvas");
  canvas.width = cellSize;
  canvas.height = cellSize;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cellSize, cellSize);

  const cs = designData ? (designData.charScale || 1.0) : 1.0;
  const pad = cellSize * 0.06;
  const baseScale = (cellSize - pad * 2) / 1024;
  const scale = baseScale * cs;
  const ox = pad + (1 - cs) * (cellSize - pad * 2) / 2;
  const oy = pad + (1 - cs) * (cellSize - pad * 2) / 2;
  const dScale = densityScale(medians.length);
  const seed = designData ? (designData.seed || 1) : 1;
  const scaleRatio = cellSize / 640;

  const off = document.createElement("canvas");
  off.width = cellSize;
  off.height = cellSize;
  const oCtx = off.getContext("2d");

  medians.forEach((median, si) => {
    const cmod = designData ? resolveMedianMod(designData, si) : null;
    const params = designData ? resolveParams(designData, si) : { ...DEFAULT_PARAMS };
    const rawStroke = transformMedian(prepareMedian(median, cmod, params), ox, oy, scale);
    const opts = paramsToOpts(params);
    const ss = strokeScale || 1;
    opts.radius *= scaleRatio * ss;
    opts.jitter *= scaleRatio * ss;
    opts.normalBias *= scaleRatio * ss;
    const stroke = smoothMedian(rawStroke, params.smoothness);
    const trait = paramsToTrait(params, median);

    const rand = mulberry32(seed + si * 137);
    const envelope = createStrokeEnvelope(stroke, opts, rand, si, trait, dScale);

    oCtx.clearRect(0, 0, cellSize, cellSize);
    oCtx.beginPath();
    smoothClosedPath(oCtx, envelope);
    const alpha = 0.65 + trait.inkLevel * 0.3;
    oCtx.fillStyle = `rgba(28, 23, 19, ${alpha})`;
    oCtx.fill();

    ctx.globalCompositeOperation = "darken";
    ctx.drawImage(off, 0, 0);
  });

  ctx.globalCompositeOperation = "source-over";
  return canvas;
}

// ---------------------------------------------------------------------------
// Measure ink bounding box from rendered canvas
// ---------------------------------------------------------------------------
function measureInkBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = h, bottom = 0, left = w, right = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) { // alpha threshold
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top > bottom) return { top: 0, bottom: h, left: 0, right: w }; // empty

  // Enforce minimum bounds: each character occupies at least 40% of its cell
  // in each dimension, preserving the calligraphic "square space"
  const minSpan = Math.round(w * 0.4);
  const inkW = right - left;
  const inkH = bottom - top;
  if (inkW < minSpan) {
    const cx = (left + right) / 2;
    left = Math.max(0, Math.round(cx - minSpan / 2));
    right = Math.min(w, Math.round(cx + minSpan / 2));
  }
  if (inkH < minSpan) {
    const cy = (top + bottom) / 2;
    top = Math.max(0, Math.round(cy - minSpan / 2));
    bottom = Math.min(h, Math.round(cy + minSpan / 2));
  }

  return { top, bottom, left, right };
}

// --- Layout ---
function isCJK(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function isRenderable(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x4e00 && code <= 0x9fff) return true;  // CJK unified
  if (code >= 0x3400 && code <= 0x4dbf) return true;  // CJK ext A
  if (code >= 0x3000 && code <= 0x303f) return true;  // CJK punctuation
  if (code >= 0xff00 && code <= 0xffef) return true;  // fullwidth forms
  if (code >= 0x2000 && code <= 0x206f) return true;  // general punctuation
  if (/[a-zA-Z0-9.,!?;:'"()\-]/.test(ch)) return true;
  return false;
}

function parsePoem(text) {
  const classical = document.getElementById("classical-mode")?.checked;
  const rawLines = text.split(/\n/);
  const lines = [];
  let lastWasEmpty = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (lines.length > 0 && !lastWasEmpty) lines.push(null);
      lastWasEmpty = true;
      continue;
    }
    lastWasEmpty = false;
    // Walk character by character, preserving spaces as " " sentinels
    const chars = [];
    let inSpace = false;
    for (const ch of trimmed) {
      if (ch === " " || ch === "\u3000") {  // ASCII space or ideographic space
        if (!inSpace && chars.length > 0) chars.push(" ");
        inSpace = true;
        continue;
      }
      inSpace = false;
      if (!isRenderable(ch)) continue;
      if (classical && isPunctuation(ch)) continue;
      chars.push(ch);
    }
    // Remove trailing space sentinel
    while (chars.length && chars[chars.length - 1] === " ") chars.pop();
    if (chars.length > 0) lines.push(chars);
  }
  while (lines.length && lines[lines.length - 1] === null) lines.pop();
  return lines;
}

// Check if a character is CJK or fullwidth punctuation
function isPunctuation(ch) {
  const code = ch.codePointAt(0);
  // CJK punctuation U+3000-303F, fullwidth forms U+FF00-FF0F U+FF1A-FF20 U+FF3B-FF40 U+FF5B-FF65
  if (code >= 0x3000 && code <= 0x303f) return true;
  if (code >= 0xff01 && code <= 0xff0f) return true;
  if (code >= 0xff1a && code <= 0xff20) return true;
  if (code >= 0xff3b && code <= 0xff65) return true;
  // Common ASCII punctuation
  return ".,;:!?'\"()-".includes(ch);
}

// Render a non-CJK character (punctuation, Latin, numbers) as text on a canvas
// direction: "smart-h" or "horizontal" = punctuation at left; "smart" or "vertical" = punctuation at top-right
function renderTextChar(ch, cellSize, direction) {
  const canvas = document.createElement("canvas");
  canvas.width = cellSize;
  canvas.height = cellSize;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(28, 23, 19, 0.85)";
  const fontSize = Math.round(cellSize * 0.65);
  ctx.font = `${fontSize}px "Iowan Old Style", "Palatino Linotype", "SimSun", "Songti SC", serif`;

  if (isPunctuation(ch)) {
    const isVert = direction === "smart" || direction === "vertical";
    if (isVert) {
      // Top-right for vertical text
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(ch, cellSize * 0.85, cellSize * 0.05);
    } else {
      // Bottom-left for horizontal text
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(ch, cellSize * 0.05, cellSize * 0.85);
    }
  } else {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch, cellSize / 2, cellSize / 2);
  }
  return canvas;
}

function getSettings() {
  return {
    cellSize: Number(document.getElementById("s-cellSize").value),
    strokeScale: Number(document.getElementById("s-strokeScale").value),
    spacing: Number(document.getElementById("s-spacing").value),
    lineGap: Number(document.getElementById("s-lineGap").value),
    padding: Number(document.getElementById("s-padding").value),
    direction: document.querySelector('input[name="dir"]:checked').value,
    flowW: Number(document.getElementById("s-flowW").value),
    flowH: Number(document.getElementById("s-flowH").value),
    sizeVar: Number(document.getElementById("s-sizeVar").value),
    complexShrink: Number(document.getElementById("s-complexShrink").value),
  };
}

function computeLayout(lines, settings) {
  const { cellSize, spacing, lineGap, padding, direction } = settings;
  const step = cellSize + spacing;
  const paraExtra = Math.round(cellSize * 0.3 + lineGap);

  // Filter out null paragraph markers but track cumulative extra gap per line
  const realLines = [];
  const paraGaps = [];
  let extraGap = 0;
  for (const line of lines) {
    if (line === null) { extraGap += paraExtra; continue; }
    realLines.push(line);
    paraGaps.push(extraGap);
    extraGap = 0;
  }

  if (direction === "vertical") {
    const maxCharsInLine = Math.max(...realLines.map(l => l.length));
    const totalGap = paraGaps.reduce((a, b) => a + b, 0);
    const totalW = padding * 2 + realLines.length * step - spacing + (realLines.length - 1) * lineGap + totalGap;
    const totalH = padding * 2 + maxCharsInLine * step - spacing;

    const positions = [];
    let cumGap = 0;
    realLines.forEach((line, li) => {
      cumGap += paraGaps[li];
      const colX = totalW - padding - (li + 1) * step - li * lineGap - cumGap + spacing;
      line.forEach((ch, ci) => {
        if (ch !== " ") positions.push({ ch, x: colX, y: padding + ci * step });
      });
    });
    return { width: totalW, height: totalH, positions };
  } else {
    const maxCharsInLine = Math.max(...realLines.map(l => l.length));
    const totalGap = paraGaps.reduce((a, b) => a + b, 0);
    const totalW = padding * 2 + maxCharsInLine * step - spacing;
    const totalH = padding * 2 + realLines.length * step - spacing + (realLines.length - 1) * lineGap + totalGap;

    const positions = [];
    let cumGap = 0;
    realLines.forEach((line, li) => {
      cumGap += paraGaps[li];
      const rowY = padding + li * (step + lineGap) + cumGap;
      line.forEach((ch, ci) => {
        if (ch !== " ") positions.push({ ch, x: padding + ci * step, y: rowY });
      });
    });
    return { width: totalW, height: totalH, positions };
  }
}

// ---------------------------------------------------------------------------
// Smart layout: character size variation
// ---------------------------------------------------------------------------
// Compute per-character cell size based on stroke count, randomness, and
// complexity shrinking. Simpler characters (fewer strokes) shrink; complex
// ones stay full size. A seeded random jitter adds natural variation.
function computeCharSizes(allChars, baseCellSize, sizeVar, complexShrink) {
  const sizes = allChars.map((ch, i) => {
    const medians = medianCache[ch];
    const strokeCount = medians ? medians.length : 8;

    const complexity = Math.min(1, Math.max(0, (strokeCount - 3) / 17));
    const complexScale = 1 - complexShrink * (1 - complexity);

    const rand = mulberry32(i * 997 + 31);
    const jitter = 1 + (rand() - 0.5) * 2 * sizeVar;

    // Per-instance tuning multiplier
    const t = getTuningByIdx(i);
    return Math.round(baseCellSize * complexScale * jitter * t.size);
  });
  return sizes;
}

// ---------------------------------------------------------------------------
// Smart layout: pack characters by actual ink bounding boxes
// ---------------------------------------------------------------------------
function computeSmartLayout(allChars, settings, renderedChars, charSizes) {
  const { cellSize, spacing, lineGap, padding, flowW, flowH } = settings;
  // Base gaps from cellSize, modulated by user spacing/lineGap controls
  const inkGap = Math.max(0, Math.round(cellSize * 0.04 + spacing * 0.5));
  const colInkGap = Math.max(0, Math.round(cellSize * 0.02 + lineGap * 0.3));

  const positions = [];
  let colRightEdge = flowW - padding;
  let colChars = [];
  let cursorY = padding;

  function flushColumn() {
    if (!colChars.length) return;
    // Find the widest ink span in this column
    let maxInkW = 0;
    for (const item of colChars) {
      const inkW = item.bounds.right - item.bounds.left;
      if (inkW > maxInkW) maxInkW = inkW;
    }
    // Column center X: place column so its right edge aligns with colRightEdge
    const colCenterX = colRightEdge - maxInkW / 2;
    // Center each character's ink on the column center, then apply offset
    for (const item of colChars) {
      const inkCenterX = (item.bounds.left + item.bounds.right) / 2;
      item.pos.x = colCenterX - inkCenterX + (item.pos._offX || 0);
    }
    colRightEdge -= maxInkW + colInkGap;
    colChars = [];
    cursorY = padding;
  }

  function addChar(ch, bounds, flatIdx) {
    const t = getTuningByIdx(flatIdx);
    const yOffset = cursorY - bounds.top + t.offsetY;
    // x starts at 0; flushColumn will center, then we add offsetX
    const pos = { ch, x: 0, y: yOffset, _offX: t.offsetX, flatIdx };
    positions.push(pos);
    colChars.push({ pos, bounds });
    cursorY += (bounds.bottom - bounds.top) + inkGap + t.spacing;
  }

  const paraGap = Math.round(cellSize * 0.3 + lineGap);
  const spaceGap = Math.round(cellSize * 0.4);

  for (let i = 0; i < allChars.length; i++) {
    if (allChars[i] === "\n") {
      if (colChars.length > 0) flushColumn();
      colRightEdge -= paraGap;
      continue;
    }
    if (allChars[i] === "\r") {
      if (colChars.length > 0) flushColumn();
      continue;
    }
    if (allChars[i] === " ") {
      cursorY += spaceGap;
      continue;
    }

    const rendered = renderedChars[i];
    if (!rendered) continue;

    const ch = allChars[i];
    const bounds = rendered.bounds;
    const inkH = bounds.bottom - bounds.top;
    const t = getTuningByIdx(i);

    if (cursorY + inkH + t.spacing > flowH - padding && colChars.length > 0) {
      flushColumn();
    }
    addChar(ch, bounds, i);
  }
  flushColumn();

  // Clean temp properties
  for (const p of positions) delete p._offX;

  return { width: flowW, height: flowH, positions };
}

// ---------------------------------------------------------------------------
// Smart horizontal layout: pack characters in rows, left-to-right
// ---------------------------------------------------------------------------
function computeSmartHLayout(allChars, settings, renderedChars, charSizes) {
  const { cellSize, spacing, lineGap, padding, flowW, flowH } = settings;
  const inkGap = Math.max(0, Math.round(cellSize * 0.04 + spacing * 0.5));
  const rowInkGap = Math.max(0, Math.round(cellSize * 0.02 + lineGap * 0.3));
  const paraGap = Math.round(cellSize * 0.3 + lineGap);

  const positions = [];
  let rowTopEdge = padding;
  let rowChars = [];
  let cursorX = padding;

  function flushRow() {
    if (!rowChars.length) return;
    let maxInkH = 0;
    for (const item of rowChars) {
      const inkH = item.bounds.bottom - item.bounds.top;
      if (inkH > maxInkH) maxInkH = inkH;
    }
    const rowCenterY = rowTopEdge + maxInkH / 2;
    for (const item of rowChars) {
      const inkCenterY = (item.bounds.top + item.bounds.bottom) / 2;
      item.pos.y = rowCenterY - inkCenterY + (item.pos._offY || 0);
    }
    rowTopEdge += maxInkH + rowInkGap;
    rowChars = [];
    cursorX = padding;
  }

  const spaceGap = Math.round(cellSize * 0.4);

  for (let i = 0; i < allChars.length; i++) {
    if (allChars[i] === "\n") {
      if (rowChars.length > 0) flushRow();
      rowTopEdge += paraGap;
      continue;
    }
    if (allChars[i] === "\r") {
      if (rowChars.length > 0) flushRow();
      continue;
    }
    if (allChars[i] === " ") {
      cursorX += spaceGap;
      continue;
    }

    const rendered = renderedChars[i];
    if (!rendered) continue;

    const ch = allChars[i];
    const bounds = rendered.bounds;
    const inkW = bounds.right - bounds.left;
    const t = getTuningByIdx(i);

    if (cursorX + inkW + t.spacing > flowW - padding && rowChars.length > 0) {
      flushRow();
    }

    const xOffset = cursorX - bounds.left + t.offsetX;
    const pos = { ch, x: xOffset, y: 0, _offY: t.offsetY, flatIdx: i };
    positions.push(pos);
    rowChars.push({ pos, bounds });
    cursorX += inkW + inkGap + t.spacing;
  }
  flushRow();

  for (const p of positions) delete p._offY;

  return { width: flowW, height: flowH, positions };
}

// --- DOM ---
const composeCanvas = document.getElementById("compose-canvas");
const composeCtx = composeCanvas.getContext("2d");
const statusEl = document.getElementById("status");
const sceneInfoEl = document.getElementById("scene-info");

function setStatus(msg) { statusEl.textContent = msg; }

// Sync slider <-> number inputs + auto-save state
document.querySelectorAll(".sidebar label").forEach(label => {
  const range = label.querySelector("input[type='range']");
  const num = label.querySelector(".num-input");
  if (!range || !num) return;
  num.value = range.value;
  num.step = range.step;
  range.addEventListener("input", () => { num.value = range.value; saveComposeState(); });
  num.addEventListener("change", () => {
    let v = Number(num.value);
    v = Math.max(Number(range.min), Math.min(Number(range.max), v));
    range.value = v;
    num.value = v;
    saveComposeState();
  });
});

// Save text on input
document.getElementById("poem-input").addEventListener("input", saveComposeState);
document.getElementById("clear-text-btn").addEventListener("click", () => {
  document.getElementById("poem-input").value = "";
  saveComposeState();
});

// Save paper inputs on change
document.getElementById("s-flowW").addEventListener("change", saveComposeState);
document.getElementById("s-flowH").addEventListener("change", saveComposeState);

// Save direction on change
document.querySelectorAll('input[name="dir"]').forEach(r => {
  r.addEventListener("change", saveComposeState);
});

// --- Save scene ---
document.getElementById("save-btn").addEventListener("click", async () => {
  // Read raw scene from localStorage (multi-set format, not merged)
  let rawScene = scene;
  try {
    const stored = JSON.parse(localStorage.getItem(SCENE_KEY));
    if (stored && stored.sets) rawScene = stored;
  } catch {}

  // Unified bundle: scene + compose state + tuning
  saveComposeState();
  const bundle = { scene: rawScene };
  try {
    const cs = JSON.parse(localStorage.getItem(COMPOSE_STATE_KEY));
    if (cs) bundle.composeState = cs;
  } catch {}
  if (Object.keys(charTuning).length) bundle.composeTuning = charTuning;

  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/json" });

  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "sinograph-lab.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("Saved");
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }

  const name = prompt("Save as:", "sinograph-lab.json");
  if (!name) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".json") ? name : name + ".json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Saved");
});

// --- Load scene ---
document.getElementById("load-btn").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);

      // Helper to merge multi-set scene into flat compose scene
      function mergeMultiSet(raw) {
        const merged = { chars: [], designs: {} };
        for (const s of raw.sets) {
          const designs = migrateDesigns(s.designs);
          for (const ch of (s.chars || [])) {
            if (!merged.chars.includes(ch)) merged.chars.push(ch);
            if (designs[ch]) merged.designs[ch] = designs[ch];
          }
        }
        return merged;
      }

      if (data.scene) {
        // Unified bundle format
        const raw = data.scene;
        if (raw.sets) {
          scene = mergeMultiSet(raw);
        } else if (raw.chars && raw.designs) {
          scene = raw;
          scene.designs = migrateDesigns(scene.designs);
        }
        // Also save the raw scene to localStorage for Design view
        localStorage.setItem(SCENE_KEY, JSON.stringify(data.scene));
        // Restore compose state
        if (data.composeState) {
          localStorage.setItem(COMPOSE_STATE_KEY, JSON.stringify(data.composeState));
          restoreComposeState();
        }
        // Restore tuning
        if (data.composeTuning) {
          charTuning = data.composeTuning;
          saveTuning();
        }
        updateSceneInfo();
        setStatus("Loaded: " + file.name);
      } else if (data.sets) {
        // Multi-set format (legacy non-bundled)
        scene = mergeMultiSet(data);
        updateSceneInfo();
        setStatus("Loaded: " + file.name);
      } else if (data.chars && data.designs) {
        scene = data;
        scene.designs = migrateDesigns(scene.designs);
        updateSceneInfo();
        setStatus("Loaded: " + file.name);
      }
    } catch (err) {
      setStatus("Failed to load: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

// --- Send to Design ---
document.getElementById("send-to-design").addEventListener("click", () => {
  const text = document.getElementById("poem-input").value.trim();
  if (!text) { setStatus("Enter text first"); return; }
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const matches = text.match(cjkRegex);
  if (!matches || !matches.length) { setStatus("No characters found"); return; }
  const unique = [...new Set(matches)];
  localStorage.setItem("composeToDesign", JSON.stringify(unique));
  window.location.href = "./index.html";
});

// --- Toggle flow settings visibility ---
function updateFlowSettingsVisibility() {
  const dir = document.querySelector('input[name="dir"]:checked').value;
  document.getElementById("smart-settings").classList.toggle("visible", dir === "smart" || dir === "smart-h");
}
document.querySelectorAll('input[name="dir"]').forEach(r => {
  r.addEventListener("change", updateFlowSettingsVisibility);
});

// --- Render ---
document.getElementById("render-btn").addEventListener("click", doRender);

async function doRender() {
  const text = document.getElementById("poem-input").value.trim();
  if (!text) { setStatus("Enter text first"); return; }

  const lines = parsePoem(text);
  if (!lines.length) { setStatus("No characters found in text"); return; }

  const settings = getSettings();
  // Flatten lines with break sentinels:
  //   "\r" = line break (new row/column, normal gap)
  //   "\n" = paragraph break (new row/column, larger gap)
  const allChars = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line === null) { allChars.push("\n"); continue; }
    // Insert line break between consecutive text lines
    if (allChars.length > 0 && allChars[allChars.length - 1] !== "\n" && allChars[allChars.length - 1] !== "\r") {
      allChars.push("\r");
    }
    for (const ch of line) allChars.push(ch);
  }

  // Reset variant counters for fresh round-robin
  variantCounters = {};

  // Prefetch all medians (CJK only)
  const uniqueChars = [...new Set(allChars)].filter(isCJK);
  setStatus(`Loading ${uniqueChars.length} characters...`);
  await Promise.all(uniqueChars.map(ch => fetchMedians(ch)));

  let layout;
  const isSmart = settings.direction === "smart" || settings.direction === "smart-h";
  if (isSmart) {
    setStatus("Measuring characters...");

    // Compute per-character sizes
    const charSizes = computeCharSizes(allChars, settings.cellSize, settings.sizeVar, settings.complexShrink);

    // Pre-render at each character's own size, measure ink bounds
    variantCounters = {};
    const renderedChars = allChars.map((ch, i) => {
      if (ch === "\n" || ch === "\r" || ch === " ") return null; // sentinel
      const sz = charSizes[i];
      const t = getTuningByIdx(i);
      let canvas;
      if (isCJK(ch)) {
        const medians = medianCache[ch];
        if (!medians) return null;
        const designData = getVariant(ch, t.variantIdx);
        const ss = settings.strokeScale * t.strokeScale;
        canvas = renderCharacter(medians, designData, sz, ss);
      } else {
        canvas = renderTextChar(ch, sz, settings.direction);
      }
      const bounds = measureInkBounds(canvas);
      return { canvas, bounds, size: sz };
    });

    variantCounters = {};
    layout = settings.direction === "smart-h"
      ? computeSmartHLayout(allChars, settings, renderedChars, charSizes)
      : computeSmartLayout(allChars, settings, renderedChars, charSizes);

    composeCanvas.width = layout.width;
    composeCanvas.height = layout.height;
    composeCtx.fillStyle = "#fffaf0";
    composeCtx.fillRect(0, 0, layout.width, layout.height);

    setStatus(`Rendering ${layout.positions.length} characters...`);
    let rendered = 0;
    for (let i = 0; i < layout.positions.length; i++) {
      const pos = layout.positions[i];
      const sz = charSizes[i];
      const t = getTuningByIdx(i);
      let charCanvas;
      if (isCJK(pos.ch)) {
        const medians = medianCache[pos.ch];
        if (!medians) continue;
        const designData = getVariant(pos.ch, t.variantIdx);
        const ss = settings.strokeScale * t.strokeScale;
        charCanvas = renderCharacter(medians, designData, sz, ss);
      } else {
        charCanvas = renderTextChar(pos.ch, sz, settings.direction);
      }
      composeCtx.drawImage(charCanvas, pos.x, pos.y);
      rendered++;
    }
    const missing = layout.positions.length - rendered;
    const missingMsg = missing > 0 ? `, ${missing} missing` : "";
    setStatus(`Done: ${rendered} characters rendered${missingMsg}`);
    cacheSmartRender(allChars, settings, renderedChars);
    buildTuningUI(allChars);
    return;
  }

  // Grid layouts (vertical / horizontal)
  {
    layout = computeLayout(lines, settings);
  }

  // Resize canvas
  composeCanvas.width = layout.width;
  composeCanvas.height = layout.height;
  composeCtx.fillStyle = "#fffaf0";
  composeCtx.fillRect(0, 0, layout.width, layout.height);

  setStatus(`Rendering ${layout.positions.length} characters...`);

  let rendered = 0;
  for (let pi = 0; pi < layout.positions.length; pi++) {
    const pos = layout.positions[pi];
    const tPi = getTuningByIdx(pi);
    let charCanvas;
    if (isCJK(pos.ch)) {
      const medians = medianCache[pos.ch];
      if (!medians) continue;
      const designData = getVariant(pos.ch, tPi.variantIdx);
      const ssChar = settings.strokeScale * tPi.strokeScale;
      charCanvas = renderCharacter(medians, designData, settings.cellSize, ssChar);
    } else {
      charCanvas = renderTextChar(pos.ch, settings.cellSize, settings.direction);
    }
    composeCtx.drawImage(charCanvas, pos.x, pos.y);
    rendered++;
  }

  const missing = layout.positions.length - rendered;
  const missingMsg = missing > 0 ? `, ${missing} missing` : "";
  setStatus(`Done: ${rendered} characters rendered${missingMsg}`);
  lastSmartCache = null;
  // Grid layouts: still show tuning UI
  buildTuningUI(allChars);
}

// --- Export PNG ---
document.getElementById("export-png-btn").addEventListener("click", async () => {
  if (composeCanvas.width <= 1) { setStatus("Render first"); return; }

  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "compose.png",
        types: [{ description: "PNG", accept: { "image/png": [".png"] } }],
      });
      const blob = await new Promise(r => composeCanvas.toBlob(r, "image/png"));
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("PNG saved");
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }

  const a = document.createElement("a");
  a.href = composeCanvas.toDataURL("image/png");
  a.download = "compose.png";
  a.click();
  setStatus("PNG downloaded");
});

// --- Export SVG ---
document.getElementById("export-svg-btn").addEventListener("click", async () => {
  const text = document.getElementById("poem-input").value.trim();
  if (!text) { setStatus("Render first"); return; }

  const lines = parsePoem(text);
  if (!lines.length) return;

  const settings = getSettings();
  const allChars = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line === null) { allChars.push("\n"); continue; }
    if (allChars.length > 0 && allChars[allChars.length - 1] !== "\n" && allChars[allChars.length - 1] !== "\r") {
      allChars.push("\r");
    }
    for (const ch of line) allChars.push(ch);
  }
  let layout;

  // For smart layout, need to do the full measure pass
  let charSizes = null;
  const isSmart = settings.direction === "smart" || settings.direction === "smart-h";
  if (isSmart) {
    charSizes = computeCharSizes(allChars, settings.cellSize, settings.sizeVar, settings.complexShrink);
    variantCounters = {};
    const renderedChars = allChars.map((ch, i) => {
      if (ch === "\n" || ch === "\r" || ch === " ") return null;
      const sz = charSizes[i];
      const t = getTuningByIdx(i);
      let canvas;
      if (isCJK(ch)) {
        const medians = medianCache[ch];
        if (!medians) return null;
        const designData = getVariant(ch, t.variantIdx);
        const ss = settings.strokeScale * t.strokeScale;
        canvas = renderCharacter(medians, designData, sz, ss);
      } else {
        canvas = renderTextChar(ch, sz, settings.direction);
      }
      const bounds = measureInkBounds(canvas);
      return { canvas, bounds, size: sz };
    });
    variantCounters = {};
    layout = settings.direction === "smart-h"
      ? computeSmartHLayout(allChars, settings, renderedChars, charSizes)
      : computeSmartLayout(allChars, settings, renderedChars, charSizes);
  } else {
    layout = computeLayout(lines, settings);
  }

  variantCounters = {};
  setStatus("Generating SVG...");

  let paths = "";
  let posIdx = 0;
  for (const pos of layout.positions) {
    // Non-CJK: render as SVG text element
    if (!isCJK(pos.ch)) {
      const cellSize = (charSizes && charSizes[posIdx]) ? charSizes[posIdx] : settings.cellSize;
      const fontSize = Math.round(cellSize * 0.65);
      const escaped = pos.ch.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      if (isPunctuation(pos.ch)) {
        const isVert = settings.direction === "smart" || settings.direction === "vertical";
        if (isVert) {
          paths += `<text x="${(pos.x + cellSize * 0.85).toFixed(1)}" y="${(pos.y + cellSize * 0.05).toFixed(1)}" font-size="${fontSize}" font-family="Iowan Old Style, Palatino Linotype, SimSun, Songti SC, serif" fill="rgba(28,23,19,0.85)" text-anchor="end" dominant-baseline="hanging">${escaped}</text>\n`;
        } else {
          paths += `<text x="${(pos.x + cellSize * 0.05).toFixed(1)}" y="${(pos.y + cellSize * 0.85).toFixed(1)}" font-size="${fontSize}" font-family="Iowan Old Style, Palatino Linotype, SimSun, Songti SC, serif" fill="rgba(28,23,19,0.85)" text-anchor="start" dominant-baseline="auto">${escaped}</text>\n`;
        }
      } else {
        paths += `<text x="${(pos.x + cellSize / 2).toFixed(1)}" y="${(pos.y + cellSize / 2).toFixed(1)}" font-size="${fontSize}" font-family="Iowan Old Style, Palatino Linotype, SimSun, Songti SC, serif" fill="rgba(28,23,19,0.85)" text-anchor="middle" dominant-baseline="central">${escaped}</text>\n`;
      }
      posIdx++;
      continue;
    }

    const medians = medianCache[pos.ch];
    if (!medians) { posIdx++; continue; }

    const tSvg = getTuningByIdx(posIdx);
    const designData = getVariant(pos.ch, tSvg.variantIdx);
    const cs = designData ? (designData.charScale || 1.0) : 1.0;
    const cellSize = (charSizes && charSizes[posIdx]) ? charSizes[posIdx] : settings.cellSize;
    posIdx++;
    const pad = cellSize * 0.06;
    const baseScale = (cellSize - pad * 2) / 1024;
    const scale = baseScale * cs;
    const ox = pos.x + pad + (1 - cs) * (cellSize - pad * 2) / 2;
    const oy = pos.y + pad + (1 - cs) * (cellSize - pad * 2) / 2;
    const dScale = densityScale(medians.length);
    const seed = designData ? (designData.seed || 1) : 1;
    const scaleRatio = cellSize / 640;
    const ss = (settings.strokeScale || 1) * getTuningByIdx(posIdx - 1).strokeScale;

    medians.forEach((median, si) => {
      const svgmod = designData ? resolveMedianMod(designData, si) : null;
      const params = designData ? resolveParams(designData, si) : { ...DEFAULT_PARAMS };
      const rawStroke = transformMedian(prepareMedian(median, svgmod, params), ox, oy, scale);
      const opts = paramsToOpts(params);
      opts.radius *= scaleRatio * ss;
      opts.jitter *= scaleRatio * ss;
      opts.normalBias *= scaleRatio * ss;
      const stroke = smoothMedian(rawStroke, params.smoothness);
      const trait = paramsToTrait(params, median);

      const rand = mulberry32(seed + si * 137);
      const envelope = createStrokeEnvelope(stroke, opts, rand, si, trait, dScale);

      if (envelope.length < 3) return;
      const alpha = 0.65 + trait.inkLevel * 0.3;
      let d = `M${envelope[0].x.toFixed(2)},${envelope[0].y.toFixed(2)}`;
      for (let j = 1; j < envelope.length; j++) {
        d += `L${envelope[j].x.toFixed(2)},${envelope[j].y.toFixed(2)}`;
      }
      d += "Z";
      paths += `  <path d="${d}" fill="rgba(28,23,19,${alpha.toFixed(3)})" />\n`;
    });
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <rect width="100%" height="100%" fill="#fffaf0" />
${paths}</svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml" });

  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "compose.svg",
        types: [{ description: "SVG", accept: { "image/svg+xml": [".svg"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("SVG saved");
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "compose.svg";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("SVG downloaded");
});

// --- Init ---
loadTuning();
loadSceneFromStorage();
restoreComposeState();
updateFlowSettingsVisibility();
doRender();
