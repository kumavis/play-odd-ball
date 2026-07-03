// Gesture editor: overlaid example traces with crop handles, per-example fit
// badges, counter-examples (captures that must NOT fire the move), per-move
// tuning, and the attempt debugger — every completed motion segment scored
// against this move, with the reason it did or didn't fire.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  autoTrim,
  gestureExamples,
  RAW_N,
  refreshGestureTemplates,
  sensToThresh,
  threshToSens,
  type Gesture,
  type GestureAttempt,
  type GestureExample,
} from "@oddball/core";
import {
  attemptsVersion,
  editingExampleSig,
  editingGestureSig,
  gesturesSig,
  paramByKey,
  recMoveSig,
} from "../runtime/state";
import {
  addAttemptAsCounterExample,
  deleteGesture,
  finishRecordMove,
  persistGesturesSoon,
  toggleAddExample,
} from "../runtime/gestures";
import { useAppEvents } from "../hooks";
import { engine, touchGestures } from "../runtime/state";

const GEST_DIM_COLORS = ["tilt_x", "tilt_y", "tilt_z"].map((k) => paramByKey(k)?.color || "#8b90b8");

function attemptLabel(a: GestureAttempt): string {
  switch (a.outcome) {
    case "fired":
      return "fired";
    case "lost":
      return `lost tiebreak to “${a.rival ?? "another move"}”`;
    case "ambiguous":
      return `ambiguous with “${a.rival ?? "another move"}”`;
    case "far":
      return "too far from the examples";
    case "counter":
      return `matched a counter-example${typeof a.dCounter === "number" ? ` (d ${a.dCounter.toFixed(2)})` : ""} — vetoed`;
    case "gate-duration":
      return "duration outside the examples' range";
    case "gate-arc":
      return "sweep (arc) outside the examples' range";
    default:
      return a.outcome;
  }
}

export function GestureEditor() {
  const id = editingGestureSig.value;
  attemptsVersion.value; // live distance + attempts strip
  const gestures = gesturesSig.value;
  const g = id ? gestures.find((x) => x.id === id) : undefined;
  const sel = editingExampleSig.value;
  const recMove = recMoveSig.value;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const [matchFlash, setMatchFlash] = useState(false);
  const [selAttempt, setSelAttempt] = useState<number | null>(null); // attempt t
  const [, bump] = useState(0);

  const close = () => {
    // Stop an in-progress "add example" capture tied to this editor.
    if (recMove && recMove.targetId) finishRecordMove();
    dragRef.current = null;
    editingGestureSig.value = null;
  };

  // Escape closes; a freshly opened editor selects the name for typing over.
  useEffect(() => {
    if (!g) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    nameRef.current?.focus();
    nameRef.current?.select();
    setSelAttempt(null);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useAppEvents(
    (e) => {
      if (e.kind === "gestureFired" && g && e.id === g.id) {
        setMatchFlash(true);
        setTimeout(() => setMatchFlash(false), 450);
      }
    },
    [g?.id]
  );

  // ---- selected capture (example or counter-example) ------------------------
  const examples = g ? gestureExamples(g) : [];
  const counters = g?.counterExamples ?? [];
  const list = sel.kind === "counter" ? counters : examples;
  const index = Math.max(0, Math.min(list.length - 1, sel.index));
  const capture: GestureExample | null = list.length ? list[index] : null;

  const recompute = () => {
    if (!g) return;
    refreshGestureTemplates(g);
    touchGestures();
    persistGesturesSoon();
    bump((n) => n + 1);
  };

  // ---- canvas drawing ---------------------------------------------------------
  useEffect(() => {
    if (!g || !capture) return;
    drawEditorCanvas(canvasRef.current!, g, capture, sel.kind, examples, index);
  });
  useEffect(() => {
    const onResize = () => {
      if (g && capture) drawEditorCanvas(canvasRef.current!, g, capture, sel.kind, examples, index);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  if (!g) {
    return (
      <>
        <div class="gedit-backdrop gedit-backdrop--hidden"></div>
        <div class="gedit gedit--hidden"></div>
      </>
    );
  }

  const idxFromEvent = (e: PointerEvent): number => {
    const r = canvasRef.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return Math.round(frac * (RAW_N - 1));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!capture) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const px = (i: number) => (i / (RAW_N - 1)) * r.width;
    const x = e.clientX - r.left;
    const dStart = Math.abs(x - px(capture.crop.start));
    const dEnd = Math.abs(x - px(capture.crop.end));
    dragRef.current = dStart <= dEnd ? "start" : "end";
    canvasRef.current!.setPointerCapture(e.pointerId);
    onPointerMove(e);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!capture || !dragRef.current) return;
    const crop = capture.crop;
    const idx = idxFromEvent(e);
    if (dragRef.current === "start") crop.start = Math.min(idx, crop.end - 2);
    else crop.end = Math.max(idx, crop.start + 2);
    crop.start = Math.max(0, crop.start);
    crop.end = Math.min(RAW_N - 1, crop.end);
    recompute();
  };

  const capturingKind = recMove && recMove.targetId === g.id ? recMove.kind : null;
  const attempts = g._attempts || [];
  const shownAttempt =
    (selAttempt !== null && attempts.find((a) => a.t === selAttempt)) || attempts[attempts.length - 1] || null;
  const span = capture ? capture.crop.end - capture.crop.start + 1 : 0;
  const fitFor = (i: number) => (g._exFit && typeof g._exFit[i] === "number" ? (g._exFit[i] as number) : null);

  return (
    <>
      <div class="gedit-backdrop" onClick={close}></div>
      <div class="gedit">
        <div class="gedit-head">
          <span class="gedit-dot" style={{ background: g.color }}></span>
          <input
            class="gedit-name"
            type="text"
            spellcheck={false}
            ref={nameRef}
            value={g.name}
            onInput={(e) => {
              g.name = (e.target as HTMLInputElement).value || "Move";
              touchGestures();
              persistGesturesSoon();
            }}
          />
          <button class="gedit-close" title="Close" onClick={close}>
            ×
          </button>
        </div>
        <div class="gedit-canvas-wrap">
          <canvas
            class="gedit-canvas"
            ref={canvasRef}
            onPointerDown={onPointerDown as any}
            onPointerMove={onPointerMove as any}
            onPointerUp={() => (dragRef.current = null)}
          ></canvas>
        </div>
        <div class="gedit-examples">
          <span class="gedit-ex-title">examples</span>
          <div class="gedit-ex-strip">
            {examples.map((ex, i) => {
              const fit = fitFor(i);
              const outlier = fit !== null && fit > g.threshold;
              const active = sel.kind === "example" && i === index;
              const tip =
                fit !== null
                  ? `Example ${i + 1} · d=${fit.toFixed(2)} against the other examples${outlier ? " — disagrees with its siblings; re-crop or remove it" : ""}`
                  : `Example ${i + 1}`;
              return (
                <button
                  key={i}
                  class={`gedit-ex${active ? " is-active" : ""}`}
                  title={tip}
                  onClick={() => (editingExampleSig.value = { kind: "example", index: i })}
                >
                  {i + 1}
                  {fit !== null && <span class={`gedit-ex-fit${outlier ? " is-outlier" : ""}`}>{fit.toFixed(2)}</span>}
                </button>
              );
            })}
          </div>
          <button
            class={`gedit-mini${capturingKind === "example" ? " is-arming" : ""}`}
            title="Perform the move again to add it as another example"
            onClick={() => toggleAddExample(g, "example")}
          >
            {capturingKind === "example"
              ? recMove!.count
                ? `✋ ${recMove!.count} · finish`
                : "✋ Do the move…"
              : "＋ Add"}
          </button>
          <button
            class="gedit-mini gedit-mini--danger"
            title="Remove the selected example"
            disabled={sel.kind !== "example" || examples.length <= 1}
            onClick={() => {
              if (sel.kind !== "example" || examples.length <= 1) return;
              examples.splice(index, 1);
              editingExampleSig.value = { kind: "example", index: Math.min(index, examples.length - 1) };
              recompute();
            }}
          >
            Remove
          </button>
        </div>
        <div class="gedit-examples gedit-counters">
          <span
            class="gedit-ex-title"
            title="Counter-examples: motions that must NOT fire this move. A performance closer to one of these than to the real examples is vetoed — capture the near-miss that keeps misfiring, or promote a bad attempt below."
          >
            counter-examples
          </span>
          <div class="gedit-ex-strip">
            {counters.map((_, i) => {
              const active = sel.kind === "counter" && i === index;
              return (
                <button
                  key={i}
                  class={`gedit-ex gedit-ex--counter${active ? " is-active" : ""}`}
                  title={`Counter-example ${i + 1} — this motion is vetoed`}
                  onClick={() => (editingExampleSig.value = { kind: "counter", index: i })}
                >
                  c{i + 1}
                </button>
              );
            })}
            {!counters.length && <span class="gedit-hint">none — this move has no vetoes yet</span>}
          </div>
          <button
            class={`gedit-mini${capturingKind === "counter" ? " is-arming" : ""}`}
            title="Perform the motion that must NOT trigger this move — each burst becomes a counter-example"
            onClick={() => toggleAddExample(g, "counter")}
          >
            {capturingKind === "counter"
              ? recMove!.count
                ? `🚫 ${recMove!.count} · finish`
                : "🚫 Do the NON-move…"
              : "＋ Add counter"}
          </button>
          <button
            class="gedit-mini gedit-mini--danger"
            title="Remove the selected counter-example"
            disabled={sel.kind !== "counter" || !counters.length}
            onClick={() => {
              if (sel.kind !== "counter" || !counters.length) return;
              counters.splice(index, 1);
              editingExampleSig.value = counters.length
                ? { kind: "counter", index: Math.min(index, counters.length - 1) }
                : { kind: "example", index: 0 };
              recompute();
            }}
          >
            Remove
          </button>
        </div>
        <div class="gedit-crop">
          <span class="gedit-crop-info">
            {capture
              ? `${sel.kind === "counter" ? `counter ${index + 1}/${counters.length} · ` : list.length > 1 ? `ex ${index + 1}/${list.length} · ` : ""}crop ${capture.crop.start}–${capture.crop.end} of ${RAW_N} (${Math.round((span / RAW_N) * 100)}%)`
              : "crop —"}
          </span>
          <button
            class="gedit-mini"
            onClick={() => {
              if (!capture) return;
              capture.crop = autoTrim(capture.raw);
              recompute();
            }}
          >
            Auto-trim silence
          </button>
          <button
            class="gedit-mini"
            onClick={() => {
              if (!capture) return;
              capture.crop = { start: 0, end: RAW_N - 1 };
              recompute();
            }}
          >
            Reset
          </button>
        </div>
        <div class="gedit-row">
          <label>
            sensitivity <span class="gedit-num">{threshToSens(g.threshold)}</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={threshToSens(g.threshold)}
            onInput={(e) => {
              g.threshold = sensToThresh(+(e.target as HTMLInputElement).value);
              g.thresholdManual = true;
              touchGestures();
              persistGesturesSoon();
              bump((n) => n + 1);
            }}
          />
        </div>
        <div class="gedit-row">
          <label>
            retrigger gap <span class="gedit-num">{`${Math.round(g.cooldown || 500)} ms`}</span>
          </label>
          <input
            type="range"
            min="150"
            max="2500"
            step="50"
            value={g.cooldown || 500}
            onInput={(e) => {
              g.cooldown = +(e.target as HTMLInputElement).value;
              persistGesturesSoon();
              bump((n) => n + 1);
            }}
          />
        </div>
        <div class="gedit-row">
          <label title="All moves already match however the ball is held (orientation-neutral). When two moves look identical up to grip, the grip direction normally breaks the tie — tick this to exclude this move from that tiebreak because you perform it in varying grips.">
            any-grip only
          </label>
          <input
            type="checkbox"
            checked={!!g.rotInvariant}
            onChange={(e) => {
              g.rotInvariant = (e.target as HTMLInputElement).checked;
              persistGesturesSoon();
            }}
          />
          <span class="gedit-hint">never use grip direction to disambiguate this move</span>
        </div>
        <div class="gedit-live">
          <span>
            live distance{" "}
            <b style={{ color: typeof g._dist === "number" && g._dist <= g.threshold ? "var(--good)" : "" }}>
              {typeof g._dist === "number" ? g._dist.toFixed(2) : "—"}
            </b>{" "}
            · fires under <b>{g.threshold.toFixed(2)}</b>
          </span>
          <span class={`gedit-match${matchFlash ? " on" : ""}`}>MATCH</span>
        </div>
        <div
          class="gedit-attempts-row"
          title="Recent performances scored against this move — taller is closer to firing. Green fired · amber qualified but lost to another move · purple vetoed by a counter-example · dim red too far · dashed was gated (t = duration, a = sweep). Click a bar for details."
        >
          <span class="gedit-ex-title">attempts</span>
          <div class="gedit-attempts">
            {attempts.map((a) => {
              const ratio = Math.min(2, a.d / Math.max(a.threshold, 1e-6)); // 1.0 = at threshold
              const h = Math.round(6 + (1 - ratio / 2) * 30);
              const cls =
                a.outcome === "fired"
                  ? "at--fired"
                  : a.outcome === "lost" || a.outcome === "ambiguous"
                    ? "at--close"
                    : a.outcome === "counter"
                      ? "at--counter"
                      : a.outcome.startsWith("gate")
                        ? "at--gated"
                        : "at--far";
              const letter =
                a.outcome === "gate-duration" ? "t" : a.outcome === "gate-arc" ? "a" : a.outcome === "counter" ? "c" : "";
              const tip = `d=${a.d.toFixed(2)} (fires under ${a.threshold.toFixed(2)}) · sweep ${a.arc.toFixed(2)} · ${Math.round(a.durMs)} ms · grip d=${a.dAxis.toFixed(2)} — ${attemptLabel(a)}`;
              return (
                <span
                  key={a.t}
                  class={`at ${cls}${shownAttempt === a ? " is-selected" : ""}`}
                  style={{ height: `${h}px` }}
                  title={tip}
                  onClick={() => setSelAttempt(a.t)}
                >
                  {letter}
                </span>
              );
            })}
          </div>
        </div>
        <div class="gedit-attempt-info">
          {shownAttempt ? (
            <>
              {selAttempt !== null ? "selected" : "last"}: d {shownAttempt.d.toFixed(2)} /{" "}
              {shownAttempt.threshold.toFixed(2)} · sweep {shownAttempt.arc.toFixed(2)} ·{" "}
              {Math.round(shownAttempt.durMs)} ms · {attemptLabel(shownAttempt)}
              {engine.recognizer.candidateAt(shownAttempt.t) && (
                <button
                  class="gedit-mini gedit-mini--counter"
                  title="This motion must NOT fire this move — add it as a counter-example so it's vetoed from now on"
                  onClick={() => {
                    if (addAttemptAsCounterExample(g, shownAttempt.t)) {
                      editingExampleSig.value = { kind: "counter", index: (g.counterExamples?.length ?? 1) - 1 };
                      bump((n) => n + 1);
                    }
                  }}
                >
                  🚫 Counter this attempt
                </button>
              )}
            </>
          ) : (
            "perform the move to see how close each attempt scores"
          )}
        </div>
        <div class="gedit-actions">
          <button
            class="gedit-del"
            onClick={() => {
              const gid = g.id;
              close();
              deleteGesture(gid);
            }}
          >
            Delete move
          </button>
        </div>
      </div>
    </>
  );
}

// A shared value scale across ALL sibling examples, so overlaid traces are
// directly comparable. When editing a counter-example the real examples ghost
// underneath so the difference is visible.
function drawEditorCanvas(
  cv: HTMLCanvasElement,
  g: Gesture,
  capture: GestureExample,
  kind: "example" | "counter",
  examples: GestureExample[],
  index: number
): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const ctx = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  const pad = 8 * dpr;
  ctx.clearRect(0, 0, W, H);

  const raw = capture.raw;
  const crop = capture.crop;
  const N = raw.length;
  const D = raw[0].length;
  const ghosts = kind === "counter" ? examples : examples.filter((_, k) => k !== index);
  let mn = Infinity;
  let mx = -Infinity;
  for (const e of [...ghosts, capture]) {
    for (let i = 0; i < e.raw.length; i++) {
      for (let d = 0; d < D; d++) {
        const v = e.raw[i][d];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
  }
  const range = mx - mn || 1;
  const xOf = (i: number) => (i / (N - 1)) * W;
  const yOf = (v: number) => H - pad - ((v - mn) / range) * (H - pad * 2);

  // Excluded (cropped-out) regions dimmed.
  const xs = xOf(crop.start);
  const xe = xOf(crop.end);
  ctx.fillStyle = "rgba(4,6,14,0.62)";
  ctx.fillRect(0, 0, xs, H);
  ctx.fillRect(xe, 0, W - xe, H);

  // Baseline grid.
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 4; k++) {
    const y = (k / 4) * (H - 2) + 1;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  const drawTraces = (rows: number[][], alpha: number, width: number) => {
    const n = rows.length;
    for (let d = 0; d < D; d++) {
      ctx.strokeStyle = GEST_DIM_COLORS[d];
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = yOf(rows[i][d]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  };

  // Sibling examples ghosted underneath: run-to-run variation (and any capture
  // that doesn't belong) is visible at a glance.
  for (const ghost of ghosts) drawTraces(ghost.raw, 0.14, 1 * dpr);
  // The selected capture on top.
  drawTraces(raw, 0.85, 1.4 * dpr);
  ctx.globalAlpha = 1;

  // Crop handles (counter-example handles get the "veto" tint).
  const handleColor = kind === "counter" ? "#ff5d73" : "#00e5ff";
  for (const x of [xs, xe]) {
    ctx.strokeStyle = handleColor;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = handleColor;
    ctx.fillRect(x - 3 * dpr, H / 2 - 12 * dpr, 6 * dpr, 24 * dpr);
  }
}
