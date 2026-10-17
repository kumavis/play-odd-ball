import { useRef } from "preact/hooks";
import {
  audio,
  audioRunningSig,
  bpmSig,
  paramsList,
  patchViewSig,
  rateSig,
  setBpm,
  soundOnSig,
  statusSig,
  viewsSig,
} from "../runtime/state";
import { clearPatch, psyJamPatch, randomizePatch } from "../runtime/patch";
import { saveStateSoon } from "../runtime/persist";
import { toggleSound } from "../runtime/sound";
import { applySelection, connectBluetoothBall, portOptionsSig, portSelectionSig } from "../runtime/midi";
import { useFrame } from "../hooks";
import { saveProfileAndReveal } from "./panels";

const VIEWS = [
  ["ball", "Ball"],
  ["roll", "Roll"],
  ["cc", "CCs"],
  ["log", "Log"],
  ["profiles", "Profiles"],
] as const;

export function setView(view: string, on: boolean): void {
  viewsSig.value = { ...viewsSig.peek(), [view]: on };
}

export function TopBar() {
  const views = viewsSig.value;
  const status = statusSig.value;
  const soundOn = soundOnSig.value;
  // Browsers (phones especially) won't start audio before a tap or click; say
  // so instead of claiming "Sound on" while nothing plays.
  const soundLabel = !soundOn ? "🔇 Sound off" : audioRunningSig.value ? "🔊 Sound on" : "🔈 Start sound";
  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>
          ODD Ball <span>· patch bay</span>
        </h1>
      </div>
      <div class="link-state">
        <span class={`status ${status.on ? "status--on" : "status--off"}`}>{status.label}</span>
        <span class="rate">{rateSig.value} msg/s</span>
      </div>
      <div class="controls">
        <button
          class={`sound-btn ${soundOn ? "sound-btn--on" : "sound-btn--off"}${soundOn && !audioRunningSig.value ? " is-waiting" : ""}`}
          onClick={toggleSound}
        >
          {soundLabel}
        </button>
        <button
          class="tool-btn connect-btn"
          title="Pair an ODD Ball directly over Bluetooth — no macOS MIDI setup needed"
          onClick={connectBluetoothBall}
        >
          🔵 <span class="lbl">Connect ball</span>
          <span class="lbl-short">Connect</span>
        </button>
        <Tempo />
        <div class="views">
          {VIEWS.map(([key, label]) => (
            <button
              key={key}
              class={`view-btn${views[key] ? " is-active" : ""}`}
              onClick={() => setView(key, !views[key])}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          class="tool-btn"
          title="Psy jam: patch a ready-made psytrance groove (roll for kick + bass, move for hats + arp, twist for the lead)"
          aria-label="Psy jam preset"
          onClick={psyJamPatch}
        >
          🌀 <span class="lbl">Psy jam</span>
        </button>
        <button
          class="tool-btn"
          title="Randomize the patch (uses the expanded instrument groups)"
          aria-label="Random patch"
          onClick={() => randomizePatch(paramsList().map((p) => p.key))}
        >
          🎲 <span class="lbl">Random</span>
        </button>
        <button class="tool-btn" title="Disconnect every instrument" aria-label="Clear patch" onClick={clearPatch}>
          🧹 <span class="lbl">Clear</span>
        </button>
        <button
          class="tool-btn"
          title="Save the current movement→sound layout as a profile"
          aria-label="Save profile"
          onClick={saveProfileAndReveal}
        >
          💾 <span class="lbl">Save</span>
        </button>
        <select
          id="portSelect"
          title="MIDI input port"
          aria-label="MIDI input port"
          value={portSelectionSig.value}
          onChange={(e) => applySelection((e.target as HTMLSelectElement).value)}
        >
          {portOptionsSig.value.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}

/** BPM for the tempo-locked instruments, with a light that flashes on the beat. */
function Tempo() {
  const bpm = bpmSig.value;
  const dotRef = useRef<HTMLSpanElement>(null);
  const change = (next: number) => {
    setBpm(next);
    saveStateSoon();
  };
  useFrame(() => {
    const dot = dotRef.current;
    if (!dot) return;
    const beat = audio.beatPosition();
    const on = beat !== null && beat - Math.floor(beat) < 0.18;
    dot.classList.toggle("is-on", on);
    dot.classList.toggle("is-bar", on && Math.floor(beat!) % 4 === 0);
  });
  return (
    <div class="tempo" title="Tempo of the BPM-locked (psytrance) instruments">
      <span class="tempo-dot" ref={dotRef} aria-hidden="true"></span>
      <button onClick={() => change(bpm - 1)} aria-label="Slower">
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min="60"
        max="200"
        value={bpm}
        aria-label="Tempo in BPM"
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          change(+el.value);
          el.value = String(bpmSig.peek()); // show the clamped value
        }}
      />
      <span class="tempo-unit">BPM</span>
      <button onClick={() => change(bpm + 1)} aria-label="Faster">
        +
      </button>
    </div>
  );
}

export { patchViewSig };
