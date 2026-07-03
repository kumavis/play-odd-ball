import { useRef } from "preact/hooks";
import { sensToThresh, threshToSens, gestureExamples } from "@oddball/core";
import {
  attemptsVersion,
  clamp1,
  editingExampleSig,
  editingGestureSig,
  gesturesSig,
  histOpenSig,
  paramsList,
  recMoveSig,
  recRawSig,
  recSessionSig,
  sparkBuf,
  SPARK_MAX,
  touchGestures,
} from "../runtime/state";
import { saveStateSoon } from "../runtime/persist";
import {
  deleteGesture,
  importSessionFile,
  persistGesturesSoon,
  toggleRecordMove,
} from "../runtime/gestures";
import { toggleRawRec, toggleSessionRec } from "../runtime/recording";
import { useAppEvents, useFrame, fitCanvas } from "../hooks";

export function HistDock() {
  const open = histOpenSig.value;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recSession = recSessionSig.value;
  const recRaw = recRawSig.value;
  const recMove = recMoveSig.value;
  const params = paramsList();

  useFrame(() => {
    if (!histOpenSig.peek()) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const fit = fitCanvas(cv);
    if (!fit) return;
    const { ctx, W, H, dpr } = fit;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g <= 4; g++) {
      const y = (g / 4) * (H - 2) + 1;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    for (const p of paramsList()) {
      const buf = sparkBuf[p.key];
      if (!buf || buf.length < 2) continue;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (SPARK_MAX - 1)) * W;
        const y = H - 1 - clamp1(buf[i]) * (H - 2);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  // Only the main-button state (a top-level recording with no target move).
  const mainRec = recMove && !recMove.targetId ? recMove : null;

  return (
    <div class={`hist-dock${open ? "" : " hist-dock--collapsed"}`}>
      <div class="hist-dock-head">
        <button
          class={`hist-dock-toggle${open ? " is-open" : ""}`}
          title="Toggle input history"
          onClick={() => {
            histOpenSig.value = !open;
            saveStateSoon();
          }}
        >
          <span class="hist-dock-caret">▸</span>
          <span class="hist-dock-title">Input history</span>
        </button>
        <span class="hist-legend">
          {params.map((p) => (
            <span class="item" key={p.key}>
              <span class="sw" style={{ background: p.color }}></span>
              {p.label}
            </span>
          ))}
        </span>
        <div class="hist-actions">
          <button
            class={`rec-btn${recSession ? " is-recording" : ""}`}
            title="Record this session's data (~20 Hz value snapshots) and download it"
            onClick={toggleSessionRec}
          >
            {recSession ? `⏹ Stop · ${recSession.seconds.toFixed(1)}s` : "⏺ Record"}
          </button>
          <button
            class={`rec-btn${recRaw ? " is-recording" : ""}`}
            title="High-fidelity capture: every MIDI message at full rate, including Tap/Shake/Twist notes — for analysis (like listen.py --raw)"
            onClick={toggleRawRec}
          >
            {recRaw ? `⏹ Stop raw · ${recRaw.seconds.toFixed(1)}s · ${recRaw.msgs} msg` : "⏺ Raw"}
          </button>
          <button
            class={`rec-btn${mainRec ? " is-arming" : ""}`}
            title="Record a move — repeat it a few times for a more reliable trigger — then wire it in the patch bay"
            onClick={toggleRecordMove}
          >
            {mainRec ? (mainRec.count ? `✋ ${mainRec.count} captured · finish` : "✋ Do the move…") : "✋ Record move"}
          </button>
          <button
            class="rec-btn"
            title="Turn a recorded session into a move trigger — every rep in it becomes an example"
            onClick={() => fileRef.current?.click()}
          >
            📂 Import move
          </button>
          <input
            type="file"
            accept="application/json,.json"
            hidden
            ref={fileRef}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files && input.files[0];
              if (f) importSessionFile(f);
              input.value = ""; // allow re-importing the same file
            }}
          />
        </div>
      </div>
      <canvas class="hist-canvas" ref={canvasRef}></canvas>
      <GestureList />
    </div>
  );
}

function GestureList() {
  attemptsVersion.value; // live distances update after every recognition pass
  const gestures = gesturesSig.value;
  const listRef = useRef<HTMLDivElement>(null);

  useAppEvents((e) => {
    if (e.kind !== "gestureFired") return;
    const row = listRef.current?.querySelector(`.gesture[data-id="${e.id}"]`);
    if (row) {
      row.classList.add("is-hit");
      setTimeout(() => row.classList.remove("is-hit"), 450);
    }
  });

  return (
    <div class="gesture-list" ref={listRef}>
      {gestures.map((g) => {
        const dist = typeof g._dist === "number" ? g._dist.toFixed(2) : "—";
        const nEx = gestureExamples(g).length;
        return (
          <div class="gesture" data-id={g.id} key={g.id}>
            <span class="g-dot" style={{ background: g.color }}></span>
            <span class="g-name">{g.name}</span>
            <span class="g-ex" title={`${nEx} example${nEx === 1 ? "" : "s"} building this trigger`}>
              {nEx}×
            </span>
            <span class="g-dist">d {dist}</span>
            <span class="g-sens-label">sensitivity</span>
            <input
              class="g-sens"
              type="range"
              min="0"
              max="100"
              value={threshToSens(g.threshold)}
              onInput={(e) => {
                g.threshold = sensToThresh(+(e.target as HTMLInputElement).value);
                g.thresholdManual = true;
                touchGestures();
                persistGesturesSoon();
              }}
            />
            <button class="g-edit" title="Edit / crop move" onClick={() => {
              editingExampleSig.value = { kind: "example", index: 0 };
              editingGestureSig.value = g.id;
            }}>
              ✎
            </button>
            <button class="g-del" title="Delete move" onClick={() => deleteGesture(g.id)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
