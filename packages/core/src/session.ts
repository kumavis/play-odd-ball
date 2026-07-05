import { GEST_DIM_KEYS, GEST_DIMS } from "./gesture/config.js";
import type { FeatureFrame } from "./gesture/segment.js";

/** A ~20 Hz value-snapshot session file (the web app's ⏺ Record button). */
export interface SessionFile {
  recorded?: string;
  durationMs?: number;
  params?: { key: string; label: string }[];
  samples: { t: number; values: Record<string, number> }[];
}

/** A full-rate raw MIDI capture (the web app's ⏺ Raw button / listen.py --raw). */
export interface RawCaptureFile {
  recorded?: string;
  durationMs?: number;
  format: "oddball-raw-midi-1";
  note?: string;
  messages: { t: number; dev: string; status: number; d1: number | null; d2: number | null }[];
}

export function isRawCapture(data: unknown): data is RawCaptureFile {
  return !!data && typeof data === "object" && (data as any).format === "oddball-raw-midi-1";
}

/**
 * Rebuild orientation feature frames from a recorded session's samples so its
 * moves can be re-segmented (see activeRegions) and turned into gesture
 * examples. Returns null when the file has no usable samples.
 */
export function sessionFeatureFrames(data: unknown): FeatureFrame[] | null {
  const samples = data && (data as SessionFile).samples;
  if (!Array.isArray(samples) || samples.length < 4) return null;
  return samples.map((s) => ({
    t: typeof s.t === "number" ? s.t : 0,
    feat: GEST_DIM_KEYS.map((k) => {
      const v = s.values && s.values[k];
      return typeof v === "number" ? v : 0;
    }),
  }));
}

/**
 * Rebuild orientation feature frames from a raw MIDI capture (the ⏺ Raw
 * button / listen.py --raw) — the full-rate sibling of sessionFeatureFrames,
 * free of the ~20 Hz session recorder's aliasing. Carries each orientation
 * CC's last value forward and emits one frame per orientation message; frames
 * start once all three axes have reported so a partial initial pose can't
 * read as a huge fake jump. Returns null when the file has no usable frames.
 */
export function rawCaptureFeatureFrames(data: unknown): FeatureFrame[] | null {
  if (!isRawCapture(data) || !Array.isArray(data.messages)) return null;
  const vals = [0, 0, 0];
  let seen = 0;
  const frames: FeatureFrame[] = [];
  for (const m of data.messages) {
    if (!m || typeof m.t !== "number" || (m.status & 0xf0) !== 0xb0) continue;
    const dim = GEST_DIMS.indexOf((m.d1 ?? -1) as (typeof GEST_DIMS)[number]);
    if (dim === -1 || typeof m.d2 !== "number") continue;
    vals[dim] = m.d2 / 127;
    seen |= 1 << dim;
    if (seen === 7) frames.push({ t: m.t, feat: vals.slice() });
  }
  return frames.length >= 4 ? frames : null;
}
