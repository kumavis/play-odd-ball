// Sound on/off intent, with the browser-autoplay dance: default ON, but the
// context usually can't start until the first user gesture, so arm a one-time
// listener that resumes it on the first interaction anywhere on the page.
import { audio, soundOnSig } from "./state";
import { saveStateSoon } from "./persist";

export let soundIntent = true; // desired on/off; audio may be gated by autoplay policy

export function setSoundOn(on: boolean): void {
  soundIntent = on;
  soundOnSig.value = on;
}

export async function toggleSound(): Promise<void> {
  if (audio.enabled) {
    audio.disable();
    setSoundOn(false);
  } else {
    await audio.enable();
    setSoundOn(true);
  }
  saveStateSoon();
}

export function armDefaultSound(): void {
  setSoundOn(true);
  const start = async () => {
    if (soundIntent && !audio.enabled) {
      await audio.enable();
      setSoundOn(true);
    }
  };
  start();
  const once = () => {
    start();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("pointerdown", once);
    window.removeEventListener("keydown", once);
  };
  window.addEventListener("pointerdown", once);
  window.addEventListener("keydown", once);
}

export function setSoundIntentFromSaved(on: boolean): void {
  if (on) armDefaultSound();
  else setSoundOn(false);
}
