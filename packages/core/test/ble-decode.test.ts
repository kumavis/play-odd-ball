// decodeBleMidi against realistic ODD Ball packet shapes — especially the
// dense multi-CC packets a ~400 msg/s orientation stream produces. Written
// while chasing a report of "notes arrive, CCs don't" on Android BLE: these
// pin that every legal BLE-MIDI encoding of the CC stream decodes fully, so
// a missing stream in a raw capture means the ball never sent it.
import { describe, expect, it } from "vitest";
import { decodeBleMidi } from "../src/midi/ble.js";

const HDR = 0x88; // header byte (bit7 set + timestamp-high bits)
const TS = 0xc0; // a timestamp-low byte (bit7 set)

describe("decodeBleMidi", () => {
  it("decodes a lone tap note packet", () => {
    expect(decodeBleMidi(new Uint8Array([HDR, TS, 0x90, 0, 127]))).toEqual([[0x90, 0, 127]]);
  });

  it("decodes dense CCs with full status per event", () => {
    const pkt = new Uint8Array([HDR, TS, 0xb0, 3, 64, TS + 1, 0xb0, 4, 65, TS + 2, 0xb0, 5, 66]);
    expect(decodeBleMidi(pkt)).toEqual([
      [0xb0, 3, 64],
      [0xb0, 4, 65],
      [0xb0, 5, 66],
    ]);
  });

  it("decodes running-status CCs with a timestamp per event", () => {
    const pkt = new Uint8Array([HDR, TS, 0xb0, 3, 64, TS + 1, 4, 65, TS + 2, 5, 66]);
    expect(decodeBleMidi(pkt)).toEqual([
      [0xb0, 3, 64],
      [0xb0, 4, 65],
      [0xb0, 5, 66],
    ]);
  });

  it("decodes running-status CCs with no timestamps between events", () => {
    const pkt = new Uint8Array([HDR, TS, 0xb0, 0, 10, 1, 11, 2, 12, 3, 13, 4, 14, 5, 15, 6, 16]);
    expect(decodeBleMidi(pkt).map((m) => m[1])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps running status across an interleaved realtime byte", () => {
    const pkt = new Uint8Array([HDR, TS, 0xb0, 3, 64, TS + 1, 0xf8, TS + 2, 4, 65]);
    expect(decodeBleMidi(pkt)).toEqual([
      [0xb0, 3, 64],
      [0xf8],
      [0xb0, 4, 65],
    ]);
  });

  it("handles a timestamp byte that collides with the realtime range (0xF8+)", () => {
    // ts-low = 0x80 | 0x78..0x7f lands in 0xf8..0xff; the byte AFTER the
    // skipped timestamp must still decode as a normal message.
    const pkt = new Uint8Array([HDR, 0xf9, 0xb0, 3, 64]);
    expect(decodeBleMidi(pkt)).toEqual([[0xb0, 3, 64]]);
  });

  it("decodes a full-MTU packet of mixed notes and CCs", () => {
    const pkt = new Uint8Array([
      HDR, TS, 0x90, 0, 100, TS, 0xb0, 3, 1, TS, 0xb0, 4, 2, TS, 0xb0, 5, 3, TS, 0x80, 0, 0,
    ]);
    const kinds = decodeBleMidi(pkt).map((m) => m[0] & 0xf0);
    expect(kinds).toEqual([0x90, 0xb0, 0xb0, 0xb0, 0x80]);
  });

  it("returns nothing for runts and empty packets", () => {
    expect(decodeBleMidi(new Uint8Array([]))).toEqual([]);
    expect(decodeBleMidi(new Uint8Array([HDR]))).toEqual([]);
    expect(decodeBleMidi(new Uint8Array([HDR, TS]))).toEqual([]);
  });
});
