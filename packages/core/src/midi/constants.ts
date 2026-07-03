// MIDI facts about the ODD Ball (see docs/MIDI.md in the repo root).
//
// The ball sends everything on channel 1: Notes 0/1/2 for Tap/Shake/Twist and
// CC0-6 for the continuous signals. It also emits CC7 — which is MIDI Channel
// Volume and can mute a DAW — so consumers usually want to drop it.

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Scientific pitch name ("C-1", "A4") for a MIDI note number. */
export const noteName = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** The ball identifies the gesture by note number. */
export const NOTE_GESTURE: Record<number, string> = { 0: "Tap", 1: "Shake", 2: "Twist" };
export const NOTE_TAP = 0;

// Documented CC assignments (docs/MIDI.md):
export const CC_SHAKE = 0;
export const CC_TWIST = 1;
export const CC_FREEFALL = 2;
export const CC_ORIENT_X = 3;
export const CC_ORIENT_Y = 4;
export const CC_ORIENT_Z = 5;
export const CC_MOVEMENT = 6;
/** CC7 is MIDI Channel Volume — the ball emits it but it should be ignored. */
export const CC_VOLUME = 7;

/** The orientation CCs (X/Y/Z) that trace the pose path used for gestures and roll. */
export const ORIENTATION_CCS = [CC_ORIENT_X, CC_ORIENT_Y, CC_ORIENT_Z] as const;

// Standard BLE-MIDI GATT identifiers (midi.org spec).
export const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
export const BLE_MIDI_CHARACTERISTIC = "7772e5db-3868-4112-a1a9-f2669d106bf3";
