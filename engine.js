/* eslint-disable no-unused-vars */
// ---------------------------------------------------------------------------
// Stroke rendering engine (extracted from chinese-prototype)
// Pure functions: no DOM, no state. Imported by both prototype and design tool.
// ---------------------------------------------------------------------------

// --- PRNG ---
function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Geometry ---
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function transformMedian(median, ox, oy, scale) {
  return median.map(([mx, my]) => ({
    x: ox + mx * scale,
    y: oy + (900 - my) * scale
  }));
}

// Catmull-Rom spline smoothing of a median polyline.
// tension: 0 = original polyline (no-op), 1 = full spline smoothing.
// Preserves first and last points exactly.
function smoothMedian(points, tension) {
  if (tension <= 0 || points.length < 3) return points;
  const t = Math.min(tension, 1);

  // Phantom endpoints: reflect first/last segment
  const p0 = { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y };
  const pN = { x: 2 * points[points.length - 1].x - points[points.length - 2].x,
               y: 2 * points[points.length - 1].y - points[points.length - 2].y };
  const ctrl = [p0, ...points, pN];

  const result = [];
  for (let i = 1; i < ctrl.length - 2; i++) {
    const p0 = ctrl[i - 1], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[i + 2];
    const segLen = dist(p1, p2);
    const steps = Math.max(2, Math.ceil(segLen / 4));
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      // Catmull-Rom basis (alpha = 0.5, standard)
      const u2 = u * u, u3 = u2 * u;
      const sx = 0.5 * ((-p0.x + 3*p1.x - 3*p2.x + p3.x)*u3
                       + (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*u2
                       + (-p0.x + p2.x)*u
                       + 2*p1.x);
      const sy = 0.5 * ((-p0.y + 3*p1.y - 3*p2.y + p3.y)*u3
                       + (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*u2
                       + (-p0.y + p2.y)*u
                       + 2*p1.y);
      // Lerp between original linear interpolation and spline based on tension
      const lx = p1.x + (p2.x - p1.x) * u;
      const ly = p1.y + (p2.y - p1.y) * u;
      result.push({ x: lx + (sx - lx) * t, y: ly + (sy - ly) * t });
    }
  }
  // Ensure last point is exact
  const last = points[points.length - 1];
  result.push({ x: last.x, y: last.y });
  return result;
}

function samplePolyline(points, step) {
  const sampled = [];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = dist(a, b);
    if (!segLen) continue;
    const dx = (b.x - a.x) / segLen;
    const dy = (b.y - a.y) / segLen;
    let offset = carry;
    while (offset <= segLen) {
      sampled.push({ x: a.x + dx * offset, y: a.y + dy * offset, nx: -dy, ny: dx, tx: dx, ty: dy });
      offset += step;
    }
    carry = offset - segLen;
  }
  if (!sampled.length && points.length) {
    const last = points[points.length - 1];
    sampled.push({ x: last.x, y: last.y, nx: 0, ny: -1, tx: 1, ty: 0 });
  }
  return sampled;
}

function estimateCurvatures(samples) {
  const curvatures = new Float64Array(samples.length);
  for (let i = 1; i < samples.length - 1; i++) {
    const dx = samples[i + 1].tx - samples[i - 1].tx;
    const dy = samples[i + 1].ty - samples[i - 1].ty;
    curvatures[i] = Math.sqrt(dx * dx + dy * dy);
  }
  curvatures[0] = curvatures[1] || 0;
  curvatures[samples.length - 1] = curvatures[samples.length - 2] || 0;
  return curvatures;
}

function densityScale(strokeCount) {
  // Blend: 40% fixed + 60% scaled, so high-stroke chars don't shrink too much
  const raw = Math.sqrt(4.5 / Math.max(1, strokeCount));
  return 0.4 + 0.6 * raw;
}

// --- Stroke classification ---
function classifyStroke(median) {
  let totalLen = 0;
  for (let i = 1; i < median.length; i++) {
    totalLen += Math.hypot(median[i][0] - median[i - 1][0], median[i][1] - median[i - 1][1]);
  }
  if (totalLen < 180) {
    // Sub-classify short strokes by slope direction
    const startPt = median[0];
    const endPt = median[median.length - 1];
    const sdx = endPt[0] - startPt[0];
    const sdy = endPt[1] - startPt[1];
    const slen = Math.hypot(sdx, sdy);
    if (slen > 20) {
      const slope = Math.abs(sdy / sdx);
      // Only apply when slope > 30 degrees (tan(30) ≈ 0.577)
      if (slope > 0.577) {
        // Top-right to bottom-left (MMAH: dx<0, dy<0): descending pressure
        if (sdx < 0 && sdy < 0) return "short-desc";
        // Top-left to bottom-right (MMAH: dx>0, dy<0): ascending pressure
        if (sdx > 0 && sdy < 0) return "short-asc";
      }
    }
    return "short";
  }

  // Detect zhe (折): significant direction change (turn) in the stroke
  // Also record the turn position (as fraction of total length) for taper timing
  let zheTurnProgress = 0;
  if (median.length >= 3) {
    let maxAngleChange = 0;
    let maxAngleIdx = -1;
    for (let i = 1; i < median.length - 1; i++) {
      const dx1 = median[i][0] - median[i - 1][0];
      const dy1 = median[i][1] - median[i - 1][1];
      const dx2 = median[i + 1][0] - median[i][0];
      const dy2 = median[i + 1][1] - median[i][1];
      const len1 = Math.hypot(dx1, dy1);
      const len2 = Math.hypot(dx2, dy2);
      if (len1 > 10 && len2 > 10) {
        const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (angle > maxAngleChange) {
          maxAngleChange = angle;
          maxAngleIdx = i;
        }
      }
    }
    // Threshold: ~60 degrees = significant turn
    if (maxAngleChange > Math.PI / 3) {
      // Compute progress of the turn point along the stroke
      let lenToTurn = 0;
      for (let i = 1; i <= maxAngleIdx; i++) {
        lenToTurn += Math.hypot(median[i][0] - median[i - 1][0], median[i][1] - median[i - 1][1]);
      }
      zheTurnProgress = lenToTurn / totalLen;
      return "zhe:" + zheTurnProgress.toFixed(3);
    }
  }

  // Overall direction: start to end
  const startPt = median[0];
  const endPt = median[median.length - 1];
  const dx = endPt[0] - startPt[0];
  const dy = endPt[1] - startPt[1];
  // MMAH: y increases upward. pie goes left and down (dx<0, dy<0 in MMAH = visually down-left)
  if (dx < -30 && dy < -30) return "pie";
  // Ti (提): goes right and up with steep slope (>30 degrees from horizontal)
  // Many heng rise slightly; only classify as ti when dy/dx > tan(30°) ≈ 0.577
  if (dx > 30 && dy > 0 && dy / dx > 0.577) return "ti";
  return "normal";
}

// --- Stroke trait generation ---
function parseStrokeType(raw) {
  if (raw.startsWith("zhe:")) return { type: "zhe", turnProgress: parseFloat(raw.slice(4)) };
  return { type: raw, turnProgress: 0 };
}

function generateStrokeTraits(rand, strokeCount, opts, medians) {
  const traits = [];
  const v = opts.strokeVariation || 1;
  const deplete = opts.inkDepletion || 1;
  const style = opts.strokeStyle || "calligraphic";
  let inkLevel = 1.0;
  for (let i = 0; i < strokeCount; i++) {
    const r = () => rand();
    const rawType = medians ? classifyStroke(medians[i]) : "normal";
    const { type: strokeType, turnProgress } = parseStrokeType(rawType);
    let exitSharpness, entryPressure;
    if (style === "calligraphic") {
      if (strokeType === "pie" || strokeType === "ti" || strokeType === "short-desc") {
        exitSharpness = 0.6 + r() * 0.3 * v;
      } else if (strokeType === "zhe") {
        exitSharpness = 0.5 + r() * 0.3 * v;
      } else if (strokeType === "short" || strokeType === "short-asc") {
        exitSharpness = 0.4 + r() * 0.3 * v;
      } else {
        exitSharpness = r() * 0.2 * v;
      }
      entryPressure = strokeType.startsWith("short") ? 0.3 + r() * 0.3 * v : 0.6 + r() * 0.6 * v;
    } else {
      exitSharpness = r() * 0.8 * v;
      entryPressure = 0.6 + r() * 0.6 * v;
    }
    traits.push({
      strokeType,
      turnProgress,
      weightMul: 1 + (r() - 0.5) * 0.6 * v,
      speedBias: 1 + (r() - 0.5) * 0.8 * v,
      entryPressure,
      exitSharpness,
      tremor: r() * r() * v,
      inkLevel,
      asymmetry: (r() - 0.5) * 0.6 * v,
      pressurePeakPos: 0.2 + r() * 0.5,
    });
    inkLevel -= (0.06 + r() * 0.12) * deplete;
    if (inkLevel < 0.25 || r() < 0.15 / Math.max(0.3, deplete)) inkLevel = 0.7 + r() * 0.3;
  }
  return traits;
}

// --- Pressure curves ---
function pressureCalligraphic(progress, trait, opts) {
  // Short-desc: short stroke going top-right to bottom-left (mini-pie), descending pressure
  if (trait.strokeType === "short-desc") {
    const entryBoost = 0.3 * Math.exp(-progress * 4);
    let descent = 1.0;
    if (progress > 0.35) {
      const t = (progress - 0.35) / 0.65;
      descent = 1.0 - t * t * 0.8;
    }
    const raw = (descent + entryBoost) * trait.weightMul;
    return Math.max(0.15, Math.min(raw, 1.2));
  }

  // Short-asc: short stroke going top-left to bottom-right (na-dot), ascending pressure
  if (trait.strokeType === "short-asc") {
    let ascent = 0.5;
    if (progress < 0.6) {
      const t = progress / 0.6;
      ascent = 0.5 + t * t * 0.5; // quadratic rise to ~1.0
    } else {
      ascent = 1.0;
    }
    const raw = ascent * trait.weightMul;
    return Math.max(0.15, Math.min(raw, 1.2));
  }

  // Pie (撇) and Ti (提): descending width profile
  // Gradual descent starting around 50%, accelerating toward exit
  if (trait.strokeType === "pie" || trait.strokeType === "ti") {
    const entryW = 0.5 + trait.entryPressure * 0.5;
    const entryBoost = entryW * Math.exp(-progress * 3) * 0.4;
    // Holds near full width until ~40%, then smooth descent
    let descent = 1.0;
    if (progress > 0.4) {
      const t = (progress - 0.4) / 0.6; // 0 at 40%, 1 at 100%
      descent = 1.0 - t * t * 0.85;     // quadratic ease-in taper
    }
    const base = (descent + entryBoost);
    const speedWave = 1 + 0.06 * Math.sin(progress * Math.PI * trait.speedBias * 3);
    const raw = base * speedWave * trait.weightMul;
    return Math.max(0.12, Math.min(raw, 1.3));
  }

  // Zhe (折): normal body, taper begins at the last turn point
  if (trait.strokeType === "zhe") {
    const entryW = 0.5 + trait.entryPressure * 0.5;
    const entryFade = Math.exp(-progress * 4);
    const entryBoost = entryW * entryFade * 0.4;
    const midDip = Math.sin(progress * Math.PI);
    const midThin = 1 - opts.taper * midDip * 0.5;
    // Taper starts at the turn point (from classifyStroke)
    const taperStart = Math.max(0.5, trait.turnProgress || 0.75);
    let exitMul = 1;
    if (progress > taperStart) {
      const t = (progress - taperStart) / (1 - taperStart);
      exitMul = 1 - t * t * 0.85; // quadratic taper to ~0.15
    }
    const base = (midThin + entryBoost) * exitMul;
    const speedWave = 1 + 0.08 * Math.sin(progress * Math.PI * trait.speedBias * 3);
    const raw = base * speedWave * trait.weightMul;
    return Math.max(0.10, Math.min(raw, 1.3));
  }

  const entryW = 0.5 + trait.entryPressure * 0.5;
  const entryFade = Math.exp(-progress * 4);
  const entryBoost = entryW * entryFade * 0.4;
  const midDip = Math.sin(progress * Math.PI);
  const midThin = 1 - opts.taper * midDip * 0.5;
  let exitMul = 1;
  if (trait.exitSharpness > 0.3) {
    const taperStart = 0.55 - trait.exitSharpness * 0.15;
    if (progress > taperStart) {
      const t = (progress - taperStart) / (1 - taperStart);
      const minExit = 0.3 - trait.exitSharpness * 0.1;
      exitMul = minExit + (1 - minExit) * Math.pow(1 - t, 1 + trait.exitSharpness);
    }
  } else {
    const pressW = (0.3 - trait.exitSharpness) / 0.3;
    const exitFade = Math.exp(-(1 - progress) * 4);
    exitMul = 1 + exitFade * pressW * 0.3;
  }
  const base = (midThin + entryBoost) * exitMul;
  const speedWave = 1 + 0.08 * Math.sin(progress * Math.PI * trait.speedBias * 3);
  const raw = base * speedWave * trait.weightMul;
  return Math.max(0.18, Math.min(raw, 1.3));
}

function pressureExpressive(progress, trait, opts) {
  const entryW = 0.5 + trait.entryPressure * 0.5;
  const entryFade = Math.exp(-progress * 4);
  const exitW = 0.3 + (1 - trait.exitSharpness) * 0.7;
  const exitFade = Math.exp(-(1 - progress) * 4);
  const midDip = Math.sin(progress * Math.PI);
  const midThin = 1 - opts.taper * midDip * 0.5;
  const endpointPressure = entryW * entryFade + exitW * exitFade;
  const base = Math.max(midThin, midThin + endpointPressure * 0.4);
  const speedWave = 1 + 0.08 * Math.sin(progress * Math.PI * trait.speedBias * 3);
  const raw = base * speedWave * trait.weightMul;
  return Math.max(0.15, Math.min(raw, 1.3));
}

function pressureBrush(progress, trait, opts) {
  const entryFloor = 0.25 + trait.entryPressure * 0.3;
  const exitFloor = 0.1 + (1 - trait.exitSharpness) * 0.25;
  const entryBlend = Math.max(0, 1 - progress * 5);
  const exitBlend = Math.max(0, (progress - 0.8) / 0.2);
  const floor = entryFloor * entryBlend + exitFloor * exitBlend;
  const taperEnv = Math.pow(Math.sin(progress * Math.PI), Math.max(0.1, opts.taper));
  const shape = Math.max(taperEnv, floor);
  const entryRamp = entryFloor + (1 - entryFloor) * Math.min(1, progress * 5);
  const combined = shape * entryRamp * (0.5 + trait.entryPressure * 0.5);
  const exitT = Math.max(0, (progress - 0.82) / 0.18);
  const exitMul = 1 - exitT * trait.exitSharpness * 0.7;
  const peakDist = progress - trait.pressurePeakPos;
  const peakBump = 0.12 * Math.exp(-peakDist * peakDist / 0.03);
  const speedWave = 1 + 0.1 * Math.sin(progress * Math.PI * trait.speedBias * 3);
  const raw = combined * exitMul * speedWave * trait.weightMul + peakBump;
  return Math.max(0.12, Math.min(raw, 1.2));
}

function pressureEven(progress, trait, opts) {
  const entryRamp = 0.7 + 0.3 * Math.min(1, progress * 8);
  const exitRamp = 0.7 + 0.3 * Math.min(1, (1 - progress) * 8);
  const speedWave = 1 + 0.05 * Math.sin(progress * Math.PI * trait.speedBias * 3);
  const raw = entryRamp * exitRamp * speedWave * trait.weightMul;
  return Math.max(0.2, Math.min(raw, 1.15));
}

function pressureCurve(progress, trait, opts) {
  let base;
  switch (opts.strokeStyle) {
    case "expressive": base = pressureExpressive(progress, trait, opts); break;
    case "brush": base = pressureBrush(progress, trait, opts); break;
    case "even": base = pressureEven(progress, trait, opts); break;
    default: base = pressureCalligraphic(progress, trait, opts); break;
  }

  // Custom width curve: interpolate from control points, blend with base
  const curve = trait.widthCurve;
  if (curve && curve.length >= 2) {
    // Find segment
    let i = 0;
    while (i < curve.length - 1 && curve[i + 1].x < progress) i++;
    let cy;
    if (i >= curve.length - 1) {
      cy = curve[curve.length - 1].y;
    } else {
      const seg = curve[i + 1].x - curve[i].x;
      const t = seg > 0 ? (progress - curve[i].x) / seg : 0;
      cy = curve[i].y + (curve[i + 1].y - curve[i].y) * t;
    }
    // cy is 0-1 where 1 = full width. Blend: use curve as the primary shape.
    return Math.max(0.1, cy * 1.5 * trait.weightMul);
  }

  return base;
}

// --- Tremor ---
function tremorOffset(progress, trait, rand, opts) {
  if (trait.tremor < 0.01) return { dx: 0, dy: 0 };
  const envelope = Math.sin(progress * Math.PI);
  const intensity = trait.tremor * opts.tremor * envelope;
  const freq = 8 + trait.tremor * 20;
  const phase1 = Math.sin(progress * freq * Math.PI * 2 + rand() * 6.28);
  const phase2 = Math.cos(progress * freq * Math.PI * 2.7 + rand() * 6.28);
  return { dx: phase1 * intensity, dy: phase2 * intensity };
}

// --- Angle ---
function resolveAngle(opts, strokeIndex, progress, rand) {
  const varRad = (opts.angleVar * Math.PI) / 180;
  const strokeShift = varRad * Math.sin(strokeIndex * 2.39996);
  const progressDrift = varRad * 0.4 * Math.sin(progress * Math.PI * 2.5);
  const noise = varRad * 0.2 * (rand() - 0.5);
  return (opts.brushAngle * Math.PI) / 180 + strokeShift + progressDrift + noise;
}

// --- Smoothing ---
function simplifyPolygon(points, minDist) {
  if (points.length <= 3) return points.slice();
  const s = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - s[s.length - 1].x, points[i].y - s[s.length - 1].y) >= minDist) {
      s.push(points[i]);
    }
  }
  if (s.length > 2) {
    const d = Math.hypot(s[0].x - s[s.length - 1].x, s[0].y - s[s.length - 1].y);
    if (d < minDist) s.pop();
  }
  return s.length >= 3 ? s : points.slice();
}

function chaikinClosed(points, passes) {
  let cur = points.slice();
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) return cur;
    const next = [];
    for (let i = 0; i < cur.length; i++) {
      const p0 = cur[i];
      const p1 = cur[(i + 1) % cur.length];
      next.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      next.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    cur = next;
  }
  return cur;
}

function smoothClosedPath(ctx, points) {
  if (!points.length) return;
  if (points.length < 3) {
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    return;
  }
  const mids = points.map((p, i) => {
    const n = points[(i + 1) % points.length];
    return { x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 };
  });
  ctx.moveTo(mids[0].x, mids[0].y);
  for (let i = 0; i < points.length; i++) {
    const ctrl = points[(i + 1) % points.length];
    const mid = mids[(i + 1) % points.length];
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, mid.x, mid.y);
  }
  ctx.closePath();
}

// --- Envelope ---
function interpolateOffsetCurve(progress, curve) {
  if (!curve || curve.length < 2) return 0;
  let i = 0;
  while (i < curve.length - 1 && curve[i + 1].x < progress) i++;
  if (i >= curve.length - 1) return curve[curve.length - 1].y;
  const seg = curve[i + 1].x - curve[i].x;
  const t = seg > 0 ? (progress - curve[i].x) / seg : 0;
  return curve[i].y + (curve[i + 1].y - curve[i].y) * t;
}

function createStrokeEnvelope(stroke, opts, rand, strokeIndex, trait, dScale) {
  const effectiveR = opts.radius * (dScale || 1);
  const fineStep = Math.max(1.5, opts.sampleStep * 0.5);
  const samples = samplePolyline(stroke, fineStep);
  const curvatures = estimateCurvatures(samples);
  const left = [];
  const right = [];

  // Offset curve: displacement magnitude scales with effectiveR
  const offsetCurve = trait.offsetCurve;
  const offsetScale = effectiveR * 3; // max displacement = 3x radius at curve value of 1

  let maxCurv = 0;
  for (let i = 0; i < curvatures.length; i++) {
    if (curvatures[i] > maxCurv) maxCurv = curvatures[i];
  }

  // Pre-generate warp phases (deterministic from rand, before per-sample loop)
  const warpAmount = opts.warp || 0;
  const warpPhases = [];
  if (warpAmount > 0) {
    for (let w = 0; w < 3; w++) {
      warpPhases.push({
        freq: 1.2 + w * 1.7,       // ~1.2, 2.9, 4.6 cycles along stroke
        phase: rand() * Math.PI * 2,
        amp: (1 - w * 0.3),         // decreasing amplitude for higher freq
      });
    }
  }

  samples.forEach((s, idx) => {
    const progress = samples.length > 1 ? idx / (samples.length - 1) : 0.5;

    // Apply offset curve: displace point perpendicular to stroke direction
    let sx = s.x, sy = s.y;
    if (offsetCurve) {
      const offsetVal = interpolateOffsetCurve(progress, offsetCurve);
      sx += s.nx * offsetVal * offsetScale;
      sy += s.ny * offsetVal * offsetScale;
    }

    // Apply warp: low-frequency centerline displacement
    if (warpAmount > 0) {
      const envelope = Math.sin(progress * Math.PI); // fade at endpoints
      let warpVal = 0;
      for (let w = 0; w < warpPhases.length; w++) {
        const wp = warpPhases[w];
        warpVal += wp.amp * Math.sin(progress * wp.freq * Math.PI * 2 + wp.phase);
      }
      warpVal /= warpPhases.length;
      const displacement = warpVal * warpAmount * effectiveR * envelope;
      sx += s.nx * displacement;
      sy += s.ny * displacement;
    }

    const angle = resolveAngle(opts, strokeIndex || 0, progress, rand);
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    const pressure = pressureCurve(progress, trait, opts);
    const normCurv = maxCurv > 0 ? curvatures[idx] / maxCurv : 0;
    const artBoost = 1 + normCurv * opts.curvatureWeight * 0.8;
    const cornerClamp = 1 - normCurv * 0.35;
    const dirW = Math.abs(s.tx * ax + s.ty * ay);
    const widthCore = effectiveR * pressure * artBoost * cornerClamp * (0.65 + dirW * 0.35);
    const edgeNoise = opts.jitter * (rand() - 0.5) * 0.18;
    const centerShift = opts.normalBias * (0.5 + rand() * 0.3);
    const asymOff = trait.asymmetry * widthCore * 0.4;
    const flare = (0.85 + rand() * 0.15) * widthCore;
    const trem = tremorOffset(progress, trait, rand, opts);
    const cx = sx + s.nx * (centerShift + asymOff) + trem.dx;
    const cy = sy + s.ny * (centerShift + asymOff) + trem.dy;
    const lr = Math.max(1, flare + edgeNoise);
    const rr = Math.max(1, flare - edgeNoise * 0.5);
    left.push({ x: cx + s.nx * lr, y: cy + s.ny * lr });
    right.push({ x: cx - s.nx * rr, y: cy - s.ny * rr });
  });

  // Caps
  const capN = 8;
  const s0 = samples[0];
  const sN = samples[samples.length - 1];

  // Start cap
  const sL = left[0], sR = right[0];
  const halfSpan = Math.hypot(sL.x - sR.x, sL.y - sR.y) / 2;
  const bulgeDist = halfSpan * (0.3 + trait.entryPressure * 0.5);
  const startCap = [];
  for (let i = 0; i <= capN; i++) {
    const t = i / capN;
    const baseX = sR.x + (sL.x - sR.x) * t;
    const baseY = sR.y + (sL.y - sR.y) * t;
    const bulge = Math.sin(t * Math.PI) * bulgeDist;
    startCap.push({ x: baseX + (-s0.tx) * bulge, y: baseY + (-s0.ty) * bulge });
  }

  // End cap
  const eL = left[left.length - 1], eR = right[right.length - 1];
  const eCx = (eL.x + eR.x) / 2, eCy = (eL.y + eR.y) / 2;
  const eHalfSpan = Math.hypot(eL.x - eR.x, eL.y - eR.y) / 2;
  const sharpness = trait.exitSharpness;
  const eBulgeDist = eHalfSpan * (0.3 + (1 - sharpness) * 0.5);
  const pointDist = eHalfSpan * sharpness * 1.8;
  const endCap = [];
  for (let i = 0; i <= capN; i++) {
    const t = i / capN;
    const baseX = eL.x + (eR.x - eL.x) * t;
    const baseY = eL.y + (eR.y - eL.y) * t;
    const bulge = Math.sin(t * Math.PI);
    const roundX = baseX + sN.tx * eBulgeDist * bulge;
    const roundY = baseY + sN.ty * eBulgeDist * bulge;
    const pointX = eCx + sN.tx * pointDist;
    const pointY = eCy + sN.ty * pointDist;
    const blend = bulge * sharpness;
    endCap.push({
      x: roundX * (1 - blend) + pointX * blend,
      y: roundY * (1 - blend) + pointY * blend
    });
  }

  const poly = [...left, ...endCap, ...right.reverse(), ...startCap];
  const simplified = simplifyPolygon(poly, Math.max(1.5, effectiveR * 0.15));
  return chaikinClosed(simplified, 2);
}

// --- Exports for module bundling ---
export {
  mulberry32, transformMedian, smoothMedian, densityScale,
  classifyStroke, parseStrokeType, pressureCurve,
  createStrokeEnvelope, smoothClosedPath,
};
