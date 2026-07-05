// Persistence: patch config + settings survive a reload. Keys and schema match
// the original vanilla app exactly, so existing users keep their setups.
import {
  clamp1,
  connections,
  histOpenSig,
  mkConn,
  paramByKey,
  patchViewSig,
  sensitivitySig,
  seqCfg,
  SEQ_GAP_DEFAULT,
  touchConnections,
  viewsSig,
  type SeqCfg,
} from "./state";
import { soundIntent } from "./sound";

export const STORAGE_KEY = "oddball.patchbay.v1";
export const GESTURE_KEY = "oddball.gestures.v1";
export const PROFILE_KEY = "oddball.profiles.v1";

let loading = true; // suppress saves while restoring on startup
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function doneLoading(): void {
  loading = false;
}

// ---- Schema migration ------------------------------------------------------
// v2 corrected the ODD Ball CC mapping (see docs/MIDI.md): X/Y/Z orientation is
// on CC3-5, not CC0-2 — so the modulation-source names were reassigned. Data
// saved under the old scheme is remapped to whatever routed the SAME CC before,
// so a restored patch keeps its exact physical behaviour.
export const SCHEMA_VERSION = 2;
const SOURCE_MIGRATION_V2: Record<string, string> = {
  tilt_x: "shake", // was CC0
  tilt_y: "twist", // was CC1
  tilt_z: "freefall", // was CC2
  cc3: "tilt_x", // CC3 (X orientation)
  cc4: "tilt_y", // CC4 (Y orientation)
  cc5: "tilt_z", // CC5 (Z orientation)
  cc6: "movement", // CC6 (movement)
};
const migrateSource = (src: string) => SOURCE_MIGRATION_V2[src] || src;

/** Rewrite source names inside a { connections, seqCfg } bundle in place. */
export function migrateBundleV2<T extends { connections?: any; seqCfg?: any }>(bundle: T): T {
  if (!bundle || typeof bundle !== "object") return bundle;
  if (bundle.connections && typeof bundle.connections === "object") {
    for (const k in bundle.connections) {
      const c = bundle.connections[k];
      if (c && typeof c.source === "string") c.source = migrateSource(c.source);
    }
  }
  if (bundle.seqCfg && typeof bundle.seqCfg === "object") {
    const migrated: Record<string, unknown> = {};
    for (const src in bundle.seqCfg) migrated[migrateSource(src)] = bundle.seqCfg[src];
    bundle.seqCfg = migrated;
  }
  return bundle;
}

export function serializeState() {
  return {
    schema: SCHEMA_VERSION,
    connections,
    seqCfg,
    sensitivity: sensitivitySig.peek(),
    sound: soundIntent,
    views: viewsSig.peek(),
    histOpen: histOpenSig.peek(),
    patchView: patchViewSig.peek(),
  };
}

export function saveState(): void {
  if (loading) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
  } catch {
    /* storage unavailable (private mode / quota) — ignore */
  }
}

/** Coalesce bursts of writes (e.g. dragging an editor slider) into one save. */
export function saveStateSoon(): void {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

export function loadState(): any {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved && (saved.schema || 1) < SCHEMA_VERSION) migrateBundleV2(saved);
    return saved;
  } catch {
    return null;
  }
}

/** Apply seqCfg entries from a saved bundle, validating each. */
export function applySeqCfg(saved: Record<string, SeqCfg> | undefined, replace = false): void {
  if (replace) for (const k in seqCfg) delete seqCfg[k];
  if (!saved || typeof saved !== "object") return;
  for (const src in saved) {
    const c = saved[src];
    if (c && (c.mode === "together" || c.mode === "sequence")) {
      seqCfg[src] = { mode: c.mode, gap: typeof c.gap === "number" ? c.gap : SEQ_GAP_DEFAULT };
    }
  }
}

/** Apply connection entries from a saved bundle over the current set,
 * validating each field so a stale or corrupt entry can never break the app. */
export function applyConnections(saved: Record<string, any> | undefined): void {
  if (!saved) return;
  for (const instKey in connections) {
    const c = saved[instKey];
    if (c && typeof c.source === "string" && paramByKey(c.source)) {
      connections[instKey] = mkConn(
        c.source,
        typeof c.atten === "number" ? clamp1(c.atten) : 1,
        typeof c.thresh === "number" ? clamp1(c.thresh) : 0
      );
      if (typeof c.order === "number") connections[instKey]!.order = c.order;
      // The optional note input only survives if its source still exists.
      if (typeof c.noteSource === "string" && paramByKey(c.noteSource)) {
        connections[instKey]!.noteSource = c.noteSource;
      }
    } else if (c === null) {
      connections[instKey] = null;
    }
  }
  touchConnections();
}

/** Restore the main saved state bundle (connections + seqCfg + sensitivity). */
export function applySavedState(saved: any): void {
  if (!saved) return;
  applyConnections(saved.connections);
  applySeqCfg(saved.seqCfg);
  if (typeof saved.sensitivity === "number") {
    sensitivitySig.value = Math.max(0, Math.min(100, saved.sensitivity));
  }
}
