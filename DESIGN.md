# Chinese Character Design Tool: Stroke-Level Control

## The Idea

Take the rendering engine from chinese-prototype and turn it into a per-character design tool where every stroke can be individually tuned. The user works on one character at a time, adjusts each stroke's parameters independently, and saves the result as a reusable character definition.

The prototype proved that centerline-driven stroke synthesis produces expressive, legible Chinese characters. But the prototype treats all strokes in a character with the same global parameters (plus randomized variation). Real calligraphy does not work that way. A calligrapher makes deliberate choices per stroke: this horizontal is heavy, that falling stroke tapers sharply, the dot is quick and light. The tool should let the designer make those same choices.

## What the Tool Does

**One character at a time.** The workspace shows a single character large enough to see stroke details. No grid of five characters. Focus.

**Stroke selection.** Click a stroke to select it. Selected stroke highlights (maybe skeleton overlay or color tint). The parameter panel updates to show that stroke's current settings.

**Per-stroke parameters.** Each stroke gets its own copy of:
- Stroke style (calligraphic, expressive, brush, even, or mixed)
- Width / radius
- Pressure curve shape (or custom control points)
- Taper strength (entry and exit independently)
- Entry behavior (blunt, tapered, pressed)
- Exit behavior (收笔 press, 出锋 taper, hook lift)
- Brush angle and angle variation
- Tremor amount
- Ink level / depletion
- Jitter
- Asymmetry

**Global defaults with per-stroke overrides.** Start with global settings that apply to all strokes. Then override any parameter on any stroke. Unmodified strokes inherit from global. This means you can set a base style quickly, then refine individual strokes that need special treatment.

**Character-level controls.** These stay global:
- Density scaling (auto or manual)
- Compositing mode
- Canvas size / padding
- Random seed

**Save and load.** Each character's complete parameter set (global defaults + per-stroke overrides) saves as a JSON file. Load it back to continue editing. Export as SVG or PNG.

**Character switching.** Type or paste a character to load its MMAH median data. Or load from the full graphics.txt dataset dynamically.

## Why Per-Stroke Control Matters

The four styles in the prototype are interesting but coarse. They apply the same pressure curve to every stroke. The "calligraphic" style adds stroke-type awareness (撇 tapers, dots taper both ends, normal strokes get 收笔), but even that is rule-based and uniform within each category.

In real calligraphy:
- The first stroke of 永 (the dot at top) is often heavy and decisive. The current system makes it thin because it is short.
- The 撇 in 永 should taper gradually, but the 捺 (right-falling) should broaden before lifting. Same character, opposite behaviors.
- In 關, some internal strokes are deliberately lighter to create hierarchy. The outer frame is bolder.
- A calligrapher might write the horizontal in 女 with a slight upward arc and heavy center, while the sweeping strokes are thinner and faster.

None of these choices can be expressed with a single set of global sliders. Per-stroke control makes them possible.

## Architecture

### Data Model

```
CharacterDesign {
  character: string           // e.g. "永"
  medians: number[][][]       // from MMAH (read-only)
  seed: number                // random seed
  global: StrokeParams        // default params for all strokes
  overrides: {                // sparse map: stroke index -> partial params
    [strokeIndex]: Partial<StrokeParams>
  }
  metadata: {
    created: timestamp
    modified: timestamp
    notes: string             // designer's notes
  }
}

StrokeParams {
  style: "calligraphic" | "expressive" | "brush" | "even"
  radius: number
  taperEntry: number
  taperExit: number
  exitBehavior: "press" | "taper" | "hook"
  entryBehavior: "blunt" | "taper" | "press"
  brushAngle: number
  angleVariation: number
  tremor: number
  jitter: number
  inkLevel: number
  inkDepletion: number
  asymmetry: number
  curvatureWeight: number
  pressureCurve: number[]     // custom control points, optional
}
```

### Rendering Pipeline

Same engine as chinese-prototype, but instead of generating random traits, read them from the saved design. The `generateStrokeTraits` function becomes `resolveStrokeParams(global, overrides, strokeIndex)` which merges global defaults with any per-stroke overrides.

### UI Layout

```
+------------------------------------------+
|  [char input]  [load] [save] [export]    |
+------------------------------------------+
|                    |                      |
|                    |  Global params       |
|                    |  (applies to all)    |
|   Large canvas     |                      |
|   (single char)    |  ---                 |
|                    |  Stroke #N params    |
|   click stroke     |  (overrides only)    |
|   to select        |                      |
|                    |  [reset to global]   |
+------------------------------------------+
|  Stroke list: [1] [2] [3] [4] [5] ...   |
+------------------------------------------+
```

### Stroke Hit Testing

To know which stroke the user clicked, render each stroke's envelope to a hidden canvas with a unique color per stroke. On click, read the pixel color at the click point and map it back to a stroke index. Simple and accurate even for complex overlapping strokes.

### File Format

JSON, one file per character. Example filename: `永.json` or `6c38.json` (Unicode codepoint).

```json
{
  "character": "永",
  "seed": 42,
  "global": {
    "style": "calligraphic",
    "radius": 12,
    "taperEntry": 0.3,
    "taperExit": 0.55,
    "exitBehavior": "press",
    "brushAngle": -30,
    "tremor": 0,
    "inkLevel": 0.85
  },
  "overrides": {
    "0": { "radius": 8, "exitBehavior": "press", "style": "brush" },
    "2": { "exitBehavior": "taper", "taperExit": 0.8 }
  }
}
```

Only overridden values are stored. Clean, minimal, easy to diff.

## What This Enables

**Font design workflow.** Design characters one at a time with full stroke-level control. Save each. Build up a character set. Export for use in posters, titles, or full font pipelines.

**Style exploration.** Try mixing styles within a single character. Calligraphic horizontals with expressive falling strokes. Brush-style dots with even-style frames.

**Teaching tool.** Show students how different stroke parameters affect character appearance. Let them experiment with individual strokes to understand calligraphic principles.

**The Shijing pipeline.** Design a set of characters for a specific poem. Each character hand-tuned. Export and compose into the poster layout.

## What This Does NOT Do

- Full font generation (thousands of characters). This is a per-character design tool.
- Real-time freehand calligraphy simulation. The input is structured MMAH data, not pen strokes.
- AI-based style transfer. The control is manual and parametric.

## Build Plan

### Phase 1: Single-character workspace
- Large canvas, one character
- Dynamic character loading from MMAH data (type to switch)
- Global parameter panel (reuse existing sliders)

### Phase 2: Stroke selection and per-stroke overrides
- Click-to-select with hit-test canvas
- Per-stroke parameter panel (shows only overrides)
- Visual indicator of selected stroke
- Reset-to-global button per stroke

### Phase 3: Save / Load / Export
- JSON save/load for character designs
- PNG and SVG export
- Browser localStorage for quick persistence
- File download/upload for portability

### Phase 4: Refinements
- Undo/redo
- Stroke list panel with thumbnails
- Copy stroke params from one stroke to another
- Batch apply: select multiple strokes, adjust together
- Custom pressure curve editor (bezier control points)

---

## Academic Validation

The approach of per-stroke parametric control over centerline-driven rendering sits in a genuine gap in both research and commercial tools. No existing system combines all three elements: structured stroke decomposition, per-stroke parametric control, and an interactive design interface.

### What the literature validates

**Centerline/skeleton-based stroke modeling is well-established.** Xu et al. (2005, "Automatic generation of artistic Chinese calligraphy," IEEE Intelligent Systems) and Wong & Ip (2000, "A model-based approach for the generation and stylization of Chinese calligraphic characters," Journal of Visualization and Computer Animation) both demonstrated that defining strokes as centerline paths with variable-width pressure profiles produces high-quality calligraphic output. The mathematical foundation is sound.

**Per-stroke decomposition improves results.** StrokeGAN (Zeng et al., 2021, AAAI) showed that generating characters stroke-by-stroke, with a discriminator evaluating individual strokes, reduces mode collapse and improves quality over whole-character approaches like zi2zi. This validates that stroke-level granularity matters for quality, not just for user control.

**The stroke data already exists.** Make Me a Hanzi provides median (centerline) data for ~9,500 characters. This is the exact input the rendering engine needs. No stroke extraction step is required.

**METAFONT is the strongest conceptual precedent.** Knuth's METAFONT (1986) demonstrated that parametric, program-driven stroke rendering is both flexible and powerful. Chinese METAFONT efforts (Haralambous, 1990s) showed the approach applies to CJK but revealed that the interface matters as much as the model. A code-based system was too inaccessible. An interactive UI solves this.

### What does not exist yet

**No tool combines structured stroke decomposition + per-stroke parametric control + interactive UI.** The HKU/Peking University research groups (Xu, Pan, Lau) built parametric brush models driven by stroke skeletons, validating the rendering engine concept, but produced research prototypes without polished interactive interfaces. Commercial font editors (Glyphs, FontForge, FontLab) operate at the outline/contour level, not the stroke-semantics level. Deep learning approaches (zi2zi, CalliGAN, DeepVecFont) offer latent-space control rather than direct geometric parameter manipulation.

**The gap is the interactive design layer on top of proven rendering.** The rendering math is validated. The stroke data exists. What is missing is the tool that lets a designer click a stroke, drag a slider, and see the result in real time.

### Key references

| Paper / Project | Year | Relevance |
|---|---|---|
| Xu, Lau, Tang, Pan. "Automatic generation of artistic Chinese calligraphy." IEEE Intelligent Systems | 2005 | Validates centerline + variable-width profile approach |
| Wong & Ip. "A model-based approach for CJK calligraphic characters." J. Vis. Comp. Anim. | 2000 | Early per-stroke parametric model |
| Zeng et al. "StrokeGAN: Reducing Mode Collapse via Stroke-Level Generation." AAAI | 2021 | Validates stroke-level decomposition for quality |
| Wang & Lian. "DeepVecFont: Synthesizing High-quality Vector Fonts." SIGGRAPH Asia | 2021 | Vector font generation, shows per-stroke control gap |
| skishore. Make Me a Hanzi. GitHub | 2016 | Provides the centerline data for ~9,500 characters |
| Knuth. METAFONT. | 1986 | Conceptual precedent for parametric stroke rendering |

### Bottom line

The approach is academically valid. The rendering model is established. The data exists. The gap, an interactive per-stroke design tool, is real and unfilled. Building it is not speculative research. It is engineering a proven approach into an accessible form.

---

## Submission Targets

### Upcoming deadlines (actionable)

| Venue | Deadline | Fit | Notes |
|---|---|---|---|
| **SIGGRAPH Asia 2026** | Abstract May 5, Paper May 12 | Strong | CJK audience, technical papers. Rendering + calligraphy work regularly appears here. Kuala Lumpur, Dec 1-4. |
| **Pacific Graphics 2026** | Abstract Jun 1, Paper Jun 8 | Strong | Asia-focused graphics. Published in Computer Graphics Forum. Singapore, Oct 6-9. |
| **SIGGRAPH 2026 Posters** | Apr 21 | Good for visibility | Short format, lower bar. Los Angeles, Jul 19-23. |
| **C&C 2026 Poster/Demo** | Apr 16 | Good for visibility | Creativity support tools venue. London, Jul 13-16. |
| **CHI 2027** | ~Sep 2026 (est.) | Best for tool + user study | Top HCI venue. Needs user evaluation. Pittsburgh, May 2027. |
| **ATypI Sharjah 2026** | TBA (~mid 2026) | Industry exposure | Theme: "Between: Tradition / Transition / Transformation." Oct 28-31. |

### Journals (rolling submission)

| Journal | Fit | Notes |
|---|---|---|
| **ACM TOG** | Top tier | The standard for graphics. CJK font synthesis papers appear regularly. Also accepts via SIGGRAPH review. |
| **IEEE TVCG** | Strong | Good for rendering + interactive visualization angle. Also accepts via IEEE VIS. |
| **Computers & Graphics** | Solid | Broader scope, good for a focused contribution. |

### Framing by venue

**Graphics venues** (SIGGRAPH Asia, Pacific Graphics, TOG): Frame as a novel parametric stroke rendering system with per-stroke control, validated on CJK characters. Emphasize the rendering pipeline, density-aware scaling, stroke-type classification, and visual quality.

**HCI venues** (CHI, UIST, C&C): Frame as an interactive design tool that fills a gap in creative software for CJK typography. Emphasize the interaction design, per-stroke control workflow, and user evaluation. A user study with type designers or calligraphers would strengthen this framing significantly.

**Typography venues** (ATypI): Frame as a bridge between traditional calligraphy and digital type design. Emphasize the cultural value, the expressiveness beyond static fonts, and practical use for poster/display typography.

### Recommended path

1. **Near-term (Apr-May 2026):** Submit poster to SIGGRAPH 2026 or C&C 2026 for early visibility while the tool is still in development.
2. **Mid-term (May-Jun 2026):** Target SIGGRAPH Asia 2026 or Pacific Graphics 2026 with a full paper on the rendering engine + interactive tool.
3. **Longer-term (Sep 2026):** If a user study is completed by then, submit to CHI 2027 with the full tool + evaluation.
4. **Parallel:** Submit to ACM TOG as a journal paper if the contribution is substantial enough (rendering engine + tool + evaluation).
