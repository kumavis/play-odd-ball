import { GEST_COOLDOWN_DEFAULT, GEST_THRESH_DEFAULT, RAW_N, SEQ_GAP_DEFAULT } from "./config.js";
import { resample, type CropWindow, type FeatureRow } from "./math.js";
import {
  GEST_PALETTE,
  gestureExamples,
  refreshGestureTemplates,
  type Gesture,
  type GestureExample,
} from "./model.js";

/** The compact persisted form of one example. */
export interface SerializedExample {
  crop: CropWindow;
  durMs?: number;
  raw: number[][];
}

/** The compact persisted form of one move (localStorage / profile snapshot). */
export interface SerializedGesture {
  id: string;
  name: string;
  color: string;
  threshold: number;
  thresholdManual: boolean;
  rotInvariant: boolean;
  cooldown: number;
  seqGap: number;
  examples: SerializedExample[];
  counterExamples?: SerializedExample[];
  // Legacy single-example fields (read-only; never written):
  raw?: number[][];
  crop?: CropWindow;
  template?: number[][];
}

/** Compact, serializable form of a set of moves. */
const serializeExample = (ex: { crop: CropWindow; durMs: number | null; raw: number[][] }): SerializedExample => ({
  crop: ex.crop,
  durMs: typeof ex.durMs === "number" ? Math.round(ex.durMs) : undefined,
  raw: ex.raw.map((r) => r.map((v) => +v.toFixed(4))), // round to keep JSON small
});

export function serializeGestures(gestures: Gesture[]): SerializedGesture[] {
  return gestures.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    threshold: g.threshold,
    thresholdManual: !!g.thresholdManual,
    rotInvariant: !!g.rotInvariant,
    cooldown: g.cooldown,
    seqGap: g.seqGap,
    examples: gestureExamples(g).map(serializeExample),
    counterExamples: g.counterExamples?.length ? g.counterExamples.map(serializeExample) : undefined,
  }));
}

/**
 * Rebuild one example ({ raw resampled to RAW_N, clamped crop }) from stored
 * data. Returns null for anything malformed so a bad entry can't break the move.
 */
export function exampleFromData(e: any): GestureExample | null {
  let raw: FeatureRow[] | null = e && Array.isArray(e.raw) ? e.raw : null;
  if (!raw || !raw.length || !Array.isArray(raw[0])) return null;
  raw = resample(raw, RAW_N);
  let crop: CropWindow =
    e.crop && typeof e.crop.start === "number" && typeof e.crop.end === "number"
      ? {
          start: Math.max(0, Math.min(RAW_N - 1, e.crop.start)),
          end: Math.max(0, Math.min(RAW_N - 1, e.crop.end)),
        }
      : { start: 0, end: RAW_N - 1 };
  if (crop.end <= crop.start) crop = { start: 0, end: RAW_N - 1 };
  const durMs = typeof e.durMs === "number" && e.durMs > 0 ? e.durMs : null;
  return { raw, crop, durMs };
}

/**
 * Rebuild a full gesture (with computed templates) from stored/profile data.
 * Returns null for anything malformed so bad entries can never break the app.
 * Understands three formats: the current `examples` array, the previous single
 * `raw` + `crop`, and the oldest template-only capture.
 */
export function gestureFromData(g: any): Gesture | null {
  if (!g) return null;
  let examples: GestureExample[];
  if (Array.isArray(g.examples)) {
    examples = g.examples.map(exampleFromData).filter(Boolean) as GestureExample[];
  } else {
    // Legacy single-example: raw+crop, or the oldest format that only kept the
    // template (treat it as the raw capture).
    const raw = Array.isArray(g.raw) ? g.raw : Array.isArray(g.template) ? g.template : null;
    const one = exampleFromData({ raw, crop: g.crop });
    examples = one ? [one] : [];
  }
  if (!examples.length) return null;
  const out: Gesture = {
    id: String(g.id),
    name: g.name || "Move",
    color: g.color || GEST_PALETTE[0],
    threshold: typeof g.threshold === "number" ? g.threshold : GEST_THRESH_DEFAULT,
    // Entries saved before auto-calibration have no flag; a stored threshold
    // that differs from the old default means the user moved the slider.
    thresholdManual:
      typeof g.thresholdManual === "boolean"
        ? g.thresholdManual
        : typeof g.threshold === "number" && Math.abs(g.threshold - GEST_THRESH_DEFAULT) > 1e-6,
    rotInvariant: !!g.rotInvariant,
    cooldown: typeof g.cooldown === "number" ? g.cooldown : GEST_COOLDOWN_DEFAULT,
    seqGap: typeof g.seqGap === "number" ? g.seqGap : SEQ_GAP_DEFAULT,
    examples,
  };
  if (Array.isArray(g.counterExamples)) {
    const counters = g.counterExamples.map(exampleFromData).filter(Boolean) as GestureExample[];
    if (counters.length) out.counterExamples = counters;
  }
  refreshGestureTemplates(out);
  return out;
}
