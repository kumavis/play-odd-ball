import { describe, expect, it } from "vitest";
import { createGesture, makeExample, refreshGestureTemplates } from "../src/gesture/model.js";
import { GestureRecognizer } from "../src/gesture/recognizer.js";
import { gestureFromData, serializeGestures } from "../src/gesture/serialize.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// Two distinguishable motions: a one-way sweep and an out-and-back.
const sweep = (n = 50) => range(n).map((i) => [0.5 + 0.3 * (i / n), 0.5, (i / n) * 0.8]);
// Amplitude chosen so its total sphere arc stays within the arc gate's 2×
// band of the sweep's (the gates are tested elsewhere; here we want the veto).
const outAndBack = (n = 50) =>
  range(n).map((i) => {
    const u = Math.sin((i / (n - 1)) * Math.PI);
    return [0.5 + 0.3 * u, 0.5 - 0.1 * u, 0.45 * u];
  });

describe("counter-examples", () => {
  it("vetoes a match that is closer to a counter-example", () => {
    const rec = new GestureRecognizer();
    const g = createGesture("Sweepy", [{ rows: sweep(), durMs: 500 }], 0);
    // Loosen the threshold so the out-and-back would normally fire too.
    g.thresholdManual = true;
    g.threshold = 1.1;
    // Duration/arc gates must not interfere with what we're testing.
    g.examples.forEach((ex) => (ex.durMs = null));
    rec.gestures.push(g);

    let fired = 0;
    rec.on("fired", () => fired++);

    // Sanity: without a counter-example the impostor fires.
    rec.recognize(outAndBack(), 500, 1000);
    const before = fired;
    expect(before).toBe(1);

    // Add the impostor as a counter-example and rebuild.
    g.counterExamples = [makeExample({ rows: outAndBack(), durMs: 500 })];
    refreshGestureTemplates(g);

    rec.recognize(outAndBack(), 500, 20000);
    expect(fired).toBe(before); // vetoed
    const last = g._attempts![g._attempts!.length - 1];
    expect(last.outcome).toBe("counter");
    expect(last.dCounter).toBeLessThanOrEqual(last.d + 0.05);

    // The real move still fires.
    rec.recognize(sweep(), 500, 40000);
    expect(fired).toBe(before + 1);
  });

  it("round-trips counter-examples through serialization", () => {
    const g = createGesture("With counters", [{ rows: sweep(), durMs: 500 }], 0);
    g.counterExamples = [makeExample({ rows: outAndBack(), durMs: 450 })];
    refreshGestureTemplates(g);
    const [data] = serializeGestures([g]);
    expect(data.counterExamples).toHaveLength(1);
    const back = gestureFromData(JSON.parse(JSON.stringify(data)));
    expect(back!.counterExamples).toHaveLength(1);
    expect(back!.invCounterTemplates!.length).toBeGreaterThan(0);
  });

  it("keeps recent candidates so an attempt can become a counter-example", () => {
    const rec = new GestureRecognizer();
    const g = createGesture("Sweepy", [{ rows: sweep(), durMs: 500 }], 0);
    rec.gestures.push(g);
    rec.recognize(outAndBack(), 470, 12345);
    const cand = rec.candidateAt(12345);
    expect(cand).not.toBeNull();
    expect(cand!.durMs).toBe(470);
    expect(cand!.rows.length).toBe(50);
  });
});

describe("rival naming in attempts", () => {
  it("names the winner on a lost tiebreak and the rival on an ambiguous tie", () => {
    const rec = new GestureRecognizer();
    // Two moves built from the SAME motion → guaranteed near-tie; rotInvariant
    // on both forbids the axis tiebreak → ambiguous.
    const a = createGesture("Alpha", [{ rows: sweep(), durMs: 500 }], 0);
    const b = createGesture("Beta", [{ rows: sweep(), durMs: 500 }], 1);
    a.rotInvariant = true;
    b.rotInvariant = true;
    rec.gestures.push(a, b);
    let ambiguous = 0;
    rec.on("ambiguous", () => ambiguous++);
    rec.recognize(sweep(), 500, 5000);
    expect(ambiguous).toBe(1);
    const la = a._attempts![a._attempts!.length - 1];
    const lb = b._attempts![b._attempts!.length - 1];
    expect(la.outcome).toBe("ambiguous");
    expect(la.rival).toBe("Beta");
    expect(lb.rival).toBe("Alpha");
  });
});
