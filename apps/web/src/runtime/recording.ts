// Session recording (~20 Hz value snapshots) and high-fidelity raw capture
// (every non-realtime MIDI message), both downloadable as JSON.
import type { MidiBytes } from "@oddball/core";
import { bleDiag, logEvent, paramsList, recRawSig, recSessionSig } from "./state";

const download = (payload: unknown, name: string, pretty: boolean) => {
  const blob = new Blob([JSON.stringify(payload, undefined, pretty ? 2 : undefined)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ---- Session recording: ~20 Hz snapshots of every modulation source ---------
let sessionRec: { start: number; last: number; samples: { t: number; values: Record<string, number> }[] } | null =
  null;
const SESSION_SAMPLE_MS = 50; // ~20 Hz is plenty for later analysis

export function toggleSessionRec(): void {
  if (sessionRec) {
    stopSessionRec();
    return;
  }
  sessionRec = { start: performance.now(), last: 0, samples: [] };
  recSessionSig.value = { start: sessionRec.start, seconds: 0 };
  logEvent("REC", "session recording started", "note");
}

export function sampleSession(now: number): void {
  if (!sessionRec) return;
  const t = now - sessionRec.start;
  if (t - sessionRec.last < SESSION_SAMPLE_MS) return;
  sessionRec.last = t;
  const values: Record<string, number> = {};
  for (const p of paramsList()) values[p.key] = +p.get().toFixed(4);
  sessionRec.samples.push({ t: Math.round(t), values });
  recSessionSig.value = { start: sessionRec.start, seconds: t / 1000 };
}

function stopSessionRec(): void {
  const rec = sessionRec;
  sessionRec = null;
  recSessionSig.value = null;
  if (!rec || !rec.samples.length) return;
  const payload = {
    recorded: new Date().toISOString(),
    durationMs: Math.round(performance.now() - rec.start),
    params: paramsList().map((p) => ({ key: p.key, label: p.label })),
    samples: rec.samples,
  };
  download(payload, `oddball-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, true);
  logEvent("REC", `session saved · ${rec.samples.length} samples`, "note");
}

// ---- High-fidelity (event-driven) raw capture --------------------------------
// The session recorder above snapshots on a ~20 Hz timer, which aliases the
// ball's ~400 msg/s stream and drops Note messages entirely. This mode logs
// EVERY non-realtime MIDI message the moment it arrives, so the download
// matches what `listen.py --raw` captures.
let rawRec: {
  start: number;
  msgs: { t: number; dev: string; status: number; d1: number | null; d2: number | null }[];
} | null = null;

export function toggleRawRec(): void {
  if (rawRec) {
    stopRawRec();
    return;
  }
  rawRec = { start: performance.now(), msgs: [] };
  recRawSig.value = { start: rawRec.start, seconds: 0, msgs: 0 };
  logEvent("RAW", "full-rate capture started", "note");
}

/** Called for each non-realtime message while armed (before any filtering). */
export function rawRecPush(data: MidiBytes, deviceId: string): void {
  if (!rawRec) return;
  rawRec.msgs.push({
    t: +(performance.now() - rawRec.start).toFixed(2), // ms from start
    dev: deviceId || "_",
    status: data[0] ?? 0,
    d1: data[1] ?? null,
    d2: data[2] ?? null,
  });
}

/** Refresh the armed-raw UI counters (called from the frame loop). */
export function tickRawRec(now: number): void {
  if (!rawRec) return;
  recRawSig.value = { start: rawRec.start, seconds: (now - rawRec.start) / 1000, msgs: rawRec.msgs.length };
}

function stopRawRec(): void {
  const rec = rawRec;
  rawRec = null;
  recRawSig.value = null;
  if (!rec || !rec.msgs.length) {
    if (rec) logEvent("RAW", "capture stopped — no messages", "note");
    return;
  }
  const durationMs = Math.round(performance.now() - rec.start);
  const payload = {
    recorded: new Date().toISOString(),
    durationMs,
    format: "oddball-raw-midi-1",
    note:
      "Every non-realtime MIDI message in arrival order. t = ms from start; " +
      "status/d1/d2 are the raw MIDI bytes (0x90 note-on, 0xB0 control-change, …).",
    messages: rec.msgs,
    // Direct-BLE diagnostics: decoded counts by kind + the last raw
    // (pre-decode) packets, so a capture from a phone can show whether the
    // ball ever SENT motion CCs or only sparse events.
    ...(bleDiag.packets
      ? {
          ble: {
            packets: bleDiag.packets,
            bytes: bleDiag.bytes,
            notes: bleDiag.notes,
            ccs: bleDiag.ccs,
            realtime: bleDiag.realtime,
            other: bleDiag.other,
            lastPackets: bleDiag.lastPackets.slice(),
          },
        }
      : {}),
  };
  download(payload, `oddball-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, false);
  const rate = Math.round(rec.msgs.length / (durationMs / 1000));
  logEvent("RAW", `saved · ${rec.msgs.length} messages · ${rate}/s`, "note");
}
