import { describe, expect, it } from "vitest";
import { BPM_DEFAULT, BPM_MAX, BPM_MIN, LOOKAHEAD, TempoClock, clampBpm, dueSteps } from "../src/audio/clock";

const clockAt = (bpm = 120, origin = 0) => {
  const c = new TempoClock();
  c.bpm = bpm;
  c.origin = origin;
  return c;
};

describe("TempoClock", () => {
  it("divides a beat into four 16th-note steps", () => {
    const c = clockAt(120);
    expect(c.stepDur).toBeCloseTo(0.125);
    expect(c.timeOf(4)).toBeCloseTo(0.5); // one beat at 120 BPM
  });

  it("clamps tempo into range and rejects junk", () => {
    expect(clampBpm(10)).toBe(BPM_MIN);
    expect(clampBpm(999)).toBe(BPM_MAX);
    expect(clampBpm(144.6)).toBe(145);
    expect(clampBpm(NaN)).toBe(BPM_DEFAULT);
  });

  it("keeps the current step position when the tempo changes", () => {
    const c = clockAt(120, 1);
    const now = 3.3;
    const before = c.position(now);
    c.setBpm(150, now);
    expect(c.bpm).toBe(150);
    expect(c.position(now)).toBeCloseTo(before);
    // …and the grid runs at the new rate from there.
    expect(c.timeOf(Math.ceil(before) + 4) - c.timeOf(Math.ceil(before))).toBeCloseTo(0.4);
  });
});

describe("dueSteps", () => {
  it("schedules every step inside the lookahead window exactly once", () => {
    const c = clockAt(120);
    const cursor = { next: null as number | null };
    const seen: number[] = [];
    let last = 0;
    // Simulate a jittery ~60 fps animation loop for two seconds.
    for (let t = 0; t < 2; t += 0.012 + ((t * 7919) % 0.01)) {
      for (const s of dueSteps(c, cursor, t)) {
        expect(s.time).toBeGreaterThanOrEqual(t);
        expect(s.time).toBeLessThan(t + LOOKAHEAD);
        seen.push(s.step);
      }
      last = t;
    }
    expect(seen).toEqual([...seen.keys()]); // 0, 1, 2, … with no gaps or repeats
    // Nothing inside the final window was left unscheduled.
    expect(c.timeOf(seen[seen.length - 1] + 1)).toBeGreaterThanOrEqual(last + LOOKAHEAD);
  });

  it("keeps independent voices on the same grid", () => {
    const c = clockAt(145, 0.05);
    const a = { next: null as number | null };
    const b = { next: null as number | null };
    dueSteps(c, a, 0.1);
    const late = dueSteps(c, b, 1.234); // a voice patched in later
    for (const s of late) expect((s.time - c.origin) / c.stepDur).toBeCloseTo(s.step);
  });

  it("resyncs instead of bursting a backlog after a stall", () => {
    const c = clockAt(120);
    const cursor = { next: null as number | null };
    dueSteps(c, cursor, 0);
    const after = dueSteps(c, cursor, 10); // e.g. the tab slept for 10 s
    expect(after.length).toBeLessThanOrEqual(Math.ceil(LOOKAHEAD / c.stepDur));
    expect(after[0].time).toBeGreaterThanOrEqual(10);
  });
});
