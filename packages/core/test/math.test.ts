import { describe, expect, it } from "vitest";
import {
  autoTrim,
  dtwDist,
  invariantProfile,
  normalizeShared,
  resample,
  sphereRows,
} from "../src/gesture/math.js";
import { G_AZ_AMP } from "../src/gesture/config.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("resample", () => {
  it("keeps endpoints and length", () => {
    const rows = range(10).map((i) => [i / 9, 1 - i / 9, 0.5]);
    const out = resample(rows, 32);
    expect(out).toHaveLength(32);
    expect(out[0]).toEqual(rows[0]);
    expect(out[31][0]).toBeCloseTo(1);
    expect(out[31][1]).toBeCloseTo(0);
  });

  it("handles empty and single-row input", () => {
    expect(resample([], 4)).toHaveLength(4);
    const out = resample([[0.3, 0.4, 0.5]], 4);
    expect(out.every((r) => r[0] === 0.3 && r[2] === 0.5)).toBe(true);
  });
});

describe("normalizeShared", () => {
  it("is invariant to per-dimension offset and shared scale", () => {
    const rows = range(20).map((i) => [Math.sin(i / 3) * 0.2 + 0.5, Math.cos(i / 3) * 0.1 + 0.4, 0.5]);
    const shifted = rows.map((r) => [r[0] * 2 + 0.1, r[1] * 2 - 0.3, r[2] * 2 + 0.2]);
    const a = normalizeShared(rows);
    const b = normalizeShared(shifted);
    for (let i = 0; i < a.length; i++) {
      for (let d = 0; d < 3; d++) expect(b[i][d]).toBeCloseTo(a[i][d], 6);
    }
  });

  it("does not mutate its input", () => {
    const rows = [[0.1, 0.2, 0.3], [0.9, 0.8, 0.7]];
    const copy = rows.map((r) => r.slice());
    normalizeShared(rows);
    expect(rows).toEqual(copy);
  });
});

describe("dtwDist", () => {
  const wave = (phase: number, n = 32) =>
    range(n).map((i) => [Math.sin(i / 4 + phase), Math.cos(i / 4 + phase), 0]);

  it("is zero against itself", () => {
    const a = wave(0);
    expect(dtwDist(a, a)).toBeCloseTo(0, 9);
  });

  it("scores similar shapes closer than different ones", () => {
    const a = wave(0);
    const near = wave(0.15);
    const far = range(32).map((i) => [i / 31, 0, 0]);
    expect(dtwDist(a, near)).toBeLessThan(dtwDist(a, far));
  });

  it("returns Infinity for empty input", () => {
    expect(dtwDist([], [[0, 0, 0]])).toBe(Infinity);
  });
});

describe("autoTrim", () => {
  it("finds the active span of a padded capture", () => {
    const n = 96;
    const rows = range(n).map((i) => {
      const active = i >= 30 && i < 60;
      const v = active ? 0.5 + 0.4 * Math.sin((i - 30) / 3) : 0.5;
      return [v, 0.5, 0.5];
    });
    const crop = autoTrim(rows);
    expect(crop.start).toBeGreaterThan(15);
    expect(crop.start).toBeLessThanOrEqual(31);
    expect(crop.end).toBeGreaterThanOrEqual(58);
    expect(crop.end).toBeLessThan(75);
  });

  it("returns the full span for a flat capture", () => {
    const rows = range(96).map(() => [0.5, 0.5, 0.5]);
    expect(autoTrim(rows)).toEqual({ start: 0, end: 95 });
  });
});

describe("sphereRows / invariantProfile", () => {
  // Synthesize CC rows from a tilt path via the fitted transfer function
  // (docs/FINDINGS.md): cc3/cc4 = 0.5 + G_AZ_AMP·(horizontal direction · sinθ),
  // cc5 = (1 − cosθ)/2.
  const ccFromTilt = (theta: number, azimuth: number) => {
    const s = Math.sin(theta);
    return [
      0.5 + G_AZ_AMP * Math.cos(azimuth) * s,
      0.5 + G_AZ_AMP * Math.sin(azimuth) * s,
      (1 - Math.cos(theta)) / 2,
    ];
  };

  it("maps upright to the north pole", () => {
    const [v] = sphereRows([ccFromTilt(0, 0)]);
    expect(v[2]).toBeCloseTo(1, 6);
  });

  it("recovers the tilt angle from cc5", () => {
    const theta = Math.PI / 3;
    const [v] = sphereRows([ccFromTilt(theta, 1.2)]);
    expect(Math.acos(v[2])).toBeCloseTo(theta, 5);
  });

  it("is invariant to a regrip (constant azimuth rotation of the path)", () => {
    // A tip-out-and-back move with a slight curve, performed in two grips 90°
    // apart. The invariant profile must be (nearly) identical.
    const path = (grip: number) =>
      range(40).map((i) => {
        const u = i / 39;
        const theta = Math.sin(u * Math.PI) * 1.1; // out to ~63° and back
        const az = grip + u * 0.9; // slight sweep while tilted
        return ccFromTilt(theta, az);
      });
    const a = invariantProfile(path(0));
    const b = invariantProfile(path(Math.PI / 2));
    expect(b.arc).toBeCloseTo(a.arc, 2);
    expect(dtwDist(a.profile, b.profile)).toBeLessThan(0.02);
  });

  it("distinguishes clockwise from counter-clockwise bends", () => {
    const loop = (dir: 1 | -1) =>
      range(40).map((i) => {
        const u = (i / 39) * Math.PI * 1.5;
        return ccFromTilt(0.8 + 0.15 * Math.sin(u * 2), dir * u);
      });
    const cw = invariantProfile(loop(1));
    const ccw = invariantProfile(loop(-1));
    expect(dtwDist(cw.profile, ccw.profile)).toBeGreaterThan(0.1);
  });
});
