import { describe, expect, it } from "vitest";
import { decodeBleMidi } from "../src/midi/ble.js";
import { parseMidiMessage } from "../src/midi/parse.js";
import { OddballEngine } from "../src/engine.js";

describe("parseMidiMessage", () => {
  it("decodes note on/off, CC and pitch bend", () => {
    expect(parseMidiMessage([0x90, 0, 100])).toEqual({ kind: "noteOn", channel: 0, note: 0, velocity: 100 });
    // Note-on with velocity 0 is a note-off per the MIDI spec.
    expect(parseMidiMessage([0x90, 0, 0]).kind).toBe("noteOff");
    expect(parseMidiMessage([0x80, 5, 20]).kind).toBe("noteOff");
    expect(parseMidiMessage([0xb0, 3, 64])).toEqual({ kind: "controlChange", channel: 0, controller: 3, value: 64 });
    expect(parseMidiMessage([0xe0, 0, 64])).toEqual({ kind: "pitchBend", channel: 0, value: 0 });
    expect(parseMidiMessage([0xf8]).kind).toBe("realtime");
  });
});

describe("decodeBleMidi", () => {
  it("decodes a single note-on event", () => {
    // header, timestamp, status, d1, d2
    const msgs = decodeBleMidi(new Uint8Array([0x80, 0x80, 0x90, 0x00, 0x64]));
    expect(msgs).toEqual([[0x90, 0x00, 0x64]]);
  });

  it("handles running status (status byte omitted on later events)", () => {
    const msgs = decodeBleMidi(
      new Uint8Array([0x80, 0x80, 0xb0, 0x03, 0x40, 0x81, 0x04, 0x41])
    );
    expect(msgs).toEqual([
      [0xb0, 0x03, 0x40],
      [0xb0, 0x04, 0x41],
    ]);
  });

  it("passes realtime bytes through and keeps running status alive", () => {
    const msgs = decodeBleMidi(
      new Uint8Array([0x80, 0x80, 0xb0, 0x05, 0x10, 0x81, 0xf8, 0x81, 0x06, 0x11])
    );
    expect(msgs).toEqual([
      [0xb0, 0x05, 0x10],
      [0xf8],
      [0xb0, 0x06, 0x11],
    ]);
  });

  it("ignores runt packets", () => {
    expect(decodeBleMidi(new Uint8Array([0x80]))).toEqual([]);
  });
});

describe("OddballEngine message handling", () => {
  it("drops CC7 (channel volume) by default", () => {
    const eng = new OddballEngine();
    const res = eng.handleMessage("dev", [0xb0, 7, 99]);
    expect(res.ignored).toBe(true);
    expect(eng.cc[7]).toBeUndefined();
  });

  it("treats only Tap (and unknown) notes as taps", () => {
    const eng = new OddballEngine();
    expect(eng.handleMessage("dev", [0x90, 0, 90]).isTap).toBe(true); // Tap
    expect(eng.handleMessage("dev", [0x90, 1, 90]).isTap).toBe(false); // Shake
    expect(eng.handleMessage("dev", [0x90, 2, 90]).isTap).toBe(false); // Twist
    expect(eng.handleMessage("dev", [0x90, 9, 90]).isTap).toBe(true); // unknown → tap
  });

  it("keeps per-device CC state and averages the aggregate", () => {
    const eng = new OddballEngine();
    eng.handleMessage("a", [0xb0, 3, 100]);
    eng.handleMessage("b", [0xb0, 3, 50]);
    expect(eng.deviceCc.a[3]).toBe(100);
    expect(eng.deviceCc.b[3]).toBe(50);
    expect(eng.cc[3]).toBe(75);
    eng.removeDevice("b");
    eng.handleMessage("a", [0xb0, 3, 90]);
    expect(eng.cc[3]).toBe(90);
  });
});
