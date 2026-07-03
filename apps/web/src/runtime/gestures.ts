// Gesture CRUD, move recording (examples + counter-examples), session import,
// and the recognizer event wiring that turns matches into patch-bay triggers.
import {
  activeRegions,
  createGesture,
  gestureExamples,
  makeExample,
  refreshGestureTemplates,
  serializeGestures,
  gestureFromData,
  sessionFeatureFrames,
  SEQ_GAP_DEFAULT,
  type ExampleCapture,
  type Gesture,
} from "@oddball/core";
import {
  attemptsVersion,
  editingExampleSig,
  editingGestureSig,
  emitAppEvent,
  engine,
  gestureEnv,
  gesturesSig,
  logEvent,
  recMoveSig,
  touchGestures,
} from "./state";
import { dropConnectionsFor, fireChain } from "./patch";
import { GESTURE_KEY } from "./persist";

const recognizer = engine.recognizer;

export function persistGestures(): void {
  try {
    localStorage.setItem(GESTURE_KEY, JSON.stringify(serializeGestures(gesturesSig.peek())));
  } catch {
    /* storage unavailable — ignore */
  }
}

let gPersistTimer: ReturnType<typeof setTimeout> | undefined;
export function persistGesturesSoon(): void {
  clearTimeout(gPersistTimer);
  gPersistTimer = setTimeout(persistGestures, 200);
}

export function loadGestures(): void {
  let data: unknown = null;
  try {
    data = JSON.parse(localStorage.getItem(GESTURE_KEY) || "null");
  } catch {
    data = null;
  }
  if (!Array.isArray(data)) return;
  const gestures = data.map(gestureFromData).filter(Boolean) as Gesture[];
  gesturesSig.value = gestures;
  recognizer.gestures = gestures;
  touchGestures();
}

/** Swap in a whole new set of moves (profile load). */
export function replaceGestures(data: unknown[]): void {
  for (const g of gesturesSig.peek()) {
    dropConnectionsFor("g:" + g.id);
    delete gestureEnv[g.id];
  }
  const gestures = (Array.isArray(data) ? data : []).map(gestureFromData).filter(Boolean) as Gesture[];
  gesturesSig.value = gestures;
  touchGestures();
  persistGestures();
}

export function saveGesture(name: string | null, exampleCaptures: ExampleCapture[]): Gesture {
  const gestures = gesturesSig.peek();
  const g = createGesture(name, exampleCaptures, gestures.length);
  gestures.push(g);
  touchGestures();
  persistGestures();
  const n = g.examples.length;
  logEvent("GESTURE", `saved “${g.name}”${n > 1 ? ` · ${n} examples` : ""} — edit or wire it up`, "note");
  return g;
}

export function addExamplesToGesture(g: Gesture, exampleCaptures: ExampleCapture[]): void {
  for (const ex of exampleCaptures) g.examples.push(makeExample(ex));
  refreshGestureTemplates(g);
  touchGestures();
  persistGestures();
}

/** Add counter-examples (captures that must NOT fire this move) and rebuild. */
export function addCounterExamplesToGesture(g: Gesture, exampleCaptures: ExampleCapture[]): void {
  const list = (g.counterExamples ||= []);
  for (const ex of exampleCaptures) list.push(makeExample(ex));
  refreshGestureTemplates(g);
  touchGestures();
  persistGestures();
}

/** Promote a recent recognition attempt's motion into a counter-example. */
export function addAttemptAsCounterExample(g: Gesture, attemptT: number): boolean {
  const cand = recognizer.candidateAt(attemptT);
  if (!cand) return false;
  addCounterExamplesToGesture(g, [{ rows: cand.rows, durMs: cand.durMs }]);
  logEvent("GESTURE", `added that attempt as a counter-example of “${g.name}”`, "note");
  return true;
}

export function deleteGesture(id: string): void {
  const g = gesturesSig.peek().find((x) => x.id === id);
  dropConnectionsFor("g:" + id);
  delete gestureEnv[id];
  gesturesSig.value = gesturesSig.peek().filter((x) => x.id !== id);
  touchGestures();
  persistGestures();
  if (editingGestureSig.peek() === id) editingGestureSig.value = null;
  if (g) logEvent("GESTURE", `deleted “${g.name}”`, "note");
}

// ---- Move recording ---------------------------------------------------------
function syncRecMoveSig(): void {
  const rec = recognizer.recording;
  recMoveSig.value = rec ? { targetId: rec.targetId, kind: rec.kind, count: rec.examples.length } : null;
}

/** Arm (or finish) recording a new move from the main Record button. */
export function toggleRecordMove(): void {
  if (recognizer.recording) {
    finishRecordMove();
    return;
  }
  // No naming prompt up front (a blocking dialog would stall the MIDI loop):
  // the move is created with a default name on finish and the editor opens
  // with the name field selected, ready to type over.
  recognizer.startRecording(null, null, "example");
  syncRecMoveSig();
}

/** Arm (or finish) capturing extra examples — or counter-examples — for one move. */
export function toggleAddExample(g: Gesture, kind: "example" | "counter" = "example"): void {
  if (recognizer.recording) {
    finishRecordMove();
    return;
  }
  recognizer.startRecording(g.id, g.name, kind);
  syncRecMoveSig();
}

export function finishRecordMove(): void {
  const rec = recognizer.finishRecording();
  syncRecMoveSig();
  if (!rec || !rec.examples.length) {
    if (rec) logEvent("GESTURE", "recording cancelled — no move captured", "note");
    return;
  }
  if (rec.targetId) {
    const g = gesturesSig.peek().find((x) => x.id === rec.targetId);
    if (!g) {
      openForRename(saveGesture(rec.name, rec.examples));
      return;
    }
    const n = rec.examples.length;
    if (rec.kind === "counter") {
      addCounterExamplesToGesture(g, rec.examples);
      logEvent(
        "GESTURE",
        `added ${n} counter-example${n === 1 ? "" : "s"} to “${g.name}” · ${g.counterExamples!.length} total`,
        "note"
      );
      editingExampleSig.value = { kind: "counter", index: g.counterExamples!.length - 1 };
    } else {
      addExamplesToGesture(g, rec.examples);
      logEvent(
        "GESTURE",
        `added ${n} example${n === 1 ? "" : "s"} to “${g.name}” · ${gestureExamples(g).length} total`,
        "note"
      );
      editingExampleSig.value = { kind: "example", index: gestureExamples(g).length - 1 };
    }
  } else {
    openForRename(saveGesture(rec.name, rec.examples));
  }
}

/** Open a just-created move in the editor; the name field selects itself. */
function openForRename(g: Gesture): void {
  editingExampleSig.value = { kind: "example", index: 0 };
  editingGestureSig.value = g.id;
}

// ---- Session-file import ------------------------------------------------------
/** Turn a recorded session JSON (from the Record button) into a move: every
 * rep found in it becomes one example. */
export function importSessionFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    let data: unknown = null;
    try {
      data = JSON.parse(String(reader.result));
    } catch {
      data = null;
    }
    const frames = sessionFeatureFrames(data);
    if (!frames) {
      logEvent("IMPORT", "that file has no usable session samples", "note");
      return;
    }
    const regions = activeRegions(frames);
    if (!regions.length) {
      logEvent("IMPORT", "couldn't find a move in that recording", "note");
      return;
    }
    const suggested =
      (file.name || "").replace(/\.json$/i, "").replace(/^oddball-session-.*$/, "").trim() || null;
    openForRename(saveGesture(suggested, regions));
  };
  reader.readAsText(file);
}

// ---- Recognizer event wiring ---------------------------------------------------
export function wireRecognizerEvents(): void {
  recognizer.on("fired", (g, d) => {
    gestureEnv[g.id] = 1;
    // Trigger each connected instrument on its own envelope, staggered by the
    // move's spacing in play order, so the sounds fire as a sequence.
    fireChain("g:" + g.id, g.seqGap ?? SEQ_GAP_DEFAULT);
    logEvent("GESTURE", `${g.name} matched · d=${d.toFixed(2)}`, "note");
    emitAppEvent({ kind: "gestureFired", id: g.id });
  });
  recognizer.on("ambiguous", (best, second) => {
    logEvent(
      "GESTURE",
      `ambiguous — ${best.g.name} d=${best.d.toFixed(2)} vs ${second.g.name} d=${second.d.toFixed(2)} · not firing`,
      "note"
    );
    attemptsVersion.value++;
  });
  recognizer.on("exampleCaptured", (count) => {
    syncRecMoveSig();
    const kind = recognizer.recording?.kind === "counter" ? "counter-example" : "example";
    logEvent("GESTURE", `captured ${kind} ${count} — repeat or finish`, "note");
  });
  recognizer.on("attempt", () => {
    attemptsVersion.value++;
  });
}
