// App bootstrap: restore persisted state, wire events, start the loops.
import { audio, bleDiag, connections, engine, histOpenSig, patchViewSig, viewsSig } from "./state";
import { applySavedState, doneLoading, loadState, saveState } from "./persist";
import { loadGestures, wireRecognizerEvents } from "./gestures";
import { loadProfiles } from "./profiles";
import { initMidi, onMidiMessage } from "./midi";
import { setSoundIntentFromSaved } from "./sound";
import { startLoop } from "./loop";

export async function initRuntime(): Promise<void> {
  // Gestures must load before the patch config so connections that reference a
  // gesture source ("g:<id>") validate against a source that exists.
  loadGestures();

  const saved = loadState();
  applySavedState(saved);
  loadProfiles();
  wireRecognizerEvents();

  audio.chimesOn = !!connections.chimes;

  if (saved && saved.views && typeof saved.views === "object") {
    viewsSig.value = { ...saved.views };
  }
  if (saved && typeof saved.histOpen === "boolean") histOpenSig.value = saved.histOpen;
  patchViewSig.value = saved && saved.patchView === "orbit" ? "orbit" : "rack";

  setSoundIntentFromSaved(saved && typeof saved.sound === "boolean" ? saved.sound : true);

  // Everything restored — allow saves and persist the current state once.
  doneLoading();
  saveState();

  startLoop();

  // Debug/test hook: lets a console (or automated test) drive the app with
  // synthetic MIDI without a physical ball, e.g.
  //   __oddball.feed("sim", [0xb0, 3, 64])
  (window as any).__oddball = {
    engine,
    connections,
    bleDiag,
    feed: (deviceId: string, data: number[]) => onMidiMessage(deviceId, data),
  };

  await initMidi();
}
