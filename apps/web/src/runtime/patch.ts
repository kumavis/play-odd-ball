// Patch-bay logic: connect/disconnect, response shaping, and sequenced
// ("in order") playback chains.
import {
  audio,
  clamp1,
  connections,
  connEditorSig,
  engine,
  gestureBySource,
  INSTRUMENTS,
  isGestureSource,
  mkConn,
  paramByKey,
  paramValue,
  seqCfg,
  seqEnv,
  seqOnset,
  seqQueue,
  SEQ_GAP_DEFAULT,
  SEQ_ONSET_COOLDOWN,
  SEQ_ONSET_HI,
  SEQ_ONSET_LO,
  touchConnections,
  type Conn,
} from "./state";
import { saveStateSoon } from "./persist";
import { setSoundOn } from "./sound";

/** Drop queued chain steps, onset trackers and live trigger envelopes — called
 * when the patch is cleared or swapped so steps scheduled milliseconds earlier
 * can't fire into the new layout. */
export function resetSeqRuntime(): void {
  seqQueue.length = 0;
  for (const k in seqOnset) delete seqOnset[k];
  for (const k in seqEnv) delete seqEnv[k];
}

/** Instrument keys currently driven by `source`, ordered by their play order. */
export function siblingsOf(source: string): string[] {
  return INSTRUMENTS.filter((i) => connections[i.key] && connections[i.key]!.source === source)
    .map((i) => i.key)
    .sort((a, b) => (connections[a]!.order ?? 0) - (connections[b]!.order ?? 0));
}

export function seqConfig(source: string) {
  return seqCfg[source] || (seqCfg[source] = { mode: "together", gap: SEQ_GAP_DEFAULT });
}

/**
 * A source plays its instruments one-after-another when it's a recorded
 * gesture (always) or a plain input the user switched into "sequence" mode. A
 * plain input only counts as sequenced while it drives at least two
 * instruments: the onset loop never fires a chain for a lone instrument, so
 * treating that case as sequenced would leave it permanently silent.
 */
export function sourceSequenced(source: string): boolean {
  if (isGestureSource(source)) return true;
  if (!seqCfg[source] || seqCfg[source].mode !== "sequence") return false;
  return siblingsOf(source).length >= 2;
}

export function seqGapFor(source: string): number {
  if (isGestureSource(source)) {
    const g = gestureBySource(source);
    return g ? (g.seqGap ?? SEQ_GAP_DEFAULT) : SEQ_GAP_DEFAULT;
  }
  return seqConfig(source).gap;
}

/** Fire a source's connected instruments in play order, staggered by `gap` ms. */
export function fireChain(source: string, gap: number): void {
  const now = performance.now();
  siblingsOf(source).forEach((instKey, i) => {
    if (gap > 0 && i > 0) seqQueue.push({ instKey, at: now + i * gap });
    else seqEnv[instKey] = 1;
  });
}

export function shape(conn: Conn | null, instKey?: string): number {
  if (!conn) return 0;
  // Sequenced instruments read their own (possibly delayed) trigger envelope so
  // a single movement can fire its instruments in order; everything else reads
  // the live parameter value and plays continuously / simultaneously.
  const raw = instKey && sourceSequenced(conn.source) ? seqEnv[instKey] || 0 : paramValue(conn.source);
  const t = conn.thresh;
  const gated = raw <= t ? 0 : (raw - t) / (1 - t);
  return clamp1(gated) * conn.atten;
}

export function connect(srcKey: string, instKey: string): void {
  const prev = connections[instKey];
  const conn = mkConn(srcKey, prev?.atten ?? 1, prev?.thresh ?? 0);
  // New links join the end of their source's play chain; reconnecting the same
  // pair keeps its position.
  conn.order =
    prev && prev.source === srcKey && typeof prev.order === "number"
      ? prev.order
      : siblingsOf(srcKey).filter((k) => k !== instKey).length;
  connections[instKey] = conn;
  if (instKey === "chimes") audio.chimesOn = true;
  touchConnections();
  saveStateSoon();
}

/** Move an instrument earlier (-1) or later (+1) in its movement's play chain. */
export function moveInSequence(instKey: string, dir: -1 | 1): void {
  const conn = connections[instKey];
  if (!conn) return;
  const sibs = siblingsOf(conn.source);
  const idx = sibs.indexOf(instKey);
  const j = idx + dir;
  if (j < 0 || j >= sibs.length) return;
  sibs.splice(idx, 1);
  sibs.splice(j, 0, instKey);
  sibs.forEach((k, i) => {
    connections[k]!.order = i;
  });
  touchConnections();
  saveStateSoon();
}

export function disconnect(instKey: string): void {
  connections[instKey] = null;
  // Drop this instrument's pending chain steps and trigger envelope so a
  // step scheduled milliseconds ago can't fire into a rewired patch.
  for (let i = seqQueue.length - 1; i >= 0; i--) {
    if (seqQueue[i].instKey === instKey) seqQueue.splice(i, 1);
  }
  delete seqEnv[instKey];
  if (instKey === "chimes") audio.chimesOn = false;
  if (connEditorSig.peek()?.instKey === instKey) connEditorSig.value = null;
  touchConnections();
  saveStateSoon();
}

/** Disconnect every instrument from its trigger — a clean slate. */
export function clearPatch(): void {
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  connEditorSig.value = null;
  saveStateSoon();
}

/** Build a fresh random patch: a handful of instruments, each wired to a
 * random parameter with a random response curve. */
export function randomizePatch(paramKeys: string[]): void {
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  const insts = INSTRUMENTS.slice();
  for (let i = insts.length - 1; i > 0; i--) {
    // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [insts[i], insts[j]] = [insts[j], insts[i]];
  }
  const n = 3 + Math.floor(Math.random() * 5); // 3..7 instruments
  for (let i = 0; i < n && i < insts.length; i++) {
    const src = paramKeys[Math.floor(Math.random() * paramKeys.length)];
    connect(src, insts[i].key);
    const c = connections[insts[i].key]!;
    c.atten = +(0.5 + Math.random() * 0.5).toFixed(2);
    c.thresh = +(Math.random() * 0.35).toFixed(2);
  }
  connEditorSig.value = null;
  touchConnections();
  saveStateSoon();
}

/** Switch a plain input between playing its instruments together vs. in order. */
export function setSeqMode(source: string, mode: "together" | "sequence"): void {
  if (isGestureSource(source)) return;
  seqConfig(source).mode = mode;
  touchConnections();
  saveStateSoon();
}

// Chimes are an event instrument (audio.hit), not a continuous voice, so a
// connection can't just stream a level into them. A plain tap connection keeps
// the zero-latency per-note path (true velocity, retriggers on every bounce);
// any other source fires one chime per rising edge of its shaped value — which
// also covers sequenced chains, whose per-instrument envelope jumps 0→1 when
// the chain step lands.
const chimeState = { prev: 0, last: 0 };
export const chimeDirect = (conn: Conn | null): boolean =>
  !!conn && conn.source === "tap" && !sourceSequenced("tap");

export function updateChimes(conn: Conn | null, v: number, now: number): void {
  if (!conn) {
    chimeState.prev = 0;
    return;
  }
  if (!chimeDirect(conn)) {
    if (chimeState.prev < SEQ_ONSET_LO && v >= SEQ_ONSET_HI && now - chimeState.last > SEQ_ONSET_COOLDOWN) {
      chimeState.last = now;
      audio.hit(Math.round(clamp1(v) * 127), (engine.cc[3] ?? 64) / 127);
    }
  }
  chimeState.prev = v;
}

/** Play a short demo of one instrument, resuming audio if needed without
 * changing the user's sound on/off intent. */
export async function previewInstrument(key: string): Promise<void> {
  if (!audio.ctx) {
    await audio.enable();
    // Enabling the context for a preview turns sound on for real; reflect it.
    setSoundOn(true);
    return void audio.preview(key);
  }
  if (audio.ctx.state === "suspended") {
    await audio.ctx.resume();
    // Global sound is off: re-suspend after the demo finishes so we honor it.
    // The demo swell is 1.3s but event voices ring on — lightning's rolling
    // thunder tail lasts ~3.6s past its trigger — so leave room for the decay.
    if (!audio.enabled)
      setTimeout(() => {
        if (!audio.enabled) audio.ctx!.suspend();
      }, 5000);
  }
  audio.preview(key);
}

/** Ensure a source that no longer exists (deleted gesture) is unpatched. */
export function dropConnectionsFor(sourceKey: string): void {
  for (const instKey in connections) {
    if (connections[instKey] && connections[instKey]!.source === sourceKey) disconnect(instKey);
  }
}

/** True when a saved connection can be applied (its source exists). */
export const sourceExists = (key: string): boolean => !!paramByKey(key);
