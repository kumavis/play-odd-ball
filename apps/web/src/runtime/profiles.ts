// Saved profiles: snapshot the whole movement→sound layout. A profile bundles
// the patch connections, the moves themselves (self-contained: reloading it
// recreates the gesture triggers) and the roll sensitivity.
import { serializeGestures } from "@oddball/core";
import {
  audio,
  connections,
  connEditorSig,
  editingGestureSig,
  gesturesSig,
  logEvent,
  profilesSig,
  sensitivitySig,
  seqCfg,
  type Profile,
} from "./state";
import {
  applyConnections,
  applySeqCfg,
  migrateBundleV2,
  PROFILE_KEY,
  saveState,
  SCHEMA_VERSION,
} from "./persist";
import { disconnect, resetSeqRuntime } from "./patch";
import { INSTRUMENTS } from "./state";
import { replaceGestures } from "./gestures";

export function loadProfiles(): void {
  let profiles: Profile[] = [];
  try {
    const data = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    profiles = Array.isArray(data) ? data.filter((p) => p && p.id) : [];
  } catch {
    profiles = [];
  }
  // Migrate pre-v2 profiles (old CC source names) and persist the upgrade once.
  let changed = false;
  for (const p of profiles) {
    if (((p as any).schema || 1) < SCHEMA_VERSION) {
      migrateBundleV2(p);
      (p as any).schema = SCHEMA_VERSION;
      changed = true;
    }
  }
  profilesSig.value = profiles;
  if (changed) writeProfiles();
}

export function writeProfiles(): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profilesSig.peek()));
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * Save the current layout as a profile. No blocking prompt (the original used
 * window.prompt, which froze the MIDI/animation loop — see
 * docs/CONVERSION-NOTES.md): the profile is created with a default name and
 * the Profiles panel's inline rename field takes it from there.
 * Returns the new profile's id so the UI can focus its name field.
 */
export function saveCurrentProfile(): string {
  const profiles = profilesSig.peek();
  const p: Profile = {
    id: "p" + Date.now().toString(36),
    name: `Profile ${profiles.length + 1}`,
    created: Date.now(),
    schema: SCHEMA_VERSION,
    connections: serializeConnections(),
    seqCfg: JSON.parse(JSON.stringify(seqCfg)),
    gestures: serializeGestures(gesturesSig.peek()),
    sensitivity: sensitivitySig.peek(),
  };
  profilesSig.value = [...profiles, p];
  writeProfiles();
  logEvent("PROFILE", `saved “${p.name}” — rename it in the Profiles panel`, "note");
  return p.id;
}

function serializeConnections(): Profile["connections"] {
  const out: Profile["connections"] = {};
  for (const k in connections) {
    const c = connections[k];
    out[k] = c ? { source: c.source, atten: c.atten, thresh: c.thresh, order: c.order } : null;
  }
  return out;
}

export function applyProfile(id: string): void {
  const profile = profilesSig.peek().find((p) => p.id === id);
  if (!profile) return;
  connEditorSig.value = null;
  editingGestureSig.value = null;

  // Clear the current patch (removes cables) and swap the moves wholesale.
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  replaceGestures(profile.gestures as unknown[]);

  // Restore per-source playback config (together vs. in order).
  applySeqCfg(profile.seqCfg, true);

  // Now that every source exists, apply the saved connections.
  audio.chimesOn = false;
  applyConnections(profile.connections || {});
  if (connections.chimes) audio.chimesOn = true;

  if (typeof profile.sensitivity === "number") {
    sensitivitySig.value = Math.max(0, Math.min(100, profile.sensitivity));
  }
  saveState();
  logEvent("PROFILE", `loaded “${profile.name}”`, "note");
}

export function deleteProfile(id: string): void {
  profilesSig.value = profilesSig.peek().filter((p) => p.id !== id);
  writeProfiles();
}

export function renameProfile(id: string, name: string): void {
  const p = profilesSig.peek().find((x) => x.id === id);
  if (!p) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === p.name) return;
  p.name = trimmed;
  profilesSig.value = [...profilesSig.peek()];
  writeProfiles();
}
