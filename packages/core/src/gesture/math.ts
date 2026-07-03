import { DTW_BAND, GEST_N, G_AZ_AMP, SPEED_FEAT_MAX, TURN_MIN_ARC } from "./config.js";

/** One sample of the orientation feature vector (0..1 per dimension). */
export type FeatureRow = number[];

/** Linear-resample a variable-length list of feature rows to exactly N rows. */
export function resample(frames: readonly FeatureRow[], N: number): FeatureRow[] {
  const D = frames.length ? frames[0].length : 3;
  const src = frames.length ? frames : [new Array(D).fill(0)];
  const out: FeatureRow[] = [];
  for (let i = 0; i < N; i++) {
    const pos = src.length === 1 ? 0 : (i / (N - 1)) * (src.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(src.length - 1, lo + 1);
    const f = pos - lo;
    const row = new Array(D);
    for (let d = 0; d < D; d++) row[d] = src[lo][d] * (1 - f) + src[hi][d] * f;
    out.push(row);
  }
  return out;
}

/**
 * Mean-center each dimension (so absolute orientation offset doesn't matter),
 * then divide every dimension by a single shared scale. Per-dimension
 * z-scoring is deliberately avoided: it blows tiny sensor jitter on
 * otherwise-still axes up to full scale and wrecks matching. The shared scale
 * is the RMS of the per-axis spread (root of the mean variance), NOT the
 * single most-active axis — the RMS lets all axes contribute, preserving their
 * relative shape. Operates on a copy so the caller's raw rows stay 0..1.
 */
export function normalizeShared(rows: readonly FeatureRow[]): FeatureRow[] {
  const N = rows.length;
  const D = N ? rows[0].length : 0;
  const out = rows.map((r) => r.slice());
  let sumVar = 0;
  for (let d = 0; d < D; d++) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += out[i][d];
    mean /= N;
    let varr = 0;
    for (let i = 0; i < N; i++) {
      out[i][d] -= mean;
      varr += out[i][d] ** 2;
    }
    varr /= N;
    sumVar += varr;
  }
  const inv = 1 / Math.max(Math.sqrt(sumVar / Math.max(1, D)), 0.02);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) out[i][d] *= inv;
  return out;
}

export const resampleNorm = (frames: readonly FeatureRow[], N: number): FeatureRow[] =>
  normalizeShared(resample(frames, N));

// ---- Orientation-neutral matching (gravity-sphere invariants) --------------
// Per docs/FINDINGS.md the ball is a gravity-only sensor: CC5 encodes tilt
// from vertical and CC3/CC4 encode the lean azimuth. Yaw is physically
// unobservable, so the entire orientation signal is the gravity direction in
// the ball's body frame — a point moving on the unit sphere — and holding the
// ball differently rotates that whole path by one fixed rotation.
// Orientation-neutral matching therefore runs on rotation-invariant properties
// of the sphere path: the relative-speed profile and the signed turning
// profile (geodesic curvature).

/**
 * Map raw 0..1 CC rows [cc3, cc4, cc5] onto unit gravity vectors. Trust CC5
 * for the vertical component and use CC3/CC4 only for the horizontal
 * *direction*, scaled to the radius the vertical leaves — this absorbs the
 * smaller, less certain azimuth gain (~0.35 vs 0.50) and hand jitter near the
 * poles.
 */
export function sphereRows(rows: readonly FeatureRow[]): FeatureRow[] {
  return rows.map((r) => {
    const hx = (r[0] - 0.5) / G_AZ_AMP;
    const hy = (r[1] - 0.5) / G_AZ_AMP;
    const z = Math.max(-1, Math.min(1, 1 - 2 * r[2]));
    const hr = Math.sqrt(Math.max(0, 1 - z * z)); // horizontal radius implied by z
    const hlen = Math.hypot(hx, hy);
    const s = hlen > 0.02 ? hr / hlen : 0;
    const v = [hx * s, hy * s, z];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  });
}

type Vec3 = readonly [number, number, number] | readonly number[];
const vDot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vCross = (a: Vec3, b: Vec3): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vLen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
/** Great-circle angle between unit vectors (stable near 0 and π). */
const arcAngle = (a: Vec3, b: Vec3) => Math.atan2(vLen(vCross(a, b)), vDot(a, b));

export interface InvariantProfile {
  /** GEST_N−2 rows of [relative speed − 1, sin(turn), (1 − cos(turn))/2]. */
  profile: FeatureRow[];
  /** Total great-circle arc length (radians), for the arc gate. */
  arc: number;
}

/**
 * The rotation-invariant profile of one capture (`rows` = raw 0..1 CC rows at
 * any resolution). The turn angle is the signed bend between successive
 * great-circle steps, measured in the tangent plane; encoding it as
 * (sin, 1−cos) keeps the feature continuous through a dead-stop reversal
 * (turn ≈ ±π), where the raw sign is numerically arbitrary, while sin still
 * carries chirality for partial bends (figure-8 lobes).
 */
export function invariantProfile(rows: readonly FeatureRow[]): InvariantProfile {
  const sp = resample(sphereRows(rows), GEST_N).map((v) => {
    const l = vLen(v) || 1; // resampling pulls points off the sphere
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  const N = sp.length;
  const arcs = new Array(N - 1);
  let total = 0;
  for (let i = 0; i + 1 < N; i++) {
    arcs[i] = arcAngle(sp[i], sp[i + 1]);
    total += arcs[i];
  }
  const mean = total / arcs.length || 1e-9;
  const profile: FeatureRow[] = [];
  for (let i = 1; i + 1 < N; i++) {
    const speed = Math.min(SPEED_FEAT_MAX, (arcs[i - 1] + arcs[i]) / 2 / mean - 1);
    let sinT = 0;
    let bowT = 0;
    if (arcs[i - 1] > TURN_MIN_ARC && arcs[i] > TURN_MIN_ARC) {
      const n = sp[i];
      const proj = (p: number[]) => {
        const d = vDot(p, n);
        return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
      };
      const u = proj([n[0] - sp[i - 1][0], n[1] - sp[i - 1][1], n[2] - sp[i - 1][2]]);
      const w = proj([sp[i + 1][0] - n[0], sp[i + 1][1] - n[1], sp[i + 1][2] - n[2]]);
      if (vLen(u) > 1e-9 && vLen(w) > 1e-9) {
        const turn = Math.atan2(vDot(n, vCross(u, w)), vDot(u, w));
        sinT = Math.sin(turn);
        bowT = (1 - Math.cos(turn)) / 2;
      }
    }
    profile.push([speed, sinT, bowT]);
  }
  return { profile, arc: total };
}

/**
 * DTW distance between two normalized sequences. Local cost is Euclidean
 * distance scaled by sqrt(D); result is divided by the candidate length so the
 * returned number is an average per-step distance (dimension-agnostic).
 *
 * A Sakoe-Chiba band constrains warping to cells within DTW_BAND of the
 * diagonal. Without it, two genuinely different gestures can be stretched into
 * alignment (false positives); the band also skips most of the cost matrix.
 */
export function dtwDist(a: readonly FeatureRow[], b: readonly FeatureRow[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;
  const D = a[0].length;
  const invD = 1 / Math.sqrt(D);
  const INF = Infinity;
  const band = Math.max(1, Math.round(Math.max(n, m) * DTW_BAND));
  let prev = new Array(m + 1).fill(INF);
  let cur = new Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    // Reset the row so cells outside this row's band stay unreachable (INF)
    // instead of holding stale values from two rows back (arrays are swapped).
    cur.fill(INF);
    // Center the band on the diagonal, scaled in case the lengths differ.
    const center = Math.round((i * m) / n);
    const jlo = Math.max(1, center - band);
    const jhi = Math.min(m, center + band);
    for (let j = jlo; j <= jhi; j++) {
      let s = 0;
      for (let d = 0; d < D; d++) {
        const diff = a[i - 1][d] - b[j - 1][d];
        s += diff * diff;
      }
      const cost = Math.sqrt(s) * invD;
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / n;
}

export interface CropWindow {
  start: number;
  end: number;
}

/**
 * Find the active span of a raw capture using a scale-free activity measure
 * (per-step change smoothed, thresholded relative to its own peak) so "cut
 * silence" works regardless of how hard the move was.
 */
export function autoTrim(raw: readonly FeatureRow[]): CropWindow {
  const n = raw.length;
  if (n < 4) return { start: 0, end: n - 1 };
  const act = new Array(n).fill(0);
  let ema = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    if (i) for (let d = 0; d < raw[i].length; d++) s += Math.abs(raw[i][d] - raw[i - 1][d]);
    ema = ema * 0.6 + s * 0.4;
    act[i] = ema;
    if (ema > peak) peak = ema;
  }
  const thresh = Math.max(peak * 0.14, 1e-4);
  let start = 0;
  let end = n - 1;
  while (start < n && act[start] < thresh) start++;
  // Nothing cleared the threshold (a flat capture): keep the full span. The
  // original app let `start` run past `end` here, which cropped a flat capture
  // to its last few samples (see docs/CONVERSION-NOTES.md).
  if (start >= n) return { start: 0, end: n - 1 };
  while (end > start && act[end] < thresh) end--;
  const pad = Math.round(n * 0.04);
  start = Math.max(0, start - pad);
  end = Math.min(n - 1, end + pad);
  if (end - start < 2) return { start: 0, end: n - 1 };
  return { start, end };
}
