// Rolling detection: accumulate absolute change of the ORIENTATION CCs (3-5)
// between frames, then smooth into a 0..1 "speed". Measured on the device:
// idle sensor jitter is ~200-475 units/sec even when still, active rolling is
// ~900-1300/sec — so we gate above the idle floor and only report intensity
// when it's really rolling.

export interface RollSnapshot {
  /** Smoothed CC-units/sec on the orientation channels. */
  rate: number;
  /** Ungated normalized rate (0..1) for meters. */
  raw: number;
  /** Final gated 0..1 intensity. */
  speed: number;
}

export class RollTracker {
  /** CC units/sec that maps to full intensity. */
  scale = 1300;
  /** Fraction of `scale` below which it's silent. */
  gate = 0.5;
  /** Seconds; smoothing time-constant for the rate. */
  tau = 0.22;

  private accum = 0;
  rate = 0;
  raw = 0;
  speed = 0;

  /** Add one message's absolute orientation-CC delta (raw CC units). */
  addDelta(delta: number): void {
    this.accum += delta;
  }

  reset(): void {
    this.accum = 0;
    this.rate = 0;
    this.raw = 0;
    this.speed = 0;
  }

  /**
   * Advance by one frame. `deviceCount` averages the accumulated motion so
   * binding N balls doesn't inflate the rate N-fold; pass the number of
   * devices that have actually sent CCs (a silent extra input must not halve
   * the rate and effectively raise the gate on the one ball really rolling).
   */
  tick(dt: number, deviceCount = 1): RollSnapshot {
    const nDev = Math.max(1, deviceCount);
    const changePerSec = this.accum / nDev / dt;
    this.accum = 0;
    // The ball sends its CCs in tight bursts, so the per-frame rate is very
    // spiky. A time-weighted EMA (framerate-independent) reflects the true
    // average so idle jitter can't spike the output.
    const a = 1 - Math.exp(-dt / this.tau);
    this.rate += (changePerSec - this.rate) * a;
    this.raw = Math.min(1, this.rate / this.scale);
    // Gate out idle drift: below gate -> silent, then remap the rest 0..1.
    this.speed = this.raw <= this.gate ? 0 : (this.raw - this.gate) / (1 - this.gate);
    return { rate: this.rate, raw: this.raw, speed: this.speed };
  }
}

/**
 * Map a single 0..100 "sensitivity" onto the roll gate + scale: higher
 * sensitivity means a lower threshold and less motion needed to reach full
 * intensity.
 */
export function rollSensitivity(pct: number): { gate: number; scale: number } {
  const s = Math.max(0, Math.min(1, pct / 100));
  return {
    gate: 0.72 - 0.5 * s, // ~0.72 (hard) -> ~0.22 (easy)
    scale: 1800 - 1050 * s, // ~1800/sec -> ~750/sec to hit full
  };
}

// Motion energy = how fast the orientation is changing (a velocity), NOT how
// far the ball is tilted. This scale maps a vigorous move to ~1.0 while a
// still ball (held at any angle) reads near 0.
export const MOTION_SCALE = 7.0;

/** Normalize a gesture-activity reading (Σ|Δfeat|/s) to 0..1 motion energy. */
export const motionEnergy = (activity: number): number =>
  Math.max(0, Math.min(1, activity / MOTION_SCALE));
