import {
  GEST_ACT_TAU,
  GEST_ATTEMPTS_MAX,
  GEST_MARGIN,
  GEST_N,
  HIST_MS,
  SEG_EARLY_MS,
  SEG_END,
  SEG_HOLD,
  SEG_MAX,
  SEG_MIN_MS,
  SEG_PEAK_MIN,
  SEG_PREROLL,
  SEG_START,
  SEG_TAIL,
} from "./config.js";
import { invariantProfile, resampleNorm, type FeatureRow } from "./math.js";
import {
  arcOk,
  axisGestureDist,
  counterGestureDist,
  durationOk,
  gestureExamples,
  invGestureDist,
  type AttemptOutcome,
  type ExampleCapture,
  type Gesture,
  type GestureAttempt,
} from "./model.js";
import type { FeatureFrame } from "./segment.js";

interface Segment {
  frames: FeatureFrame[];
  peak: number;
  fired: boolean;
  triedUpTo: number;
}

/**
 * Per-device gesture pipeline. Each ball gets its own feature stream, activity
 * signal, history buffer and segmenter — the cross-device CC average is fine
 * for sound routing, but a blended pose from two balls is meaningless for
 * recognition, and a second (even still) controller would dilute the first
 * one's motion. A pipe's featAccum gathers orientation path length from EVERY
 * message (drained each frame) so fast motion keeps reading faster instead of
 * aliasing at the frame rate.
 */
export interface GesturePipe {
  featAccum: number;
  activity: number;
  hist: FeatureFrame[];
  seg: Segment | null;
  segLastActive: number;
}

export interface RecognizerEvents {
  /** A move matched and passed its cooldown. */
  fired: (g: Gesture, dist: number) => void;
  /** A near-tie between two moves that could not be tiebroken (nothing fired). */
  ambiguous: (best: { g: Gesture; d: number }, second: { g: Gesture; d: number }) => void;
  /** A burst was captured while a recording is armed. */
  exampleCaptured: (count: number) => void;
  /** A completed motion segment was scored against every move (attempt buffers updated). */
  attempt: () => void;
}

export interface RecordingSession {
  name: string | null;
  /** When set, captured examples are meant to reinforce an existing move. */
  targetId: string | null;
  /** "example" (default) reinforces a move; "counter" captures counter-examples. */
  kind: "example" | "counter";
  examples: ExampleCapture[];
}

/** A recently completed motion segment, kept so the UI can turn a bad attempt
 * into a counter-example after the fact. */
export interface RecentCandidate {
  t: number;
  rows: FeatureRow[];
  durMs: number;
}

/**
 * The live gesture engine: feed it per-device orientation features each frame
 * (plus per-message path-length deltas) and it segments bursts of motion,
 * matches them against the saved moves and emits events.
 *
 * Matching is two-tier, orientation-neutral by DEFAULT: the primary score is
 * the grip-independent invariant profile, so every move matches however the
 * ball is held. When two moves near-tie there the grip-DEPENDENT axis distance
 * breaks the tie (players who keep a consistent grip). A move flagged
 * rotInvariant opts out of tiebreaking; ties involving it stay ambiguous.
 */
export class GestureRecognizer {
  gestures: Gesture[] = [];
  recording: RecordingSession | null = null;
  /** Ring buffer of recent completed candidates (newest last). */
  readonly recentCandidates: RecentCandidate[] = [];

  private cool: Record<string, number> = {};
  private pipes: Record<string, GesturePipe> = {};
  private listeners: { [K in keyof RecognizerEvents]?: RecognizerEvents[K][] } = {};

  on<K extends keyof RecognizerEvents>(event: K, cb: RecognizerEvents[K]): () => void {
    const list = (this.listeners[event] ||= []) as RecognizerEvents[K][];
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i !== -1) list.splice(i, 1);
    };
  }

  private emit<K extends keyof RecognizerEvents>(event: K, ...args: Parameters<RecognizerEvents[K]>): void {
    for (const cb of this.listeners[event] || []) (cb as (...a: unknown[]) => void)(...args);
  }

  pipe(deviceId: string): GesturePipe {
    return (this.pipes[deviceId] ||= { featAccum: 0, activity: 0, hist: [], seg: null, segLastActive: 0 });
  }

  removeDevice(deviceId: string): void {
    delete this.pipes[deviceId];
  }

  clearPipes(): void {
    this.pipes = {};
  }

  /** Drop any in-flight segments (e.g. when arming a recording). */
  clearSegments(): void {
    for (const id in this.pipes) this.pipes[id].seg = null;
  }

  /** Smoothed activity of the most active device (drives motion-energy UX). */
  maxActivity(): number {
    let max = 0;
    for (const id in this.pipes) if (this.pipes[id].activity > max) max = this.pipes[id].activity;
    return max;
  }

  /** Accumulate orientation path length for one device (call per CC message). */
  addOrientationDelta(deviceId: string, delta01: number): void {
    this.pipe(deviceId).featAccum += delta01;
  }

  /**
   * Advance one device's pipeline by one frame: update its activity signal +
   * history, then run the segmenter (which may fire a match or capture an
   * example). `feat` is the device's current 0..1 orientation feature row.
   */
  frame(deviceId: string, now: number, dt: number, feat: FeatureRow): void {
    const pipe = this.pipe(deviceId);
    // Speed is the orientation path length per second gathered from every MIDI
    // message this frame (drained here). For smooth motion this equals a
    // net-delta reading; for fast motion it keeps climbing instead of aliasing
    // down once the ball outruns the frame rate.
    const speed = pipe.featAccum / dt;
    pipe.featAccum = 0;
    const a = 1 - Math.exp(-dt / GEST_ACT_TAU);
    pipe.activity += (speed - pipe.activity) * a;
    pipe.hist.push({ t: now, feat });
    while (pipe.hist.length && now - pipe.hist[0].t > HIST_MS) pipe.hist.shift();
    this.handleSegment(pipe, now, feat);
  }

  // Feed each frame in; when a move completes it is either saved as an example
  // (if we're arming a recording) or matched. A move starts when activity
  // crosses SEG_START (pulling in ~SEG_PREROLL ms of preceding frames so the
  // wind-up is kept) and ends after SEG_HOLD ms back under SEG_END.
  private handleSegment(pipe: GesturePipe, now: number, feat: FeatureRow): void {
    const act = pipe.activity;
    if (!pipe.seg) {
      if ((this.recording || this.gestures.length) && act > SEG_START) {
        const lo = now - SEG_PREROLL;
        pipe.seg = {
          frames: pipe.hist.filter((h) => h.t >= lo).slice(),
          peak: act,
          fired: false,
          triedUpTo: -1,
        };
        pipe.segLastActive = now;
      }
      return;
    }
    const seg = pipe.seg;
    seg.frames.push({ t: now, feat });
    if (act > seg.peak) seg.peak = act;
    if (act > SEG_END) pipe.segLastActive = now;

    // Early recognition: after SEG_EARLY_MS of stillness the trailing window is
    // full, so fire the match now instead of sitting out the rest of SEG_HOLD —
    // this cuts move-end→sound latency from ~400ms to ~120ms. If the stillness
    // was actually a mid-move pause, the segment keeps growing and (if nothing
    // fired) gets one more attempt on the fuller data. Recording is
    // latency-insensitive and still captures on the full close.
    if (
      !this.recording &&
      !seg.fired &&
      seg.triedUpTo !== pipe.segLastActive &&
      act <= SEG_END &&
      now - pipe.segLastActive >= SEG_EARLY_MS
    ) {
      seg.triedUpTo = pipe.segLastActive;
      const kept = seg.frames.filter((h) => h.t <= pipe.segLastActive + SEG_TAIL);
      const durMs = kept.length ? kept[kept.length - 1].t - kept[0].t : 0;
      if (kept.length >= 6 && durMs >= SEG_MIN_MS && seg.peak >= SEG_PEAK_MIN) {
        if (this.recognize(kept.map((h) => h.feat), durMs, now)) seg.fired = true;
      }
    }

    if (now - pipe.segLastActive > SEG_HOLD || now - seg.frames[0].t > SEG_MAX) {
      pipe.seg = null;
      // Already matched (or attempted) on exactly this data during the early
      // pass and nothing new arrived since — don't fire or log a second time.
      if (!this.recording && (seg.fired || seg.triedUpTo === pipe.segLastActive)) return;
      const kept = seg.frames.filter((h) => h.t <= pipe.segLastActive + SEG_TAIL);
      const durMs = kept.length ? kept[kept.length - 1].t - kept[0].t : 0;
      // Require a clear activity peak so drift that just grazes SEG_START then
      // fades is rejected rather than matched as a (garbage) move.
      if (kept.length >= 6 && durMs >= SEG_MIN_MS && seg.peak >= SEG_PEAK_MIN) {
        this.processSegment(kept.map((h) => h.feat), durMs, now);
      }
    }
  }

  private processSegment(frames: FeatureRow[], durMs: number, now: number): void {
    if (this.recording) {
      // Each completed burst is one example. Capturing continues until the
      // caller finishes the recording, so one session can gather several reps.
      this.recording.examples.push({ rows: frames, durMs });
      this.emit("exampleCaptured", this.recording.examples.length);
    } else {
      this.recognize(frames, durMs, now);
    }
  }

  /**
   * Match a candidate against every move; returns the gesture that fired (or
   * null) so the segmenter can tell whether an early attempt landed.
   */
  recognize(frames: FeatureRow[], durMs: number, now: number): Gesture | null {
    // Keep the candidate so a bad attempt can be promoted to a counter-example.
    this.recentCandidates.push({ t: now, rows: frames.map((r) => r.slice()), durMs });
    if (this.recentCandidates.length > GEST_ATTEMPTS_MAX) this.recentCandidates.shift();

    const axisNorm = resampleNorm(frames, GEST_N); // grip-dependent view (tiebreaks)
    const inv = invariantProfile(frames); // orientation-neutral view (primary)
    let best: { g: Gesture; d: number } | null = null;
    let second: { g: Gesture; d: number } | null = null;
    let fired: Gesture | null = null;
    const evals: { g: Gesture; d: number; dCounter: number; durOkay: boolean; arcOkay: boolean }[] = [];
    for (const g of this.gestures) {
      const d = invGestureDist(inv.profile, g);
      g._dist = d; // shown in the UI even when the gates skip it
      g._distAxis = axisGestureDist(axisNorm, g);
      const dCounter = counterGestureDist(inv.profile, g);
      const durOkay = durationOk(g, durMs);
      const arcOkay = arcOk(g, inv.arc);
      evals.push({ g, d, dCounter, durOkay, arcOkay });
      if (!durOkay || !arcOkay) continue;
      // Only moves under their own threshold compete: a strict move that
      // itself fails to qualify must not shadow a looser rival.
      if (d > g.threshold) continue;
      // Counter-example veto: the candidate resembles a capture the user
      // explicitly marked as NOT this move (nearly) as much as it resembles
      // the move's own examples. The GEST_MARGIN bias is deliberate: between
      // "the move" and "explicitly not the move", a near-tie must not fire —
      // honest reps of the counter motion vary run to run, and a knife-edge
      // rule would let half of them through.
      if (dCounter <= d + GEST_MARGIN) continue;
      if (!best || d < best.d) {
        second = best;
        best = { g, d };
      } else if (!second || d < second.d) {
        second = { g, d };
      }
    }
    let ambiguous = false;
    if (best) {
      const nearTie = !!second && second.d - best.d < GEST_MARGIN;
      if (!nearTie) {
        if (this.fireGesture(best.g, best.d, now)) fired = best.g;
      } else {
        const canTiebreak = !best.g.rotInvariant && !second!.g.rotInvariant;
        const da = best.g._distAxis!;
        const db = second!.g._distAxis!;
        if (canTiebreak && Math.abs(da - db) >= GEST_MARGIN) {
          const w = da <= db ? best : second!;
          if (this.fireGesture(w.g, w.d, now)) fired = w.g;
        } else {
          ambiguous = true;
          this.emit("ambiguous", best, second!);
        }
      }
    }
    for (const ev of evals) {
      const vetoed = ev.dCounter <= ev.d + GEST_MARGIN && ev.d <= ev.g.threshold;
      const outcome: AttemptOutcome = !ev.durOkay
        ? "gate-duration"
        : !ev.arcOkay
          ? "gate-arc"
          : ev.d > ev.g.threshold
            ? "far"
            : vetoed
              ? "counter"
              : fired === ev.g
                ? "fired"
                : ambiguous
                  ? "ambiguous"
                  : "lost";
      // Name the move this one tied with or lost to, so the debugger can say
      // more than "another move".
      let rival: string | undefined;
      if (outcome === "ambiguous" && best && second) {
        rival = ev.g === best.g ? second.g.name : best.g.name;
      } else if (outcome === "lost") {
        rival = fired ? fired.name : best ? best.g.name : undefined;
      }
      this.recordAttempt(ev.g, {
        t: now,
        d: ev.d,
        dAxis: ev.g._distAxis!,
        arc: inv.arc,
        durMs,
        threshold: ev.g.threshold,
        outcome,
        rival,
        dCounter: Number.isFinite(ev.dCounter) ? ev.dCounter : undefined,
      });
    }
    this.emit("attempt");
    return fired;
  }

  /** Look up a recent candidate by its attempt timestamp. */
  candidateAt(t: number): RecentCandidate | null {
    for (let i = this.recentCandidates.length - 1; i >= 0; i--) {
      if (this.recentCandidates[i].t === t) return this.recentCandidates[i];
    }
    return null;
  }

  private recordAttempt(g: Gesture, entry: GestureAttempt): void {
    const buf = g._attempts || (g._attempts = []);
    buf.push(entry);
    if (buf.length > GEST_ATTEMPTS_MAX) buf.shift();
  }

  private fireGesture(g: Gesture, d: number, now: number): boolean {
    if (now - (this.cool[g.id] || 0) < (g.cooldown || 500)) {
      // Preserve the original behaviour: a cooldown suppression still counts
      // as the segment having fired (no retry on the full close).
      return true;
    }
    this.cool[g.id] = now;
    this.emit("fired", g, d);
    return true;
  }

  // ---- Recording ----------------------------------------------------------

  /** Arm example capture; the next bursts of motion become examples. */
  startRecording(
    targetId: string | null = null,
    name: string | null = null,
    kind: "example" | "counter" = "example"
  ): void {
    this.recording = { name, targetId, kind, examples: [] };
    this.clearSegments(); // start fresh
  }

  /** Disarm and return whatever was captured. */
  finishRecording(): RecordingSession | null {
    const rec = this.recording;
    this.recording = null;
    return rec;
  }

  /** Number of usable examples across a move (nil-safe helper re-export). */
  exampleCount(g: Gesture): number {
    return gestureExamples(g).length;
  }
}
