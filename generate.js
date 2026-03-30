// ---------------------------------------------------------------------------
// Sinograph Lab - Auto-generation & Evolution
// Stroke-aware generation: starts from a base style, then evolves per-stroke
// overrides where they matter most.
// ---------------------------------------------------------------------------
import { classifyStroke, parseStrokeType } from "./engine.js";

// Seeded random (same as engine.js mulberry32)
function rng(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Gaussian random using Box-Muller
function gaussian(rand) {
  const u1 = Math.max(1e-10, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// MedianMod ranges per stroke type.
// These define the natural skeletal variation range for each stroke class.
// bow is fraction of stroke length; bends are degrees.
// ---------------------------------------------------------------------------
const MEDIAN_MOD_RANGES = {
  normal: { bow: [-0.12, 0.12], entryBend: [-15, 15], exitBend: [-15, 15] },
  pie:    { bow: [-0.08, 0.08], entryBend: [-20, 10], exitBend: [-25, 5]  },
  ti:     { bow: [-0.06, 0.06], entryBend: [-10, 20], exitBend: [-5, 10]  },
  zhe:    { bow: [-0.1,  0.1 ], entryBend: [-15, 15], exitBend: [-20, 10] },
  short:  { bow: [-0.15, 0.15], entryBend: [-20, 20], exitBend: [-20, 20] },
  "short-desc": { bow: [-0.1, 0.1], entryBend: [-15, 10], exitBend: [-20, 5] },
  "short-asc":  { bow: [-0.1, 0.1], entryBend: [-10, 20], exitBend: [-5, 15] },
};

// Rendering params: only very conservative variation around the calligraphic preset
const STROKE_SENSITIVITY = {
  normal: { taper: 0.15, brushAngle: 0.2, weightMul: 0.1 },
  pie:    { taper: 0.2, brushAngle: 0.25, asymmetry: 0.15 },
  ti:     { taper: 0.15, brushAngle: 0.15 },
  zhe:    { curvatureWeight: 0.2, taper: 0.1 },
  short:  { radius: 0.2, taper: 0.15, weightMul: 0.15 },
  "short-desc": { taper: 0.2, brushAngle: 0.15 },
  "short-asc":  { taper: 0.15, brushAngle: 0.15 },
};

// Full parameter ranges (for clamping)
const PARAM_RANGES = {
  radius:          [8, 60],
  taper:           [0.1, 2.0],
  brushAngle:      [-90, 30],
  angleVar:        [0, 60],
  tremor:          [0, 12],
  jitter:          [1, 20],
  weightMul:       [0.5, 1.8],
  inkLevel:        [0.5, 1.0],
  asymmetry:       [-0.5, 0.5],
  curvatureWeight: [0, 2.5],
  sampleStep:      [2, 15],
  normalBias:      [-15, 15],
  dryness:         [0, 0.5],
  warp:            [0, 1.5],
  smoothness:      [0.1, 0.8],
};

const STYLES = ["calligraphic", "expressive", "brush", "even"];

// ---------------------------------------------------------------------------
// Base style presets (starting points for global params)
// ---------------------------------------------------------------------------
const PRESETS = {
  classic: {
    style: "calligraphic", radius: 30, taper: 0.55, brushAngle: -30,
    angleVar: 0, tremor: 0, jitter: 3, weightMul: 1, inkLevel: 0.9,
    asymmetry: 0, curvatureWeight: 0.5, smoothness: 0.45, dryness: 0.12,
    warp: 0, normalBias: 0, sampleStep: 5,
  },
  bold: {
    style: "calligraphic", radius: 50, taper: 0.8, brushAngle: -40,
    angleVar: 5, tremor: 0, jitter: 2, weightMul: 1.5, inkLevel: 0.95,
    asymmetry: 0.1, curvatureWeight: 0.8, smoothness: 0.5, dryness: 0.05,
    warp: 0, normalBias: 0, sampleStep: 5,
  },
  delicate: {
    style: "calligraphic", radius: 12, taper: 1.2, brushAngle: -20,
    angleVar: 0, tremor: 0, jitter: 1.5, weightMul: 0.7, inkLevel: 0.85,
    asymmetry: -0.1, curvatureWeight: 1.0, smoothness: 0.6, dryness: 0.15,
    warp: 0, normalBias: 0, sampleStep: 4,
  },
  expressive: {
    style: "expressive", radius: 35, taper: 0.7, brushAngle: -45,
    angleVar: 30, tremor: 4, jitter: 8, weightMul: 1.1, inkLevel: 0.8,
    asymmetry: 0.2, curvatureWeight: 1.5, smoothness: 0.35, dryness: 0.2,
    warp: 0.5, normalBias: 5, sampleStep: 6,
  },
  brush: {
    style: "brush", radius: 40, taper: 0.4, brushAngle: -50,
    angleVar: 15, tremor: 2, jitter: 5, weightMul: 1.3, inkLevel: 0.75,
    asymmetry: 0.15, curvatureWeight: 0.3, smoothness: 0.3, dryness: 0.3,
    warp: 0.3, normalBias: -3, sampleStep: 5,
  },
  dry: {
    style: "brush", radius: 25, taper: 0.9, brushAngle: -35,
    angleVar: 10, tremor: 6, jitter: 12, weightMul: 0.9, inkLevel: 0.55,
    asymmetry: 0, curvatureWeight: 0.5, smoothness: 0.4, dryness: 0.45,
    warp: 0.8, normalBias: 0, sampleStep: 7,
  },
  even: {
    style: "even", radius: 22, taper: 0.3, brushAngle: 0,
    angleVar: 0, tremor: 0, jitter: 2, weightMul: 1.0, inkLevel: 0.95,
    asymmetry: 0, curvatureWeight: 0, smoothness: 0.5, dryness: 0.05,
    warp: 0, normalBias: 0, sampleStep: 5,
  },
};

const PRESET_NAMES = Object.keys(PRESETS);

// ---------------------------------------------------------------------------
// Classify all strokes in a character's medians
// Returns array of { type, index } for each stroke
// ---------------------------------------------------------------------------
function classifyStrokes(medians) {
  if (!medians) return [];
  return medians.map((median, i) => {
    const raw = classifyStroke(median);
    const { type } = parseStrokeType(raw);
    return { type, index: i };
  });
}

// ---------------------------------------------------------------------------
// Perturb a single parameter value within its range
// ---------------------------------------------------------------------------
function perturbParam(key, value, strength, rand) {
  const range = PARAM_RANGES[key];
  if (!range) return value;
  const span = range[1] - range[0];
  return clamp(value + gaussian(rand) * span * strength, range[0], range[1]);
}

// ---------------------------------------------------------------------------
// Generate a design with stroke-level overrides.
// Strategy: pick a base preset, apply light global variation,
// then generate meaningful per-stroke-type overrides.
// ---------------------------------------------------------------------------
export function generateRandom(seed, medians) {
  const rand = rng(seed);

  // Base is always calligraphic preset with very light global variation
  const base = PRESETS.classic;
  const global = { ...base };
  for (const key of Object.keys(PARAM_RANGES)) {
    global[key] = perturbParam(key, base[key] ?? 0, 0.05, rand);
  }
  global.widthCurve = null;
  global.offsetCurve = null;

  // Global medianMod: subtle overall shape tendency
  const medianMod = {
    bow:        clamp((rand() - 0.5) * 0.2, -0.15, 0.15),
    entryBend:  clamp((rand() - 0.5) * 20,  -12,   12),
    exitBend:   clamp((rand() - 0.5) * 20,  -12,   12),
  };

  // Per-stroke overrides: medianMod variation + very subtle rendering tweaks
  const overrides = {};
  if (medians) {
    const strokes = classifyStrokes(medians);

    for (const s of strokes) {
      const modRanges = MEDIAN_MOD_RANGES[s.type] || MEDIAN_MOD_RANGES.normal;
      const sensitivity = STROKE_SENSITIVITY[s.type] || STROKE_SENSITIVITY.normal;
      const ov = {};

      // Per-stroke medianMod: type-specific range, centered on global tendency
      const strokeMod = {};
      for (const [param, [lo, hi]] of Object.entries(modRanges)) {
        const baseVal = medianMod[param];
        const spread = (hi - lo) * 0.35;
        strokeMod[param] = clamp(baseVal + gaussian(rand) * spread, lo, hi);
      }
      ov.medianMod = strokeMod;

      // Conservative rendering tweaks (optional, low probability)
      for (const [param, weight] of Object.entries(sensitivity)) {
        if (rand() > 0.5) continue;
        ov[param] = perturbParam(param, global[param] ?? 0, weight * 0.5, rand);
      }

      overrides[String(s.index)] = ov;
    }
  }

  return {
    seed,
    charScale: 1.0,
    medianMod,
    global,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Breed: create offspring from a parent design by stroke-level mutation.
// Keeps parent's global params mostly intact, evolves the overrides.
// ---------------------------------------------------------------------------
export function breed(parent, seed, medians, mutationRate = 0.12) {
  const rand = rng(seed);

  // Very subtle global rendering perturb
  const global = { ...parent.global };
  for (const key of Object.keys(PARAM_RANGES)) {
    if (global[key] == null) continue;
    global[key] = perturbParam(key, global[key], 0.03, rand);
  }
  global.widthCurve = parent.global.widthCurve
    ? JSON.parse(JSON.stringify(parent.global.widthCurve)) : null;
  global.offsetCurve = parent.global.offsetCurve
    ? JSON.parse(JSON.stringify(parent.global.offsetCurve)) : null;

  // Evolve global medianMod
  const parentMod = parent.medianMod || { bow: 0, entryBend: 0, exitBend: 0 };
  const medianMod = {
    bow:       clamp(parentMod.bow       + gaussian(rand) * 0.04 * mutationRate * 8, -0.2, 0.2),
    entryBend: clamp(parentMod.entryBend + gaussian(rand) * 3    * mutationRate * 8, -20, 20),
    exitBend:  clamp(parentMod.exitBend  + gaussian(rand) * 3    * mutationRate * 8, -20, 20),
  };

  // Evolve per-stroke overrides
  const overrides = {};
  if (medians) {
    const strokes = classifyStrokes(medians);

    for (const s of strokes) {
      const parentOv = parent.overrides[String(s.index)] || {};
      const childOv = {};

      // Evolve medianMod for this stroke
      const modRanges = MEDIAN_MOD_RANGES[s.type] || MEDIAN_MOD_RANGES.normal;
      const parentStrokeMod = parentOv.medianMod || medianMod;
      const strokeMod = {};
      for (const [param, [lo, hi]] of Object.entries(modRanges)) {
        const spread = (hi - lo) * 0.15 * mutationRate * 8;
        strokeMod[param] = clamp(parentStrokeMod[param] + gaussian(rand) * spread, lo, hi);
      }
      childOv.medianMod = strokeMod;

      // Evolve rendering overrides conservatively
      const sensitivity = STROKE_SENSITIVITY[s.type] || STROKE_SENSITIVITY.normal;
      for (const [param, weight] of Object.entries(sensitivity)) {
        const baseVal = parentOv[param] ?? global[param] ?? 0;
        if (rand() < weight) {
          childOv[param] = perturbParam(param, baseVal, mutationRate * weight * 0.5, rand);
        }
      }

      overrides[String(s.index)] = childOv;
    }
  } else {
    for (const [idx, ov] of Object.entries(parent.overrides || {})) {
      overrides[idx] = { ...ov };
      if (ov.medianMod) {
        overrides[idx].medianMod = {
          bow:       clamp(ov.medianMod.bow       + gaussian(rand) * 0.03, -0.2, 0.2),
          entryBend: clamp(ov.medianMod.entryBend + gaussian(rand) * 2,    -20,  20),
          exitBend:  clamp(ov.medianMod.exitBend  + gaussian(rand) * 2,    -20,  20),
        };
      }
    }
  }

  return {
    seed,
    charScale: parent.charScale || 1.0,
    medianMod,
    global,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Crossover: blend two parent designs at the stroke level
// ---------------------------------------------------------------------------
export function crossover(parentA, parentB, seed, medians) {
  const rand = rng(seed);

  const global = {};
  global.style = rand() < 0.5 ? parentA.global.style : parentB.global.style;
  for (const key of Object.keys(PARAM_RANGES)) {
    const va = parentA.global[key] ?? 0;
    const vb = parentB.global[key] ?? 0;
    global[key] = lerp(va, vb, rand());
  }
  global.widthCurve = null;
  global.offsetCurve = null;

  // Blend global medianMod
  const modA = parentA.medianMod || { bow: 0, entryBend: 0, exitBend: 0 };
  const modB = parentB.medianMod || { bow: 0, entryBend: 0, exitBend: 0 };
  const t = rand();
  const medianMod = {
    bow:       lerp(modA.bow,       modB.bow,       t),
    entryBend: lerp(modA.entryBend, modB.entryBend, t),
    exitBend:  lerp(modA.exitBend,  modB.exitBend,  t),
  };

  // Per-stroke: randomly pick from parent A or B, blend medianMod
  const overrides = {};
  if (medians) {
    for (let i = 0; i < medians.length; i++) {
      const key = String(i);
      const pickA = rand() < 0.5;
      const src = pickA ? parentA : parentB;
      const other = pickA ? parentB : parentA;
      const srcOv = src.overrides[key] || {};
      const otherOv = other.overrides[key] || {};
      overrides[key] = {};

      // Blend medianMod
      const smA = srcOv.medianMod || src.medianMod || { bow: 0, entryBend: 0, exitBend: 0 };
      const smB = otherOv.medianMod || other.medianMod || { bow: 0, entryBend: 0, exitBend: 0 };
      const bt = rand();
      overrides[key].medianMod = {
        bow:       lerp(smA.bow,       smB.bow,       bt),
        entryBend: lerp(smA.entryBend, smB.entryBend, bt),
        exitBend:  lerp(smA.exitBend,  smB.exitBend,  bt),
      };

      // Inherit rendering overrides from chosen parent
      for (const [param, val] of Object.entries(srcOv)) {
        if (param === "medianMod") continue;
        overrides[key][param] = perturbParam(param, val, 0.03, rand);
      }
    }
  }

  return {
    seed,
    charScale: lerp(parentA.charScale || 1, parentB.charScale || 1, rand()),
    medianMod,
    global,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Generate N designs for a character
// ---------------------------------------------------------------------------
export function generateBatch(count, baseSeed, medians) {
  const designs = [];
  for (let i = 0; i < count; i++) {
    designs.push(generateRandom(baseSeed + i * 1337, medians));
  }
  return designs;
}

export { PRESET_NAMES, PRESETS };
