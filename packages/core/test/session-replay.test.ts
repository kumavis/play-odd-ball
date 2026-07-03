// Integration tests against the real recordings in data/ — the same files the
// matcher was originally tuned on (see docs/FINDINGS.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeRegions } from "../src/gesture/segment.js";
import { sessionFeatureFrames } from "../src/session.js";
import { createGesture } from "../src/gesture/model.js";
import { GestureRecognizer } from "../src/gesture/recognizer.js";

const DATA = join(__dirname, "..", "..", "..", "data");
const loadFrames = (file: string) => {
  const data = JSON.parse(readFileSync(join(DATA, file), "utf8"));
  const frames = sessionFeatureFrames(data);
  expect(frames).not.toBeNull();
  return frames!;
};

describe("session import (real recordings)", () => {
  it("finds repeated move regions in home-grip-twist.json", () => {
    const regions = activeRegions(loadFrames("home-grip-twist.json"));
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const r of regions) {
      expect(r.rows.length).toBeGreaterThanOrEqual(6);
      expect(r.durMs).toBeGreaterThanOrEqual(260);
    }
  });

  it("finds move regions in arm-catapult.json", () => {
    const regions = activeRegions(loadFrames("arm-catapult.json"));
    expect(regions.length).toBeGreaterThanOrEqual(1);
  });

  it("finds no move in the D2 hand-tremor noise-floor recording", () => {
    const regions = activeRegions(loadFrames("D2.json"));
    expect(regions.length).toBe(0);
  });
});

describe("cross-rep recognition (real recordings)", () => {
  it("a move built from some reps recognizes the remaining reps", () => {
    const regions = activeRegions(loadFrames("home-grip-twist.json"));
    expect(regions.length).toBeGreaterThanOrEqual(3);
    // Build the move from all but the last rep; probe with the held-out rep(s).
    const train = regions.slice(0, -1);
    const probeRegions = regions.slice(-1);
    const rec = new GestureRecognizer();
    const g = createGesture("home twist", train.map((r) => ({ rows: r.rows, durMs: r.durMs })), 0);
    rec.gestures.push(g);
    let fired = 0;
    rec.on("fired", () => fired++);
    let now = 100_000;
    for (const probe of probeRegions) {
      rec.recognize(probe.rows, probe.durMs, now);
      now += 10_000; // clear the cooldown between probes
    }
    expect(fired).toBe(probeRegions.length);
  });
});
