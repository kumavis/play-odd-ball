import { CC_ORIENT_X, CC_ORIENT_Y, CC_ORIENT_Z } from "../midi/constants.js";

// A gesture is recognized from the ball's ORIENTATION trajectory only: the
// X/Y/Z axes (CC3/4/5, see docs/MIDI.md). Those trace a smooth, repeatable path
// through a move, which is exactly what DTW template-matching needs.
//
// The other CCs — Shake (CC0), Twist (CC1), Freefall (CC2), Movement (CC6) —
// are event/intensity signals, not pose. Feeding them into the matcher adds
// run-to-run noise and lets their large swings crush the discriminative
// orientation axes under the shared normalization scale.
export const GEST_DIMS = [CC_ORIENT_X, CC_ORIENT_Y, CC_ORIENT_Z] as const;
/** The session-file keys those dims are stored under, in the same order. */
export const GEST_DIM_KEYS = ["tilt_x", "tilt_y", "tilt_z"] as const;

export const GEST_N = 32; // template length after resampling
export const DTW_BAND = 0.15; // Sakoe-Chiba radius as a fraction of length
export const RAW_N = 96; // stored raw resolution (for editing/crop)
export const GEST_ACT_TAU = 0.15; // s; smoothing for the activity signal

// Segmenter thresholds. A "move" is a burst of motion bracketed by stillness;
// activity is Σ|Δfeat|/s, i.e. how FAST the orientation is changing (a still
// ball held at any angle reads ~0).
export const SEG_START = 4.0; // activity that begins a move
export const SEG_END = 1.4; // activity under which the ball is "still"
export const SEG_HOLD = 400; // ms below SEG_END that ends a move
export const SEG_TAIL = 120; // ms of trailing stillness kept in a move
export const SEG_EARLY_MS = SEG_TAIL; // stillness before an early match attempt
export const SEG_PREROLL = 320; // ms of pre-motion frames folded into a move
export const SEG_MIN_MS = 260; // ignore twitches shorter than this
export const SEG_MAX = 4000; // ms cap on a single move
// A segment only *starts* above SEG_START, so it always peaks at >= SEG_START.
// Requiring a clearly higher peak before we accept the move rejects borderline
// drift/jitter that grazes the start threshold and then fades.
export const SEG_PEAK_MIN = 6.0; // peak activity a real move must reach

// Import-time segmentation floor: the ~20 Hz session recorder undersamples the
// ~58 frames/s live stream 3–4× (docs/FINDINGS.md), which shrinks measured
// path length — so imports scale the live thresholds toward the recording's
// own peak, floored here so a stillness recording isn't carved into garbage.
export const SEG_IMPORT_FLOOR = 0.8; // min start activity; D2 hand-tremor peaks ~0.3

export const HIST_MS = 4000; // per-device feature-history buffer length

// Matching.
export const GEST_MARGIN = 0.05; // winner must beat runner-up by this much
export const GEST_DUR_RATIO = 2; // duration gate looseness (see durationOk)
export const GEST_ARC_RATIO = 2; // arc gate looseness (see arcOk)
export const GEST_ATTEMPTS_MAX = 12; // per-move attempt ring buffer (debug UI)

// Turning is only meaningful while the path is actually moving; below this
// step length (radians) the direction is sensor noise and the turn reads 0.
export const TURN_MIN_ARC = 0.01;
// Cap the relative-speed feature so a single dropped-frame step can't dominate.
export const SPEED_FEAT_MAX = 3;
// Fitted transfer function (docs/FINDINGS.md): CC3/CC4 azimuth gain.
export const G_AZ_AMP = 0.35;

// Default match threshold (avg per-step DTW distance). Lower = stricter.
export const GEST_THRESH_MIN = 0.15;
export const GEST_THRESH_MAX = 1.1;
export const GEST_THRESH_DEFAULT = 0.55;

export const GEST_COOLDOWN_DEFAULT = 500; // ms between fires of one move
export const SEQ_GAP_DEFAULT = 130; // ms between steps of a movement's chain

/** Map a 0..100 UI "sensitivity" onto a match threshold (and back). */
export const sensToThresh = (s: number): number =>
  GEST_THRESH_MIN + (s / 100) * (GEST_THRESH_MAX - GEST_THRESH_MIN);
export const threshToSens = (t: number): number =>
  Math.round(((t - GEST_THRESH_MIN) / (GEST_THRESH_MAX - GEST_THRESH_MIN)) * 100);
