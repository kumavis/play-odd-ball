// Floating per-cable editor: threshold + attenuation, plus playback controls
// (together vs. in-order, chain position, step spacing) when the cable's
// source drives more than one instrument.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  clamp1,
  connections,
  connEditorSig,
  connVersion,
  INSTRUMENTS,
  isGestureSource,
  gestureBySource,
  paramByKey,
  paramsList,
  paramValue,
  touchConnections,
} from "../runtime/state";
import {
  disconnect,
  moveInSequence,
  seqConfig,
  seqGapFor,
  setSeqMode,
  shape,
  siblingsOf,
  sourceSequenced,
} from "../runtime/patch";
import { saveStateSoon } from "../runtime/persist";
import { persistGesturesSoon } from "../runtime/gestures";
import { useFrame } from "../hooks";

export function ConnEditor() {
  const editing = connEditorSig.value;
  connVersion.value; // re-render when the patch changes under us
  const boxRef = useRef<HTMLDivElement>(null);
  const meterInRef = useRef<HTMLDivElement>(null);
  const meterOutRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0); // slider labels re-render on input

  const conn = editing ? connections[editing.instKey] : null;

  // Position: near the click, kept on-screen (measured after first render).
  useEffect(() => {
    const ed = boxRef.current;
    if (!ed || !editing) return;
    const w = ed.offsetWidth || 240;
    const h = ed.offsetHeight || 210;
    let x = editing.x + 14;
    let y = editing.y - 20;
    x = Math.min(x, window.innerWidth - w - 12);
    y = Math.min(Math.max(12, y), window.innerHeight - h - 12);
    ed.style.left = `${x}px`;
    ed.style.top = `${y}px`;
  }, [editing]);

  // Click anywhere outside the editor / a cable closes it.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".conn-editor")) return;
      if (t.closest(".cable-hit")) return;
      connEditorSig.value = null;
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [editing]);

  // Live in/out meter.
  useFrame(() => {
    const e = connEditorSig.peek();
    const c = e && connections[e.instKey];
    if (!c) return;
    if (meterInRef.current) meterInRef.current.style.width = `${clamp1(paramValue(c.source)) * 100}%`;
    if (meterOutRef.current) meterOutRef.current.style.width = `${clamp1(shape(c, e!.instKey)) * 100}%`;
  });

  if (!editing || !conn) return <div class="conn-editor conn-editor--hidden" />;

  const inst = INSTRUMENTS.find((i) => i.key === editing.instKey);
  const sibs = siblingsOf(conn.source);
  const showSeq = sibs.length >= 2;
  const gesture = isGestureSource(conn.source);
  const sequenced = sourceSequenced(conn.source);
  const idx = sibs.indexOf(editing.instKey);
  const gap = seqGapFor(conn.source);
  const mode = gesture ? "sequence" : seqConfig(conn.source).mode;

  return (
    <div class="conn-editor" ref={boxRef}>
      <div class="ce-head">
        <span class="ce-title">
          {paramByKey(conn.source)?.label ?? conn.source} → {inst?.label ?? editing.instKey}
        </span>
        <button class="ce-close" onClick={() => (connEditorSig.value = null)}>
          ×
        </button>
      </div>
      <div class="ce-row">
        <label>
          threshold <span class="ce-num">{conn.thresh.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min="0"
          max="95"
          value={Math.round(conn.thresh * 100)}
          onInput={(e) => {
            conn.thresh = +(e.target as HTMLInputElement).value / 100;
            bump((n) => n + 1);
            saveStateSoon();
          }}
        />
      </div>
      <div class="ce-row">
        <label>
          attenuation <span class="ce-num">{conn.atten.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(conn.atten * 100)}
          onInput={(e) => {
            conn.atten = +(e.target as HTMLInputElement).value / 100;
            bump((n) => n + 1);
            saveStateSoon();
          }}
        />
      </div>
      <div class="ce-meter">
        <div class="ce-meter-in" ref={meterInRef}></div>
        <div class="ce-meter-out" ref={meterOutRef}></div>
      </div>
      {inst?.noted && (
        <div class="ce-row ce-note">
          <label title="A second input: this parameter's live value picks the pitch of each note this instrument plays. “auto” keeps the instrument's own melody logic.">
            note from
          </label>
          <select
            value={conn.noteSource ?? ""}
            onChange={(e) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val) conn.noteSource = val;
              else delete conn.noteSource;
              touchConnections();
              saveStateSoon();
              bump((n) => n + 1);
            }}
          >
            <option value="">auto (own melody)</option>
            {paramsList().map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {showSeq && (
        <div class="ce-seq">
          <div class="ce-seq-head">
            playback · <span>{`step ${idx + 1} / ${sibs.length}`}</span>
          </div>
          {!gesture && (
            <div class="ce-seq-mode">
              <button
                class={`ce-mode-btn${mode === "together" ? " is-active" : ""}`}
                title="All sounds play at the same time"
                onClick={() => setSeqMode(conn.source, "together")}
              >
                together
              </button>
              <button
                class={`ce-mode-btn${mode === "sequence" ? " is-active" : ""}`}
                title="Sounds play one after another, in order"
                onClick={() => setSeqMode(conn.source, "sequence")}
              >
                in order
              </button>
            </div>
          )}
          {sequenced && (
            <div class="ce-seq-body">
              <div class="ce-seq-order">
                <button class="ce-seq-btn" title="Play earlier" disabled={idx <= 0} onClick={() => moveInSequence(editing.instKey, -1)}>
                  ◀ earlier
                </button>
                <button
                  class="ce-seq-btn"
                  title="Play later"
                  disabled={idx >= sibs.length - 1}
                  onClick={() => moveInSequence(editing.instKey, +1)}
                >
                  later ▶
                </button>
              </div>
              <div class="ce-row">
                <label>
                  spacing <span class="ce-num">{gap}</span> ms
                </label>
                <input
                  type="range"
                  min="0"
                  max="600"
                  step="10"
                  value={gap}
                  onInput={(e) => {
                    const val = +(e.target as HTMLInputElement).value;
                    const g = gestureBySource(conn.source);
                    if (g) {
                      g.seqGap = val;
                      persistGesturesSoon();
                    } else {
                      seqConfig(conn.source).gap = val;
                      saveStateSoon();
                    }
                    touchConnections();
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}
      <button class="ce-disconnect" onClick={() => disconnect(editing.instKey)}>
        Disconnect
      </button>
    </div>
  );
}
