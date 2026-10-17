// Sound on/off intent, with the browser-autoplay dance: default ON, but the
// context usually can't start until a user gesture, so keep an unlock listener
// armed that resumes it on the next interaction anywhere on the page — until
// the context is actually running.
//
// Phones need care here: a touch `pointerdown` is NOT a user activation (only
// pointerup / touchend / click are), so a one-shot pointerdown listener left
// mobile audio silent while the button claimed "Sound on". iOS also suspends
// ("interrupts") the context on calls, lock and backgrounding, so the unlock
// re-arms whenever the context drops out while sound is wanted.
import { audio, audioRunningSig, soundOnSig } from "./state";
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
    setSoundOn(true);
    await startAudio();
  }
  saveStateSoon();
}

const UNLOCK_EVENTS = ["pointerup", "touchend", "click", "keydown"] as const;
let unlockArmed = false;

function armUnlock(): void {
  if (unlockArmed) return;
  unlockArmed = true;
  for (const ev of UNLOCK_EVENTS) window.addEventListener(ev, onUnlockGesture, { capture: true, passive: true });
}

function disarmUnlock(): void {
  if (!unlockArmed) return;
  unlockArmed = false;
  for (const ev of UNLOCK_EVENTS) window.removeEventListener(ev, onUnlockGesture, { capture: true });
}

function onUnlockGesture(): void {
  if (!soundIntent) return disarmUnlock();
  void startAudio();
}

/** Create/resume the context; mirrors its state into audioRunningSig. The
 * first call happens without a gesture, so its resume may stay pending until
 * a later gesture-driven call gets through — the unlock stays armed till then. */
export async function startAudio(): Promise<void> {
  const first = !audio.ctx;
  const pending = audio.enable();
  if (first && audio.ctx) {
    audio.ctx.addEventListener("statechange", () => {
      const running = audio.ctx!.state === "running";
      audioRunningSig.value = running;
      if (running) disarmUnlock();
      else if (soundIntent) armUnlock();
    });
  }
  if (audio.ctx?.state !== "running") armUnlock();
  await pending;
  audioRunningSig.value = audio.ctx?.state === "running";
  if (audioRunningSig.peek()) disarmUnlock();
}

export function armDefaultSound(): void {
  setSoundOn(true);
  armUnlock();
  void startAudio();
  // Coming back to the tab (or unlocking the phone) after an interruption.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && soundIntent && audio.ctx && audio.ctx.state !== "running") void startAudio();
  });
}

export function setSoundIntentFromSaved(on: boolean): void {
  if (on) armDefaultSound();
  else setSoundOn(false);
}
