import { GEST_DIMS } from "./gesture/config.js";
import type { FeatureRow } from "./gesture/math.js";
import { GestureRecognizer } from "./gesture/recognizer.js";
import { CC_VOLUME, NOTE_GESTURE, NOTE_TAP, ORIENTATION_CCS } from "./midi/constants.js";
import { parseMidiMessage, type MidiBytes, type MidiEvent } from "./midi/parse.js";
import { motionEnergy, RollTracker } from "./motion.js";

const ROLL_CHANNELS = new Set<number>(ORIENTATION_CCS);
const GEST_CHANNELS = new Set<number>(GEST_DIMS);

export interface HandledMessage {
  event: MidiEvent;
  /**
   * For note-ons: whether this note should drive tap-style triggers. Shake
   * (note 1) and Twist (note 2) already report through CC0/CC1, so only a Tap
   * counts — otherwise a vigorous shake double-triggers as both a shake and a
   * fake tap. Unknown notes are treated as taps so a firmware with a remapped
   * note table keeps working.
   */
  isTap: boolean;
  /** For note-ons: the documented gesture name ("Tap"/"Shake"/"Twist"), if known. */
  noteGesture?: string;
  /** For control changes: the cross-device aggregated value after this update. */
  aggregated?: number;
  /** True when the message was swallowed (system realtime, or the CC7 drop). */
  ignored: boolean;
}

export interface FrameSnapshot {
  dt: number;
  /** Smoothed roll rate (CC units/sec), normalized raw (0..1) and gated speed (0..1). */
  rollRate: number;
  rollRaw: number;
  rollSpeed: number;
  /** Smoothed Σ|Δfeat|/s of the most active ball. */
  activity: number;
  /** 0..1 normalized motion energy. */
  motion: number;
}

/**
 * The device-facing half of the ODD Ball stack: feed it every MIDI message
 * from every input (Web MIDI or BLE) tagged with a device id, call tick() once
 * per animation frame, and it maintains per-device CC state, a cross-device
 * aggregate, roll/motion tracking and the gesture recognizer.
 *
 * Per-device CC state matters: when several controllers are bound at once
 * their streams must NOT overwrite one shared slot — that makes cross-device
 * value jumps look like huge orientation deltas. Values are kept separate and
 * merged (averaged) into the shared aggregate used for sound routing, while
 * gestures and roll always measure within a single device.
 */
export class OddballEngine {
  readonly roll = new RollTracker();
  readonly recognizer = new GestureRecognizer();

  /** Per-device CC state, keyed by input id. */
  readonly deviceCc: Record<string, Record<number, number>> = {};
  /** Cross-device aggregated CC values (average of every device that reported). */
  readonly cc: Record<number, number> = {};

  /** Count of non-realtime messages seen (for msg/s meters). */
  msgCount = 0;
  /** When true (default), CC7 is swallowed: the ball emits it, but CC7 is MIDI
   * Channel Volume and would otherwise pollute meters/gestures (and mutes DAWs). */
  dropVolumeCc = true;

  private lastFrame: number | null = null;

  /** Feed one raw MIDI message from a device. Returns what was understood. */
  handleMessage(deviceId: string, data: MidiBytes): HandledMessage {
    const event = parseMidiMessage(data);
    // System-realtime housekeeping (clock, active sensing) isn't musical data;
    // keep it out of the msg/s rate, the same way listen.py ignores it.
    if (event.kind === "realtime") return { event, isTap: false, ignored: true };
    this.msgCount++;

    if (event.kind === "noteOn") {
      const noteGesture = NOTE_GESTURE[event.note];
      const isTap = noteGesture === undefined || event.note === NOTE_TAP;
      return { event, isTap, noteGesture, ignored: false };
    }

    if (event.kind === "controlChange") {
      if (this.dropVolumeCc && event.controller === CC_VOLUME) {
        return { event, isTap: false, ignored: true };
      }
      const dev = (this.deviceCc[deviceId] ||= {});
      const prev = dev[event.controller];
      // Roll delta is measured within a single device only.
      if (prev !== undefined && ROLL_CHANNELS.has(event.controller)) {
        this.roll.addDelta(Math.abs(event.value - prev));
      }
      // Gesture path length is per-device too, measured against the device's
      // own previous value — never the cross-device average, which would let a
      // second controller dilute (or fake) this ball's motion.
      if (prev !== undefined && GEST_CHANNELS.has(event.controller)) {
        this.recognizer.addOrientationDelta(deviceId, Math.abs(event.value - prev) / 127);
      }
      dev[event.controller] = event.value;
      const aggregated = this.aggregateCc(event.controller);
      this.cc[event.controller] = aggregated;
      return { event, isTap: false, aggregated, ignored: false };
    }

    return { event, isTap: false, ignored: false };
  }

  /** Average a controller's value across every device that has reported it. */
  aggregateCc(controller: number): number {
    let sum = 0;
    let n = 0;
    for (const id in this.deviceCc) {
      const v = this.deviceCc[id][controller];
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  /** A device's current 0..1 orientation feature row. */
  deviceFeature(deviceId: string): FeatureRow {
    const dev = this.deviceCc[deviceId] || {};
    return GEST_DIMS.map((c) => (dev[c] ?? 0) / 127);
  }

  /** Forget one device's state (unplugged / BLE dropped). */
  removeDevice(deviceId: string): void {
    delete this.deviceCc[deviceId];
    this.recognizer.removeDevice(deviceId);
  }

  /** Forget every device's state (rebinding the input set). */
  resetDevices(): void {
    for (const k in this.deviceCc) delete this.deviceCc[k];
    this.recognizer.clearPipes();
    this.roll.reset();
  }

  /**
   * Advance the engine by one animation frame. Runs the roll tracker and every
   * device's gesture pipeline (which may fire recognizer events).
   */
  tick(now: number): FrameSnapshot {
    const dt = Math.max(0.001, (now - (this.lastFrame ?? now)) / 1000);
    this.lastFrame = now;

    const roll = this.roll.tick(dt, Object.keys(this.deviceCc).length);

    for (const id in this.deviceCc) {
      this.recognizer.frame(id, now, dt, this.deviceFeature(id));
    }
    // Also tick devices that have a pipe but no CC yet? A pipe only exists
    // once CCs arrived, so deviceCc covers every live pipe.

    const activity = this.recognizer.maxActivity();
    return {
      dt,
      rollRate: roll.rate,
      rollRaw: roll.raw,
      rollSpeed: roll.speed,
      activity,
      motion: motionEnergy(activity),
    };
  }
}
