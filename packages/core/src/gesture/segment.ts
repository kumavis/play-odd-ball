import {
  GEST_ACT_TAU,
  SEG_END,
  SEG_HOLD,
  SEG_IMPORT_FLOOR,
  SEG_MAX,
  SEG_MIN_MS,
  SEG_PEAK_MIN,
  SEG_PREROLL,
  SEG_START,
} from "./config.js";
import type { FeatureRow } from "./math.js";

/** A timestamped feature frame (t in ms, feat = 0..1 rows). */
export interface FeatureFrame {
  t: number;
  feat: FeatureRow;
}

export interface MoveRegion {
  rows: FeatureRow[];
  durMs: number;
}

/**
 * Split a recorded session into EVERY distinct move it contains — so recording
 * the move several times (with a pause between reps) yields one example per
 * rep. Falls back to the file's single active span when no clean bursts are
 * found, so a lone continuous move still imports.
 *
 * Thresholds are the LIVE segmenter's, tightened toward the recording's own
 * peak when that peak is lower: the ~20 Hz session recorder undersamples the
 * ~58 frames/s live stream 3–4× (docs/FINDINGS.md), which shrinks the measured
 * path length and with it the absolute activity. The absolute floor keeps a
 * stillness recording from being carved into garbage "reps".
 */
export function activeRegions(frames: FeatureFrame[]): MoveRegion[] {
  const n = frames.length;
  if (n < 6) return [];
  // Smoothed per-frame activity (framerate-independent), mirroring the live path.
  const act = new Array(n).fill(0);
  let ema = 0;
  let peakAll = 0;
  for (let i = 0; i < n; i++) {
    const dt = i ? Math.max(0.001, (frames[i].t - frames[i - 1].t) / 1000) : 0.05;
    let speed = 0;
    if (i) {
      let s = 0;
      for (let d = 0; d < frames[i].feat.length; d++) s += Math.abs(frames[i].feat[d] - frames[i - 1].feat[d]);
      speed = s / dt;
    }
    ema += (speed - ema) * (1 - Math.exp(-dt / GEST_ACT_TAU));
    act[i] = ema;
    if (ema > peakAll) peakAll = ema;
  }
  const startThr = Math.min(SEG_START, Math.max(SEG_IMPORT_FLOOR, peakAll * 0.35));
  const endThr = Math.min(SEG_END, Math.max(SEG_IMPORT_FLOOR * 0.35, peakAll * 0.12));
  const peakMin = Math.min(SEG_PEAK_MIN, Math.max(SEG_IMPORT_FLOOR * 1.5, peakAll * 0.5));
  const regions: MoveRegion[] = [];
  let i = 0;
  while (i < n) {
    if (act[i] <= startThr) {
      i++;
      continue;
    }
    const startT = frames[i].t;
    let lastActive = frames[i].t;
    let peak = act[i];
    let j = i;
    for (; j < n; j++) {
      if (act[j] > endThr) lastActive = frames[j].t;
      if (act[j] > peak) peak = act[j];
      if (frames[j].t - lastActive > SEG_HOLD || frames[j].t - startT > SEG_MAX) break;
    }
    const lo = startT - SEG_PREROLL;
    const hi = lastActive + 120;
    const rows = frames.filter((f) => f.t >= lo && f.t <= hi).map((f) => f.feat);
    const durMs = lastActive - startT;
    if (rows.length >= 6 && durMs >= SEG_MIN_MS && peak >= peakMin) regions.push({ rows, durMs });
    // Advance past the rest of this burst before scanning for the next start.
    i = j + 1;
    while (i < n && act[i] > endThr) i++;
  }
  if (!regions.length && peakAll > SEG_IMPORT_FLOOR) {
    // No clean bursts but real motion exists: import the file's single active
    // span (idle head/tail trimmed) so a continuous move still comes through.
    let firstT: number | null = null;
    let lastT: number | null = null;
    for (let k = 0; k < n; k++) {
      if (act[k] > endThr) {
        if (firstT === null) firstT = frames[k].t;
        lastT = frames[k].t;
      }
    }
    if (firstT !== null && lastT !== null) {
      const lo = firstT - SEG_PREROLL;
      const hi = lastT + 120;
      const rows = frames.filter((f) => f.t >= lo && f.t <= hi).map((f) => f.feat);
      if (rows.length >= 6) regions.push({ rows, durMs: lastT - firstT });
    }
  }
  return regions;
}
