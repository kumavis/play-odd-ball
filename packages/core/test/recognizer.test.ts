import { describe, expect, it } from "vitest";
import { OddballEngine } from "../src/engine.js";
import { createGesture } from "../src/gesture/model.js";
import { gestureFromData, serializeGestures } from "../src/gesture/serialize.js";
import type { Gesture } from "../src/gesture/model.js";

/**
 * Replay a synthetic "move" through the live engine: all three orientation
 * CCs sweep quickly (vigorous motion), then the ball sits still. Messages are
 * interleaved with ~60fps ticks the way the real app runs.
 */
function performMove(eng: OddballEngine, startMs: number, moveMs = 600, stillMs = 900): number {
  let t = startMs;
  const frame = 1000 / 60;
  const msgsPerFrame = 6; // ~360 msg/s, close to the real ball
  const cc = (c: number, v: number) => eng.handleMessage("dev", [0xb0, c, Math.round(v)]);
  const moveFrames = Math.round(moveMs / frame);
  for (let i = 0; i < moveFrames; i++) {
    const u = i / (moveFrames - 1);
    for (let k = 0; k < msgsPerFrame; k++) {
      const uu = u + (k / msgsPerFrame) * (1 / moveFrames);
      // A tip-out-and-back with a curl — full-range, fast.
      cc(3, 64 + 50 * Math.sin(uu * Math.PI * 2));
      cc(4, 64 + 50 * Math.sin(uu * Math.PI * 2 + 1.1));
      cc(5, 20 + 90 * Math.abs(Math.sin(uu * Math.PI)));
    }
    t += frame;
    eng.tick(t);
  }
  const stillFrames = Math.round(stillMs / frame);
  for (let i = 0; i < stillFrames; i++) {
    t += frame;
    eng.tick(t);
  }
  return t;
}

describe("live segmentation + recognition (end to end)", () => {
  it("captures a recorded move and re-recognizes the same motion", () => {
    const eng = new OddballEngine();
    const rec = eng.recognizer;

    // Prime the CC state so the first move doesn't start from a value jump.
    let t = 0;
    eng.handleMessage("dev", [0xb0, 3, 64]);
    eng.handleMessage("dev", [0xb0, 4, 64]);
    eng.handleMessage("dev", [0xb0, 5, 20]);
    t = 200;
    eng.tick(t);

    // Record two examples of the move.
    rec.startRecording();
    t = performMove(eng, t);
    t = performMove(eng, t);
    const session = rec.finishRecording();
    expect(session).not.toBeNull();
    expect(session!.examples.length).toBe(2);

    const g = createGesture("Test move", session!.examples, 0);
    rec.gestures.push(g);

    // Perform the same move again — it should fire.
    const fired: Gesture[] = [];
    rec.on("fired", (gg) => fired.push(gg));
    t = performMove(eng, t);
    expect(fired.map((f) => f.name)).toContain("Test move");
  });

  it("does not fire on stillness", () => {
    const eng = new OddballEngine();
    const rec = eng.recognizer;
    const g = createGesture("Quiet", [
      { rows: Array.from({ length: 40 }, (_, i) => [0.5 + 0.3 * Math.sin(i / 5), 0.5, i / 40]), durMs: 500 },
    ], 0);
    rec.gestures.push(g);
    let firedCount = 0;
    rec.on("fired", () => firedCount++);
    let t = 0;
    eng.handleMessage("dev", [0xb0, 3, 64]);
    for (let i = 0; i < 300; i++) {
      // tiny jitter, way under the segment start threshold
      eng.handleMessage("dev", [0xb0, 3, 64 + (i % 2)]);
      t += 1000 / 60;
      eng.tick(t);
    }
    expect(firedCount).toBe(0);
  });
});

describe("gesture serialization", () => {
  it("round-trips through serialize + gestureFromData", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [
      0.5 + 0.3 * Math.sin(i / 4),
      0.5 + 0.3 * Math.cos(i / 4),
      i / 50,
    ]);
    const g = createGesture("Round trip", [{ rows, durMs: 730 }], 2);
    g.rotInvariant = true;
    g.cooldown = 900;
    const [data] = serializeGestures([g]);
    const back = gestureFromData(JSON.parse(JSON.stringify(data)));
    expect(back).not.toBeNull();
    expect(back!.name).toBe("Round trip");
    expect(back!.rotInvariant).toBe(true);
    expect(back!.cooldown).toBe(900);
    expect(back!.threshold).toBeCloseTo(g.threshold, 6);
    expect(back!.examples).toHaveLength(1);
    expect(back!.examples[0].crop).toEqual(g.examples[0].crop);
    expect(back!.examples[0].durMs).toBe(730);
    expect(back!.invTemplates!.length).toBeGreaterThan(0);
  });

  it("migrates the legacy single raw+crop format", () => {
    const raw = Array.from({ length: 96 }, (_, i) => [0.5 + 0.2 * Math.sin(i / 6), 0.5, 0.4]);
    const back = gestureFromData({ id: "old", name: "Legacy", raw, crop: { start: 5, end: 60 }, threshold: 0.4 });
    expect(back).not.toBeNull();
    expect(back!.examples).toHaveLength(1);
    expect(back!.examples[0].crop).toEqual({ start: 5, end: 60 });
    // A stored threshold differing from the old default marks it manual.
    expect(back!.thresholdManual).toBe(true);
  });

  it("rejects malformed entries instead of breaking", () => {
    expect(gestureFromData(null)).toBeNull();
    expect(gestureFromData({ id: "x", examples: [{ raw: "nope" }] })).toBeNull();
  });
});
