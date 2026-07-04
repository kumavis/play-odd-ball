// Central mutable runtime + reactive signals. Structural state (connections,
// gestures, profiles, view toggles) lives in signals so Preact re-renders;
// per-frame hot values (envelopes, roll speed, CC levels) stay in plain
// mutables that the rAF loop reads/writes and imperative frame callbacks
// consume — same architecture as the original app, minus the manual DOM.
import { signal } from "@preact/signals";
import { OddballEngine, SEQ_GAP_DEFAULT, type Gesture } from "@oddball/core";
import { AudioEngine, type InstrumentDef } from "../audio/engine";

export const engine = new OddballEngine();
export const audio = new AudioEngine();

// ---- Instruments ---------------------------------------------------------
export const INSTRUMENTS: InstrumentDef[] = [
  ...AudioEngine.INSTRUMENTS,
  { key: "chimes", label: "Chimes", noted: true },
];

// ---- Connections ---------------------------------------------------------
// Each instrument input takes one parameter (or none). A connection carries a
// per-connection response curve: `thresh` gates out signal below a floor and
// `atten` scales the result.
//   shaped = ((raw - thresh) / (1 - thresh))  (clamped, 0 below thresh) * atten
export interface Conn {
  source: string;
  atten: number;
  thresh: number;
  order?: number;
  /** Optional second input for the `noted` instruments: the parameter whose
   * 0..1 value picks the pitch of each event (e.g. tap triggers the piano,
   * Orient X chooses the note). Absent = the instrument's own pitch logic. */
  noteSource?: string;
}

export const clamp1 = (v: number) => Math.max(0, Math.min(1, v));

// thresh is capped just under 1 (matching the UI slider's 0.95 max): shape()
// divides by (1 - thresh), so a stored/imported value of exactly 1 would turn
// the whole chain into NaN gain — and assigning NaN to an AudioParam throws.
export const CONN_THRESH_MAX = 0.95;
export const mkConn = (source: string, atten = 1, thresh = 0): Conn => ({
  source,
  atten: clamp1(atten),
  thresh: Math.min(CONN_THRESH_MAX, clamp1(thresh)),
});

/** instrument key -> connection (mutable; bump connVersion after changes). */
export const connections: Record<string, Conn | null> = {};
INSTRUMENTS.forEach((inst) => {
  connections[inst.key] = null;
});
connections.bass = mkConn("roll_speed");
connections.chimes = mkConn("tap");

/** Bumped whenever the patch changes shape (connect/disconnect/reorder). */
export const connVersion = signal(0);
export const touchConnections = () => {
  connVersion.value++;
};

// ---- Live (per-frame) values ---------------------------------------------
export const live = {
  rollRate: 0,
  rollRaw: 0, // ungated normalized rate (0..1) for the meter
  rollSpeed: 0, // final gated 0..1 intensity sent to the synth
  motion: 0, // 0..1 normalized motion energy
  tapEnv: 0, // decaying envelope that jumps to the tap velocity on each note
};

export const gestureEnv: Record<string, number> = {}; // gesture id -> 0..1 trigger envelope
export const seqEnv: Record<string, number> = {}; // instKey -> 0..1 per-instrument trigger
export const seqQueue: { instKey: string; at: number }[] = []; // pending chain steps
export interface SeqCfg {
  mode: "together" | "sequence";
  gap: number;
}
export const seqCfg: Record<string, SeqCfg> = {}; // per plain-input playback config
export const seqOnset: Record<string, { prev: number; last: number }> = {};

export const SEQ_ONSET_LO = 0.06; // fall below this to re-arm the trigger
export const SEQ_ONSET_HI = 0.14; // rise above this to fire the chain
export const SEQ_ONSET_COOLDOWN = 220; // ms minimum between chain triggers
export { SEQ_GAP_DEFAULT };

// ---- Modulation sources (PARAMS) ------------------------------------------
export interface ParamDef {
  key: string;
  label: string;
  color: string;
  gesture?: boolean;
  get: () => number;
}

// CC assignments follow the documented ODD Ball mapping (see docs/MIDI.md):
// CC0 Shake · CC1 Twist · CC2 Freefall · CC3-5 X/Y/Z orientation · CC6 Movement.
const cc = (n: number) => () => (engine.cc[n] ?? 0) / 127;
export const BASE_PARAMS: ParamDef[] = [
  { key: "roll_speed", label: "Roll speed", color: "#28e0a0", get: () => live.rollSpeed },
  { key: "roll_rate", label: "Roll rate", color: "#00e5ff", get: () => live.rollRaw },
  { key: "energy", label: "Motion energy", color: "#ffd166", get: () => live.motion },
  { key: "tap", label: "Tap envelope", color: "#ff5db1", get: () => live.tapEnv },
  { key: "shake", label: "Shake (CC0)", color: "hsl(20 75% 62%)", get: cc(0) },
  { key: "twist", label: "Twist (CC1)", color: "hsl(65 75% 62%)", get: cc(1) },
  { key: "freefall", label: "Freefall (CC2)", color: "hsl(110 75% 62%)", get: cc(2) },
  { key: "tilt_x", label: "Orient X (CC3)", color: "hsl(155 75% 62%)", get: cc(3) },
  { key: "tilt_y", label: "Orient Y (CC4)", color: "hsl(200 75% 62%)", get: cc(4) },
  { key: "tilt_z", label: "Orient Z (CC5)", color: "hsl(245 75% 62%)", get: cc(5) },
  { key: "movement", label: "Movement (CC6)", color: "hsl(290 75% 62%)", get: cc(6) },
];

/** All gestures, shared with engine.recognizer.gestures (same array). */
export const gesturesSig = signal<Gesture[]>(engine.recognizer.gestures);
/** Re-publish the gestures array (after any mutation) so the UI re-renders. */
export function touchGestures(): void {
  engine.recognizer.gestures = gesturesSig.peek();
  gesturesSig.value = [...engine.recognizer.gestures];
}

const gestureParam = (g: Gesture): ParamDef => ({
  key: "g:" + g.id,
  label: "✋ " + g.name,
  color: g.color,
  gesture: true,
  get: () => gestureEnv[g.id] || 0,
});

/** Ordered modulation sources: base params then one per saved move. */
export function paramsList(): ParamDef[] {
  return [...BASE_PARAMS, ...gesturesSig.value.map(gestureParam)];
}

const paramIndex = new Map(BASE_PARAMS.map((p) => [p.key, p]));
export function paramByKey(key: string): ParamDef | undefined {
  const base = paramIndex.get(key);
  if (base) return base;
  if (key.startsWith("g:")) {
    const g = gesturesSig.peek().find((x) => "g:" + x.id === key);
    return g ? gestureParam(g) : undefined;
  }
  return undefined;
}

export const paramValue = (key: string): number => paramByKey(key)?.get() ?? 0;
export const isGestureSource = (src: string): boolean => src.startsWith("g:");
export const gestureBySource = (src: string): Gesture | null =>
  src.startsWith("g:") ? (gesturesSig.peek().find((g) => g.id === src.slice(2)) ?? null) : null;

// ---- Sparklines / history --------------------------------------------------
export const SPARK_MAX = 180;
export const sparkBuf: Record<string, number[]> = {}; // param key -> ring buffer of 0..1

// ---- UI signals -------------------------------------------------------------
export interface LogEntry {
  id: number;
  tag: string; // bold prefix ("NOTE", "GESTURE", …) or "" for plain lines
  text: string;
  cls: string; // "" | "note"
}
let logId = 0;
export const logSig = signal<LogEntry[]>([]);
export function logEvent(tag: string, text: string, cls = ""): void {
  const next = [{ id: ++logId, tag, text, cls }, ...logSig.peek()];
  if (next.length > 80) next.length = 80;
  logSig.value = next;
}

export const statusSig = signal<{ on: boolean; label: string }>({ on: false, label: "disconnected" });
export const rateSig = signal(0); // msg/s
export const lastNoteSig = signal<{ name: string; sub: string }>({ name: "—", sub: "waiting for a tap…" });

export type HintKind = "default" | "bt-unavailable" | "bt-blocked" | "bt-failed" | "no-midi" | "midi-denied" | null;
export const hintSig = signal<{ kind: HintKind; detail?: string }>({ kind: "default" });

export const soundOnSig = signal(true); // reflects the button; audio may be gated by autoplay
export const viewsSig = signal<Record<string, boolean>>({});
export const histOpenSig = signal(false);
export const patchViewSig = signal<"rack" | "orbit">("rack");
export const sensitivitySig = signal(45);

/** Instrument key whose connection is being edited (+ anchor position). */
export const connEditorSig = signal<{ instKey: string; x: number; y: number } | null>(null);
/** Gesture id open in the gesture editor. */
export const editingGestureSig = signal<string | null>(null);
/** Which capture the editor canvas shows: an example or a counter-example. */
export const editingExampleSig = signal<{ kind: "example" | "counter"; index: number }>({
  kind: "example",
  index: 0,
});
/** Bumped after every recognition pass so live distances re-render. */
export const attemptsVersion = signal(0);
/** Armed move-recording state (null when not recording). */
export const recMoveSig = signal<{ targetId: string | null; kind: "example" | "counter"; count: number } | null>(null);
export const recSessionSig = signal<{ start: number; seconds: number } | null>(null);
export const recRawSig = signal<{ start: number; seconds: number; msgs: number } | null>(null);

export interface Profile {
  id: string;
  name: string;
  created: number;
  schema: number;
  connections: Record<string, (Conn & { order?: number }) | null>;
  seqCfg: Record<string, SeqCfg>;
  gestures: unknown[];
  sensitivity: number;
}
export const profilesSig = signal<Profile[]>([]);

// ---- Frame subscription -----------------------------------------------------
export interface FrameInfo {
  now: number;
  dt: number;
}
type FrameCb = (f: FrameInfo) => void;
const frameCbs = new Set<FrameCb>();
export function onFrame(cb: FrameCb): () => void {
  frameCbs.add(cb);
  return () => frameCbs.delete(cb);
}
export function runFrameCbs(f: FrameInfo): void {
  for (const cb of frameCbs) cb(f);
}

// App-level one-shot events (note flashes, gesture hits) for panels that
// animate imperatively.
export type AppEvent =
  | { kind: "note"; note: number; velocity: number; gesture?: string }
  | { kind: "gestureFired"; id: string };
type EventCb = (e: AppEvent) => void;
const eventCbs = new Set<EventCb>();
export function onAppEvent(cb: EventCb): () => void {
  eventCbs.add(cb);
  return () => eventCbs.delete(cb);
}
export function emitAppEvent(e: AppEvent): void {
  for (const cb of eventCbs) cb(e);
}
