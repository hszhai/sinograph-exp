// ---------------------------------------------------------------------------
// Sinograph Lab - Interactive per-stroke Chinese character design
// ---------------------------------------------------------------------------
import {
  mulberry32, transformMedian, smoothMedian, densityScale,
  classifyStroke, parseStrokeType, pressureCurve,
  createStrokeEnvelope, smoothClosedPath,
} from "./engine.js";

const CANVAS_SIZE = 640;
const PAD = 40;

// ---------------------------------------------------------------------------
// Dynamic character data loading from hanzi-writer-data CDN
// ---------------------------------------------------------------------------
const CDN_BASE = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1";
const medianCache = {}; // in-memory cache: character -> medians array
let loadingChar = null;

async function fetchMedians(ch) {
  if (medianCache[ch]) return medianCache[ch];

  const url = `${CDN_BASE}/${encodeURIComponent(ch)}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  if (data && data.medians) {
    medianCache[ch] = data.medians;
    return data.medians;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scene: character set + all designs
// ---------------------------------------------------------------------------
const SCENE_KEY = "charDesignScene";
const MAX_SET_SIZE = 50;
const MAX_VARIANTS = 10;
let visibleVariants = 5;

// Scene structure: { sets: [{ name, chars, designs }], currentSet: 0 }
let scene = loadScene();
let currentVariant = 0;

function emptySet(name) {
  return { name: name || "Set 1", chars: [], designs: {} };
}

function emptyScene() {
  return { sets: [emptySet()], currentSet: 0 };
}

function currentSetObj() {
  return scene.sets[scene.currentSet];
}

// Migrate: if a design value is a plain object (not array), wrap it
function migrateDesigns(designs) {
  if (!designs) return {};
  for (const ch of Object.keys(designs)) {
    if (designs[ch] && !Array.isArray(designs[ch])) {
      designs[ch] = [designs[ch]];
    }
  }
  return designs;
}

function loadScene() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCENE_KEY));
    if (raw) {
      // New multi-set format
      if (raw.sets) {
        raw.sets.forEach(s => { s.designs = migrateDesigns(s.designs); });
        if (raw.currentSet == null) raw.currentSet = 0;
        return raw;
      }
      // Migrate old single-set format
      if (raw.chars) {
        raw.designs = migrateDesigns(raw.designs);
        return { sets: [{ name: "Set 1", chars: raw.chars, designs: raw.designs }], currentSet: 0 };
      }
    }
  } catch {}
  // Migrate old library format if present
  try {
    const old = JSON.parse(localStorage.getItem("charDesignLibrary"));
    if (old && typeof old === "object") {
      const chars = Object.keys(old).slice(0, MAX_SET_SIZE);
      const designs = {};
      for (const ch of chars) designs[ch] = [old[ch]];
      return { sets: [{ name: "Set 1", chars, designs }], currentSet: 0 };
    }
  } catch {}
  return emptyScene();
}

function saveScene() {
  localStorage.setItem(SCENE_KEY, JSON.stringify(scene));
}

function saveCurrentDesign() {
  const data = getCleanDesignData();
  const ch = data.character;
  const set = currentSetObj();
  if (!set.designs[ch]) set.designs[ch] = [];
  set.designs[ch][currentVariant] = data;
  if (!set.chars.includes(ch)) {
    if (set.chars.length >= MAX_SET_SIZE) return;
    set.chars.push(ch);
  }
  saveScene();
  updateSetUI();
  buildVariantBar();
}

function getDesignForChar(ch, variantIdx) {
  const set = currentSetObj();
  const variants = set.designs[ch];
  if (!variants || !Array.isArray(variants)) return null;
  const idx = variantIdx !== undefined ? variantIdx : 0;
  return variants[idx] || null;
}

function getVariantCount(ch) {
  const set = currentSetObj();
  const variants = set.designs[ch];
  if (!variants || !Array.isArray(variants)) return 0;
  return variants.filter(v => v != null).length;
}

function addCharsToSet(chars) {
  const set = currentSetObj();
  let added = 0;
  for (const ch of chars) {
    if (set.chars.length >= MAX_SET_SIZE) break;
    if (!set.chars.includes(ch)) {
      set.chars.push(ch);
      added++;
    }
  }
  saveScene();
  updateSetUI();
  return added;
}

// --- Default params ---
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
  widthCurve: null, // null = use pressure curve from style. Array of {x,y} = custom
  offsetCurve: null, // null = no offset. Array of {x,y} = perpendicular displacement
};

const NUM_CURVE_POINTS = 8;

// Sample a style's built-in pressure curve into control points for the curve editor
function sampleStyleCurve(params, median) {
  const opts = paramsToOpts(params);
  const trait = paramsToTrait(params, median || [[0,0],[100,100]]);
  const points = [];
  for (let i = 0; i < NUM_CURVE_POINTS; i++) {
    const progress = i / (NUM_CURVE_POINTS - 1);
    const p = pressureCurve(progress, trait, opts);
    points.push({ x: progress, y: Math.min(1, p / 1.3) }); // normalize to 0-1 range
  }
  return points;
}

// --- State ---
let currentChar = "永";
let noiseSeed = 1;
let selectedStrokes = new Set(); // empty = global, otherwise set of stroke indices
let design = createDesign(currentChar);

function primaryStroke() {
  if (selectedStrokes.size === 0) return -1;
  return Math.min(...selectedStrokes);
}

function isSelected(i) {
  return selectedStrokes.has(i);
}

function isGlobal() {
  return selectedStrokes.size === 0;
}

function createDesign(ch) {
  return {
    character: ch,
    seed: noiseSeed,
    charScale: 1.0, // per-character scale (0.85 - 1.15)
    global: { ...DEFAULT_PARAMS },
    overrides: {},
  };
}

// --- DOM refs ---
const canvas = document.getElementById("main-canvas");
const ctx = canvas.getContext("2d");
const hitCanvas = document.createElement("canvas");
hitCanvas.width = CANVAS_SIZE;
hitCanvas.height = CANVAS_SIZE;
const hitCtx = hitCanvas.getContext("2d");

const charInput = document.getElementById("char-input");
const strokeBar = document.getElementById("stroke-bar");
const resetBtn = document.getElementById("reset-stroke-btn");
const scaleSlider = document.getElementById("char-scale");
const scaleNum = document.getElementById("char-scale-num");
let canvasHintText = "Click a stroke to edit individually";

// --- Character scale ---
function syncScaleSlider() {
  const v = design.charScale || 1.0;
  scaleSlider.value = v;
  scaleNum.value = v;
}

scaleSlider.addEventListener("input", () => {
  design.charScale = Number(scaleSlider.value);
  scaleNum.value = design.charScale;
  render();
});

scaleNum.addEventListener("change", () => {
  let v = Number(scaleNum.value);
  v = Math.max(0.85, Math.min(1.15, v));
  design.charScale = v;
  scaleSlider.value = v;
  scaleNum.value = v;
  render();
});

// Param controls
const SLIDER_IDS = [
  "radius", "taper",
  "brushAngle", "angleVar", "tremor", "jitter", "warp", "smoothness", "weightMul",
  "inkLevel", "asymmetry", "curvatureWeight", "sampleStep", "normalBias", "dryness"
];
const PARAM_IDS = ["style", ...SLIDER_IDS];

const paramEls = {};
const numEls = {};
SLIDER_IDS.forEach(id => {
  const el = document.getElementById("p-" + id);
  if (el) paramEls[id] = el;
  const num = document.querySelector(`.num-input[data-for="p-${id}"]`);
  if (num) {
    numEls[id] = num;
    num.step = el.step;
  }
});
// Style is a radio group, handle separately
const styleRadioContainer = document.getElementById("p-style");
const getStyleValue = () => {
  const checked = styleRadioContainer.querySelector("input:checked");
  return checked ? checked.value : "calligraphic";
};
const setStyleValue = (val) => {
  const radio = styleRadioContainer.querySelector(`input[value="${val}"]`);
  if (radio) radio.checked = true;
};

// --- Resolve params for a stroke ---
function resolveStrokeParams(strokeIndex) {
  const base = { ...design.global };
  const over = design.overrides[strokeIndex];
  if (over) {
    Object.keys(over).forEach(k => { base[k] = over[k]; });
  }
  return base;
}

// Build opts for the engine from per-stroke params
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
    strokeVariation: 0, // we control per-stroke directly
    inkDepletion: 0,
  };
}

// Build a trait from per-stroke params (deterministic, no random generation)
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

// --- Medians for current character ---
function getMedians() {
  return medianCache[currentChar] || [];
}

// --- Rendering ---
function renderMessage(msg) {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = "#f7efdf";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = "#999";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, CANVAS_SIZE / 2, CANVAS_SIZE / 2);
}

function render() {
  const medians = getMedians();
  if (!medians.length) {
    if (loadingChar === currentChar) {
      renderMessage("Loading " + currentChar + "...");
    } else {
      renderMessage("No data for this character");
    }
    return;
  }

  const cs = design.charScale || 1.0;
  const baseScale = (CANVAS_SIZE - PAD * 2) / 1024;
  const scale = baseScale * cs;
  const ox = PAD + (1 - cs) * (CANVAS_SIZE - PAD * 2) / 2; // center offset
  const oy = PAD + (1 - cs) * (CANVAS_SIZE - PAD * 2) / 2;
  const dScale = densityScale(medians.length);

  // Clear
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = "#f7efdf";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Hit-test canvas
  hitCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Offscreen for darken compositing
  const offscreen = document.createElement("canvas");
  offscreen.width = CANVAS_SIZE;
  offscreen.height = CANVAS_SIZE;
  const oCtx = offscreen.getContext("2d");

  // Render one stroke to offscreen and composite with darken
  function renderOneStroke(strokePoints, opts, trait, si) {
    const rand = mulberry32(noiseSeed + si * 137);
    const envelope = createStrokeEnvelope(strokePoints, opts, rand, si, trait, dScale);

    oCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    oCtx.beginPath();
    smoothClosedPath(oCtx, envelope);
    const alpha = 0.65 + trait.inkLevel * 0.3;
    oCtx.fillStyle = `rgba(28, 23, 19, ${alpha})`;
    oCtx.fill();

    ctx.globalCompositeOperation = "darken";
    ctx.drawImage(offscreen, 0, 0);

    return envelope;
  }

  medians.forEach((median, si) => {
    const rawStroke = transformMedian(median, ox, oy, scale);
    const params = resolveStrokeParams(si);
    const opts = paramsToOpts(params);
    const stroke = smoothMedian(rawStroke, params.smoothness);
    const trait = paramsToTrait(params, median);

    const envelope = renderOneStroke(stroke, opts, trait, si);

    // Hit-test
    hitCtx.beginPath();
    smoothClosedPath(hitCtx, envelope);
    hitCtx.fillStyle = `rgb(${si + 1}, 0, 0)`;
    hitCtx.fill();
  });

  ctx.globalCompositeOperation = "source-over";

  // Highlight selected strokes
  selectedStrokes.forEach(si => {
    if (si < 0 || si >= medians.length) return;
    const rawHighlight = transformMedian(medians[si], ox, oy, scale);
    const stroke = smoothMedian(rawHighlight, resolveStrokeParams(si).smoothness);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(196, 98, 26, 0.8)";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(196, 98, 26, 0.9)";
    ctx.beginPath();
    ctx.arc(stroke[0].x, stroke[0].y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(196, 98, 26, 0.5)";
    ctx.beginPath();
    ctx.arc(stroke[stroke.length - 1].x, stroke[stroke.length - 1].y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Draw hint text inside canvas, bottom-left
  if (canvasHintText) {
    ctx.save();
    ctx.font = '13px "Menlo", "SFMono-Regular", monospace';
    ctx.fillStyle = "rgba(95, 83, 72, 0.6)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(canvasHintText, 16, CANVAS_SIZE - 12);
    ctx.restore();
  }
}

// --- Stroke bar ---
function buildStrokeBar() {
  strokeBar.innerHTML = "";
  const medians = getMedians();

  // "All" button for global
  const allBtn = document.createElement("button");
  allBtn.className = "stroke-btn" + (isGlobal() ? " active" : "");
  allBtn.textContent = "All";
  allBtn.addEventListener("click", () => selectStroke(-1));
  strokeBar.appendChild(allBtn);

  medians.forEach((_, i) => {
    const btn = document.createElement("button");
    const hasOverride = design.overrides[i] && Object.keys(design.overrides[i]).length > 0;
    btn.className = "stroke-btn"
      + (isSelected(i) ? " active" : "")
      + (hasOverride ? " has-override" : "");
    btn.textContent = `${i + 1}`;
    btn.addEventListener("click", (e) => selectStroke(i, e.shiftKey));
    strokeBar.appendChild(btn);
  });
}

// --- Selection ---
function selectStroke(index, addToSelection) {
  if (index === -1) {
    selectedStrokes.clear();
  } else if (addToSelection) {
    if (selectedStrokes.has(index)) {
      selectedStrokes.delete(index);
    } else {
      selectedStrokes.add(index);
    }
  } else {
    selectedStrokes.clear();
    selectedStrokes.add(index);
  }
  updatePanel();
  buildStrokeBar();
  render();
}

// --- Panel sync ---
function syncSlidersFrom(params) {
  setStyleValue(params.style);
  SLIDER_IDS.forEach(id => {
    const el = paramEls[id];
    if (!el) return;
    el.value = params[id];
    if (numEls[id]) numEls[id].value = params[id];
  });
}

function updatePanel() {
  const ps = primaryStroke();
  if (ps === -1) {
    canvasHintText = "Click a stroke to edit individually";
    resetBtn.disabled = true;
    syncSlidersFrom(design.global);
    drawCurveEditor(design.global.widthCurve);
    drawOffsetCurveEditor(design.global.offsetCurve);
  } else {
    const anyOverride = [...selectedStrokes].some(si =>
      design.overrides[si] && Object.keys(design.overrides[si]).length > 0
    );
    if (selectedStrokes.size > 1) {
      canvasHintText = `${selectedStrokes.size} strokes selected`;
    } else {
      canvasHintText = anyOverride ? `Stroke ${ps + 1}: overridden` : `Stroke ${ps + 1}`;
    }
    resetBtn.disabled = !anyOverride;
    const params = resolveStrokeParams(ps);
    syncSlidersFrom(params);
    drawCurveEditor(params.widthCurve);
    drawOffsetCurveEditor(params.offsetCurve);
  }
}

// --- Param change handler ---
function onParamChange(id, fromNumInput) {
  let val;
  if (id === "style") {
    val = getStyleValue();
  } else {
    const el = paramEls[id];
    if (!el) return;
    if (fromNumInput && numEls[id]) {
      val = Number(numEls[id].value);
      el.value = val; // sync slider from number
    } else {
      val = Number(el.value);
      if (numEls[id]) numEls[id].value = val; // sync number from slider
    }
  }

  if (isGlobal()) {
    design.global[id] = val;
  } else {
    selectedStrokes.forEach(si => {
      if (!design.overrides[si]) design.overrides[si] = {};
      design.overrides[si][id] = val;
    });
    buildStrokeBar();
  }

  render();

  // Redraw curve preview when style or pressure-related params change
  if (id === "style" || id === "taper") {
    const ps = primaryStroke();
    const curveData = ps >= 0
      ? resolveStrokeParams(ps).widthCurve
      : design.global.widthCurve;
    drawCurveEditor(curveData);
  }
}

// Wire up param listeners
SLIDER_IDS.forEach(id => {
  const el = paramEls[id];
  if (el) el.addEventListener("input", () => onParamChange(id));
});

// Number inputs
SLIDER_IDS.forEach(id => {
  const num = numEls[id];
  if (num) num.addEventListener("input", () => onParamChange(id, true));
});

// Style radios
styleRadioContainer.querySelectorAll("input").forEach(radio => {
  radio.addEventListener("change", () => onParamChange("style"));
});

// --- Reset stroke to global ---
resetBtn.addEventListener("click", () => {
  if (!isGlobal()) {
    selectedStrokes.forEach(si => {
      delete design.overrides[si];
    });
    updatePanel();
    buildStrokeBar();
    render();
  }
});

// --- Reset all ---
document.getElementById("reset-all-btn").addEventListener("click", () => {
  design.global = { ...DEFAULT_PARAMS };
  design.overrides = {};
  selectedStrokes.clear();
  buildStrokeBar();
  updatePanel();
  render();
});

// --- Canvas click: stroke hit-testing ---
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_SIZE / rect.width;
  const scaleY = CANVAS_SIZE / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const pixel = hitCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  const strokeIndex = pixel[0] - 1; // stroke 0 is encoded as rgb(1,0,0)

  if (strokeIndex >= 0 && strokeIndex < getMedians().length) {
    selectStroke(strokeIndex, e.shiftKey);
  } else {
    selectStroke(-1);
  }
});

// --- Character switching (async) ---
async function switchToChar(ch, existingDesign) {
  currentChar = ch;
  charInput.value = ch;
  currentVariant = 0;

  // Check scene for saved design
  if (!existingDesign) {
    existingDesign = getDesignForChar(ch, 0);
  }

  if (existingDesign) {
    noiseSeed = existingDesign.seed || 1;
    design = {
      character: ch,
      seed: noiseSeed,
      charScale: existingDesign.charScale || 1.0,
      global: { ...DEFAULT_PARAMS, ...existingDesign.global },
      overrides: existingDesign.overrides || {},
    };
  } else {
    design = createDesign(ch);
  }

  selectedStrokes.clear();
  syncScaleSlider();

  // Load median data if not cached
  if (!medianCache[ch]) {
    loadingChar = ch;
    buildStrokeBar();
    updatePanel();
    render(); // shows "Loading..."

    const medians = await fetchMedians(ch);
    loadingChar = null;

    if (!medians) {
      render(); // shows "No data"
      return;
    }

    // Check we're still on the same character (user might have typed another)
    if (currentChar !== ch) return;
  }

  // Add to set if not already there
  const _set = currentSetObj();
  if (!_set.chars.includes(ch) && _set.chars.length < MAX_SET_SIZE) {
    _set.chars.push(ch);
    saveScene();
  }

  buildStrokeBar();
  buildVariantBar();
  updatePanel();
  updateSetUI();
  render();
}

function switchToVariant(idx) {
  // Save current variant first
  saveCurrentDesign();

  currentVariant = idx;
  const existing = getDesignForChar(currentChar, idx);
  if (existing) {
    noiseSeed = existing.seed || 1;
    design = {
      character: currentChar,
      seed: noiseSeed,
      charScale: existing.charScale || 1.0,
      global: { ...DEFAULT_PARAMS, ...existing.global },
      overrides: existing.overrides || {},
    };
  } else {
    // New variant: start fresh with a different seed
    noiseSeed = Math.floor(Math.random() * 10000) + 1;
    design = createDesign(currentChar);
    design.seed = noiseSeed;
  }

  selectedStrokes.clear();
  syncScaleSlider();
  buildStrokeBar();
  buildVariantBar();
  updatePanel();
  render();
}

let charInputTimer = null;
charInput.addEventListener("input", () => {
  clearTimeout(charInputTimer);
  const ch = charInput.value.trim();
  if (!ch) return;
  // Small debounce for typing
  charInputTimer = setTimeout(() => {
    if (ch.length === 1) switchToChar(ch);
  }, 150);
});

// --- Reroll ---
document.getElementById("reroll-btn").addEventListener("click", () => {
  noiseSeed++;
  design.seed = noiseSeed;
  render();
});

// --- Save ---
function getCleanDesignData() {
  const cleanOverrides = {};
  Object.entries(design.overrides).forEach(([k, v]) => {
    if (v && Object.keys(v).length > 0) cleanOverrides[k] = v;
  });
  return {
    character: design.character,
    seed: design.seed,
    charScale: design.charScale,
    global: design.global,
    overrides: cleanOverrides,
  };
}

document.getElementById("save-btn").addEventListener("click", async () => {
  // Save current character first
  saveCurrentDesign();

  const json = JSON.stringify(scene, null, 2);
  const blob = new Blob([json], { type: "application/json" });

  // Use File System Access API if available (lets user pick location/name)
  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: "scene.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === "AbortError") return; // user cancelled
    }
  }

  // Fallback: classic download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scene.json";
  a.click();
  URL.revokeObjectURL(url);
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
        // Multi-set scene file
        scene = data;
        scene.sets.forEach(s => { s.designs = migrateDesigns(s.designs); });
        if (scene.currentSet == null) scene.currentSet = 0;
        saveScene();
        updateSetUI();
        const set = currentSetObj();
        if (set.chars.length > 0) switchToChar(set.chars[0]);
      } else if (data.chars && data.designs) {
        // Legacy single-set scene file - import as new set
        const imported = { name: "Imported", chars: data.chars.slice(0, MAX_SET_SIZE), designs: migrateDesigns(data.designs) };
        scene.sets.push(imported);
        scene.currentSet = scene.sets.length - 1;
        saveScene();
        updateSetUI();
        if (imported.chars.length > 0) switchToChar(imported.chars[0]);
      } else if (data.character) {
        // Legacy single-character file
        switchToChar(data.character, data);
      }
    } catch (err) {
      console.error("Failed to load:", err);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

// --- Export PNG ---
document.getElementById("export-png-btn").addEventListener("click", () => {
  const prevSelected = new Set(selectedStrokes);
  selectedStrokes.clear();
  render();

  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${design.character}.png`;
  a.click();

  selectedStrokes = prevSelected;
  render();
});

// --- Export SVG ---
document.getElementById("export-svg-btn").addEventListener("click", () => {
  const medians = getMedians();
  if (!medians.length) return;

  const scale = (CANVAS_SIZE - PAD * 2) / 1024;
  const dScale = densityScale(medians.length);

  function envelopeToSvgPath(envelope, inkLevel) {
    if (envelope.length < 3) return "";
    const mids = envelope.map((p, i) => {
      const n = envelope[(i + 1) % envelope.length];
      return { x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 };
    });
    let d = `M ${mids[0].x.toFixed(2)} ${mids[0].y.toFixed(2)}`;
    for (let i = 0; i < envelope.length; i++) {
      const ctrl = envelope[(i + 1) % envelope.length];
      const mid = mids[(i + 1) % envelope.length];
      d += ` Q ${ctrl.x.toFixed(2)} ${ctrl.y.toFixed(2)} ${mid.x.toFixed(2)} ${mid.y.toFixed(2)}`;
    }
    d += " Z";
    const alpha = 0.65 + inkLevel * 0.3;
    return `  <path d="${d}" fill="rgba(28,23,19,${alpha.toFixed(2)})" />\n`;
  }

  let paths = "";
  medians.forEach((median, si) => {
    const rawStroke = transformMedian(median, PAD, PAD, scale);
    const params = resolveStrokeParams(si);
    const opts = paramsToOpts(params);
    const stroke = smoothMedian(rawStroke, params.smoothness);
    const trait = paramsToTrait(params, median);
    const rand = mulberry32(noiseSeed + si * 137);
    const envelope = createStrokeEnvelope(stroke, opts, rand, si, trait, dScale);
    paths += envelopeToSvgPath(envelope, trait.inkLevel);
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
  <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" fill="#f7efdf" />
${paths}</svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${design.character}.svg`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Width curve presets
// ---------------------------------------------------------------------------
const WIDTH_PRESETS = [
  { name: "U", gen: () => {
    // U shape: thin in middle, thick at ends
    const pts = [];
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const t = i / (NUM_CURVE_POINTS - 1);
      const y = 0.85 - 0.55 * Math.sin(t * Math.PI);
      pts.push({ x: t, y });
    }
    return pts;
  }},
  { name: "\u2229", gen: () => {
    // Inverse U: thick in middle, thin at ends
    const pts = [];
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const t = i / (NUM_CURVE_POINTS - 1);
      const y = 0.25 + 0.6 * Math.sin(t * Math.PI);
      pts.push({ x: t, y });
    }
    return pts;
  }},
  { name: "\u2572", gen: () => {
    // High then taper: starts thick, tapers off (pie stroke)
    const pts = [];
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const t = i / (NUM_CURVE_POINTS - 1);
      const y = 0.85 * Math.pow(1 - t, 0.7);
      pts.push({ x: t, y: Math.max(0.08, y) });
    }
    return pts;
  }},
  { name: "\u2571", gen: () => {
    // Rising then taper: starts small, rises, tapers at end
    const pts = [];
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const t = i / (NUM_CURVE_POINTS - 1);
      const rise = Math.pow(Math.sin(t * Math.PI * 0.65), 0.5);
      const taper = t > 0.7 ? 1 - ((t - 0.7) / 0.3) * 0.6 : 1;
      pts.push({ x: t, y: Math.max(0.08, rise * taper * 0.8) });
    }
    return pts;
  }},
];

function buildWidthPresets() {
  const container = document.getElementById("width-presets");
  container.innerHTML = "";

  WIDTH_PRESETS.forEach(preset => {
    const btn = document.createElement("button");
    btn.className = "curve-preset-btn";
    btn.title = preset.name;

    // Draw tiny preview
    const mini = document.createElement("canvas");
    mini.width = 60;
    mini.height = 30;
    const mc = mini.getContext("2d");
    const pts = preset.gen();
    // Fill area under curve
    mc.fillStyle = "rgba(159, 63, 23, 0.15)";
    mc.beginPath();
    mc.moveTo(4, 28);
    pts.forEach((p) => {
      mc.lineTo(4 + p.x * 52, 28 - p.y * 24);
    });
    mc.lineTo(56, 28);
    mc.closePath();
    mc.fill();
    // Stroke the curve
    mc.strokeStyle = "rgba(159, 63, 23, 0.8)";
    mc.lineWidth = 2;
    mc.beginPath();
    pts.forEach((p, i) => {
      const x = 4 + p.x * 52;
      const y = 28 - p.y * 24;
      if (i === 0) mc.moveTo(x, y); else mc.lineTo(x, y);
    });
    mc.stroke();

    btn.appendChild(mini);
    btn.addEventListener("click", () => {
      const newPts = preset.gen();
      setActiveCurve(newPts);
      drawCurveEditor(newPts);
      render();
    });
    container.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Width curve editor
// ---------------------------------------------------------------------------
const curveCanvas = document.getElementById("curve-canvas");
const curveCtx = curveCanvas.getContext("2d");
const CURVE_W = 260;
const CURVE_H = 120;
const CURVE_PAD = 16;
let draggingPoint = -1;

function getActiveCurve() {
  const ps = primaryStroke();
  if (ps >= 0) {
    return resolveStrokeParams(ps).widthCurve;
  }
  return design.global.widthCurve;
}

function setActiveCurve(points) {
  if (isGlobal()) {
    design.global.widthCurve = points;
  } else {
    selectedStrokes.forEach(si => {
      if (!design.overrides[si]) design.overrides[si] = {};
      design.overrides[si].widthCurve = points ? points.map(p => ({ ...p })) : null;
    });
    buildStrokeBar();
  }
}

function getPreviewCurve() {
  const ps = primaryStroke();
  const params = ps >= 0 ? resolveStrokeParams(ps) : design.global;
  const median = ps >= 0 ? getMedians()[ps] : null;
  return sampleStyleCurve(params, median);
}

function drawCurveEditor(curvePoints) {
  const cw = curveCanvas.width;
  const ch = curveCanvas.height;
  curveCtx.clearRect(0, 0, cw, ch);

  curveCtx.fillStyle = "#faf5eb";
  curveCtx.fillRect(0, 0, cw, ch);

  const plotL = CURVE_PAD;
  const plotR = cw - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = ch - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  // Grid
  curveCtx.strokeStyle = "rgba(78, 61, 46, 0.18)";
  curveCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = plotL + (plotW * i) / 4;
    curveCtx.beginPath(); curveCtx.moveTo(x, plotT); curveCtx.lineTo(x, plotB); curveCtx.stroke();
  }
  for (let i = 0; i <= 2; i++) {
    const y = plotT + (plotH * i) / 2;
    curveCtx.beginPath(); curveCtx.moveTo(plotL, y); curveCtx.lineTo(plotR, y); curveCtx.stroke();
  }

  // Labels
  curveCtx.fillStyle = "rgba(95, 83, 72, 0.5)";
  curveCtx.font = '9px "Menlo", monospace';
  curveCtx.textAlign = "center";
  curveCtx.fillText("entry", plotL, ch - 2);
  curveCtx.fillText("exit", plotR, ch - 2);
  curveCtx.textAlign = "left";
  curveCtx.fillText("wide", 1, plotT + 3);
  curveCtx.fillText("thin", 1, plotB);

  // Always draw the style's built-in curve as a ghost reference
  const stylePts = getPreviewCurve();
  curveCtx.strokeStyle = curvePoints ? "rgba(78, 61, 46, 0.22)" : "rgba(159, 63, 23, 0.5)";
  curveCtx.lineWidth = curvePoints ? 1.5 : 2;
  curveCtx.setLineDash(curvePoints ? [4, 3] : []);
  curveCtx.beginPath();
  stylePts.forEach((p, i) => {
    const sx = plotL + p.x * plotW;
    const sy = plotB - p.y * plotH;
    if (i === 0) curveCtx.moveTo(sx, sy); else curveCtx.lineTo(sx, sy);
  });
  curveCtx.stroke();
  curveCtx.setLineDash([]);

  if (curvePoints) {
    // Draw custom curve
    curveCtx.strokeStyle = "rgba(159, 63, 23, 0.7)";
    curveCtx.lineWidth = 2;
    curveCtx.beginPath();
    curvePoints.forEach((p, i) => {
      const sx = plotL + p.x * plotW;
      const sy = plotB - p.y * plotH;
      if (i === 0) curveCtx.moveTo(sx, sy); else curveCtx.lineTo(sx, sy);
    });
    curveCtx.stroke();

    // Draw draggable points
    curvePoints.forEach((p) => {
      const sx = plotL + p.x * plotW;
      const sy = plotB - p.y * plotH;
      curveCtx.fillStyle = "rgba(196, 98, 26, 0.9)";
      curveCtx.beginPath();
      curveCtx.arc(sx, sy, 5, 0, Math.PI * 2);
      curveCtx.fill();
    });
  } else {
    // Show style curve points as ghost dots
    stylePts.forEach((p) => {
      const sx = plotL + p.x * plotW;
      const sy = plotB - p.y * plotH;
      curveCtx.fillStyle = "rgba(95, 83, 72, 0.3)";
      curveCtx.beginPath();
      curveCtx.arc(sx, sy, 4, 0, Math.PI * 2);
      curveCtx.fill();
    });
    curveCtx.fillStyle = "rgba(95, 83, 72, 0.4)";
    curveCtx.font = '10px "Menlo", monospace';
    curveCtx.textAlign = "center";
    curveCtx.fillText("click to customize", cw / 2, ch / 2);
  }
}

function curveScreenToData(clientX, clientY) {
  const rect = curveCanvas.getBoundingClientRect();
  const scaleX = CURVE_W / rect.width;
  const scaleY = CURVE_H / rect.height;
  const sx = (clientX - rect.left) * scaleX;
  const sy = (clientY - rect.top) * scaleY;

  const plotL = CURVE_PAD;
  const plotR = CURVE_W - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = CURVE_H - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  const x = Math.max(0, Math.min(1, (sx - plotL) / plotW));
  const y = Math.max(0, Math.min(1, (plotB - sy) / plotH));
  return { x, y, sx, sy };
}

function findNearestPoint(sx, sy, pts) {
  const plotL = CURVE_PAD;
  const plotR = CURVE_W - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = CURVE_H - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  let best = -1;
  let bestDist = 20; // max pick distance in canvas pixels
  pts.forEach((p, i) => {
    const px = plotL + p.x * plotW;
    const py = plotB - p.y * plotH;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

curveCanvas.addEventListener("mousedown", (e) => {
  let pts = getActiveCurve();
  if (!pts) {
    // First click: activate curve seeded from current style's pressure curve
    pts = getPreviewCurve().map(p => ({ ...p }));
    setActiveCurve(pts);
    render();
  }

  const { sx, sy } = curveScreenToData(e.clientX, e.clientY);
  draggingPoint = findNearestPoint(sx, sy, pts);
});

curveCanvas.addEventListener("mousemove", (e) => {
  if (draggingPoint < 0) return;
  const pts = getActiveCurve();
  if (!pts) return;

  const { y } = curveScreenToData(e.clientX, e.clientY);
  // x position is fixed for the 5 control points
  pts[draggingPoint].y = y;
  setActiveCurve(pts);
  drawCurveEditor(pts);
  render();
});

curveCanvas.addEventListener("mouseup", () => { draggingPoint = -1; });
curveCanvas.addEventListener("mouseleave", () => { draggingPoint = -1; });

// Double-click to reset curve
curveCanvas.addEventListener("dblclick", () => {
  if (isGlobal()) {
    design.global.widthCurve = null;
  } else {
    selectedStrokes.forEach(si => {
      if (design.overrides[si]) {
        delete design.overrides[si].widthCurve;
        if (Object.keys(design.overrides[si]).length === 0) {
          delete design.overrides[si];
        }
      }
    });
    buildStrokeBar();
  }
  drawCurveEditor(null);
  render();
});

// ---------------------------------------------------------------------------
// Offset curve editor
// ---------------------------------------------------------------------------
const offsetCanvas = document.getElementById("offset-canvas");
const offsetCtx = offsetCanvas.getContext("2d");
const OFFSET_W = 260;
const OFFSET_H = 120;
let draggingOffsetPoint = -1;

function getActiveOffsetCurve() {
  const ps = primaryStroke();
  if (ps >= 0) {
    return resolveStrokeParams(ps).offsetCurve;
  }
  return design.global.offsetCurve;
}

function setActiveOffsetCurve(points) {
  if (isGlobal()) {
    design.global.offsetCurve = points;
  } else {
    selectedStrokes.forEach(si => {
      if (!design.overrides[si]) design.overrides[si] = {};
      design.overrides[si].offsetCurve = points ? points.map(p => ({ ...p })) : null;
    });
    buildStrokeBar();
  }
}

function drawOffsetCurveEditor(curvePoints) {
  const cw = offsetCanvas.width;
  const ch = offsetCanvas.height;
  offsetCtx.clearRect(0, 0, cw, ch);

  offsetCtx.fillStyle = "#faf5eb";
  offsetCtx.fillRect(0, 0, cw, ch);

  const plotL = CURVE_PAD;
  const plotR = cw - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = ch - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  // Grid
  offsetCtx.strokeStyle = "rgba(78, 61, 46, 0.18)";
  offsetCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = plotL + (plotW * i) / 4;
    offsetCtx.beginPath(); offsetCtx.moveTo(x, plotT); offsetCtx.lineTo(x, plotB); offsetCtx.stroke();
  }
  for (let i = 0; i <= 2; i++) {
    const y = plotT + (plotH * i) / 2;
    offsetCtx.beginPath(); offsetCtx.moveTo(plotL, y); offsetCtx.lineTo(plotR, y); offsetCtx.stroke();
  }

  // Zero line (center) - more prominent
  const zeroY = plotT + plotH / 2;
  offsetCtx.strokeStyle = "rgba(78, 61, 46, 0.3)";
  offsetCtx.lineWidth = 1;
  offsetCtx.setLineDash([4, 3]);
  offsetCtx.beginPath(); offsetCtx.moveTo(plotL, zeroY); offsetCtx.lineTo(plotR, zeroY); offsetCtx.stroke();
  offsetCtx.setLineDash([]);

  // Labels
  offsetCtx.fillStyle = "rgba(95, 83, 72, 0.5)";
  offsetCtx.font = '9px "Menlo", monospace';
  offsetCtx.textAlign = "center";
  offsetCtx.fillText("entry", plotL, ch - 2);
  offsetCtx.fillText("exit", plotR, ch - 2);
  offsetCtx.textAlign = "left";
  offsetCtx.fillText("+", 4, plotT + 3);
  offsetCtx.fillText("0", 4, zeroY + 3);
  offsetCtx.fillText("\u2013", 4, plotB);

  if (curvePoints) {
    // Draw custom offset curve
    offsetCtx.strokeStyle = "rgba(23, 100, 159, 0.7)";
    offsetCtx.lineWidth = 2;
    offsetCtx.beginPath();
    curvePoints.forEach((p, i) => {
      const sx = plotL + p.x * plotW;
      // y: -1 to +1, map so +1 is at top, -1 at bottom
      const sy = plotT + (1 - (p.y + 1) / 2) * plotH;
      if (i === 0) offsetCtx.moveTo(sx, sy); else offsetCtx.lineTo(sx, sy);
    });
    offsetCtx.stroke();

    // Draw draggable points
    curvePoints.forEach((p) => {
      const sx = plotL + p.x * plotW;
      const sy = plotT + (1 - (p.y + 1) / 2) * plotH;
      offsetCtx.fillStyle = "rgba(23, 100, 159, 0.9)";
      offsetCtx.beginPath();
      offsetCtx.arc(sx, sy, 5, 0, Math.PI * 2);
      offsetCtx.fill();
    });
  } else {
    // Flat line at zero (no offset)
    offsetCtx.strokeStyle = "rgba(95, 83, 72, 0.3)";
    offsetCtx.lineWidth = 1.5;
    offsetCtx.beginPath();
    offsetCtx.moveTo(plotL, zeroY);
    offsetCtx.lineTo(plotR, zeroY);
    offsetCtx.stroke();

    // Ghost dots at zero
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const px = i / (NUM_CURVE_POINTS - 1);
      const sx = plotL + px * plotW;
      offsetCtx.fillStyle = "rgba(95, 83, 72, 0.3)";
      offsetCtx.beginPath();
      offsetCtx.arc(sx, zeroY, 4, 0, Math.PI * 2);
      offsetCtx.fill();
    }

    offsetCtx.fillStyle = "rgba(95, 83, 72, 0.4)";
    offsetCtx.font = '10px "Menlo", monospace';
    offsetCtx.textAlign = "center";
    offsetCtx.fillText("click to add offset", cw / 2, ch / 2 + 16);
  }
}

function offsetScreenToData(clientX, clientY) {
  const rect = offsetCanvas.getBoundingClientRect();
  const scaleX = OFFSET_W / rect.width;
  const scaleY = OFFSET_H / rect.height;
  const sx = (clientX - rect.left) * scaleX;
  const sy = (clientY - rect.top) * scaleY;

  const plotL = CURVE_PAD;
  const plotR = OFFSET_W - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = OFFSET_H - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  const x = Math.max(0, Math.min(1, (sx - plotL) / plotW));
  // Map screen to -1..+1 range (top = +1, bottom = -1)
  const y = Math.max(-1, Math.min(1, ((plotB - sy) / plotH) * 2 - 1));
  return { x, y, sx, sy };
}

function findNearestOffsetPoint(sx, sy, pts) {
  const plotL = CURVE_PAD;
  const plotR = OFFSET_W - CURVE_PAD;
  const plotT = CURVE_PAD;
  const plotB = OFFSET_H - CURVE_PAD;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  let best = -1;
  let bestDist = 20;
  pts.forEach((p, i) => {
    const px = plotL + p.x * plotW;
    const py = plotT + (1 - (p.y + 1) / 2) * plotH;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

offsetCanvas.addEventListener("mousedown", (e) => {
  let pts = getActiveOffsetCurve();
  if (!pts) {
    // First click: create flat offset curve (all zeros)
    pts = [];
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      pts.push({ x: i / (NUM_CURVE_POINTS - 1), y: 0 });
    }
    setActiveOffsetCurve(pts);
    render();
  }

  const { sx, sy } = offsetScreenToData(e.clientX, e.clientY);
  draggingOffsetPoint = findNearestOffsetPoint(sx, sy, pts);
});

offsetCanvas.addEventListener("mousemove", (e) => {
  if (draggingOffsetPoint < 0) return;
  const pts = getActiveOffsetCurve();
  if (!pts) return;

  const { y } = offsetScreenToData(e.clientX, e.clientY);
  pts[draggingOffsetPoint].y = y;
  setActiveOffsetCurve(pts);
  drawOffsetCurveEditor(pts);
  render();
});

offsetCanvas.addEventListener("mouseup", () => { draggingOffsetPoint = -1; });
offsetCanvas.addEventListener("mouseleave", () => { draggingOffsetPoint = -1; });

// Double-click to reset offset curve
offsetCanvas.addEventListener("dblclick", () => {
  if (isGlobal()) {
    design.global.offsetCurve = null;
  } else {
    selectedStrokes.forEach(si => {
      if (design.overrides[si]) {
        delete design.overrides[si].offsetCurve;
        if (Object.keys(design.overrides[si]).length === 0) {
          delete design.overrides[si];
        }
      }
    });
    buildStrokeBar();
  }
  drawOffsetCurveEditor(null);
  render();
});

// ---------------------------------------------------------------------------
// Smooth tool: average each interior point with its neighbors
// ---------------------------------------------------------------------------
function smoothCurvePoints(pts) {
  if (!pts || pts.length < 3) return pts;
  const smoothed = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p }; // keep endpoints
    const prev = pts[i - 1];
    const next = pts[i + 1];
    return { x: p.x, y: prev.y * 0.25 + p.y * 0.5 + next.y * 0.25 };
  });
  return smoothed;
}

document.getElementById("smooth-width-btn").addEventListener("click", () => {
  let pts = getActiveCurve();
  if (!pts) return;
  pts = smoothCurvePoints(pts);
  setActiveCurve(pts);
  drawCurveEditor(pts);
  render();
});

document.getElementById("smooth-offset-btn").addEventListener("click", () => {
  let pts = getActiveOffsetCurve();
  if (!pts) return;
  pts = smoothCurvePoints(pts);
  setActiveOffsetCurve(pts);
  drawOffsetCurveEditor(pts);
  render();
});

// ---------------------------------------------------------------------------
// Variant bar UI
// ---------------------------------------------------------------------------
const THUMB_SIZE = 200; // internal resolution (CSS scales down to 100px)
const THUMB_PAD = 16;

function drawMizige(tCtx, size) {
  const c = size / 2;
  const m = 6; // margin inset
  tCtx.save();
  tCtx.strokeStyle = "rgba(78, 61, 46, 0.25)";
  tCtx.lineWidth = 1.5;
  // Outer border
  tCtx.strokeRect(m, m, size - m * 2, size - m * 2);
  // Dashed cross and diagonals
  tCtx.strokeStyle = "rgba(78, 61, 46, 0.16)";
  tCtx.setLineDash([6, 5]);
  tCtx.beginPath();
  // Horizontal center
  tCtx.moveTo(m, c); tCtx.lineTo(size - m, c);
  // Vertical center
  tCtx.moveTo(c, m); tCtx.lineTo(c, size - m);
  // Diagonals
  tCtx.moveTo(m, m); tCtx.lineTo(size - m, size - m);
  tCtx.moveTo(size - m, m); tCtx.lineTo(m, size - m);
  tCtx.stroke();
  tCtx.setLineDash([]);
  tCtx.restore();
}

function renderThumbnail(tCanvas, designData, medians, seed) {
  const tCtx = tCanvas.getContext("2d");
  const size = tCanvas.width;
  tCtx.clearRect(0, 0, size, size);

  // Background
  tCtx.fillStyle = "#fffaf0";
  tCtx.fillRect(0, 0, size, size);

  if (!medians || !medians.length) {
    drawMizige(tCtx, size);
    return;
  }

  const thumbScale = size / CANVAS_SIZE; // ratio to scale radius
  const cs = designData.charScale || 1.0;
  const baseScale = (size - THUMB_PAD * 2) / 1024;
  const scale = baseScale * cs;
  const tox = THUMB_PAD + (1 - cs) * (size - THUMB_PAD * 2) / 2;
  const toy = THUMB_PAD + (1 - cs) * (size - THUMB_PAD * 2) / 2;
  const dScale = densityScale(medians.length);

  // Offscreen for darken compositing
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const oCtx = off.getContext("2d");

  medians.forEach((median, si) => {
    const rawStroke = transformMedian(median, tox, toy, scale);
    const base = { ...DEFAULT_PARAMS, ...(designData.global || {}) };
    const over = (designData.overrides || {})[si];
    const params = over ? { ...base, ...over } : base;
    const opts = paramsToOpts(params);
    opts.radius *= thumbScale; // scale radius to thumbnail size
    opts.jitter *= thumbScale;
    opts.normalBias *= thumbScale;
    const stroke = smoothMedian(rawStroke, params.smoothness);
    const trait = paramsToTrait(params, median);

    const rand = mulberry32((seed || 1) + si * 137);
    const envelope = createStrokeEnvelope(stroke, opts, rand, si, trait, dScale);

    oCtx.clearRect(0, 0, size, size);
    oCtx.beginPath();
    smoothClosedPath(oCtx, envelope);
    const alpha = 0.65 + trait.inkLevel * 0.3;
    oCtx.fillStyle = `rgba(28, 23, 19, ${alpha})`;
    oCtx.fill();

    tCtx.globalCompositeOperation = "darken";
    tCtx.drawImage(off, 0, 0);
  });

  tCtx.globalCompositeOperation = "source-over";

  // Draw mi-zi-ge grid on top (after strokes, so it's visible)
  drawMizige(tCtx, size);
}

function buildVariantBar() {
  const bar = document.getElementById("variant-bar");
  if (!bar) return;
  bar.innerHTML = "";

  const variants = currentSetObj().designs[currentChar];
  const medians = getMedians();

  // Auto-expand if variants exist beyond visible count
  const variants_ = currentSetObj().designs[currentChar];
  if (variants_ && variants_.length > visibleVariants) {
    visibleVariants = Math.min(MAX_VARIANTS, Math.ceil(variants_.length / 5) * 5);
  }

  for (let i = 0; i < visibleVariants; i++) {
    const slot = document.createElement("div");
    const hasData = variants && variants[i] != null;
    slot.className = "variant-slot"
      + (i === currentVariant ? " active" : "")
      + (hasData ? " occupied" : " empty-hint");

    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = THUMB_SIZE;
    thumbCanvas.height = THUMB_SIZE;
    if (hasData) {
      renderThumbnail(thumbCanvas, variants[i], medians, variants[i].seed || 1);
    } else {
      // Empty slot: just draw mi-zi-ge with a "+" hint
      const tCtx = thumbCanvas.getContext("2d");
      tCtx.fillStyle = "#fffaf0";
      tCtx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
      drawMizige(tCtx, THUMB_SIZE);
      tCtx.fillStyle = "rgba(78, 61, 46, 0.22)";
      tCtx.font = "bold 40px sans-serif";
      tCtx.textAlign = "center";
      tCtx.textBaseline = "middle";
      tCtx.fillText("+", THUMB_SIZE / 2, THUMB_SIZE / 2);
    }
    slot.appendChild(thumbCanvas);

    slot.title = hasData ? `Variant ${i + 1}` : `New variant`;
    slot.addEventListener("click", (e) => {
      if (e.target.classList.contains("variant-delete")) return;
      switchToVariant(i);
    });

    // Drag-to-reorder for occupied slots
    if (hasData) {
      slot.draggable = true;
      slot.dataset.varIdx = i;
      slot.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        slot.style.opacity = "0.5";
      });
      slot.addEventListener("dragend", () => { slot.style.opacity = ""; });
    }
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("drag-over"); });
    slot.addEventListener("dragleave", () => { slot.classList.remove("drag-over"); });
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      slot.classList.remove("drag-over");
      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
      const toIdx = i;
      if (fromIdx === toIdx || isNaN(fromIdx)) return;
      if (!variants) return;
      // Swap the two slots
      const tmp = variants[fromIdx];
      variants[fromIdx] = variants[toIdx];
      variants[toIdx] = tmp;
      // Update currentVariant if it was involved in the swap
      if (currentVariant === fromIdx) currentVariant = toIdx;
      else if (currentVariant === toIdx) currentVariant = fromIdx;
      saveScene();
      buildVariantBar();
    });

    // Delete button for occupied non-active variants
    if (hasData && i !== currentVariant) {
      const del = document.createElement("button");
      del.className = "variant-delete";
      del.textContent = "\u00d7";
      del.title = "Delete variant";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (variants) {
          variants[i] = null;
          while (variants.length > 0 && variants[variants.length - 1] == null) {
            variants.pop();
          }
          saveScene();
          buildVariantBar();
        }
      });
      slot.appendChild(del);
    }

    bar.appendChild(slot);
  }

  // "+5" button if room for more
  if (visibleVariants < MAX_VARIANTS) {
    const addBtn = document.createElement("div");
    addBtn.className = "variant-slot empty-hint";
    addBtn.title = "Show 5 more slots";
    addBtn.style.cursor = "pointer";
    const label = document.createElement("span");
    label.textContent = "+5";
    label.style.cssText = "font-size:13px; color:rgba(78,61,46,0.4); font-family:Menlo,monospace;";
    addBtn.appendChild(label);
    addBtn.addEventListener("click", () => {
      visibleVariants = Math.min(MAX_VARIANTS, visibleVariants + 5);
      buildVariantBar();
    });
    bar.appendChild(addBtn);
  }
}

// ---------------------------------------------------------------------------
// Set tabs UI
// ---------------------------------------------------------------------------
function buildSetTabs() {
  let tabBar = document.getElementById("set-tabs");
  if (!tabBar) {
    tabBar = document.createElement("div");
    tabBar.id = "set-tabs";
    tabBar.style.cssText = "display:flex; gap:4px; margin-bottom:6px; flex-wrap:wrap; align-items:center;";
    const section = document.querySelector(".set-section .set-header");
    section.parentNode.insertBefore(tabBar, section.nextSibling);
  }
  tabBar.innerHTML = "";

  scene.sets.forEach((s, i) => {
    const tab = document.createElement("button");
    tab.textContent = s.name;
    tab.className = "set-tool-btn" + (i === scene.currentSet ? " set-tab-active" : "");
    tab.style.cssText = i === scene.currentSet
      ? "border-color:var(--accent); color:var(--accent); background:rgba(159,63,23,0.08);"
      : "";
    tab.addEventListener("click", () => switchSet(i));

    // Delete set on right-click (context menu) if more than one set
    if (scene.sets.length > 1) {
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (confirm(`Delete set "${s.name}"?`)) {
          deleteSet(i);
        }
      });
      tab.title = `${s.name} (right-click to delete)`;
    }
    tabBar.appendChild(tab);
  });

  // "+ New" button
  const addBtn = document.createElement("button");
  addBtn.textContent = "+";
  addBtn.className = "set-tool-btn";
  addBtn.title = "New set";
  addBtn.addEventListener("click", () => {
    const name = prompt("Set name:", `Set ${scene.sets.length + 1}`);
    if (!name) return;
    scene.sets.push(emptySet(name));
    scene.currentSet = scene.sets.length - 1;
    saveScene();
    updateSetUI();
  });
  tabBar.appendChild(addBtn);
}

function switchSet(idx) {
  if (idx === scene.currentSet) return;
  saveCurrentDesign();
  scene.currentSet = idx;
  saveScene();
  const set = currentSetObj();
  updateSetUI();
  if (set.chars.length > 0) {
    switchToChar(set.chars[0]);
  }
}

function deleteSet(idx) {
  if (scene.sets.length <= 1) return;
  scene.sets.splice(idx, 1);
  if (scene.currentSet >= scene.sets.length) scene.currentSet = scene.sets.length - 1;
  if (scene.currentSet < 0) scene.currentSet = 0;
  saveScene();
  const set = currentSetObj();
  updateSetUI();
  if (set.chars.length > 0) {
    switchToChar(set.chars[0]);
  }
}

// ---------------------------------------------------------------------------
// Character set UI
// ---------------------------------------------------------------------------
function updateSetUI() {
  const container = document.getElementById("char-set");
  if (!container) return;

  const set = currentSetObj();
  buildSetTabs();
  if (!set.chars.length) {
    container.innerHTML = '<span class="set-empty">Type a character or import a text file</span>';
    return;
  }

  container.innerHTML = "";
  set.chars.forEach(ch => {
    const btn = document.createElement("button");
    const variants = set.designs[ch];
    const hasDesign = variants && Array.isArray(variants) && variants.some(v => {
      if (!v) return false;
      return Object.keys(v.overrides || {}).length > 0 ||
        JSON.stringify(v.global) !== JSON.stringify(DEFAULT_PARAMS);
    });
    btn.className = "set-char"
      + (ch === currentChar ? " active" : "")
      + (hasDesign ? " has-design" : "");
    btn.textContent = ch;
    btn.title = ch;
    btn.addEventListener("click", () => switchToChar(ch));
    container.appendChild(btn);
  });
}

// --- Import txt ---
document.getElementById("import-txt-btn").addEventListener("click", () => {
  document.getElementById("txt-file-input").click();
});

document.getElementById("clear-set-btn").addEventListener("click", () => {
  scene.sets[scene.currentSet] = emptySet(currentSetObj().name);
  saveScene();
  updateSetUI();
});

document.getElementById("txt-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    // Extract unique CJK characters
    const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
    const matches = text.match(cjkRegex);
    if (!matches) return;
    const unique = [...new Set(matches)];
    const added = addCharsToSet(unique);
    if (added > 0 && !currentSetObj().chars.includes(currentChar)) {
      switchToChar(currentSetObj().chars[0]);
    }
    updateSetUI();
  };
  reader.readAsText(file);
  e.target.value = "";
});

// ---------------------------------------------------------------------------
// Auto-save on changes (debounced)
// ---------------------------------------------------------------------------
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    const data = getCleanDesignData();
    const hasChanges = Object.keys(data.overrides).length > 0 ||
      JSON.stringify(data.global) !== JSON.stringify(DEFAULT_PARAMS) ||
      (data.charScale && data.charScale !== 1.0);
    if (hasChanges) {
      saveCurrentDesign();
    }
  }, 2000);
}

// Patch render to trigger auto-save
const _originalRender = render;
render = function() {
  _originalRender();
  scheduleAutoSave();
};

// --- Import from Compose tool ---
function importFromCompose() {
  try {
    const raw = localStorage.getItem("composeToDesign");
    if (raw) {
      const chars = JSON.parse(raw);
      if (Array.isArray(chars) && chars.length > 0) {
        // Create a new set for the imported characters
        const newSet = emptySet("From Compose");
        chars.forEach(ch => { if (newSet.chars.length < MAX_SET_SIZE) newSet.chars.push(ch); });
        scene.sets.push(newSet);
        scene.currentSet = scene.sets.length - 1;
        saveScene();
      }
      localStorage.removeItem("composeToDesign");
    }
  } catch {}
}

function getComposeDesignChar() {
  const ch = localStorage.getItem("composeToDesignChar");
  if (ch) {
    localStorage.removeItem("composeToDesignChar");
    // Ensure the character is in the set
    if (!currentSetObj().chars.includes(ch)) {
      addCharsToSet([ch]);
    }
    return ch;
  }
  return null;
}

// --- Init ---
async function init() {
  importFromCompose();
  buildWidthPresets();
  updateSetUI();
  buildVariantBar();
  // Check if compose sent us a specific character to design
  const composeChar = getComposeDesignChar();
  const startChar = composeChar || (currentSetObj().chars.length > 0 ? currentSetObj().chars[0] : currentChar);
  await switchToChar(startChar);
  // Flash the character in the set to draw attention
  if (composeChar) {
    const setBtn = document.querySelector(`.set-char.active`);
    if (setBtn) {
      setBtn.style.transition = "box-shadow 0.3s";
      setBtn.style.boxShadow = "0 0 0 3px rgba(159, 63, 23, 0.5)";
      setTimeout(() => { setBtn.style.boxShadow = ""; }, 1500);
    }
  }
}
init();
