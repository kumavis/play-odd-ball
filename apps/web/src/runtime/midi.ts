// Input plumbing: Web MIDI port selection + BLE-MIDI direct pairing, feeding
// every message into the core engine and translating notes into app UX.
import { signal } from "@preact/signals";
import { BleConnectError, connectBleBall, noteName, type BleBall, type MidiBytes } from "@oddball/core";
import {
  audio,
  connections,
  emitAppEvent,
  engine,
  hintSig,
  lastNoteSig,
  live,
  logEvent,
  statusSig,
} from "./state";
import { chimeDirect } from "./patch";
import { rawRecPush } from "./recording";

export interface PortOption {
  value: string;
  label: string;
}
export const portOptionsSig = signal<PortOption[]>([]);
export const portSelectionSig = signal<string>("");

let midi: MIDIAccess | null = null;
let selectedWebInputs: MIDIInput[] = []; // current Web MIDI port selection
const bleInputs: BleBall[] = []; // ODD Balls paired directly over Web Bluetooth

export const isOdd = (name: string) => /odd/i.test(name);

/** Every message from every input funnels through here. */
export function onMidiMessage(deviceId: string, data: MidiBytes): void {
  // High-fidelity capture logs the raw message before any app-side filtering
  // (e.g. the CC7 drop in the engine) so the file is a faithful record.
  const status = data[0] ?? 0;
  if (status < 0xf8) rawRecPush(data, deviceId);

  const res = engine.handleMessage(deviceId, data);
  const ev = res.event;
  if (ev.kind === "noteOn") {
    // Shake (note 1) and Twist (note 2) already report through CC0/CC1, so
    // only a Tap drives the tap envelope and the chimes.
    if (res.isTap) live.tapEnv = Math.max(live.tapEnv, ev.velocity / 127);
    lastNoteSig.value = {
      name: noteName(ev.note),
      sub: `note ${ev.note} · velocity ${ev.velocity}${res.noteGesture ? ` · ${res.noteGesture.toLowerCase()}` : ""}`,
    };
    emitAppEvent({ kind: "note", note: ev.note, velocity: ev.velocity, gesture: res.noteGesture });
    // Pitch follows X orientation (CC3) so moving the ball plays different
    // notes. Only the direct tap→chimes patch fires from here; other sources
    // trigger chimes from their own value edges in the frame loop.
    if (res.isTap && chimeDirect(connections.chimes)) audio.hit(ev.velocity, (engine.cc[3] ?? 64) / 127);
    logEvent("NOTE", `${noteName(ev.note)} (${ev.note}) vel ${ev.velocity}${res.noteGesture ? ` · ${res.noteGesture}` : ""}`, "note");
  } else if (ev.kind === "pitchBend") {
    logEvent("PITCH", String(ev.value));
  }
}

// Recompute the combined active-input list (Web MIDI selection + BLE balls)
// and refresh status. Called whenever either source changes.
function syncActiveInputs(): void {
  const total = selectedWebInputs.length + bleInputs.length;
  // Drop stale per-device state so a removed controller stops contributing.
  engine.resetDevices();
  if (total === 0) {
    statusSig.value = { on: false, label: "disconnected" };
    return;
  }
  statusSig.value = { on: true, label: total > 1 ? `connected · ${total}` : "connected" };
  if (hintSig.peek().kind === "default") hintSig.value = { kind: null };
}

/** Bind onmidimessage to a list of Web MIDI inputs (and detach all others). */
function bindInputs(inputs: MIDIInput[]): void {
  if (midi) for (const inp of midi.inputs.values()) inp.onmidimessage = null;
  selectedWebInputs = inputs;
  for (const inp of inputs) {
    inp.onmidimessage = (e: MIDIMessageEvent) => onMidiMessage(inp.id, e.data!);
  }
  syncActiveInputs();
  if (inputs.length) logEvent("", `listening on ${inputs.map((i) => i.name).join(", ")}`);
}

/** Resolve a dropdown value ("all-odd" / "all" / a port id) to inputs. */
export function applySelection(value: string): void {
  if (!midi) return;
  portSelectionSig.value = value;
  const inputs = [...midi.inputs.values()];
  let chosen: MIDIInput[];
  if (value === "all-odd") chosen = inputs.filter((i) => isOdd(i.name || ""));
  else if (value === "all") chosen = inputs;
  else {
    const one = midi.inputs.get(value);
    chosen = one ? [one] : [];
  }
  bindInputs(chosen);
}

export function refreshPorts(): void {
  if (!midi) return;
  const prev = portSelectionSig.peek();
  const inputs = [...midi.inputs.values()];
  if (inputs.length === 0) {
    portOptionsSig.value = [{ value: "", label: "No MIDI inputs found" }];
    portSelectionSig.value = "";
    // Keep any Bluetooth-paired ball active; status reflects the combined total.
    selectedWebInputs = [];
    syncActiveInputs();
    return;
  }
  const oddInputs = inputs.filter((i) => isOdd(i.name || ""));
  const opts: PortOption[] = [];
  if (oddInputs.length)
    opts.push({ value: "all-odd", label: oddInputs.length > 1 ? `All ODD Balls (${oddInputs.length})` : "ODD Ball" });
  if (inputs.length > 1) opts.push({ value: "all", label: `All inputs (${inputs.length})` });
  for (const input of inputs) opts.push({ value: input.id, label: input.name || input.id });
  portOptionsSig.value = opts;

  // Keep the prior choice if still valid, else default to all ODD Balls.
  const values = opts.map((o) => o.value);
  const target = prev && values.includes(prev) ? prev : oddInputs.length ? "all-odd" : inputs[0].id;
  applySelection(target);
}

export async function initMidi(): Promise<void> {
  if (!navigator.requestMIDIAccess) {
    statusSig.value = { on: false, label: "no Web MIDI" };
    hintSig.value = { kind: "no-midi" };
    return;
  }
  try {
    midi = await navigator.requestMIDIAccess({ sysex: false });
    refreshPorts();
    midi.onstatechange = refreshPorts;
  } catch (err) {
    statusSig.value = { on: false, label: "permission denied" };
    hintSig.value = { kind: "midi-denied", detail: String(err) };
  }
}

// ---- Bluetooth (BLE-MIDI) direct pairing --------------------------------------
export async function connectBluetoothBall(): Promise<void> {
  let ball: BleBall;
  try {
    statusSig.value = { on: false, label: "connecting…" };
    ball = await connectBleBall({
      onMessage: (msg, from) => onMidiMessage(from.id, msg),
      onDisconnect: (from) => removeBleInput(from.id),
    });
  } catch (err) {
    syncActiveInputs();
    if (err instanceof BleConnectError) {
      if (err.kind === "cancelled") return void syncActiveInputs(); // user dismissed the chooser
      if (err.kind === "unavailable") return void (hintSig.value = { kind: "bt-unavailable" });
      if (err.kind === "blocked") return void (hintSig.value = { kind: "bt-blocked" });
      return void (hintSig.value = { kind: "bt-failed", detail: String(err.cause ?? err.message) });
    }
    hintSig.value = { kind: "bt-failed", detail: String(err) };
    return;
  }
  if (bleInputs.some((p) => p.id === ball.id)) {
    // Already paired (double click): the fresh GATT session replaces the old
    // one; just refresh status.
    syncActiveInputs();
    return;
  }
  bleInputs.push(ball);
  syncActiveInputs();
  logEvent("", `Bluetooth ball ${ball.name} connected`, "note");
}

function removeBleInput(id: string): void {
  const idx = bleInputs.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [port] = bleInputs.splice(idx, 1);
  engine.removeDevice(id);
  syncActiveInputs();
  logEvent("", `Bluetooth ball ${port.name} disconnected`);
}
