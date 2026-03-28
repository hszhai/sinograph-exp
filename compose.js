// ---------------------------------------------------------------------------
// Sinograph Lab - Compose Tool
// Renders text using character designs from a scene file.
// ---------------------------------------------------------------------------
import {
  mulberry32, transformMedian, smoothMedian, densityScale,
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
    sceneInfoEl.textContent = "No scene loaded";
    return;
  }
  const charCount = scene.chars.length;
  const varCount = Object.values(scene.designs)
    .reduce((sum, vs) => sum + (Array.isArray(vs) ? vs.filter(v => v).length : 0), 0);
  sceneInfoEl.textContent = charCount > 0 ? `${charCount} chars, ${varCount} variants` : "No scene loaded";
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

function getVariant(ch) {
  if (!scene || !scene.designs[ch]) return null;
  const variants = scene.designs[ch].filter(v => v != null);
  if (!variants.length) return null;
  if (!variantCounters[ch]) variantCounters[ch] = 0;
  const idx = variantCounters[ch] % variants.length;
  variantCounters[ch]++;
  return variants[idx];
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

const TUNING_DEFAULTS = { size: 1, offsetX: 0, offsetY: 0, spacing: 0, strokeScale: 1 };

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
  const layout = computeSmartLayout(allChars, settings, renderedChars, charSizes);

  // Redraw snapshot
  const draw = () => {
    composeCtx.clearRect(0, 0, composeCanvas.width, composeCanvas.height);
    composeCtx.drawImage(snapshot, 0, 0);

    // Draw bounding boxes for all characters of the same type
    const selCh = highlightIdx >= 0 ? allChars[highlightIdx] : null;
    layout.positions.forEach((pos, i) => {
      const sz = charSizes[i] || settings.cellSize;
      const isSelected = (i === highlightIdx);
      const isSameChar = (pos.ch === selCh && i !== highlightIdx);

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
    const btn = document.createElement("button");
    btn.className = "tuning-char" + (charTuning[tuningKey(idx)] ? " has-tuning" : "");
    btn.textContent = ch;
    btn.dataset.idx = idx;
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

function deselectTuning() {
  tuningSelectedIdx = -1;
  document.querySelectorAll(".tuning-char").forEach(btn => btn.classList.remove("active"));
  document.getElementById("tuning-panel").innerHTML = "";
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
    window.location.href = "./index.html";
  };

  saveComposeState();
}

function updateTuningHighlights() {
  document.querySelectorAll(".tuning-char").forEach(btn => {
    const idx = Number(btn.dataset.idx);
    btn.classList.toggle("has-tuning", !!charTuning[tuningKey(idx)]);
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
  if (over) Object.keys(over).forEach(k => { base[k] = over[k]; });
  return base;
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
    const rawStroke = transformMedian(median, ox, oy, scale);
    const params = designData ? resolveParams(designData, si) : { ...DEFAULT_PARAMS };
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
  return { top, bottom, left, right };
}

// --- Layout ---
function parsePoem(text) {
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const rawLines = text.split(/\n/);
  const lines = [];
  for (const line of rawLines) {
    const chars = line.match(cjkRegex);
    if (chars && chars.length > 0) lines.push(chars);
  }
  return lines;
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

  if (direction === "vertical") {
    const maxCharsInLine = Math.max(...lines.map(l => l.length));
    const totalW = padding * 2 + lines.length * step - spacing + (lines.length - 1) * lineGap;
    const totalH = padding * 2 + maxCharsInLine * step - spacing;

    const positions = [];
    lines.forEach((line, li) => {
      const colX = totalW - padding - (li + 1) * step - li * lineGap + spacing;
      line.forEach((ch, ci) => {
        positions.push({ ch, x: colX, y: padding + ci * step });
      });
    });
    return { width: totalW, height: totalH, positions };
  } else {
    const maxCharsInLine = Math.max(...lines.map(l => l.length));
    const totalW = padding * 2 + maxCharsInLine * step - spacing;
    const totalH = padding * 2 + lines.length * step - spacing + (lines.length - 1) * lineGap;

    const positions = [];
    lines.forEach((line, li) => {
      const rowY = padding + li * (step + lineGap);
      line.forEach((ch, ci) => {
        positions.push({ ch, x: padding + ci * step, y: rowY });
      });
    });
    return { width: totalW, height: totalH, positions };
  }
}

function computeFlowLayout(allChars, settings) {
  const { cellSize, spacing, padding, flowW, flowH } = settings;
  const step = cellSize + spacing;

  const colCap = Math.max(1, Math.floor((flowH - padding * 2 + spacing) / step));
  const positions = [];
  let col = 0, row = 0;

  for (const ch of allChars) {
    const colX = flowW - padding - (col + 1) * step + spacing;
    if (colX < padding - spacing) break;
    positions.push({ ch, x: colX, y: padding + row * step });
    row++;
    if (row >= colCap) { row = 0; col++; }
  }

  return { width: flowW, height: flowH, positions };
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
    const pos = { ch, x: 0, y: yOffset, _offX: t.offsetX };
    positions.push(pos);
    colChars.push({ pos, bounds });
    cursorY += (bounds.bottom - bounds.top) + inkGap + t.spacing;
  }

  for (let i = 0; i < allChars.length; i++) {
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

// Save paper inputs on change
document.getElementById("s-flowW").addEventListener("change", saveComposeState);
document.getElementById("s-flowH").addEventListener("change", saveComposeState);

// Save direction on change
document.querySelectorAll('input[name="dir"]').forEach(r => {
  r.addEventListener("change", saveComposeState);
});

// --- Save scene ---
document.getElementById("save-btn").addEventListener("click", async () => {
  const json = JSON.stringify(scene, null, 2);
  const blob = new Blob([json], { type: "application/json" });

  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "scene.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("Scene saved");
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }

  const name = prompt("Save as:", "scene.json");
  if (!name) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".json") ? name : name + ".json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Scene downloaded");
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
      if (data.sets) {
        // Multi-set format
        const merged = { chars: [], designs: {} };
        for (const s of data.sets) {
          const designs = migrateDesigns(s.designs);
          for (const ch of (s.chars || [])) {
            if (!merged.chars.includes(ch)) merged.chars.push(ch);
            if (designs[ch]) merged.designs[ch] = designs[ch];
          }
        }
        scene = merged;
        updateSceneInfo();
        setStatus("Scene loaded: " + file.name);
      } else if (data.chars && data.designs) {
        scene = data;
        scene.designs = migrateDesigns(scene.designs);
        updateSceneInfo();
        setStatus("Scene loaded: " + file.name);
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
  document.getElementById("smart-settings").classList.toggle("visible", dir === "smart");
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
  const allChars = lines.flat();

  // Reset variant counters for fresh round-robin
  variantCounters = {};

  // Prefetch all medians
  const uniqueChars = [...new Set(allChars)];
  setStatus(`Loading ${uniqueChars.length} characters...`);
  await Promise.all(uniqueChars.map(ch => fetchMedians(ch)));

  let layout;
  if (settings.direction === "smart") {
    setStatus("Measuring characters...");

    // Compute per-character sizes
    const charSizes = computeCharSizes(allChars, settings.cellSize, settings.sizeVar, settings.complexShrink);

    // Pre-render at each character's own size, measure ink bounds
    variantCounters = {};
    const renderedChars = allChars.map((ch, i) => {
      const medians = medianCache[ch];
      if (!medians) return null;
      const designData = getVariant(ch);
      const sz = charSizes[i];
      const ss = settings.strokeScale * getTuningByIdx(i).strokeScale;
      const canvas = renderCharacter(medians, designData, sz, ss);
      const bounds = measureInkBounds(canvas);
      return { canvas, bounds, designData, size: sz };
    });

    variantCounters = {};
    layout = computeSmartLayout(allChars, settings, renderedChars, charSizes);

    composeCanvas.width = layout.width;
    composeCanvas.height = layout.height;
    composeCtx.fillStyle = "#fffaf0";
    composeCtx.fillRect(0, 0, layout.width, layout.height);

    setStatus(`Rendering ${layout.positions.length} characters...`);
    let rendered = 0;
    for (let i = 0; i < layout.positions.length; i++) {
      const pos = layout.positions[i];
      const medians = medianCache[pos.ch];
      if (!medians) continue;
      const designData = getVariant(pos.ch);
      const sz = charSizes[i];
      const ss = settings.strokeScale * getTuningByIdx(i).strokeScale;
      const charCanvas = renderCharacter(medians, designData, sz, ss);
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

  if (settings.direction === "flow") {
    layout = computeFlowLayout(allChars, settings);
  } else {
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
    const medians = medianCache[pos.ch];
    if (!medians) continue;
    const designData = getVariant(pos.ch);
    const ssChar = settings.strokeScale * getTuningByIdx(pi).strokeScale;
    const charCanvas = renderCharacter(medians, designData, settings.cellSize, ssChar);
    composeCtx.drawImage(charCanvas, pos.x, pos.y);
    rendered++;
  }

  const missing = layout.positions.length - rendered;
  const missingMsg = missing > 0 ? `, ${missing} missing` : "";
  setStatus(`Done: ${rendered} characters rendered${missingMsg}`);
  lastSmartCache = null;
  if (settings.direction === "flow" || settings.direction === "smart") {
    buildTuningUI(allChars);
  } else {
    document.getElementById("tuning-section").classList.add("tuning-hidden");
  }
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
  const allChars = lines.flat();
  let layout;

  // For smart layout, need to do the full measure pass
  let charSizes = null;
  if (settings.direction === "smart") {
    charSizes = computeCharSizes(allChars, settings.cellSize, settings.sizeVar, settings.complexShrink);
    variantCounters = {};
    const renderedChars = allChars.map((ch, i) => {
      const medians = medianCache[ch];
      if (!medians) return null;
      const designData = getVariant(ch);
      const sz = charSizes[i];
      const ss = settings.strokeScale * getTuningByIdx(i).strokeScale;
      const canvas = renderCharacter(medians, designData, sz, ss);
      const bounds = measureInkBounds(canvas);
      return { canvas, bounds, designData, size: sz };
    });
    variantCounters = {};
    layout = computeSmartLayout(allChars, settings, renderedChars, charSizes);
  } else if (settings.direction === "flow") {
    layout = computeFlowLayout(allChars, settings);
  } else {
    layout = computeLayout(lines, settings);
  }

  variantCounters = {};
  setStatus("Generating SVG...");

  let paths = "";
  let posIdx = 0;
  for (const pos of layout.positions) {
    const medians = medianCache[pos.ch];
    if (!medians) { posIdx++; continue; }

    const designData = getVariant(pos.ch);
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
      const rawStroke = transformMedian(median, ox, oy, scale);
      const params = designData ? resolveParams(designData, si) : { ...DEFAULT_PARAMS };
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
