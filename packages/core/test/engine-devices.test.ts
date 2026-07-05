import { describe, expect, it } from "vitest";
import { OddballEngine } from "../src/engine.js";
import { connectBleBall } from "../src/midi/ble.js";
import { rawCaptureFeatureFrames } from "../src/session.js";

const cc = (eng: OddballEngine, dev: string, ctrl: number, val: number) =>
  eng.handleMessage(dev, [0xb0, ctrl, val]);

describe("device removal and aggregate CC state", () => {
  it("removeDevice recomputes the aggregate without the departed device", () => {
    const eng = new OddballEngine();
    cc(eng, "a", 3, 100);
    cc(eng, "b", 3, 50);
    expect(eng.cc[3]).toBe(75);
    eng.removeDevice("a");
    expect(eng.cc[3]).toBe(50);
  });

  it("removeDevice of the last reporter drops the aggregate entirely", () => {
    const eng = new OddballEngine();
    cc(eng, "a", 3, 100);
    cc(eng, "a", 5, 80);
    eng.removeDevice("a");
    // No stale values left to drive instruments after the ball disconnects.
    expect(eng.cc[3]).toBeUndefined();
    expect(eng.cc[5]).toBeUndefined();
    expect(Object.keys(eng.cc)).toHaveLength(0);
  });

  it("resetDevices clears the aggregate map", () => {
    const eng = new OddballEngine();
    cc(eng, "a", 3, 100);
    cc(eng, "b", 6, 20);
    eng.resetDevices();
    expect(Object.keys(eng.cc)).toHaveLength(0);
    expect(Object.keys(eng.deviceCc)).toHaveLength(0);
  });
});

describe("rawCaptureFeatureFrames", () => {
  const rawFile = (messages: { t: number; status: number; d1: number; d2: number }[]) => ({
    format: "oddball-raw-midi-1",
    messages: messages.map((m) => ({ ...m, dev: "d" })),
  });

  it("decodes orientation CCs into feature frames once all axes reported", () => {
    const msgs = [
      { t: 0, status: 0xb0, d1: 3, d2: 127 }, // only X so far — no frame
      { t: 5, status: 0xb0, d1: 4, d2: 0 },
      { t: 10, status: 0xb0, d1: 5, d2: 64 }, // first frame here
      { t: 15, status: 0x90, d1: 0, d2: 100 }, // note-on ignored
      { t: 20, status: 0xb0, d1: 0, d2: 40 }, // non-orientation CC ignored
      { t: 25, status: 0xb0, d1: 3, d2: 0 },
      { t: 30, status: 0xb0, d1: 4, d2: 127 },
      { t: 35, status: 0xb0, d1: 5, d2: 127 },
    ];
    const frames = rawCaptureFeatureFrames(rawFile(msgs))!;
    expect(frames.map((f) => f.t)).toEqual([10, 25, 30, 35]);
    expect(frames[0].feat).toEqual([1, 0, 64 / 127]);
    // Last values carry forward per axis.
    expect(frames[3].feat).toEqual([0, 1, 1]);
  });

  it("rejects non-raw data and captures with too few frames", () => {
    expect(rawCaptureFeatureFrames({ samples: [] })).toBeNull();
    expect(rawCaptureFeatureFrames(null)).toBeNull();
    expect(
      rawCaptureFeatureFrames(rawFile([{ t: 0, status: 0xb0, d1: 3, d2: 10 }]))
    ).toBeNull();
  });
});

describe("connectBleBall re-pair", () => {
  function fakeBluetooth() {
    const listeners: Record<string, EventListener[]> = {};
    const target = (store: string) => ({
      addEventListener: (ev: string, fn: EventListener) => {
        (listeners[`${store}:${ev}`] ||= []).push(fn);
      },
      removeEventListener: (ev: string, fn: EventListener) => {
        const l = listeners[`${store}:${ev}`] || [];
        const i = l.indexOf(fn);
        if (i !== -1) l.splice(i, 1);
      },
    });
    const char = { ...target("char"), startNotifications: async () => {} };
    const device = {
      ...target("device"),
      id: "dev1",
      name: "ODD Test",
      gatt: {
        connect: async () => ({
          getPrimaryService: async () => ({ getCharacteristic: async () => char }),
        }),
        disconnect: () => {},
      },
    };
    const bluetooth = { requestDevice: async () => device } as unknown as Bluetooth;
    return { bluetooth, listeners, char };
  }

  it("replaces (not stacks) the value listener when pairing the same ball twice", async () => {
    const { bluetooth, listeners, char } = fakeBluetooth();
    const received: number[][] = [];
    const opts = { bluetooth, onMessage: (msg: number[]) => received.push(msg) };
    await connectBleBall(opts);
    await connectBleBall(opts);
    expect(listeners["char:characteristicvaluechanged"]).toHaveLength(1);
    expect(listeners["device:gattserverdisconnected"]).toHaveLength(1);

    // One BLE packet (header + timestamp + note-on) must decode exactly once.
    const packet = new Uint8Array([0x80, 0x80, 0x90, 0x00, 0x64]);
    const value = new DataView(packet.buffer);
    for (const fn of listeners["char:characteristicvaluechanged"]) {
      fn({ target: { ...char, value } } as unknown as Event);
    }
    expect(received).toEqual([[0x90, 0x00, 0x64]]);
  });
});
