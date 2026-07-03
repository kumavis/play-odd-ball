import {
  paramsList,
  patchViewSig,
  rateSig,
  soundOnSig,
  statusSig,
  viewsSig,
} from "../runtime/state";
import { clearPatch, randomizePatch } from "../runtime/patch";
import { toggleSound } from "../runtime/sound";
import { applySelection, connectBluetoothBall, portOptionsSig, portSelectionSig } from "../runtime/midi";
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
  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>
          ODD Ball <span>· patch bay</span>
        </h1>
      </div>
      <div class="controls">
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
          title="Randomize the patch"
          onClick={() => randomizePatch(paramsList().map((p) => p.key))}
        >
          🎲 Random patch
        </button>
        <button class="tool-btn" title="Disconnect every instrument" onClick={clearPatch}>
          🧹 Clear patch
        </button>
        <button
          class="tool-btn"
          title="Save the current movement→sound layout as a profile"
          onClick={saveProfileAndReveal}
        >
          💾 Save profile
        </button>
        <button class={`sound-btn ${soundOn ? "sound-btn--on" : "sound-btn--off"}`} onClick={toggleSound}>
          {soundOn ? "🔊 Sound on" : "🔇 Sound off"}
        </button>
        <button
          class="tool-btn"
          title="Pair an ODD Ball directly over Bluetooth — no macOS MIDI setup needed"
          onClick={connectBluetoothBall}
        >
          🔵 Connect ball
        </button>
        <select
          id="portSelect"
          title="MIDI input port"
          value={portSelectionSig.value}
          onChange={(e) => applySelection((e.target as HTMLSelectElement).value)}
        >
          {portOptionsSig.value.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span class={`status ${status.on ? "status--on" : "status--off"}`}>{status.label}</span>
        <span class="rate">{rateSig.value} msg/s</span>
      </div>
    </header>
  );
}

export { patchViewSig };
