import { describe, expect, it } from "vitest";
import { arcOk, createGesture } from "../src/gesture/model.js";
import { GEST_ARC_RATIO } from "../src/gesture/config.js";
import type { FeatureRow } from "../src/gesture/math.js";

/** A smooth synthetic capture; `phase` varies the shape between examples. */
const capture = (phase: number, n = 60): FeatureRow[] =>
  Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1);
    return [
      0.5 + 0.3 * Math.sin(u * Math.PI * 2 + phase),
      0.5 + 0.3 * Math.cos(u * Math.PI * 2 + phase * 0.7),
      0.2 + 0.6 * Math.abs(Math.sin(u * Math.PI + phase * 0.3)),
    ];
  });

describe("arc gate", () => {
  it("derives its band from the examples' as-cropped arcs, not the crop-variant templates", () => {
    const g = createGesture("m", [
      { rows: capture(0), durMs: 500 },
      { rows: capture(0.05), durMs: 500 },
    ], 0);
    const arcs = g.exampleArcs!;
    expect(arcs).toHaveLength(2);
    for (const a of arcs) expect(a).toBeGreaterThan(0);
    const lo = Math.min(...arcs) / GEST_ARC_RATIO;
    const hi = Math.max(...arcs) * GEST_ARC_RATIO;
    expect(arcOk(g, lo * 1.01)).toBe(true);
    expect(arcOk(g, hi * 0.99)).toBe(true);
    expect(arcOk(g, lo * 0.9)).toBe(false);
    expect(arcOk(g, hi * 1.1)).toBe(false);
  });
});
