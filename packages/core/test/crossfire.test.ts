// Cross-move false-positive benchmark against the real recordings in data/.
// Pins the behavior measured in docs/IMPLEMENTATION-REVIEW.md so matcher
// changes are always evaluated against real captures: recall on each motion's
// own reps, cross-fire counts between distinct motions, and the
// effectiveness of counter-examples.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { activeRegions, type MoveRegion } from "../src/gesture/segment.js";
import { rawCaptureFeatureFrames, sessionFeatureFrames } from "../src/session.js";
import {
  arcOk,
  counterGestureDist,
  createGesture,
  durationOk,
  invGestureDist,
  makeExample,
  refreshGestureTemplates,
  type Gesture,
} from "../src/gesture/model.js";
import { GEST_COUNTER_MARGIN } from "../src/gesture/config.js";
import { invariantProfile } from "../src/gesture/math.js";
import { GestureRecognizer } from "../src/gesture/recognizer.js";

const DATA = join(__dirname, "..", "..", "..", "data");
const FILES: Record<string, string> = {
  twist: "home-grip-twist.json",
  catapult: "arm-catapult.json",
  backhand: "backhand invert.json", // raw capture — exercises the raw import path
  roll: "controller roll from logo up.json",
};

const loadRegions = (file: string): MoveRegion[] => {
  const data = JSON.parse(readFileSync(join(DATA, file), "utf8"));
  const frames = sessionFeatureFrames(data) ?? rawCaptureFeatureFrames(data);
  expect(frames).not.toBeNull();
  return activeRegions(frames!);
};

const regions: Record<string, MoveRegion[]> = {};
const gestures: Record<string, Gesture> = {};

beforeAll(() => {
  for (const [name, file] of Object.entries(FILES)) {
    regions[name] = loadRegions(file);
    gestures[name] = createGesture(name, regions[name].map((r) => ({ rows: r.rows, durMs: r.durMs })), 0);
  }
});

/** Would this move fire on this candidate if it were the only move loaded? */
function soloFires(g: Gesture, r: MoveRegion): boolean {
  const inv = invariantProfile(r.rows);
  const d = invGestureDist(inv.profile, g);
  if (d > g.threshold || !durationOk(g, r.durMs) || !arcOk(g, inv.arc)) return false;
  return !(counterGestureDist(inv.profile, g) <= d + GEST_COUNTER_MARGIN);
}

describe("cross-move recognition benchmark (real recordings)", () => {
  it("every motion segments into at least one rep", () => {
    for (const name of Object.keys(FILES)) expect(regions[name].length).toBeGreaterThanOrEqual(1);
  });

  it("full recognizer: own reps fire, cross-fires stay rare", () => {
    const rec = new GestureRecognizer();
    rec.gestures = Object.values(gestures);
    let now = 1_000_000;
    let correct = 0;
    let wrong = 0;
    let total = 0;
    for (const name of Object.keys(FILES)) {
      for (const r of regions[name]) {
        let firedName: string | null = null;
        const off = rec.on("fired", (g) => (firedName = g.name));
        rec.recognize(r.rows, r.durMs, now);
        off();
        now += 10_000; // clear cooldowns between probes
        total++;
        if (firedName === name) correct++;
        else if (firedName !== null) wrong++;
      }
    }
    // Measured at time of writing: 25/27 correct, 1 cross-fire (one sloppy
    // roll rep matching twist). Bounds leave a little room for tuning.
    expect(total).toBeGreaterThanOrEqual(20);
    expect(wrong).toBeLessThanOrEqual(2);
    expect(correct / total).toBeGreaterThanOrEqual(0.8);
  });

  it("counter-examples suppress a confusable impostor without wrecking recall", () => {
    // Realistic user action after misfires: two roll captures as counters on twist.
    const g = createGesture("twist", regions.twist.map((r) => ({ rows: r.rows, durMs: r.durMs })), 0);
    const before = regions.roll.filter((r) => soloFires(g, r)).length;
    g.counterExamples = regions.roll.slice(0, 2).map((r) => makeExample({ rows: r.rows, durMs: r.durMs }));
    refreshGestureTemplates(g);
    const after = regions.roll.filter((r) => soloFires(g, r)).length;
    expect(after).toBeLessThan(Math.max(before, 1));

    // Leave-one-out recall with the counters attached.
    let recall = 0;
    for (let i = 0; i < regions.twist.length; i++) {
      const train = regions.twist.filter((_, j) => j !== i);
      const gl = createGesture("t", train.map((r) => ({ rows: r.rows, durMs: r.durMs })), 0);
      gl.counterExamples = g.counterExamples;
      refreshGestureTemplates(gl);
      if (soloFires(gl, regions.twist[i])) recall++;
    }
    expect(recall / regions.twist.length).toBeGreaterThanOrEqual(0.6);
  });
});
