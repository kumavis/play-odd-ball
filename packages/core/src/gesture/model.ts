import {
  GEST_ARC_RATIO,
  GEST_COOLDOWN_DEFAULT,
  GEST_DUR_RATIO,
  GEST_N,
  GEST_THRESH_DEFAULT,
  GEST_THRESH_MAX,
  GEST_THRESH_MIN,
  RAW_N,
  SEQ_GAP_DEFAULT,
} from "./config.js";
import {
  autoTrim,
  dtwDist,
  invariantProfile,
  resample,
  resampleNorm,
  type CropWindow,
  type FeatureRow,
  type InvariantProfile,
} from "./math.js";

/** One real capture of a performance: raw 0..1 rows plus its crop window. */
export interface GestureExample {
  raw: FeatureRow[]; // resampled to RAW_N so storage is bounded
  crop: CropWindow;
  durMs: number | null;
}

/** A raw capture as it comes out of the segmenter / an imported region. */
export interface ExampleCapture {
  rows: FeatureRow[];
  durMs?: number | null;
}

export type AttemptOutcome =
  | "fired"
  | "lost"
  | "ambiguous"
  | "far"
  | "counter"
  | "gate-duration"
  | "gate-arc";

/** One scored recognition attempt, kept per move for the editor's debugger. */
export interface GestureAttempt {
  t: number;
  d: number;
  dAxis: number;
  arc: number;
  durMs: number;
  threshold: number;
  outcome: AttemptOutcome;
  /** For "lost"/"ambiguous": the name of the move this one tied with or lost to. */
  rival?: string;
  /** For "counter": distance to the counter-example that vetoed the match. */
  dCounter?: number;
}

/**
 * A "move": a named gesture built from one or more real example captures,
 * with derived template sets (recomputed via refreshGestureTemplates, never
 * persisted) and per-move trigger tuning.
 */
export interface Gesture {
  id: string;
  name: string;
  color: string;
  /** Match threshold (avg per-step DTW distance). Lower = stricter. */
  threshold: number;
  /** True once the user has moved the sensitivity slider by hand. */
  thresholdManual?: boolean;
  /** Opt out of grip-direction tiebreaking (move performed in varying grips). */
  rotInvariant?: boolean;
  cooldown: number;
  seqGap: number;
  examples: GestureExample[];
  /**
   * Counter-examples: real captures that must NOT fire this move (near-miss
   * motions that kept misfiring). A candidate whose invariant-profile distance
   * to a counter-example is within GEST_MARGIN of its distance to the real
   * examples is vetoed — between "the move" and "explicitly not the move", a
   * near-tie must not fire.
   */
  counterExamples?: GestureExample[];

  // ---- Derived (rebuilt from examples; not serialized) ----
  /** Legacy single template (first example), kept for compatibility. */
  template?: FeatureRow[] | null;
  /** Axis-locked (grip-dependent) templates for direction tiebreaks. */
  templates?: FeatureRow[][];
  /** Orientation-neutral invariant profiles — the primary match set. */
  invTemplates?: InvariantProfile[];
  /** Each example's as-cropped arc (radians) — the arc gate's reference. */
  exampleArcs?: number[];
  /** Invariant profiles of the counter-examples (the veto set). */
  invCounterTemplates?: InvariantProfile[];
  /** Leave-one-out fit per example (see looFits). */
  _exFit?: (number | null)[] | null;

  // ---- Live diagnostics (UI only; not serialized) ----
  _dist?: number;
  _distAxis?: number;
  _attempts?: GestureAttempt[];
}

export const GEST_PALETTE = ["#ff8fab", "#ffd166", "#8ec5ff", "#c792ea", "#7cffcb", "#ff9f6b", "#f871ff"];

/** Build a stored example from a raw capture (resample + auto-crop). */
export function makeExample(ex: ExampleCapture): GestureExample {
  const raw = resample(ex.rows, RAW_N);
  return {
    raw,
    crop: autoTrim(raw),
    durMs: typeof ex.durMs === "number" && ex.durMs > 0 ? ex.durMs : null,
  };
}

/** Coerce whatever is stored on a gesture into a clean, non-empty examples list. */
export function gestureExamples(g: Gesture | null | undefined): GestureExample[] {
  return g && Array.isArray(g.examples) && g.examples.length ? g.examples : [];
}

export function makeTemplate(raw: FeatureRow[], crop: CropWindow): FeatureRow[] {
  const a = raw.slice(crop.start, crop.end + 1);
  return resampleNorm(a.length >= 2 ? a : raw, GEST_N);
}

/**
 * A few crop windows around an example's crop: as-cropped, looser (more
 * silence on both ends), tighter (core only), and — when `wide` — shifted to
 * keep more head or tail. Recognition takes the best (minimum) distance across
 * every window's template, so a performance with slightly more/less lead-in or
 * follow-through still registers. When a move has several real examples the
 * extra head/tail windows add little, so `wide` is dropped to bound the
 * template count.
 */
export function cropWindows(n: number, crop: CropWindow, wide: boolean): [number, number][] {
  const span = Math.max(2, crop.end - crop.start);
  const p = (f: number) => Math.round(span * f);
  const windows = wide
    ? [
        [crop.start, crop.end], // as cropped
        [crop.start - p(0.22), crop.end + p(0.22)], // looser (keep more silence)
        [crop.start + p(0.15), crop.end - p(0.15)], // tighter (core only)
        [crop.start, crop.end + p(0.35)], // keep more follow-through
        [crop.start - p(0.35), crop.end], // keep more wind-up
      ]
    : [
        [crop.start, crop.end], // as cropped
        [crop.start - p(0.22), crop.end + p(0.22)], // looser
        [crop.start + p(0.15), crop.end - p(0.15)], // tighter
      ];
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (let [s, e] of windows) {
    s = Math.max(0, Math.min(n - 3, s));
    e = Math.max(s + 2, Math.min(n - 1, e));
    const key = s + "-" + e;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([s, e]);
    }
  }
  return out;
}

/** Axis-locked (grip-dependent) template set: pooled crop-variant normalized CC trajectories. */
export function buildTemplates(examples: GestureExample[]): FeatureRow[][] {
  const wide = examples.length <= 1;
  const out: FeatureRow[][] = [];
  for (const ex of examples) {
    if (!ex || !Array.isArray(ex.raw) || ex.raw.length < 2) continue;
    for (const [s, e] of cropWindows(ex.raw.length, ex.crop, wide)) {
      out.push(resampleNorm(ex.raw.slice(s, e + 1), GEST_N));
    }
  }
  return out;
}

/** Orientation-neutral template set: crop-variant invariant profiles. The primary match set. */
export function buildInvTemplates(examples: GestureExample[]): InvariantProfile[] {
  const wide = examples.length <= 1;
  const out: InvariantProfile[] = [];
  for (const ex of examples) {
    if (!ex || !Array.isArray(ex.raw) || ex.raw.length < 2) continue;
    for (const [s, e] of cropWindows(ex.raw.length, ex.crop, wide)) {
      out.push(invariantProfile(ex.raw.slice(s, e + 1)));
    }
  }
  return out;
}

/** Best (minimum) DTW distance of a candidate against a set of templates. */
export function bestTemplateDist(cand: FeatureRow[], templates: FeatureRow[][]): number {
  let best = Infinity;
  for (const t of templates) {
    const d = dtwDist(cand, t);
    if (d < best) best = d;
  }
  return best;
}

const bestInvDist = (profile: FeatureRow[], templates: InvariantProfile[]): number => {
  let best = Infinity;
  for (const t of templates) {
    const d = dtwDist(profile, t.profile);
    if (d < best) best = d;
  }
  return best;
};

/**
 * Distance of one invariant-profile candidate against one move (best/min over
 * the crop-variant templates of every example). Median-over-examples
 * aggregation was prototyped as a false-positive reducer and measured
 * end-to-end against the recordings in data/ — it shuffled errors around
 * without beating this scoring once threshold auto-calibration adapted; see
 * docs/IMPLEMENTATION-REVIEW.md before re-attempting.
 */
export function invGestureDist(profile: FeatureRow[], g: Gesture): number {
  return bestInvDist(profile, g.invTemplates || []);
}

/**
 * Distance of one invariant-profile candidate against a move's
 * counter-examples. Infinity when the move has none.
 */
export function counterGestureDist(profile: FeatureRow[], g: Gesture): number {
  let best = Infinity;
  for (const t of g.invCounterTemplates || []) {
    const d = dtwDist(profile, t.profile);
    if (d < best) best = d;
  }
  return best;
}

/** Distance of one axis-locked candidate against one move. */
export function axisGestureDist(norm: FeatureRow[], g: Gesture): number {
  const ts = g.templates && g.templates.length ? g.templates : g.template ? [g.template] : [];
  return bestTemplateDist(norm, ts);
}

/**
 * Leave-one-out fit per example: how far each real capture lands from the
 * templates built from the OTHER examples. Powers threshold auto-calibration
 * and the per-example badges in the editor. Null when there are fewer than
 * two examples.
 */
export function looFits(exs: GestureExample[]): (number | null)[] | null {
  if (exs.length < 2) return null;
  return exs.map((ex, i) => {
    const a = ex.raw.slice(ex.crop.start, ex.crop.end + 1);
    const probe = invariantProfile(a.length >= 2 ? a : ex.raw).profile;
    const others = exs.filter((_, j) => j !== i);
    const fit = bestInvDist(probe, buildInvTemplates(others));
    return Number.isFinite(fit) ? fit : null;
  });
}

/**
 * With two or more real examples we can measure the move's own run-to-run
 * spread and set the threshold a comfortable margin above it: 1.6× the mean
 * spread, or 1.2× the worst rep if larger. Null when it can't be measured.
 */
export function autoThreshold(g: Gesture): number | null {
  const dists = (g._exFit || []).filter((d): d is number => typeof d === "number");
  if (!dists.length) return null;
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  const worst = Math.max(...dists);
  return Math.min(GEST_THRESH_MAX, Math.max(GEST_THRESH_MIN, Math.max(mean * 1.6, worst * 1.2)));
}

/**
 * Recompute a gesture's derived templates from its current examples (call
 * after adding, deleting, or re-cropping an example) and — unless the user has
 * taken manual control of the slider — recalibrate its match threshold.
 */
export function refreshGestureTemplates(g: Gesture): void {
  const exs = gestureExamples(g);
  g.template = exs.length ? makeTemplate(exs[0].raw, exs[0].crop) : null;
  g.templates = buildTemplates(exs);
  g.invTemplates = buildInvTemplates(exs);
  g.exampleArcs = exs.map((ex) => {
    const a = ex.raw.slice(ex.crop.start, ex.crop.end + 1);
    return invariantProfile(a.length >= 2 ? a : ex.raw).arc;
  });
  g.invCounterTemplates = g.counterExamples?.length ? buildInvTemplates(g.counterExamples) : [];
  g._exFit = looFits(exs);
  const auto = autoThreshold(g);
  if (auto !== null && !g.thresholdManual) g.threshold = auto;
}

/**
 * DTW plus fixed-length resampling deliberately erase tempo — but that means a
 * slow sweep and a quick flick with the same shape are otherwise identical.
 * Compare the candidate's wall-clock duration against the range seen across
 * the move's examples; the factor is loose (2×) since DTW already absorbs
 * local timing and honest reps vary. Examples saved before durations were
 * recorded have none, so legacy moves skip the gate.
 */
export function durationOk(g: Gesture, durMs: number): boolean {
  if (!(durMs > 0)) return true;
  const durs = gestureExamples(g)
    .map((ex) => ex.durMs)
    .filter((d): d is number => typeof d === "number" && d > 0);
  if (!durs.length) return true;
  return durMs >= Math.min(...durs) / GEST_DUR_RATIO && durMs <= Math.max(...durs) * GEST_DUR_RATIO;
}

/**
 * Arc gate — the invariant twin of the duration gate. The total great-circle
 * arc a move sweeps is rotation-invariant and strongly discriminative, and the
 * relative-speed profile would otherwise erase it. A near-zero arc
 * (stillness/jitter) must FAIL here, not skip the gate — the relative-speed
 * profile of noise can land eerily close to a real move's.
 */
export function arcOk(g: Gesture, arc: number): boolean {
  if (!Number.isFinite(arc)) return true;
  // Gate against the examples' own as-cropped arcs. The crop-variant template
  // arcs (tighter crops shrink the arc, looser ones grow it) inflated an
  // already-loose ±GEST_ARC_RATIO band well past the real example spread.
  const arcs = (g.exampleArcs?.length ? g.exampleArcs : (g.invTemplates || []).map((t) => t.arc)).filter((a) => a > 0);
  if (!arcs.length) return true;
  return arc >= Math.min(...arcs) / GEST_ARC_RATIO && arc <= Math.max(...arcs) * GEST_ARC_RATIO;
}

let gestureIdCounter = 0;

/** Create a move from one or more example captures. */
export function createGesture(
  name: string | null | undefined,
  exampleCaptures: ExampleCapture[],
  existingCount: number
): Gesture {
  const examples = exampleCaptures.map(makeExample);
  const g: Gesture = {
    // Original used Date.now() alone; a same-millisecond double save produced
    // colliding ids (documented in docs/CONVERSION-NOTES.md) — add a counter.
    id: "g" + Date.now().toString(36) + (gestureIdCounter++ ? "-" + gestureIdCounter.toString(36) : ""),
    name: name || `Move ${existingCount + 1}`,
    color: GEST_PALETTE[existingCount % GEST_PALETTE.length],
    threshold: GEST_THRESH_DEFAULT,
    cooldown: GEST_COOLDOWN_DEFAULT,
    seqGap: SEQ_GAP_DEFAULT,
    examples,
  };
  refreshGestureTemplates(g);
  return g;
}
