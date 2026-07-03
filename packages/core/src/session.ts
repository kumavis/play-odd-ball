import { GEST_DIM_KEYS } from "./gesture/config.js";
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
