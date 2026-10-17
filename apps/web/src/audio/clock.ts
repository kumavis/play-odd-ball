// Shared tempo clock for the tempo-locked (psytrance) instruments.
//
// Every clocked voice derives its grid from ONE origin on the AudioContext
// timeline, so a kick, a rolling bass and an arp patched at different moments
// still land on the same 16th notes. Steps are scheduled slightly ahead of the
// audio clock (LOOKAHEAD) from the animation loop, which keeps them
// sample-accurate even when requestAnimationFrame jitters — and on phones it
// jitters a lot.

export const BPM_MIN = 60;
export const BPM_MAX = 200;
export const BPM_DEFAULT = 145; // classic full-on psytrance tempo
export const STEPS_PER_BEAT = 4; // the grid is 16th notes
/** How far ahead of the audio clock steps are scheduled (seconds). */
export const LOOKAHEAD = 0.12;
/** A cursor this far behind the audio clock resyncs instead of catching up. */
const MAX_LAG = 0.05;
/** Upper bound on steps one call may schedule (guards a stalled clock). */
const MAX_BURST = 32;

export const clampBpm = (bpm: number): number =>
  Number.isFinite(bpm) ? Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm))) : BPM_DEFAULT;

export class TempoClock {
  bpm = BPM_DEFAULT;
  /** Audio time of step 0. */
  origin = 0;

  /** Length of one 16th-note step in seconds. */
  get stepDur(): number {
    return 60 / this.bpm / STEPS_PER_BEAT;
  }

  timeOf(step: number): number {
    return this.origin + step * this.stepDur;
  }

  /** Fractional step position at audio time `t`. */
  position(t: number): number {
    return (t - this.origin) / this.stepDur;
  }

  /** First whole step that starts at or after `t`. */
  stepAtOrAfter(t: number): number {
    return Math.ceil(this.position(t) - 1e-9) || 0; // || 0: no -0 at the origin
  }

  /** Change tempo without a jump: the step position at `now` is preserved, so
   * every voice's pending step index stays valid across the change. */
  setBpm(bpm: number, now: number): void {
    const next = clampBpm(bpm);
    if (next === this.bpm) return;
    const pos = this.position(now);
    this.bpm = next;
    this.origin = now - pos * this.stepDur;
  }
}

/** A voice's position on the shared grid: the next step it hasn't scheduled. */
export interface StepCursor {
  next: number | null;
}

/**
 * The steps a voice should schedule now: every step from its cursor up to
 * `now + lookahead`, advancing the cursor past them. A cursor that is unset or
 * has fallen behind (audio was suspended, the tab slept) resyncs to the next
 * step instead of replaying the backlog in one burst.
 */
export function dueSteps(
  clock: TempoClock,
  cursor: StepCursor,
  now: number,
  lookahead = LOOKAHEAD
): { step: number; time: number }[] {
  if (cursor.next === null || clock.timeOf(cursor.next) < now - MAX_LAG) cursor.next = clock.stepAtOrAfter(now);
  const out: { step: number; time: number }[] = [];
  const horizon = now + lookahead;
  while (clock.timeOf(cursor.next) < horizon && out.length < MAX_BURST) {
    out.push({ step: cursor.next, time: Math.max(now, clock.timeOf(cursor.next)) });
    cursor.next++;
  }
  return out;
}
