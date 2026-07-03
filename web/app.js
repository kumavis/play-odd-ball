"use strict";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
// The ball identifies the gesture by note number (see docs/MIDI.md).
const NOTE_GESTURE = { 0: "Tap", 1: "Shake", 2: "Twist" };
const NOTE_TAP = 0;
const clamp1 = (v) => Math.max(0, Math.min(1, v));
// Escape untrusted text (gesture/profile/device names, error messages) before
// interpolating it into an HTML string.
const escHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const els = {
  portSelect: document.getElementById("portSelect"),
  status: document.getElementById("status"),
  rate: document.getElementById("rate"),
  ccMeters: document.getElementById("ccMeters"),
  log: document.getElementById("log"),
  orb: document.getElementById("orb"),
  shadow: document.getElementById("shadow"),
  ripples: document.getElementById("ripples"),
  lastNote: document.getElementById("lastNote"),
  lastNoteSub: document.getElementById("lastNoteSub"),
  hint: document.getElementById("hint"),
  soundToggle: document.getElementById("soundToggle"),
  btBall: document.getElementById("btBall"),
  randomPatch: document.getElementById("randomPatch"),
  clearPatch: document.getElementById("clearPatch"),
  saveProfile: document.getElementById("saveProfile"),
  saveProfilePanel: document.getElementById("saveProfilePanel"),
  profileList: document.getElementById("profileList"),
  rollFill: document.getElementById("rollFill"),
  rollVal: document.getElementById("rollVal"),
  gateMark: document.getElementById("gateMark"),
  rollRate: document.getElementById("rollRate"),
  sens: document.getElementById("sens"),
  sensVal: document.getElementById("sensVal"),
  graph: document.getElementById("graph"),
  orbit: document.getElementById("orbit"),
  orbitCanvas: document.getElementById("orbitCanvas"),
  patchViews: document.getElementById("patchViews"),
  histDock: document.getElementById("histDock"),
  histToggle: document.getElementById("histToggle"),
  histCanvas: document.getElementById("histCanvas"),
  histLegend: document.getElementById("histLegend"),
  recSession: document.getElementById("recSession"),
  recRaw: document.getElementById("recRaw"),
  recMove: document.getElementById("recMove"),
  importMove: document.getElementById("importMove"),
  importFile: document.getElementById("importFile"),
  gestureList: document.getElementById("gestureList"),
  gestureEditor: document.getElementById("gestureEditor"),
  gestureBackdrop: document.getElementById("gestureBackdrop"),
  geDot: document.getElementById("geDot"),
  geName: document.getElementById("geName"),
  geClose: document.getElementById("geClose"),
  geCanvas: document.getElementById("geCanvas"),
  geExStrip: document.getElementById("geExStrip"),
  geAddExample: document.getElementById("geAddExample"),
  geDelExample: document.getElementById("geDelExample"),
  geCropInfo: document.getElementById("geCropInfo"),
  geAutoTrim: document.getElementById("geAutoTrim"),
  geCropReset: document.getElementById("geCropReset"),
  geSens: document.getElementById("geSens"),
  geSensVal: document.getElementById("geSensVal"),
  geRot: document.getElementById("geRot"),
  geCool: document.getElementById("geCool"),
  geCoolVal: document.getElementById("geCoolVal"),
  geDist: document.getElementById("geDist"),
  geThreshShow: document.getElementById("geThreshShow"),
  geMatch: document.getElementById("geMatch"),
  geDelete: document.getElementById("geDelete"),
  drawer: document.getElementById("drawer"),
  viewToggles: document.getElementById("viewToggles"),
  connEditor: document.getElementById("connEditor"),
  ceTitle: document.getElementById("ceTitle"),
  ceClose: document.getElementById("ceClose"),
  ceThresh: document.getElementById("ceThresh"),
  ceThreshVal: document.getElementById("ceThreshVal"),
  ceAtten: document.getElementById("ceAtten"),
  ceAttenVal: document.getElementById("ceAttenVal"),
  ceMeterIn: document.getElementById("ceMeterIn"),
  ceMeterOut: document.getElementById("ceMeterOut"),
  ceDisconnect: document.getElementById("ceDisconnect"),
  ceSeq: document.getElementById("ceSeq"),
  ceSeqPos: document.getElementById("ceSeqPos"),
  ceSeqMode: document.getElementById("ceSeqMode"),
  ceModeTogether: document.getElementById("ceModeTogether"),
  ceModeSeq: document.getElementById("ceModeSeq"),
  ceSeqBody: document.getElementById("ceSeqBody"),
  ceSeqUp: document.getElementById("ceSeqUp"),
  ceSeqDown: document.getElementById("ceSeqDown"),
  ceSeqGap: document.getElementById("ceSeqGap"),
  ceSeqGapVal: document.getElementById("ceSeqGapVal"),
};

let midi = null;
let activeInputs = [];      // every input currently feeding the app (Web MIDI + BLE)
let selectedWebInputs = []; // the current Web MIDI port selection (subset of activeInputs)
const bleInputs = [];       // ODD Balls paired directly over Web Bluetooth
let msgCount = 0;

const audio = new AudioEngine();

// Rolling detection: accumulate absolute change of the ORIENTATION CCs (3-5,
// i.e. X/Y/Z orientation per the ODD MIDI docs — see docs/MIDI.md) between
// animation frames, then smooth into a 0..1 "speed" that drives the alien bass
// drone. Measured on the device: idle sensor jitter is ~200-475 units/sec even
// when still, active rolling is ~900-1300/sec — so we gate above the idle floor
// and only make sound when it's really rolling.
const ROLL_CHANNELS = new Set([3, 4, 5]);
// Per-device CC state, keyed by MIDIInput id. When several controllers are
// bound at once we must NOT let their streams overwrite one shared slot —
// that makes cross-device value jumps look like huge orientation deltas and
// pegs the roll rate. Instead we keep each device's values separate and merge
// them (average) into the shared `cc` used by the parameters.
const deviceCc = {};
let rollAccum = 0;
let rollRate = 0;      // smoothed CC-units/sec on channels 3-5
let rollSpeed = 0;     // final gated 0..1 intensity sent to the synth
let rollRaw = 0;       // ungated normalized rate (0..1) for the meter
let ROLL_SCALE = 1300; // CC units/sec (on 3-5) that maps to full intensity
let ROLL_GATE = 0.5;   // fraction of ROLL_SCALE (~650/sec) below which it's silent
let ROLL_TAU = 0.22;   // seconds; smoothing time-constant for the rate

// Motion energy = how fast the orientation is changing (a velocity), NOT how
// far the ball is tilted. gestActivity is the smoothed Σ|Δfeat|/s used by the
// segmenter; this scale maps a vigorous move to ~1.0 while a still ball (held
// at any angle) reads near 0.
const MOTION_SCALE = 7.0;
let lastMotion = 0;    // 0..1 normalized motion energy (updated each frame)

// A decaying envelope that jumps to the tap velocity on each note, usable as a
// modulation source for the instruments.
let tapEnv = 0;

// ---- Calculated parameters (modulation sources) -------------------------
// Every entry is a named signal in 0..1 that can be routed into an instrument.
const PARAMS = {
  roll_speed: { label: "Roll speed", color: "#28e0a0", get: () => rollSpeed },
  roll_rate:  { label: "Roll rate", color: "#00e5ff", get: () => rollRaw },
  energy:     { label: "Motion energy", color: "#ffd166", get: () => lastMotion },
  tap:        { label: "Tap envelope", color: "#ff5db1", get: () => tapEnv },
  // CC assignments follow the documented ODD Ball mapping (see docs/MIDI.md):
  // CC0 Shake · CC1 Twist · CC2 Freefall · CC3-5 X/Y/Z orientation · CC6 Movement.
  shake:      { label: "Shake (CC0)", color: "hsl(20 75% 62%)", get: () => (cc[0] ?? 0) / 127 },
  twist:      { label: "Twist (CC1)", color: "hsl(65 75% 62%)", get: () => (cc[1] ?? 0) / 127 },
  freefall:   { label: "Freefall (CC2)", color: "hsl(110 75% 62%)", get: () => (cc[2] ?? 0) / 127 },
  tilt_x:     { label: "Orient X (CC3)", color: "hsl(155 75% 62%)", get: () => (cc[3] ?? 0) / 127 },
  tilt_y:     { label: "Orient Y (CC4)", color: "hsl(200 75% 62%)", get: () => (cc[4] ?? 0) / 127 },
  tilt_z:     { label: "Orient Z (CC5)", color: "hsl(245 75% 62%)", get: () => (cc[5] ?? 0) / 127 },
  movement:   { label: "Movement (CC6)", color: "hsl(290 75% 62%)", get: () => (cc[6] ?? 0) / 127 },
};
const paramValue = (key) => (PARAMS[key] ? PARAMS[key].get() : 0);

// ---- Gesture recognition + session recording ----------------------------
// A "move" is a burst of motion (bracketed by stillness). We cut each burst out
// of the live stream, resample it to a fixed length and normalize it so speed &
// scale don't matter, then match it against saved templates with Dynamic Time
// Warping. A close enough match fires a decaying envelope that shows up as its
// own trigger source in the patch bay.
//
// Crucially, the segmenter keys off how FAST the orientation is changing — not
// the orb's "energy", which saturates whenever the ball is simply held at an
// extreme angle (e.g. through an arm-slingshot wind-up) and so can never mark
// the move as finished. Delta-based activity stays low while the ball is held
// still at any angle and spikes on the actual throw / snap / catch.
// A gesture is recognized from the ball's ORIENTATION trajectory only: the
// X/Y/Z axes (CC3/4/5, see docs/MIDI.md). Those trace a smooth, repeatable path
// through a move, which is exactly what DTW template-matching needs.
//
// The other CCs — Shake (CC0), Twist (CC1), Freefall (CC2), Movement (CC6) —
// are event/intensity signals, not pose. Shake and Twist even double as Note
// triggers, so they arrive as erratic bursts whose magnitude depends on how
// hard you moved rather than the shape of the move. Feeding them into the
// matcher added run-to-run noise to every DTW comparison and, on a vigorous
// move, their large swings could set the shared normalization scale and crush
// the discriminative orientation axes. Excluding them keeps recognition tied to
// the pose path. (They remain available as modulation sources in the patch bay;
// they're just not used to identify a move.)
const GEST_DIMS = [3, 4, 5]; // X / Y / Z orientation (CC3-5)
const GEST_CHANNELS = new Set(GEST_DIMS); // fast lookup for the message handler
// The PARAMS keys those dims are stored under in a recorded session file, in
// the same order — used to rebuild feature frames when importing a session.
const GEST_DIM_KEYS = ["tilt_x", "tilt_y", "tilt_z"];
const GEST_N = 32;                        // template length after resampling
const DTW_BAND = 0.15;                    // Sakoe-Chiba radius as a fraction of length
const RAW_N = 96;                         // stored raw resolution (for editing/crop)
const GEST_ACT_TAU = 0.15;                // s; smoothing for the activity signal
const SEG_START = 4.0;                    // activity (Σ|Δfeat|/s) that begins a move
const SEG_END = 1.4;                      // activity under which the ball is "still"
const SEG_HOLD = 400;                     // ms below SEG_END that ends a move
// Recognition doesn't wait for SEG_HOLD: matching only ever uses frames up to
// SEG_TAIL past the last activity, so once the ball has been still that long
// the data is complete and we match immediately. SEG_HOLD still governs when
// the segment *closes* (it exists so a brief mid-move pause doesn't split a
// move in half, not because more data is coming).
const SEG_TAIL = 120;                     // ms of trailing stillness kept in a move
const SEG_EARLY_MS = SEG_TAIL;            // stillness before an early match attempt
const SEG_PREROLL = 320;                  // ms of pre-motion frames folded into a move
const SEG_MIN_MS = 260;                   // ignore twitches shorter than this
const SEG_MAX = 4000;                     // ms cap on a single move
// A segment only *starts* above SEG_START, so it always peaks at >= SEG_START.
// Requiring a clearly higher peak before we accept the move rejects borderline
// drift/jitter that grazes the start threshold and then fades. Tune on-device.
const SEG_PEAK_MIN = 6.0;                 // peak activity a real move must reach
const GESTURE_KEY = "oddball.gestures.v1";
const GEST_PALETTE = ["#ff8fab", "#ffd166", "#8ec5ff", "#c792ea", "#7cffcb", "#ff9f6b", "#f871ff"];

let gestures = [];                 // [{ id, name, color, threshold, template }]
const gestureEnv = {};             // id -> 0..1 decaying trigger envelope
const gestureCool = {};            // id -> last-fire timestamp (debounce)

// Sequenced playback: when a movement drives several instruments, each one is
// triggered on its own delayed envelope (staggered by the move's seqGap in the
// chosen order) rather than all at once — so a movement can fire a little
// arrangement of sounds in sequence.
const SEQ_GAP_DEFAULT = 130;       // ms between steps of a movement's chain
const seqEnv = {};                 // instKey -> 0..1 decaying per-instrument trigger
const seqQueue = [];               // pending [{ instKey, at }]
// Per-source playback config for plain inputs (roll, tap, motion, …). Gestures
// carry their own seqGap and always play as a sequence, so they don't live here.
const seqCfg = {};                 // source -> { mode: "together"|"sequence", gap }
const seqOnset = {};               // source -> { prev, last } rising-edge tracker
const SEQ_ONSET_LO = 0.06;         // fall below this to re-arm the trigger
const SEQ_ONSET_HI = 0.14;         // rise above this to fire the chain
const SEQ_ONSET_COOLDOWN = 220;    // ms minimum between chain triggers

// Drop queued chain steps, onset trackers and live trigger envelopes — called
// when the patch is cleared or swapped so steps scheduled milliseconds earlier
// can't fire into the new layout.
function resetSeqRuntime() {
  seqQueue.length = 0;
  for (const k in seqOnset) delete seqOnset[k];
  for (const k in seqEnv) delete seqEnv[k];
}
const isGestureSource = (src) => !!(PARAMS[src] && PARAMS[src].gesture);
const gestureBySource = (src) =>
  (src && src.slice(0, 2) === "g:") ? gestures.find((g) => g.id === src.slice(2)) : null;

// Instrument keys currently driven by `source`, ordered by their play order.
function siblingsOf(source) {
  return INSTRUMENTS
    .filter((i) => connections[i.key] && connections[i.key].source === source)
    .map((i) => i.key)
    .sort((a, b) => (connections[a].order ?? 0) - (connections[b].order ?? 0));
}

function seqConfig(source) {
  return seqCfg[source] || (seqCfg[source] = { mode: "together", gap: SEQ_GAP_DEFAULT });
}

// A source plays its instruments one-after-another when it's a recorded gesture
// (always) or a plain input the user switched into "sequence" mode. A plain
// input only counts as sequenced while it drives at least two instruments: the
// onset loop never fires a chain for a lone instrument, so treating that case
// as sequenced would leave it reading a trigger envelope that never rises —
// i.e. permanently silent. With one instrument it plays continuously instead.
function sourceSequenced(source) {
  if (isGestureSource(source)) return true;
  if (!seqCfg[source] || seqCfg[source].mode !== "sequence") return false;
  return siblingsOf(source).length >= 2;
}

function seqGapFor(source) {
  if (isGestureSource(source)) {
    const g = gestureBySource(source);
    return g ? (g.seqGap ?? SEQ_GAP_DEFAULT) : SEQ_GAP_DEFAULT;
  }
  return seqConfig(source).gap;
}

// Fire a source's connected instruments in play order, staggered by `gap` ms.
function fireChain(source, gap) {
  const now = performance.now();
  siblingsOf(source).forEach((instKey, i) => {
    if (gap > 0 && i > 0) seqQueue.push({ instKey, at: now + i * gap });
    else seqEnv[instKey] = 1;
  });
}
let recordingGesture = null;       // { name, targetId, examples[] } while armed to capture
let gestActivity = 0;              // most active ball's smoothed Σ|Δfeat|/s (orb/motion display)
const HIST_MS = 4000;

// Per-device gesture pipelines. Each ball gets its own feature stream,
// activity signal, history buffer and segmenter, keyed by input id — the
// shared `cc` average is fine for sound routing, but a blended pose from two
// balls is meaningless for recognition, and a second (even still) controller
// would dilute the first one's motion. Any ball can trigger any move;
// simultaneous triggers are de-duplicated by each move's cooldown. A pipe's
// featAccum gathers orientation path length from EVERY message (drained each
// frame) so fast motion keeps reading faster instead of aliasing at 60fps.
const gestPipes = {};   // device id -> { featAccum, activity, hist, seg, segLastActive }
const gestPipe = (id) =>
  gestPipes[id] || (gestPipes[id] = { featAccum: 0, activity: 0, hist: [], seg: null, segLastActive: 0 });
const clearGestPipes = () => { for (const id in gestPipes) delete gestPipes[id]; };
const deviceFeature = (id) => GEST_DIMS.map((c) => ((deviceCc[id] || {})[c] ?? 0) / 127);

// Track how fast one device's orientation is changing (framerate-independent)
// and keep a short history buffer so a move's wind-up can be folded in as
// pre-roll.
function updateGestureActivity(pipe, now, dt, feat) {
  // Speed is the orientation path length per second gathered from every MIDI
  // message this frame (drained here). For smooth motion this equals the old
  // net-delta reading, so thresholds stay calibrated; for fast motion it keeps
  // climbing instead of aliasing down once the ball outruns the frame rate.
  const speed = pipe.featAccum / dt;
  pipe.featAccum = 0;
  const a = 1 - Math.exp(-dt / GEST_ACT_TAU);
  pipe.activity += (speed - pipe.activity) * a;
  pipe.hist.push({ t: now, feat });
  while (pipe.hist.length && now - pipe.hist[0].t > HIST_MS) pipe.hist.shift();
}

// Split a recorded session into EVERY distinct move it contains — so recording
// the move several times (with a pause between reps) yields one example per
// rep. Falls back to the file's single active span when no clean bursts are
// found, so a lone continuous move still imports.
//
// Thresholds are the LIVE segmenter's, tightened toward the recording's own
// peak when that peak is lower: the ~20 Hz session recorder undersamples the
// ~58 frames/s live stream 3–4× (docs/FINDINGS.md), which shrinks the measured
// path length and with it the absolute activity — on real Series C files the
// fixed live thresholds found no bursts at all. The absolute floor keeps a
// stillness recording (peak within a few× of the noise floor) from being
// carved into garbage "reps".
const SEG_IMPORT_FLOOR = 0.8;   // min start activity; D2 hand-tremor peaks ~0.3
function activeRegions(frames) {
  const n = frames.length;
  if (n < 6) return [];
  // Smoothed per-frame activity (framerate-independent), mirroring the live path.
  const act = new Array(n).fill(0);
  let ema = 0, peakAll = 0;
  for (let i = 0; i < n; i++) {
    const dt = i ? Math.max(0.001, (frames[i].t - frames[i - 1].t) / 1000) : 0.05;
    let speed = 0;
    if (i) { let s = 0; for (let d = 0; d < frames[i].feat.length; d++) s += Math.abs(frames[i].feat[d] - frames[i - 1].feat[d]); speed = s / dt; }
    ema += (speed - ema) * (1 - Math.exp(-dt / GEST_ACT_TAU));
    act[i] = ema;
    if (ema > peakAll) peakAll = ema;
  }
  const startThr = Math.min(SEG_START, Math.max(SEG_IMPORT_FLOOR, peakAll * 0.35));
  const endThr = Math.min(SEG_END, Math.max(SEG_IMPORT_FLOOR * 0.35, peakAll * 0.12));
  const peakMin = Math.min(SEG_PEAK_MIN, Math.max(SEG_IMPORT_FLOOR * 1.5, peakAll * 0.5));
  const regions = [];
  let i = 0;
  while (i < n) {
    if (act[i] <= startThr) { i++; continue; }
    const startT = frames[i].t;
    let lastActive = frames[i].t, peak = act[i], j = i;
    for (; j < n; j++) {
      if (act[j] > endThr) lastActive = frames[j].t;
      if (act[j] > peak) peak = act[j];
      if (frames[j].t - lastActive > SEG_HOLD || frames[j].t - startT > SEG_MAX) break;
    }
    const lo = startT - SEG_PREROLL, hi = lastActive + 120;
    const rows = frames.filter((f) => f.t >= lo && f.t <= hi).map((f) => f.feat);
    const durMs = lastActive - startT;
    if (rows.length >= 6 && durMs >= SEG_MIN_MS && peak >= peakMin) regions.push({ rows, durMs });
    // Advance past the rest of this burst before scanning for the next start.
    i = j + 1;
    while (i < n && act[i] > endThr) i++;
  }
  if (!regions.length && peakAll > SEG_IMPORT_FLOOR) {
    // No clean bursts but real motion exists: import the file's single active
    // span (idle head/tail trimmed) so a continuous move still comes through.
    let firstT = null, lastT = null;
    for (let k = 0; k < n; k++) {
      if (act[k] > endThr) { if (firstT === null) firstT = frames[k].t; lastT = frames[k].t; }
    }
    if (firstT !== null) {
      const lo = firstT - SEG_PREROLL, hi = lastT + 120;
      const rows = frames.filter((f) => f.t >= lo && f.t <= hi).map((f) => f.feat);
      if (rows.length >= 6) regions.push({ rows, durMs: lastT - firstT });
    }
  }
  return regions;
}

// Linear-resample a variable-length list of feature rows to exactly N rows.
function resample(frames, N) {
  const D = GEST_DIMS.length;
  const src = frames.length ? frames : [new Array(D).fill(0)];
  const out = [];
  for (let i = 0; i < N; i++) {
    const pos = src.length === 1 ? 0 : (i / (N - 1)) * (src.length - 1);
    const lo = Math.floor(pos), hi = Math.min(src.length - 1, lo + 1);
    const f = pos - lo;
    const row = new Array(D);
    for (let d = 0; d < D; d++) row[d] = src[lo][d] * (1 - f) + src[hi][d] * f;
    out.push(row);
  }
  return out;
}

// Mean-center each dimension (so absolute orientation offset doesn't matter),
// then divide every dimension by a single shared scale. Per-dimension z-scoring
// is deliberately avoided: it blows tiny sensor jitter on otherwise-still axes
// up to full scale and wrecks matching. A shared scale keeps quiet axes quiet
// while giving amplitude invariance. Operates on a copy so the caller's raw
// rows stay 0..1.
//
// The shared scale is the RMS of the per-axis spread (root of the mean
// variance), NOT the single most-active axis. Using the max let one big-swinging
// axis define the scale and shrink every other axis toward zero, so multi-axis
// moves collapsed into look-alikes; the RMS lets all axes contribute, preserving
// their relative shape.
function normalizeShared(rows) {
  const D = GEST_DIMS.length, N = rows.length;
  const out = rows.map((r) => r.slice());
  let sumVar = 0;
  for (let d = 0; d < D; d++) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += out[i][d];
    mean /= N;
    let varr = 0;
    for (let i = 0; i < N; i++) { out[i][d] -= mean; varr += out[i][d] ** 2; }
    varr /= N;
    sumVar += varr;
  }
  const inv = 1 / Math.max(Math.sqrt(sumVar / D), 0.02);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) out[i][d] *= inv;
  return out;
}

// ---- Orientation-neutral matching (gravity-sphere invariants) --------------
// Per docs/FINDINGS.md the ball is a gravity-only sensor: CC5 encodes tilt from
// vertical ((1 − cos θ)/2, full range, R² ≈ 1.0) and CC3/CC4 encode the lean
// azimuth (0.5 ± ~0.35·sin θ). Yaw is physically unobservable at any tilt. So
// the entire orientation signal is the gravity direction in the ball's body
// frame — a point moving on the unit sphere — and holding the ball differently
// rotates that whole path by one fixed rotation (Series C measured exactly
// this: the same arm move landed at +135°/+43°/−56° azimuth depending on grip).
//
// Orientation-neutral matching therefore runs on rotation-invariant properties
// of the sphere path: the relative-speed profile (how the motion accelerates
// and decelerates along the path) and the turning profile (geodesic curvature —
// how the path bends, signed so clockwise and counter-clockwise stay distinct).
// Any regrip leaves both untouched by construction; no canonical frame, sign
// heuristics, or flip searches are needed. What is genuinely lost is lean
// *direction* — Series C proves it is unrecoverable under an unknown grip
// (positive C2 collides with negative C5 in raw CC space) — so direction only
// re-enters as a tiebreaker between moves the invariants cannot separate
// (see recognize).

// Fitted transfer function (docs/FINDINGS.md): trust CC5 for the vertical
// component and use CC3/CC4 only for the horizontal *direction*, scaled to the
// radius the vertical leaves — this absorbs the smaller, less certain azimuth
// gain (~0.35 vs 0.50) and hand jitter near the poles.
const G_AZ_AMP = 0.35;
function sphereRows(rows) {
  return rows.map((r) => {
    const hx = (r[0] - 0.5) / G_AZ_AMP;
    const hy = (r[1] - 0.5) / G_AZ_AMP;
    const z = Math.max(-1, Math.min(1, 1 - 2 * r[2]));
    const hr = Math.sqrt(Math.max(0, 1 - z * z));   // horizontal radius implied by z
    const hlen = Math.hypot(hx, hy);
    const s = hlen > 0.02 ? hr / hlen : 0;
    const v = [hx * s, hy * s, z];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  });
}

const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
// Great-circle angle between unit vectors (stable near 0 and π).
const arcAngle = (a, b) => Math.atan2(vLen(vCross(a, b)), vDot(a, b));

// Turning is only meaningful while the path is actually moving; below this
// step length (radians) the direction is sensor noise and the turn reads 0.
const TURN_MIN_ARC = 0.01;
// Cap the relative-speed feature so a single dropped-frame step can't dominate.
const SPEED_FEAT_MAX = 3;

// The rotation-invariant profile of one capture (`rows` = raw 0..1 CC rows at
// any resolution): GEST_N−2 feature rows of
//   [ relative speed − 1,  sin(turn),  (1 − cos(turn))/2 ]
// plus the total arc length (radians) for the arc gate. The turn angle is the
// signed bend between successive great-circle steps, measured in the tangent
// plane; encoding it as (sin, 1−cos) keeps the feature continuous through a
// dead-stop reversal (turn ≈ ±π), where the raw sign is numerically arbitrary,
// while sin still carries chirality for partial bends (figure-8 lobes).
function invariantProfile(rows) {
  const sp = resample(sphereRows(rows), GEST_N).map((v) => {
    const l = vLen(v) || 1;                 // resampling pulls points off the sphere
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  const N = sp.length;
  const arcs = new Array(N - 1);
  let total = 0;
  for (let i = 0; i + 1 < N; i++) { arcs[i] = arcAngle(sp[i], sp[i + 1]); total += arcs[i]; }
  const mean = (total / arcs.length) || 1e-9;
  const profile = [];
  for (let i = 1; i + 1 < N; i++) {
    const speed = Math.min(SPEED_FEAT_MAX, ((arcs[i - 1] + arcs[i]) / 2) / mean - 1);
    let sinT = 0, bowT = 0;
    if (arcs[i - 1] > TURN_MIN_ARC && arcs[i] > TURN_MIN_ARC) {
      const n = sp[i];
      const proj = (p) => {
        const d = vDot(p, n);
        return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
      };
      const u = proj([n[0] - sp[i - 1][0], n[1] - sp[i - 1][1], n[2] - sp[i - 1][2]]);
      const w = proj([sp[i + 1][0] - n[0], sp[i + 1][1] - n[1], sp[i + 1][2] - n[2]]);
      if (vLen(u) > 1e-9 && vLen(w) > 1e-9) {
        const turn = Math.atan2(vDot(n, vCross(u, w)), vDot(u, w));
        sinT = Math.sin(turn);
        bowT = (1 - Math.cos(turn)) / 2;
      }
    }
    profile.push([speed, sinT, bowT]);
  }
  return { profile, arc: total };
}

const resampleNorm = (frames, N) => normalizeShared(resample(frames, N));

// A move is built from one or more EXAMPLES — real captures of the performance.
// Each example keeps its raw 0..1 capture (resampled to RAW_N so storage is
// bounded) plus its own crop window; a DTW template is derived from the cropped
// region. Storing several real examples (repeat the move, or crop several reps
// out of one recording) makes matching far more robust than re-cropping a single
// take, because it captures the genuine run-to-run variation of the gesture.
function makeExample(ex) {
  const raw = resample(ex.rows, RAW_N);
  return { raw, crop: autoTrim(raw), durMs: typeof ex.durMs === "number" && ex.durMs > 0 ? ex.durMs : null };
}

// Coerce whatever is stored on a gesture into a clean, non-empty examples list.
function gestureExamples(g) {
  return (g && Array.isArray(g.examples) && g.examples.length) ? g.examples : [];
}

function makeTemplate(raw, crop) {
  const a = raw.slice(crop.start, crop.end + 1);
  return resampleNorm(a.length >= 2 ? a : raw, GEST_N);
}

// A few crop windows around an example's crop: as-cropped, looser (more
// silence on both ends), tighter (core only), and — when `wide` — shifted to
// keep more head or tail. Recognition takes the best (minimum) distance across
// every window's template, so a performance with slightly more/less lead-in or
// follow-through still registers. When a move has several real examples the
// extra head/tail windows add little (the real reps already span that
// variation), so `wide` is dropped to bound the template count.
function cropWindows(n, crop, wide) {
  const span = Math.max(2, crop.end - crop.start);
  const p = (f) => Math.round(span * f);
  const windows = wide ? [
    [crop.start, crop.end],                        // as cropped
    [crop.start - p(0.22), crop.end + p(0.22)],    // looser (keep more silence)
    [crop.start + p(0.15), crop.end - p(0.15)],    // tighter (core only)
    [crop.start, crop.end + p(0.35)],              // keep more follow-through
    [crop.start - p(0.35), crop.end],              // keep more wind-up
  ] : [
    [crop.start, crop.end],                        // as cropped
    [crop.start - p(0.22), crop.end + p(0.22)],    // looser
    [crop.start + p(0.15), crop.end - p(0.15)],    // tighter
  ];
  const out = [];
  const seen = new Set();
  for (let [s, e] of windows) {
    s = Math.max(0, Math.min(n - 3, s));
    e = Math.max(s + 2, Math.min(n - 1, e));
    const key = s + "-" + e;
    if (!seen.has(key)) { seen.add(key); out.push([s, e]); }
  }
  return out;
}

// Axis-locked (grip-dependent) template set: crop-variant normalized CC
// trajectories of every example, pooled. Used for direction tiebreaks.
function buildTemplates(examples) {
  const wide = examples.length <= 1;
  const out = [];
  for (const ex of examples) {
    if (!ex || !Array.isArray(ex.raw) || ex.raw.length < 2) continue;
    for (const [s, e] of cropWindows(ex.raw.length, ex.crop, wide)) {
      out.push(resampleNorm(ex.raw.slice(s, e + 1), GEST_N));
    }
  }
  return out;
}

// Orientation-neutral template set: crop-variant invariant profiles (plus each
// window's total sphere arc, for the arc gate). This is the primary match set.
function buildInvTemplates(examples) {
  const wide = examples.length <= 1;
  const out = [];
  for (const ex of examples) {
    if (!ex || !Array.isArray(ex.raw) || ex.raw.length < 2) continue;
    for (const [s, e] of cropWindows(ex.raw.length, ex.crop, wide)) {
      out.push(invariantProfile(ex.raw.slice(s, e + 1)));
    }
  }
  return out;
}

// Best (minimum) DTW distance of a candidate against a set of templates.
function bestTemplateDist(cand, templates) {
  let best = Infinity;
  for (const t of templates) { const d = dtwDist(cand, t); if (d < best) best = d; }
  return best;
}

// Distances of one candidate against one move, in each view.
function invGestureDist(profile, g) {
  let best = Infinity;
  for (const t of g.invTemplates || []) {
    const d = dtwDist(profile, t.profile);
    if (d < best) best = d;
  }
  return best;
}

function axisGestureDist(norm, g) {
  const ts = (g.templates && g.templates.length) ? g.templates : (g.template ? [g.template] : []);
  return bestTemplateDist(norm, ts);
}

// Find the active span of a raw capture using a scale-free activity measure
// (per-step change smoothed, thresholded relative to its own peak) so "cut
// silence" works regardless of how hard the move was.
function autoTrim(raw) {
  const n = raw.length;
  if (n < 4) return { start: 0, end: n - 1 };
  const act = new Array(n).fill(0);
  let ema = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    if (i) for (let d = 0; d < raw[i].length; d++) s += Math.abs(raw[i][d] - raw[i - 1][d]);
    ema = ema * 0.6 + s * 0.4;
    act[i] = ema;
    if (ema > peak) peak = ema;
  }
  const thresh = Math.max(peak * 0.14, 1e-4);
  let start = 0, end = n - 1;
  while (start < n && act[start] < thresh) start++;
  while (end > start && act[end] < thresh) end--;
  const pad = Math.round(n * 0.04);
  start = Math.max(0, start - pad);
  end = Math.min(n - 1, end + pad);
  if (end - start < 2) return { start: 0, end: n - 1 };
  return { start, end };
}

// DTW distance between two normalized sequences. Local cost is Euclidean
// distance scaled by sqrt(D); result is divided by the candidate length so the
// returned number is an average per-step distance (dimension-agnostic).
//
// A Sakoe-Chiba band constrains warping to cells within DTW_BAND of the
// diagonal. Without it, two genuinely different gestures can be stretched into
// alignment (false positives); the band also skips most of the cost matrix.
function dtwDist(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return Infinity;
  // Row width varies by view (3 for CC trajectories, 3 for invariant profiles
  // today — but derive it so the views can evolve independently).
  const D = a[0].length, invD = 1 / Math.sqrt(D);
  const INF = Infinity;
  const band = Math.max(1, Math.round(Math.max(n, m) * DTW_BAND));
  let prev = new Array(m + 1).fill(INF);
  let cur = new Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    // Reset the row so cells outside this row's band stay unreachable (INF)
    // instead of holding stale values from two rows back (arrays are swapped).
    cur.fill(INF);
    // Center the band on the diagonal, scaled in case the lengths differ.
    const center = Math.round((i * m) / n);
    const jlo = Math.max(1, center - band);
    const jhi = Math.min(m, center + band);
    for (let j = jlo; j <= jhi; j++) {
      let s = 0;
      for (let d = 0; d < D; d++) { const diff = a[i - 1][d] - b[j - 1][d]; s += diff * diff; }
      const cost = Math.sqrt(s) * invD;
      cur[j] = cost + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / n;
}

// Feed each frame in; when a move completes it is either saved as a template
// (if we're arming a recording) or matched. A move starts when activity crosses
// SEG_START (pulling in ~SEG_PREROLL ms of preceding frames so the wind-up is
// kept) and ends after SEG_HOLD ms back under SEG_END. Trailing stillness is
// trimmed so a slow settle at the end doesn't skew the template.
function handleSegment(pipe, now, feat) {
  const act = pipe.activity;
  if (!pipe.seg) {
    if ((recordingGesture || gestures.length) && act > SEG_START) {
      const lo = now - SEG_PREROLL;
      pipe.seg = { frames: pipe.hist.filter((h) => h.t >= lo).slice(), peak: act, fired: false, triedUpTo: -1 };
      pipe.segLastActive = now;
    }
    return;
  }
  const seg = pipe.seg;
  seg.frames.push({ t: now, feat });
  if (act > seg.peak) seg.peak = act;
  if (act > SEG_END) pipe.segLastActive = now;

  // Early recognition: after SEG_EARLY_MS of stillness the trailing window is
  // full, so fire the match now instead of sitting out the rest of SEG_HOLD —
  // this cuts move-end→sound latency from ~400ms to ~120ms. If the stillness
  // was actually a mid-move pause, the segment keeps growing and (if nothing
  // fired) gets one more attempt on the fuller data; a pause the player can
  // see reads as the end of a move, and the per-move cooldown covers the rest.
  // Recording is latency-insensitive and still captures on the full close.
  if (!recordingGesture && !seg.fired && seg.triedUpTo !== pipe.segLastActive
      && act <= SEG_END && now - pipe.segLastActive >= SEG_EARLY_MS) {
    seg.triedUpTo = pipe.segLastActive;
    const kept = seg.frames.filter((h) => h.t <= pipe.segLastActive + SEG_TAIL);
    const durMs = kept.length ? kept[kept.length - 1].t - kept[0].t : 0;
    if (kept.length >= 6 && durMs >= SEG_MIN_MS && seg.peak >= SEG_PEAK_MIN) {
      if (recognize(kept.map((h) => h.feat), durMs)) seg.fired = true;
    }
  }

  if (now - pipe.segLastActive > SEG_HOLD || now - seg.frames[0].t > SEG_MAX) {
    pipe.seg = null;
    // Already matched (or attempted) on exactly this data during the early
    // pass and nothing new arrived since — don't fire or log a second time.
    if (!recordingGesture && (seg.fired || seg.triedUpTo === pipe.segLastActive)) return;
    const kept = seg.frames.filter((h) => h.t <= pipe.segLastActive + SEG_TAIL);
    const durMs = kept.length ? kept[kept.length - 1].t - kept[0].t : 0;
    // Require a clear activity peak so drift that just grazes SEG_START then
    // fades is rejected rather than matched as a (garbage) move.
    if (kept.length >= 6 && durMs >= SEG_MIN_MS && seg.peak >= SEG_PEAK_MIN) {
      processSegment(kept.map((h) => h.feat), durMs);
    }
  }
}

function processSegment(frames, durMs) {
  if (recordingGesture) {
    // Each completed burst is one example. We keep capturing until the user
    // clicks to finish, so one recording session can gather several reps that
    // together build a more reliable trigger.
    recordingGesture.examples.push({ rows: frames, durMs });   // raw 0..1 rows
    updateRecMoveBtn();
    if (recordingGesture.targetId) updateExampleAddBtn();
    logEvent(`<b>GESTURE</b> captured example ${recordingGesture.examples.length} — repeat or finish`, "note");
  } else {
    recognize(frames, durMs);
  }
}

// A winner must beat the runner-up by this much (avg per-step DTW distance)
// whenever the runner-up could itself have fired — a near-tie between two
// armed moves is genuinely ambiguous, and firing a coin-flip winner reads as
// random misfires. Runners-up over their own threshold don't block: they were
// never a plausible alternative.
const GEST_MARGIN = 0.05;

// DTW plus fixed-length resampling deliberately erase tempo — but that means a
// slow sweep and a quick flick with the same shape are otherwise identical.
// Compare the candidate's wall-clock duration against the range seen across
// the move's examples; the factor is loose (2×) since DTW already absorbs
// local timing and honest reps vary. Examples saved before durations were
// recorded have none, so legacy moves skip the gate.
const GEST_DUR_RATIO = 2;
function durationOk(g, durMs) {
  if (!(durMs > 0)) return true;
  const durs = gestureExamples(g).map((ex) => ex.durMs).filter((d) => typeof d === "number" && d > 0);
  if (!durs.length) return true;
  return durMs >= Math.min(...durs) / GEST_DUR_RATIO
      && durMs <= Math.max(...durs) * GEST_DUR_RATIO;
}

// Arc gate — the invariant twin of the duration gate. The total great-circle
// arc a move sweeps (radians on the gravity sphere) is rotation-invariant and
// strongly discriminative (a 90° tip out-and-back sweeps ~π; a wrist wobble
// far less), and the relative-speed profile would otherwise erase it.
const GEST_ARC_RATIO = 2;
function arcOk(g, arc) {
  if (!Number.isFinite(arc)) return true;
  const arcs = (g.invTemplates || []).map((t) => t.arc).filter((a) => a > 0);
  if (!arcs.length) return true;
  // A near-zero arc (stillness/jitter) must FAIL here, not skip the gate — the
  // relative-speed profile of noise can land eerily close to a real move's.
  return arc >= Math.min(...arcs) / GEST_ARC_RATIO
      && arc <= Math.max(...arcs) * GEST_ARC_RATIO;
}

// Match a candidate against every move; returns the gesture that fired (or
// null) so the segmenter can tell whether an early attempt landed.
//
// Two-tier, orientation-neutral by DEFAULT: the primary score is the
// grip-independent invariant profile, so every move matches however the ball
// is held. When two moves near-tie there — which is exactly what happens for
// moves that are rotations of one another (tilt-away vs tilt-left; Series C
// shows the sensor cannot tell them apart) — the grip-DEPENDENT axis distance
// breaks the tie, which works for players who keep a consistent grip. A move
// flagged rotInvariant opts out of tiebreaking (it is performed in arbitrary
// grips, so its axis distance is meaningless); ties involving it stay
// ambiguous and are logged instead of coin-flipped.
function recognize(frames, durMs) {
  const axisNorm = resampleNorm(frames, GEST_N);   // grip-dependent view (tiebreaks)
  const inv = invariantProfile(frames);            // orientation-neutral view (primary)
  let best = null, second = null, fired = null;
  for (const g of gestures) {
    const d = invGestureDist(inv.profile, g);
    g._dist = d;    // shown in the list/editor even when the gates skip it
    g._distAxis = axisGestureDist(axisNorm, g);
    if (!durationOk(g, durMs) || !arcOk(g, inv.arc)) continue;
    // Only moves under their own threshold compete: a strict move that itself
    // fails to qualify must not shadow a looser rival that would have fired.
    if (d > g.threshold) continue;
    if (!best || d < best.d) { second = best; best = { g, d }; }
    else if (!second || d < second.d) second = { g, d };
  }
  if (best) {
    const nearTie = !!second && second.d - best.d < GEST_MARGIN;
    if (!nearTie) {
      fireGesture(best.g, best.d);
      fired = best.g;
    } else {
      const canTiebreak = !best.g.rotInvariant && !second.g.rotInvariant;
      const da = best.g._distAxis, db = second.g._distAxis;
      if (canTiebreak && Math.abs(da - db) >= GEST_MARGIN) {
        const w = da <= db ? best : second;
        fireGesture(w.g, w.d);
        fired = w.g;
      } else {
        logEvent(`<b>GESTURE</b> ambiguous — ${escHtml(best.g.name)} d=${best.d.toFixed(2)} vs ${escHtml(second.g.name)} d=${second.d.toFixed(2)} · not firing`, "note");
      }
    }
  }
  renderGestures();
  return fired;
}

function fireGesture(g, d) {
  const now = performance.now();
  if (now - (gestureCool[g.id] || 0) < (g.cooldown || 500)) return;
  gestureCool[g.id] = now;
  gestureEnv[g.id] = 1;
  // Trigger each connected instrument on its own envelope, staggered by the
  // move's spacing in play order, so the sounds fire as a sequence.
  fireChain("g:" + g.id, g.seqGap ?? SEQ_GAP_DEFAULT);
  logEvent(`<b>GESTURE</b> ${escHtml(g.name)} matched · d=${d.toFixed(2)}`, "note");
  const row = els.gestureList.querySelector(`.gesture[data-id="${g.id}"]`);
  if (row) { row.classList.add("is-hit"); setTimeout(() => row.classList.remove("is-hit"), 450); }
  if (editingGesture && editingGesture.id === g.id) {
    els.geMatch.classList.add("on");
    setTimeout(() => els.geMatch.classList.remove("on"), 450);
  }
}

// Reflect the editing gesture's latest live match distance in the editor.
function updateEditorLive() {
  const g = editingGesture;
  if (!g) return;
  els.geDist.textContent = typeof g._dist === "number" ? g._dist.toFixed(2) : "—";
  els.geDist.style.color = (typeof g._dist === "number" && g._dist <= g.threshold) ? "var(--good)" : "";
}

// ---- Gesture storage + patch-bay integration ----------------------------
// The default match threshold (avg per-step DTW distance). Lower = stricter.
const GEST_THRESH_MIN = 0.15, GEST_THRESH_MAX = 1.1, GEST_THRESH_DEFAULT = 0.55;
const sensToThresh = (s) => GEST_THRESH_MIN + (s / 100) * (GEST_THRESH_MAX - GEST_THRESH_MIN);
const threshToSens = (t) => Math.round(((t - GEST_THRESH_MIN) / (GEST_THRESH_MAX - GEST_THRESH_MIN)) * 100);

function registerGestureParam(g) {
  PARAMS["g:" + g.id] = {
    label: "✋ " + g.name,
    color: g.color,
    gesture: true,
    get: () => gestureEnv[g.id] || 0,
  };
}

function unregisterGestureParam(id) {
  const key = "g:" + id;
  delete PARAMS[key];
  delete sparkBuf[key];
  delete gestureEnv[id];
  // Drop any connections that were driven by this gesture.
  for (const instKey in connections) {
    if (connections[instKey] && connections[instKey].source === key) disconnect(instKey);
  }
}

// With two or more real examples we can measure the move's own run-to-run
// spread: leave each example out in turn and score it against the templates
// built from the rest — exactly how a genuine performance will be scored at
// recognition time. The threshold then sits a comfortable margin above that
// spread instead of at a one-size-fits-all default: tight, repeatable moves
// get a strict threshold, sloppy expressive ones a loose one. A hand-moved
// sensitivity slider flips the move to manual and wins from then on.
function autoThreshold(g) {
  const exs = gestureExamples(g);
  if (exs.length < 2) return null;
  const dists = [];
  for (let i = 0; i < exs.length; i++) {
    const ex = exs[i];
    const a = ex.raw.slice(ex.crop.start, ex.crop.end + 1);
    const probe = invariantProfile(a.length >= 2 ? a : ex.raw).profile;
    const others = buildInvTemplates(exs.filter((_, j) => j !== i));
    let best = Infinity;
    for (const t of others) { const d = dtwDist(probe, t.profile); if (d < best) best = d; }
    if (Number.isFinite(best)) dists.push(best);
  }
  if (!dists.length) return null;
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  const worst = Math.max(...dists);
  // Enough headroom that a typical rep clears comfortably, without opening the
  // door to everything: 1.6× the mean spread, or 1.2× the worst rep if larger.
  return Math.min(GEST_THRESH_MAX, Math.max(GEST_THRESH_MIN, Math.max(mean * 1.6, worst * 1.2)));
}

// Recompute a gesture's derived templates from its current examples (called
// after adding, deleting, or re-cropping an example) and — unless the user has
// taken manual control of the slider — recalibrate its match threshold.
// Both views are rebuilt: the primary orientation-neutral profiles and the
// axis-locked trajectories used for direction tiebreaks.
function refreshGestureTemplates(g) {
  const exs = gestureExamples(g);
  g.template = exs.length ? makeTemplate(exs[0].raw, exs[0].crop) : null;
  g.templates = buildTemplates(exs);
  g.invTemplates = buildInvTemplates(exs);
  const auto = autoThreshold(g);
  if (auto !== null && !g.thresholdManual) g.threshold = auto;
}

// Create a move from one or more example captures (each { rows, durMs }, where
// rows is the raw 0..1 feature rows of one performance). Passing several
// examples — repeated live or cropped out of one recording — builds a more
// robust trigger than a single take.
function saveGesture(name, exampleCaptures) {
  const examples = exampleCaptures.map(makeExample);
  const g = {
    id: "g" + Date.now().toString(36),
    name: name || `Move ${gestures.length + 1}`,
    color: GEST_PALETTE[gestures.length % GEST_PALETTE.length],
    threshold: GEST_THRESH_DEFAULT,
    cooldown: 500,
    seqGap: SEQ_GAP_DEFAULT,
    examples,
  };
  refreshGestureTemplates(g);
  gestures.push(g);
  registerGestureParam(g);
  persistGestures();
  rebuildGraph();
  renderGestures();
  const n = examples.length;
  logEvent(`<b>GESTURE</b> saved “${escHtml(g.name)}”${n > 1 ? ` · ${n} examples` : ""} — edit or wire it up`, "note");
  return g;
}

// Append example captures ({ rows, durMs } each) to an existing move and rebuild.
function addExamplesToGesture(g, exampleCaptures) {
  for (const ex of exampleCaptures) g.examples.push(makeExample(ex));
  refreshGestureTemplates(g);
  persistGestures();
  renderGestures();
}

function deleteGesture(id) {
  unregisterGestureParam(id);
  gestures = gestures.filter((g) => g.id !== id);
  persistGestures();
  rebuildGraph();
  renderGestures();
}

// Compact, serializable form of the current moves (used for both localStorage
// and embedding a snapshot inside a saved profile).
function serializeGestures() {
  return gestures.map((g) => ({
    id: g.id, name: g.name, color: g.color,
    threshold: g.threshold, thresholdManual: !!g.thresholdManual,
    rotInvariant: !!g.rotInvariant,
    cooldown: g.cooldown, seqGap: g.seqGap,
    examples: gestureExamples(g).map((ex) => ({
      crop: ex.crop,
      durMs: typeof ex.durMs === "number" ? Math.round(ex.durMs) : undefined,
      raw: ex.raw.map((r) => r.map((v) => +v.toFixed(4))),   // round to keep JSON small
    })),
  }));
}

// Rebuild one example ({ raw resampled to RAW_N, clamped crop }) from stored
// data. Returns null for anything malformed so a bad entry can't break the move.
function exampleFromData(e) {
  let raw = e && Array.isArray(e.raw) ? e.raw : null;
  if (!raw || !raw.length || !Array.isArray(raw[0])) return null;
  raw = resample(raw, RAW_N);
  let crop = e.crop && typeof e.crop.start === "number" && typeof e.crop.end === "number"
    ? { start: Math.max(0, Math.min(RAW_N - 1, e.crop.start)), end: Math.max(0, Math.min(RAW_N - 1, e.crop.end)) }
    : { start: 0, end: RAW_N - 1 };
  if (crop.end <= crop.start) crop = { start: 0, end: RAW_N - 1 };
  const durMs = typeof e.durMs === "number" && e.durMs > 0 ? e.durMs : null;
  return { raw, crop, durMs };
}

// Rebuild a full gesture (with computed templates) from stored/profile data.
// Returns null for anything malformed so bad entries can never break the graph.
// Understands three formats: the current `examples` array, the previous single
// `raw` + `crop`, and the oldest template-only capture.
function gestureFromData(g) {
  if (!g) return null;
  let examples;
  if (Array.isArray(g.examples)) {
    examples = g.examples.map(exampleFromData).filter(Boolean);
  } else {
    // Legacy single-example: raw+crop, or the oldest format that only kept the
    // template (treat it as the raw capture).
    const raw = Array.isArray(g.raw) ? g.raw : (Array.isArray(g.template) ? g.template : null);
    const one = exampleFromData({ raw, crop: g.crop });
    examples = one ? [one] : [];
  }
  if (!examples.length) return null;
  const out = {
    id: g.id, name: g.name || "Move",
    color: g.color || GEST_PALETTE[0],
    threshold: typeof g.threshold === "number" ? g.threshold : GEST_THRESH_DEFAULT,
    // Entries saved before auto-calibration have no flag; a stored threshold
    // that differs from the old default means the user moved the slider.
    thresholdManual: typeof g.thresholdManual === "boolean"
      ? g.thresholdManual
      : typeof g.threshold === "number" && Math.abs(g.threshold - GEST_THRESH_DEFAULT) > 1e-6,
    rotInvariant: !!g.rotInvariant,
    cooldown: typeof g.cooldown === "number" ? g.cooldown : 500,
    seqGap: typeof g.seqGap === "number" ? g.seqGap : SEQ_GAP_DEFAULT,
    examples,
  };
  refreshGestureTemplates(out);
  return out;
}

function persistGestures() {
  try {
    localStorage.setItem(GESTURE_KEY, JSON.stringify(serializeGestures()));
  } catch (e) { /* storage unavailable — ignore */ }
}

function loadGestures() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(GESTURE_KEY) || "null"); } catch (e) { data = null; }
  if (!Array.isArray(data)) return;
  gestures = data.map(gestureFromData).filter(Boolean);
  for (const g of gestures) registerGestureParam(g);
}

// ---- Gesture + session recording UI -------------------------------------
function updateRecMoveBtn() {
  const rec = recordingGesture;
  els.recMove.classList.toggle("is-arming", !!rec);
  if (!rec) { els.recMove.textContent = "✋ Record move"; return; }
  const n = rec.examples.length;
  els.recMove.textContent = n ? `✋ ${n} captured · finish` : "✋ Do the move…";
}

function toggleRecordMove() {
  if (recordingGesture) { finishRecordMove(); return; }
  const name = (window.prompt(
    "Name this move, then perform it. Repeat it a few times (pause between reps) to build a more reliable trigger, then click ✋ again to finish.",
    `Move ${gestures.length + 1}`) || "").trim();
  if (!name) return;
  recordingGesture = { name, targetId: null, examples: [] };
  // Start fresh; the next bursts of motion become the examples.
  for (const id in gestPipes) gestPipes[id].seg = null;
  updateRecMoveBtn();
}

// Finish an armed recording: build a new move from the captured examples, or —
// if it was reinforcing an existing move — append them to it.
function finishRecordMove() {
  const rec = recordingGesture;
  recordingGesture = null;
  updateRecMoveBtn();
  updateExampleAddBtn();
  if (!rec || !rec.examples.length) {
    if (rec) logEvent("<b>GESTURE</b> recording cancelled — no move captured", "note");
    return;
  }
  if (rec.targetId) {
    const g = gestures.find((x) => x.id === rec.targetId);
    if (!g) { saveGesture(rec.name, rec.examples); return; }
    addExamplesToGesture(g, rec.examples);
    logEvent(`<b>GESTURE</b> added ${rec.examples.length} example${rec.examples.length === 1 ? "" : "s"} to “${escHtml(g.name)}” · ${gestureExamples(g).length} total`, "note");
    if (editingGesture && editingGesture.id === g.id) {
      editingExample = gestureExamples(g).length - 1;
      renderExampleStrip();
      updateEditorSettingLabels();
      drawGestureEditor();
    }
  } else {
    saveGesture(rec.name, rec.examples);
  }
}

// Turn a recorded session JSON (from the Record button) into a gesture template.
// We rebuild the orientation feature frames, trim to the active region the live
// segmenter would have captured, then resample + normalize like any other move.
function importSessionFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data = null;
    try { data = JSON.parse(reader.result); } catch (e) { data = null; }
    const samples = data && data.samples;
    if (!Array.isArray(samples) || samples.length < 4) {
      logEvent("<b>IMPORT</b> that file has no usable session samples", "note");
      return;
    }
    const frames = samples.map((s) => ({
      t: s.t || 0,
      feat: GEST_DIM_KEYS.map((k) => { const v = s.values && s.values[k]; return typeof v === "number" ? v : 0; }),
    }));
    // Pull out every rep in the recording; each becomes an example of one move.
    const regions = activeRegions(frames);
    if (!regions.length) { logEvent("<b>IMPORT</b> couldn't find a move in that recording", "note"); return; }
    const suggested = (file.name || "Imported move").replace(/\.json$/i, "").replace(/^oddball-session-.*$/, "Imported move");
    const name = (window.prompt(
      regions.length > 1
        ? `Found ${regions.length} performances — they'll build one trigger. Name this move:`
        : "Name this imported move:",
      suggested) || "").trim();
    if (!name) return;
    saveGesture(name, regions);   // list of raw-row examples
  };
  reader.readAsText(file);
}

function renderGestures() {
  els.gestureList.innerHTML = gestures.map((g) => {
    const dist = typeof g._dist === "number" ? g._dist.toFixed(2) : "—";
    const nEx = gestureExamples(g).length;
    return `<div class="gesture" data-id="${g.id}">
      <span class="g-dot" style="background:${g.color}"></span>
      <span class="g-name">${escHtml(g.name)}</span>
      <span class="g-ex" title="${nEx} example${nEx === 1 ? "" : "s"} building this trigger">${nEx}×</span>
      <span class="g-dist">d ${dist}</span>
      <span class="g-sens-label">sensitivity</span>
      <input class="g-sens" type="range" min="0" max="100" value="${threshToSens(g.threshold)}" data-id="${g.id}" />
      <button class="g-edit" data-id="${g.id}" title="Edit / crop move">✎</button>
      <button class="g-del" data-id="${g.id}" title="Delete move">×</button>
    </div>`;
  }).join("");
}

// ---- Gesture editor: crop out silence + tune per-move settings -----------
const GEST_DIM_COLORS = GEST_DIM_KEYS.map((k) => (PARAMS[k] && PARAMS[k].color) || "#8b90b8");
let editingGesture = null;   // the gesture object currently open in the editor
let editingExample = 0;      // index of the example shown in the editor canvas
let geDrag = null;           // "start" | "end" while dragging a crop handle
let gPersistTimer = null;

// The example currently shown/edited in the gesture editor.
function currentExample() {
  const exs = editingGesture ? gestureExamples(editingGesture) : [];
  if (!exs.length) return null;
  editingExample = Math.max(0, Math.min(exs.length - 1, editingExample));
  return exs[editingExample];
}

function persistGesturesSoon() {
  clearTimeout(gPersistTimer);
  gPersistTimer = setTimeout(persistGestures, 200);
}

function openGestureEditor(id) {
  const g = gestures.find((x) => x.id === id);
  if (!g) return;
  editingGesture = g;
  editingExample = 0;
  els.geDot.style.background = g.color;
  els.geName.value = g.name;
  els.geSens.value = threshToSens(g.threshold);
  els.geCool.value = g.cooldown || 500;
  els.geRot.checked = !!g.rotInvariant;
  renderExampleStrip();
  updateExampleAddBtn();
  updateEditorSettingLabels();
  els.gestureEditor.classList.remove("gedit--hidden");
  els.gestureBackdrop.classList.remove("gedit-backdrop--hidden");
  drawGestureEditor();
}

function closeGestureEditor() {
  // Stop an in-progress "add example" capture tied to this editor.
  if (recordingGesture && recordingGesture.targetId) finishRecordMove();
  editingGesture = null;
  geDrag = null;
  els.gestureEditor.classList.add("gedit--hidden");
  els.gestureBackdrop.classList.add("gedit-backdrop--hidden");
}

// Render the row of example chips (one per captured rep). The selected chip
// drives the crop canvas; each chip can be picked, and the strip shows the count.
function renderExampleStrip() {
  const g = editingGesture;
  if (!g) return;
  const exs = gestureExamples(g);
  els.geExStrip.innerHTML = exs.map((ex, i) =>
    `<button class="gedit-ex${i === editingExample ? " is-active" : ""}" data-ex="${i}">${i + 1}</button>`
  ).join("");
  els.geDelExample.disabled = exs.length <= 1;
}

// Reflect the add-example capture state on the editor's ＋ button.
function updateExampleAddBtn() {
  const g = editingGesture;
  if (!g || !els.geAddExample) return;
  const capturing = !!(recordingGesture && recordingGesture.targetId === g.id);
  els.geAddExample.classList.toggle("is-arming", capturing);
  els.geAddExample.textContent = capturing
    ? (recordingGesture.examples.length ? `✋ ${recordingGesture.examples.length} · finish` : "✋ Do the move…")
    : "＋ Add";
}

// Arm (or finish) capturing extra examples for the move being edited: perform
// the move — repeat it — and each burst appends as a new example on finish.
function toggleAddExample() {
  const g = editingGesture;
  if (!g) return;
  if (recordingGesture) { finishRecordMove(); return; }
  recordingGesture = { name: g.name, targetId: g.id, examples: [] };
  for (const id in gestPipes) gestPipes[id].seg = null;
  updateRecMoveBtn();
  updateExampleAddBtn();
}

// Remove the selected example (never the last one) and rebuild the templates.
function deleteEditingExample() {
  const g = editingGesture;
  if (!g) return;
  const exs = gestureExamples(g);
  if (exs.length <= 1) return;
  exs.splice(editingExample, 1);
  editingExample = Math.max(0, Math.min(exs.length - 1, editingExample));
  refreshGestureTemplates(g);
  persistGesturesSoon();
  renderExampleStrip();
  updateEditorSettingLabels();
  drawGestureEditor();
}

function updateEditorSettingLabels() {
  const g = editingGesture;
  if (!g) return;
  // Keep the slider in step: auto-calibration can move the threshold whenever
  // the examples change (the round-trip through threshToSens is exact, so this
  // never fights the user's own drag).
  els.geSens.value = threshToSens(g.threshold);
  els.geSensVal.textContent = threshToSens(g.threshold);
  els.geCoolVal.textContent = `${Math.round(g.cooldown || 500)} ms`;
  els.geThreshShow.textContent = g.threshold.toFixed(2);
  const ex = currentExample();
  const exs = gestureExamples(g);
  if (ex) {
    const span = ex.crop.end - ex.crop.start + 1;
    const which = exs.length > 1 ? `ex ${editingExample + 1}/${exs.length} · ` : "";
    els.geCropInfo.textContent = `${which}crop ${ex.crop.start}–${ex.crop.end} of ${RAW_N} (${Math.round((span / RAW_N) * 100)}%)`;
  }
}

function recomputeEditingTemplate() {
  const g = editingGesture;
  if (!g) return;
  refreshGestureTemplates(g);
  updateEditorSettingLabels();
  persistGesturesSoon();
}

function drawGestureEditor() {
  const g = editingGesture;
  if (!g) return;
  const ex = currentExample();
  if (!ex) return;
  const cv = els.geCanvas;
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  }
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, pad = 8 * dpr;
  ctx.clearRect(0, 0, W, H);

  const raw = ex.raw, crop = ex.crop, N = raw.length, D = raw[0].length;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) { const v = raw[i][d]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  const xOf = (i) => (i / (N - 1)) * W;
  const yOf = (v) => H - pad - ((v - mn) / range) * (H - pad * 2);

  // Excluded (cropped-out) regions dimmed.
  const xs = xOf(crop.start), xe = xOf(crop.end);
  ctx.fillStyle = "rgba(4,6,14,0.62)";
  ctx.fillRect(0, 0, xs, H);
  ctx.fillRect(xe, 0, W - xe, H);

  // Baseline grid.
  ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 4; k++) { const y = (k / 4) * (H - 2) + 1; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // Per-dimension traces.
  for (let d = 0; d < D; d++) {
    ctx.strokeStyle = GEST_DIM_COLORS[d];
    ctx.globalAlpha = 0.8; ctx.lineWidth = 1.4 * dpr; ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const x = xOf(i), y = yOf(raw[i][d]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Crop handles.
  for (const x of [xs, xe]) {
    ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = "#00e5ff";
    ctx.fillRect(x - 3 * dpr, H / 2 - 12 * dpr, 6 * dpr, 24 * dpr);
  }
}

function editorIndexFromEvent(e) {
  const r = els.geCanvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return Math.round(frac * (RAW_N - 1));
}

function onEditorPointerDown(e) {
  if (!editingGesture) return;
  const ex = currentExample();
  if (!ex) return;
  const r = els.geCanvas.getBoundingClientRect();
  const px = (i) => (i / (RAW_N - 1)) * r.width;
  const x = e.clientX - r.left;
  const dStart = Math.abs(x - px(ex.crop.start)), dEnd = Math.abs(x - px(ex.crop.end));
  geDrag = dStart <= dEnd ? "start" : "end";
  els.geCanvas.setPointerCapture(e.pointerId);
  onEditorPointerMove(e);
}

function onEditorPointerMove(e) {
  if (!editingGesture || !geDrag) return;
  const ex = currentExample();
  if (!ex) return;
  const crop = ex.crop;
  let idx = editorIndexFromEvent(e);
  if (geDrag === "start") crop.start = Math.min(idx, crop.end - 2);
  else crop.end = Math.max(idx, crop.start + 2);
  crop.start = Math.max(0, crop.start);
  crop.end = Math.min(RAW_N - 1, crop.end);
  recomputeEditingTemplate();
  drawGestureEditor();
}

function onEditorPointerUp() { geDrag = null; }

// ---- Session recording: capture the input stream, then download it -------
let sessionRec = null;         // { start, last, samples: [] }
const SESSION_SAMPLE_MS = 50;  // ~20 Hz is plenty for later analysis

function toggleSessionRec() {
  if (sessionRec) { stopSessionRec(); return; }
  sessionRec = { start: performance.now(), last: 0, samples: [] };
  els.recSession.classList.add("is-recording");
  els.recSession.textContent = "⏹ Stop · 0.0s";
  logEvent("<b>REC</b> session recording started", "note");
}

function sampleSession(now) {
  if (!sessionRec) return;
  const t = now - sessionRec.start;
  if (t - sessionRec.last < SESSION_SAMPLE_MS) return;
  sessionRec.last = t;
  const values = {};
  for (const key in PARAMS) values[key] = +paramValue(key).toFixed(4);
  sessionRec.samples.push({ t: Math.round(t), values });
  els.recSession.textContent = `⏹ Stop · ${(t / 1000).toFixed(1)}s`;
}

function stopSessionRec() {
  const rec = sessionRec;
  sessionRec = null;
  els.recSession.classList.remove("is-recording");
  els.recSession.textContent = "⏺ Record";
  if (!rec || !rec.samples.length) return;
  const payload = {
    recorded: new Date().toISOString(),
    durationMs: Math.round(performance.now() - rec.start),
    params: Object.keys(PARAMS).map((k) => ({ key: k, label: PARAMS[k].label })),
    samples: rec.samples,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `oddball-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logEvent(`<b>REC</b> session saved · ${rec.samples.length} samples`, "note");
}

// ---- High-fidelity (event-driven) raw capture ---------------------------
// The session recorder above snapshots PARAMS on a ~20 Hz timer, which aliases
// the ball's ~400 msg/s stream and — because it only stores decoded values —
// drops Note messages (Tap/Shake/Twist) entirely. This mode instead logs EVERY
// non-realtime MIDI message the moment it arrives (see onMidiMessage), so the
// download matches what `listen.py --raw` captures: full rate, notes included.
let rawRec = null;             // { start, msgs: [] }

function toggleRawRec() {
  if (rawRec) { stopRawRec(); return; }
  rawRec = { start: performance.now(), msgs: [] };
  els.recRaw.classList.add("is-recording");
  els.recRaw.textContent = "⏹ Stop raw · 0.0s";
  logEvent("<b>RAW</b> full-rate capture started", "note");
}

// Called from onMidiMessage for each non-realtime message while armed.
function rawRecPush(data, target) {
  if (!rawRec) return;
  const [status, d1, d2] = data;
  rawRec.msgs.push({
    t: +(performance.now() - rawRec.start).toFixed(2),  // ms from start
    dev: (target && target.id) || "_",
    status,
    d1: d1 ?? null,
    d2: d2 ?? null,
  });
}

function stopRawRec() {
  const rec = rawRec;
  rawRec = null;
  els.recRaw.classList.remove("is-recording");
  els.recRaw.textContent = "⏺ Raw";
  if (!rec || !rec.msgs.length) {
    if (rec) logEvent("<b>RAW</b> capture stopped — no messages", "note");
    return;
  }
  const durationMs = Math.round(performance.now() - rec.start);
  const payload = {
    recorded: new Date().toISOString(),
    durationMs,
    format: "oddball-raw-midi-1",
    note: "Every non-realtime MIDI message in arrival order. t = ms from start; " +
      "status/d1/d2 are the raw MIDI bytes (0x90 note-on, 0xB0 control-change, …).",
    messages: rec.msgs,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `oddball-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const rate = Math.round(rec.msgs.length / (durationMs / 1000));
  logEvent(`<b>RAW</b> saved · ${rec.msgs.length} messages · ${rate}/s`, "note");
}

// ---- Connections --------------------------------------------------------
// Each instrument input takes one parameter (or none). A connection carries a
// per-connection response curve: `thresh` gates out signal below a floor and
// `atten` scales the result, so you can tune how sensitive each link is.
//   shaped = ((raw - thresh) / (1 - thresh))  (clamped, 0 below thresh) * atten
const INSTRUMENTS = [...AudioEngine.INSTRUMENTS, { key: "chimes", label: "Chimes" }];
// thresh is capped just under 1 (matching the UI slider's 0.95 max): shape()
// divides by (1 - thresh), so a stored/imported value of exactly 1 would turn
// the whole chain into NaN gain — and assigning NaN to an AudioParam throws.
const CONN_THRESH_MAX = 0.95;
const mkConn = (source, atten = 1, thresh = 0) => ({
  source,
  atten: clamp1(atten),
  thresh: Math.min(CONN_THRESH_MAX, clamp1(thresh)),
});
// Every instrument starts unpatched; a couple get sensible defaults.
const connections = {};
INSTRUMENTS.forEach((inst) => { connections[inst.key] = null; });
connections.bass = mkConn("roll_speed");
connections.chimes = mkConn("tap");

function shape(conn, instKey) {
  if (!conn) return 0;
  // Sequenced instruments read their own (possibly delayed) trigger envelope so
  // a single movement can fire its instruments in order; everything else reads
  // the live parameter value and plays continuously / simultaneously.
  const raw = (instKey && sourceSequenced(conn.source))
    ? (seqEnv[instKey] || 0)
    : paramValue(conn.source);
  const t = conn.thresh;
  const gated = raw <= t ? 0 : (raw - t) / (1 - t);
  return clamp1(gated) * conn.atten;
}

// Chimes are an event instrument (audio.hit), not a continuous voice, so a
// connection can't just stream a level into them. A plain tap connection keeps
// the zero-latency per-note path (true velocity, retriggers on every bounce);
// any other source fires one chime per rising edge of its shaped value — which
// also covers sequenced chains, whose per-instrument envelope jumps 0→1 when
// the chain step lands.
const chimeState = { prev: 0, last: 0 };
const chimeDirect = (conn) => !!conn && conn.source === "tap" && !sourceSequenced("tap");
function updateChimes(conn, v, now) {
  if (!conn) { chimeState.prev = 0; return; }
  if (!chimeDirect(conn)) {
    if (chimeState.prev < SEQ_ONSET_LO && v >= SEQ_ONSET_HI && now - chimeState.last > SEQ_ONSET_COOLDOWN) {
      chimeState.last = now;
      audio.hit(Math.round(clamp1(v) * 127), (cc[3] ?? 64) / 127);
    }
  }
  chimeState.prev = v;
}

// ---- Persistence: patch config + settings survive a reload ---------------
const STORAGE_KEY = "oddball.patchbay.v1";
let loading = true;        // suppress saves while restoring on startup
let saveTimer = null;

// ---- Schema migration ----------------------------------------------------
// v2 corrected the ODD Ball CC mapping (see docs/MIDI.md): X/Y/Z orientation is
// on CC3-5, not CC0-2 — so the modulation-source names were reassigned. Data
// saved under the old scheme is remapped to whatever routed the SAME CC before,
// so a restored patch keeps its exact physical behaviour. Each old name maps to
// the new name for its CC; done atomically per-source so overlapping names
// (tilt_x/y/z existed in both schemes) never double-migrate.
const SCHEMA_VERSION = 2;
const SOURCE_MIGRATION_V2 = {
  tilt_x: "shake",     // was CC0
  tilt_y: "twist",     // was CC1
  tilt_z: "freefall",  // was CC2
  cc3: "tilt_x",       // CC3 (X orientation)
  cc4: "tilt_y",       // CC4 (Y orientation)
  cc5: "tilt_z",       // CC5 (Z orientation)
  cc6: "movement",     // CC6 (movement)
};
const migrateSource = (src) => SOURCE_MIGRATION_V2[src] || src;

// Rewrite source names inside a { connections, seqCfg } bundle in place. Sources
// that aren't CC params (roll_speed, tap, "g:<id>" gestures, …) pass through.
function migrateBundleV2(bundle) {
  if (!bundle || typeof bundle !== "object") return bundle;
  if (bundle.connections && typeof bundle.connections === "object") {
    for (const k in bundle.connections) {
      const c = bundle.connections[k];
      if (c && typeof c.source === "string") c.source = migrateSource(c.source);
    }
  }
  if (bundle.seqCfg && typeof bundle.seqCfg === "object") {
    const migrated = {};
    for (const src in bundle.seqCfg) migrated[migrateSource(src)] = bundle.seqCfg[src];
    bundle.seqCfg = migrated;
  }
  return bundle;
}

function serializeState() {
  const views = {};
  document.querySelectorAll(".side").forEach((s) => {
    views[s.dataset.view] = !s.classList.contains("side--hidden");
  });
  return {
    schema: SCHEMA_VERSION,
    connections,
    seqCfg,
    sensitivity: +els.sens.value,
    sound: soundIntent,
    views,
    histOpen: !els.histDock.classList.contains("hist-dock--collapsed"),
    patchView: orbit.active ? "orbit" : "rack",
  };
}

function saveState() {
  if (loading) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
  } catch (e) { /* storage unavailable (private mode / quota) — ignore */ }
}

// Coalesce bursts of writes (e.g. dragging an editor slider) into one save.
function saveStateSoon() {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved && (saved.schema || 1) < SCHEMA_VERSION) migrateBundleV2(saved);
    return saved;
  } catch (e) { return null; }
}

// Apply a restored config over the defaults, validating each field so a stale
// or corrupt entry can never break the graph.
function applySavedState(saved) {
  if (!saved) return;
  if (saved.connections) {
    for (const instKey in connections) {
      const c = saved.connections[instKey];
      if (c && PARAMS[c.source]) {
        connections[instKey] = mkConn(
          c.source,
          typeof c.atten === "number" ? clamp1(c.atten) : 1,
          typeof c.thresh === "number" ? clamp1(c.thresh) : 0
        );
        if (typeof c.order === "number") connections[instKey].order = c.order;
      } else if (c === null) {
        connections[instKey] = null;
      }
    }
  }
  if (saved.seqCfg && typeof saved.seqCfg === "object") {
    for (const src in saved.seqCfg) {
      const c = saved.seqCfg[src];
      if (c && (c.mode === "together" || c.mode === "sequence")) {
        seqCfg[src] = { mode: c.mode, gap: typeof c.gap === "number" ? c.gap : SEQ_GAP_DEFAULT };
      }
    }
  }
  if (typeof saved.sensitivity === "number") {
    els.sens.value = Math.max(0, Math.min(100, saved.sensitivity));
  }
}

// A single 0..100 "sensitivity" maps to the gate + scale: higher sensitivity
// means a lower threshold and less motion needed to reach full intensity.
function applySensitivity(pct) {
  const s = Math.max(0, Math.min(1, pct / 100));
  ROLL_GATE = 0.72 - 0.5 * s;      // ~0.72 (hard) -> ~0.22 (easy)
  ROLL_SCALE = 1800 - 1050 * s;    // ~1800/sec -> ~750/sec to hit full
  if (els.sensVal) els.sensVal.textContent = Math.round(pct);
  if (els.gateMark) els.gateMark.style.left = `${ROLL_GATE * 100}%`;
}

// ---- Saved profiles: snapshot the whole movement→sound layout ------------
// A profile bundles the patch connections, the moves themselves (so it's
// self-contained and reloading it recreates the gesture triggers) and the
// roll sensitivity. Stored as a named list in localStorage.
const PROFILE_KEY = "oddball.profiles.v1";
let profiles = [];

function serializeConnections() {
  const out = {};
  for (const k in connections) {
    const c = connections[k];
    out[k] = c ? { source: c.source, atten: c.atten, thresh: c.thresh, order: c.order } : null;
  }
  return out;
}

function loadProfiles() {
  try {
    const data = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    profiles = Array.isArray(data) ? data.filter((p) => p && p.id) : [];
  } catch (e) { profiles = []; }
  // Migrate pre-v2 profiles (old CC source names) and persist the upgrade once.
  let changed = false;
  for (const p of profiles) {
    if ((p.schema || 1) < SCHEMA_VERSION) {
      migrateBundleV2(p);
      p.schema = SCHEMA_VERSION;
      changed = true;
    }
  }
  if (changed) writeProfiles();
}

function writeProfiles() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles)); }
  catch (e) { /* storage unavailable — ignore */ }
}

function saveCurrentProfile() {
  const suggestion = `Profile ${profiles.length + 1}`;
  const name = (window.prompt("Name this profile:", suggestion) || "").trim();
  if (!name) return;
  profiles.push({
    id: "p" + Date.now().toString(36),
    name,
    created: Date.now(),
    schema: SCHEMA_VERSION,
    connections: serializeConnections(),
    seqCfg: JSON.parse(JSON.stringify(seqCfg)),
    gestures: serializeGestures(),
    sensitivity: +els.sens.value,
  });
  writeProfiles();
  renderProfiles();
  setView("profiles", true);
  logEvent(`<b>PROFILE</b> saved “${escHtml(name)}”`, "note");
}

function applyProfile(id) {
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  closeEditor();
  if (editingGesture) closeGestureEditor();

  // Clear the current patch (removes cables) and swap the moves wholesale.
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  for (const g of gestures.slice()) unregisterGestureParam(g.id);
  gestures = (Array.isArray(profile.gestures) ? profile.gestures : [])
    .map(gestureFromData).filter(Boolean);
  for (const g of gestures) registerGestureParam(g);
  persistGestures();
  rebuildGraph();                 // recreate source nodes for the profile's moves

  // Restore per-source playback config (together vs. in order).
  for (const k in seqCfg) delete seqCfg[k];
  if (profile.seqCfg && typeof profile.seqCfg === "object") {
    for (const src in profile.seqCfg) {
      const c = profile.seqCfg[src];
      if (c && (c.mode === "together" || c.mode === "sequence")) {
        seqCfg[src] = { mode: c.mode, gap: typeof c.gap === "number" ? c.gap : SEQ_GAP_DEFAULT };
      }
    }
  }

  // Now that every source exists, apply the saved connections.
  const conns = profile.connections || {};
  audio.chimesOn = false;
  for (const instKey in connections) {
    const c = conns[instKey];
    if (c && PARAMS[c.source]) {
      connections[instKey] = mkConn(
        c.source,
        typeof c.atten === "number" ? clamp1(c.atten) : 1,
        typeof c.thresh === "number" ? clamp1(c.thresh) : 0
      );
      if (typeof c.order === "number") connections[instKey].order = c.order;
      if (instKey === "chimes") audio.chimesOn = true;
    }
  }
  if (typeof profile.sensitivity === "number") {
    els.sens.value = Math.max(0, Math.min(100, profile.sensitivity));
    applySensitivity(+els.sens.value);
  }
  refreshConnectionStyles();
  renderGestures();
  saveState();
  logEvent(`<b>PROFILE</b> loaded “${escHtml(profile.name)}”`, "note");
}

function deleteProfile(id) {
  profiles = profiles.filter((p) => p.id !== id);
  writeProfiles();
  renderProfiles();
}

// Commit an inline-edited profile name. Empty reverts to the previous name.
function commitProfileName(input) {
  const p = profiles.find((x) => x.id === input.dataset.name);
  if (!p) return;
  const name = input.value.trim();
  if (!name) { input.value = p.name; return; }
  if (name !== p.name) { p.name = name; writeProfiles(); }
}

function renderProfiles() {
  const box = els.profileList;
  if (!box) return;
  box.innerHTML = "";
  if (!profiles.length) {
    const empty = document.createElement("div");
    empty.className = "profile-empty";
    empty.textContent = "No saved profiles yet. Build a patch, then save it.";
    box.appendChild(empty);
    return;
  }
  for (const p of profiles) {
    const nSounds = Object.values(p.connections || {}).filter(Boolean).length;
    const nMoves = Array.isArray(p.gestures) ? p.gestures.length : 0;
    const row = document.createElement("div");
    row.className = "profile";
    row.innerHTML =
      `<div class="profile-main">` +
        `<input class="profile-name" data-name="${p.id}" spellcheck="false" title="Tap to rename" />` +
        `<div class="profile-meta">${nSounds} sound${nSounds === 1 ? "" : "s"} · ${nMoves} move${nMoves === 1 ? "" : "s"}</div>` +
      `</div>` +
      `<button class="profile-load" data-load="${p.id}">Load</button>` +
      `<button class="profile-del" data-del="${p.id}" title="Delete profile">×</button>`;
    row.querySelector(".profile-name").value = p.name;
    box.appendChild(row);
  }
}

// ---- Per-parameter sparklines (inline history next to input nodes) ------
const SPARK_MAX = 180;
const sparkBuf = {};   // param key -> ring buffer of 0..1 values

function sampleSparks() {
  for (const key in PARAMS) {
    const buf = sparkBuf[key] || (sparkBuf[key] = []);
    buf.push(paramValue(key));
    if (buf.length > SPARK_MAX) buf.shift();
  }
}

function drawSpark(key) {
  const cv = graph.sparkCanvas[key];
  if (!cv) return;
  const ctx = graph.sparkCtx[key] || (graph.sparkCtx[key] = cv.getContext("2d"));
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const buf = sparkBuf[key];
  if (!buf || buf.length < 2) return;
  const color = PARAMS[key].color;
  const pts = (i) => {
    const x = (i / (SPARK_MAX - 1)) * W;
    const y = H - 1 - clamp1(buf[i]) * (H - 2);
    return [x, y];
  };
  // Filled area under the curve.
  ctx.beginPath();
  ctx.moveTo(...pts(0));
  for (let i = 1; i < buf.length; i++) ctx.lineTo(...pts(i));
  const [lx] = pts(buf.length - 1);
  ctx.lineTo(lx, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  // Line.
  ctx.beginPath();
  ctx.moveTo(...pts(0));
  for (let i = 1; i < buf.length; i++) ctx.lineTo(...pts(i));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawSparks() {
  for (const key in graph.sparkCanvas) drawSpark(key);
}

// ---- Bottom histogram: all patch inputs on one time-series --------------
let histCtx = null;

function buildHistLegend() {
  els.histLegend.innerHTML = Object.keys(PARAMS).map((k) =>
    `<span class="item"><span class="sw" style="background:${PARAMS[k].color}"></span>${escHtml(PARAMS[k].label)}</span>`
  ).join("");
}

function setupHistory() {
  histCtx = els.histCanvas.getContext("2d");
  buildHistLegend();
}

function histOpen() {
  return !els.histDock.classList.contains("hist-dock--collapsed");
}

function setHistOpen(open) {
  els.histDock.classList.toggle("hist-dock--collapsed", !open);
  els.histToggle.classList.toggle("is-open", open);
  layoutGraph();   // the graph area resizes when the dock opens/closes
  saveStateSoon();
}

function drawHistory() {
  if (!histCtx || !histOpen()) return;
  const cv = els.histCanvas;
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  }
  const ctx = histCtx, W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 0; g <= 4; g++) { const y = (g / 4) * (H - 2) + 1; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  for (const key in PARAMS) {
    const buf = sparkBuf[key];
    if (!buf || buf.length < 2) continue;
    ctx.strokeStyle = PARAMS[key].color;
    ctx.lineWidth = 1.5 * dpr; ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (SPARK_MAX - 1)) * W;
      const y = H - 1 - clamp1(buf[i]) * (H - 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ---- Patch-bay graph ----------------------------------------------------
const SVGNS = "http://www.w3.org/2000/svg";
const graph = {
  srcPorts: {}, srcNodes: {}, srcVals: {}, sparkCanvas: {}, sparkCtx: {},
  instPorts: {}, instNodes: {},
  cables: {}, temp: null,
  link: null,        // { fromType, fromKey } while a connection is in progress
  mode: null,        // "drag" (holding) or "armed" (click-to-connect)
  fromPort: null, downX: 0, downY: 0,
};

const SRC_W = 210, INST_W = 132, SRC_H = 46, INST_H = 34, GPAD = 16;

function buildGraph() {
  const el = els.graph;
  const svg = document.getElementById("graphSvg");
  const srcKeys = Object.keys(PARAMS);

  // Clear any previous nodes/cables so this can rebuild when gestures change.
  el.querySelectorAll(".gnode").forEach((n) => n.remove());
  svg.innerHTML = "";
  graph.srcPorts = {}; graph.srcNodes = {}; graph.srcVals = {};
  graph.sparkCanvas = {}; graph.sparkCtx = {};
  graph.instPorts = {}; graph.instNodes = {};
  graph.cables = {};

  const makeNode = (cls, inner, portCls) => {
    const node = document.createElement("div");
    node.className = `gnode ${cls}`;
    node.innerHTML = inner;
    const port = document.createElement("div");
    port.className = `gport ${portCls}`;
    node.appendChild(port);
    el.appendChild(node);
    return { node, port };
  };

  // Source nodes (left): label + inline sparkline + live-value bar.
  srcKeys.forEach((key) => {
    const { node, port } = makeNode(
      "gnode--src",
      `<span class="glabel">${escHtml(PARAMS[key].label)}</span><canvas class="spark"></canvas><span class="gval"></span>`,
      "gport--out"
    );
    port.dataset.port = "out";
    port.dataset.key = key;
    node.style.borderColor = PARAMS[key].color;
    graph.srcPorts[key] = port;
    graph.srcNodes[key] = node;
    graph.srcVals[key] = node.querySelector(".gval");
    graph.srcVals[key].style.background = PARAMS[key].color;
    graph.sparkCanvas[key] = node.querySelector(".spark");
  });

  // Instrument nodes (right) with input ports and a preview button.
  INSTRUMENTS.forEach((inst) => {
    const { node, port } = makeNode(
      "gnode--inst",
      `<button class="gtest" title="Preview ${inst.label}" aria-label="Preview ${inst.label}">▶</button>` +
        `<span class="glabel">${inst.label}</span><span class="gval"></span>`,
      "gport--in"
    );
    port.dataset.port = "in";
    port.dataset.key = inst.key;
    graph.instPorts[inst.key] = port;
    graph.instNodes[inst.key] = node;
    const testBtn = node.querySelector(".gtest");
    testBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    testBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      previewInstrument(inst.key, testBtn);
    });
  });

  layoutGraph();
  refreshConnectionStyles();
}

// One-time graph event wiring (kept out of buildGraph so rebuilding the nodes
// for gesture sources doesn't stack duplicate listeners).
function wireGraphEvents() {
  const el = els.graph;
  const svg = document.getElementById("graphSvg");
  window.addEventListener("resize", layoutGraph);
  el.addEventListener("pointerdown", onGraphPointerDown);
  svg.addEventListener("pointerdown", onGraphPointerDown); // clicks on cables
  // A click anywhere off the graph (or Escape) cancels an armed connection.
  window.addEventListener("pointerdown", (e) => {
    if (graph.mode === "armed" && !e.target.closest("#graph")) clearLink();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (graph.link || graph.mode)) clearLink();
  });
}

// Rebuild source/instrument nodes after gestures are added or removed, keeping
// existing connections and the histogram legend in sync.
function rebuildGraph() {
  clearLink();
  buildGraph();
  buildHistLegend();
  if (orbit.built) buildOrbit();
}

function layoutGraph() {
  const el = els.graph;
  const W = el.clientWidth, H = el.clientHeight;
  const srcKeys = Object.keys(PARAMS);
  const srcSlot = (H - GPAD * 2) / srcKeys.length;
  srcKeys.forEach((key, i) => {
    const n = graph.srcNodes[key];
    n.style.width = `${SRC_W}px`;
    n.style.left = `${GPAD}px`;
    n.style.top = `${GPAD + i * srcSlot + (srcSlot - SRC_H) / 2}px`;
  });
  const instSlot = (H - GPAD * 2) / INSTRUMENTS.length;
  const ih = Math.max(18, Math.min(INST_H, instSlot - 4));
  INSTRUMENTS.forEach((inst, i) => {
    const n = graph.instNodes[inst.key];
    n.style.width = `${INST_W}px`;
    n.style.height = `${ih}px`;
    n.style.left = `${W - INST_W - GPAD}px`;
    n.style.top = `${GPAD + i * instSlot + (instSlot - ih) / 2}px`;
  });
}

function portCenter(port) {
  const node = port.offsetParent; // the .gnode
  return {
    x: node.offsetLeft + port.offsetLeft + port.offsetWidth / 2,
    y: node.offsetTop + port.offsetTop + port.offsetHeight / 2,
  };
}

function cablePath(a, b) {
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function connect(srcKey, instKey) {
  const prev = connections[instKey];
  const conn = mkConn(srcKey, prev?.atten ?? 1, prev?.thresh ?? 0);
  // New links join the end of their source's play chain; reconnecting the same
  // pair keeps its position.
  conn.order = (prev && prev.source === srcKey && typeof prev.order === "number")
    ? prev.order
    : siblingsOf(srcKey).filter((k) => k !== instKey).length;
  connections[instKey] = conn;
  if (instKey === "chimes") audio.chimesOn = true;
  refreshConnectionStyles();
  saveStateSoon();
}

// Move an instrument earlier (-1) or later (+1) in its movement's play chain.
function moveInSequence(instKey, dir) {
  const conn = connections[instKey];
  if (!conn) return;
  const sibs = siblingsOf(conn.source);
  const idx = sibs.indexOf(instKey);
  const j = idx + dir;
  if (j < 0 || j >= sibs.length) return;
  sibs.splice(idx, 1);
  sibs.splice(j, 0, instKey);
  sibs.forEach((k, i) => { connections[k].order = i; });
  saveStateSoon();
}

function disconnect(instKey) {
  connections[instKey] = null;
  if (instKey === "chimes") audio.chimesOn = false;
  const c = graph.cables[instKey];
  if (c) { c.line.remove(); c.hit.remove(); delete graph.cables[instKey]; }
  if (editing === instKey) closeEditor();
  refreshConnectionStyles();
  saveStateSoon();
}

function refreshConnectionStyles() {
  const usedSrc = new Set(Object.values(connections).filter(Boolean).map((c) => c.source));
  for (const key in graph.srcPorts) {
    graph.srcPorts[key].classList.toggle("is-connected", usedSrc.has(key));
  }
  for (const inst of INSTRUMENTS) {
    const on = !!connections[inst.key];
    graph.instPorts[inst.key].classList.toggle("is-connected", on);
    graph.instNodes[inst.key].classList.toggle("is-off", !on);
  }
}

// Play a short demo of one instrument. Ensures the audio context is running
// (resuming it briefly even if global sound is off) without changing the user's
// sound on/off intent, then flashes the button while it plays.
async function previewInstrument(key, btn) {
  if (!audio.ctx) {
    await audio.enable();
    setSoundButton(true);
    soundIntent = true;
  } else if (audio.ctx.state === "suspended") {
    await audio.ctx.resume();
    // Global sound is off: re-suspend after the demo finishes so we honor it.
    // The demo swell is 1.3s but event voices ring on — lightning's rolling
    // thunder tail lasts ~3.6s past its trigger — so leave room for the decay.
    if (!audio.enabled) setTimeout(() => { if (!audio.enabled) audio.ctx.suspend(); }, 5000);
  }
  audio.preview(key);
  if (btn) {
    btn.classList.add("is-playing");
    setTimeout(() => btn.classList.remove("is-playing"), 1300);
  }
}

// Disconnect every instrument from its trigger — a clean slate.
function clearPatch() {
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  closeEditor();
  refreshConnectionStyles();
  saveStateSoon();
}

// Build a fresh random patch: pick a handful of instruments and wire each to a
// random parameter with a random response curve. Kept to a few voices so the
// result is playable rather than a wall of sound.
function randomizePatch() {
  for (const inst of INSTRUMENTS) if (connections[inst.key]) disconnect(inst.key);
  resetSeqRuntime();
  const paramKeys = Object.keys(PARAMS);
  const insts = INSTRUMENTS.slice();
  for (let i = insts.length - 1; i > 0; i--) {           // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [insts[i], insts[j]] = [insts[j], insts[i]];
  }
  const n = 3 + Math.floor(Math.random() * 5);           // 3..7 instruments
  for (let i = 0; i < n && i < insts.length; i++) {
    const src = paramKeys[Math.floor(Math.random() * paramKeys.length)];
    connect(src, insts[i].key);
    const c = connections[insts[i].key];
    c.atten = +(0.5 + Math.random() * 0.5).toFixed(2);
    c.thresh = +(Math.random() * 0.35).toFixed(2);
  }
  closeEditor();
  refreshConnectionStyles();
  saveStateSoon();
}

// Connecting works two ways, no long drag required:
//   • click a port, then click a port on the other side, OR
//   • press-drag-release from one port onto another (classic drag).
// A short press-and-release on a port "arms" the link: a cable then trails the
// cursor until the next click on an opposite port completes it.
function onGraphPointerDown(e) {
  const port = e.target.closest(".gport");
  // If a link is armed, this click lands it (or cancels).
  if (graph.link && graph.mode === "armed") {
    if (port && port.dataset.port !== graph.link.fromType) completeLink(port);
    else clearLink();
    return;
  }
  if (port) { startLink(port, e); return; }
  // Click on a cable hit-area opens the connection editor for that link.
  const hit = e.target.closest(".cable-hit");
  if (hit) { openEditor(hit.dataset.inst, e.clientX, e.clientY); return; }
}

function startLink(port, e) {
  e.preventDefault();
  graph.link = { fromType: port.dataset.port, fromKey: port.dataset.key };
  graph.mode = "drag";
  graph.downX = e.clientX; graph.downY = e.clientY;
  graph.fromPort = port; port.classList.add("is-source");
  graph.temp = document.createElementNS(SVGNS, "path");
  graph.temp.setAttribute("class", "cable-temp");
  graph.temp.setAttribute("stroke",
    graph.link.fromType === "out" ? (PARAMS[graph.link.fromKey]?.color || "#00e5ff") : "#00e5ff");
  graph.temp.setAttribute("stroke-width", "2.5");
  document.getElementById("graphSvg").appendChild(graph.temp);
  window.addEventListener("pointermove", onGraphPointerMove);
  window.addEventListener("pointerup", onLinkPointerUp);
  onGraphPointerMove(e); // draw the initial stub immediately
}

function completeLink(p) {
  const d = graph.link;
  if (d) {
    const srcKey = d.fromType === "out" ? d.fromKey : p.dataset.key;
    const instKey = d.fromType === "out" ? p.dataset.key : d.fromKey;
    if (PARAMS[srcKey] && connections[instKey] !== undefined) connect(srcKey, instKey);
  }
  clearLink();
}

function clearLink() {
  window.removeEventListener("pointermove", onGraphPointerMove);
  window.removeEventListener("pointerup", onLinkPointerUp);
  document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
  if (graph.fromPort) { graph.fromPort.classList.remove("is-source"); graph.fromPort = null; }
  if (graph.temp) { graph.temp.remove(); graph.temp = null; }
  graph.link = null; graph.mode = null;
}

function localPoint(e) {
  const r = els.graph.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onGraphPointerMove(e) {
  if (!graph.link || !graph.temp) return;
  const from = graph.link.fromType === "out"
    ? portCenter(graph.srcPorts[graph.link.fromKey])
    : portCenter(graph.instPorts[graph.link.fromKey]);
  graph.temp.setAttribute("d", cablePath(from, localPoint(e)));

  const over = document.elementFromPoint(e.clientX, e.clientY);
  const p = over && over.closest(".gport");
  document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
  if (p && p.dataset.port !== graph.link.fromType) p.classList.add("is-target");
}

function onLinkPointerUp(e) {
  window.removeEventListener("pointerup", onLinkPointerUp);
  if (!graph.link) return;
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const p = over && over.closest(".gport");
  if (p && p.dataset.port !== graph.link.fromType) { completeLink(p); return; }
  // Released without landing on a target: if it was basically a click (no real
  // drag), keep the link armed so the next click on a port finishes it.
  const moved = Math.hypot(e.clientX - graph.downX, e.clientY - graph.downY);
  if (moved < 6) graph.mode = "armed"; // keep temp + pointermove trailing the cursor
  else clearLink();
}

// ---- Connection editor (threshold + attenuation per link) ---------------
let editing = null; // instrument key of the connection being edited

function openEditor(instKey, clientX, clientY) {
  const conn = connections[instKey];
  if (!conn) return;
  editing = instKey;
  const inst = INSTRUMENTS.find((i) => i.key === instKey);
  els.ceTitle.textContent = `${PARAMS[conn.source].label} → ${inst.label}`;
  els.ceThresh.value = Math.round(conn.thresh * 100);
  els.ceAtten.value = Math.round(conn.atten * 100);
  updateEditorLabels();
  updateSeqEditor();

  const ed = els.connEditor;
  ed.classList.remove("conn-editor--hidden");
  const w = ed.offsetWidth || 240;
  const h = ed.offsetHeight || 210;
  let x = clientX + 14, y = clientY - 20;
  x = Math.min(x, window.innerWidth - w - 12);
  y = Math.min(Math.max(12, y), window.innerHeight - h - 12);
  ed.style.left = `${x}px`;
  ed.style.top = `${y}px`;
  refreshConnectionStyles();
}

function closeEditor() {
  editing = null;
  els.connEditor.classList.add("conn-editor--hidden");
}

function updateEditorLabels() {
  const conn = editing && connections[editing];
  if (!conn) return;
  els.ceThreshVal.textContent = conn.thresh.toFixed(2);
  els.ceAttenVal.textContent = conn.atten.toFixed(2);
}

// Show the playback controls whenever this cable's source drives more than one
// instrument, so there's actually an order worth choosing. Recorded gestures
// always play as a sequence; plain inputs get a together/in-order toggle.
function updateSeqEditor() {
  const conn = editing && connections[editing];
  const box = els.ceSeq;
  const sibs = conn ? siblingsOf(conn.source) : [];
  if (!conn || sibs.length < 2) {
    box.classList.add("ce-seq--hidden");
    return;
  }
  box.classList.remove("ce-seq--hidden");
  const gesture = isGestureSource(conn.source);
  const sequenced = sourceSequenced(conn.source);
  // Mode toggle only applies to plain inputs; gestures are always sequenced.
  els.ceSeqMode.style.display = gesture ? "none" : "";
  if (!gesture) {
    const mode = seqConfig(conn.source).mode;
    els.ceModeTogether.classList.toggle("is-active", mode === "together");
    els.ceModeSeq.classList.toggle("is-active", mode === "sequence");
  }
  // Order + spacing only matter when the sounds play one after another.
  els.ceSeqBody.style.display = sequenced ? "" : "none";
  const idx = sibs.indexOf(editing);
  els.ceSeqPos.textContent = `step ${idx + 1} / ${sibs.length}`;
  els.ceSeqUp.disabled = idx <= 0;
  els.ceSeqDown.disabled = idx >= sibs.length - 1;
  const gap = seqGapFor(conn.source);
  els.ceSeqGap.value = gap;
  els.ceSeqGapVal.textContent = gap;
}

// Switch a plain input between playing its instruments together vs. in order.
function setSeqMode(mode) {
  const conn = editing && connections[editing];
  if (!conn || isGestureSource(conn.source)) return;
  seqConfig(conn.source).mode = mode;
  updateSeqEditor();
  saveStateSoon();
}

function updateInstruments() {
  const svg = document.getElementById("graphSvg");
  const now = performance.now();
  // When the orbit view is active the rack (#graph) is display:none, so its
  // port nodes report a null offsetParent and portCenter() would throw. Skip all
  // rack DOM work in that case (the orbit renderer draws the cables instead), but
  // still push audio levels every frame so sound keeps playing in either view.
  const rackVisible = !orbit.active;
  for (const inst of INSTRUMENTS) {
    const conn = connections[inst.key];
    const v = shape(conn, inst.key);
    if (inst.key !== "chimes") audio.setVoice(inst.key, v);
    else updateChimes(conn, v, now);
    if (!rackVisible) continue;

    // Draw / update the cable for this instrument's connection.
    let c = graph.cables[inst.key];
    if (conn) {
      if (!c) {
        const hit = document.createElementNS(SVGNS, "path");
        hit.setAttribute("class", "cable-hit");
        hit.dataset.inst = inst.key;
        const line = document.createElementNS(SVGNS, "path");
        line.setAttribute("class", "cable");
        svg.appendChild(hit); svg.appendChild(line);
        c = graph.cables[inst.key] = { line, hit };
      }
      const a = portCenter(graph.srcPorts[conn.source]);
      const b = portCenter(graph.instPorts[inst.key]);
      const dd = cablePath(a, b);
      c.line.setAttribute("d", dd);
      c.hit.setAttribute("d", dd);
      c.line.setAttribute("stroke", PARAMS[conn.source].color);
      c.line.setAttribute("stroke-width", (1.5 + v * 5).toFixed(2));
      c.line.setAttribute("stroke-opacity", (0.3 + v * 0.7).toFixed(2));
      c.line.classList.toggle("is-selected", editing === inst.key);
    } else if (c) {
      c.line.remove(); c.hit.remove(); delete graph.cables[inst.key];
    }
  }
  // Source node live-value bars (rack only).
  if (rackVisible) {
    for (const key in graph.srcVals) {
      graph.srcVals[key].style.width = `${paramValue(key) * 100}%`;
    }
  }
  // Live meter inside the connection editor (works in either view).
  if (editing && connections[editing]) {
    const conn = connections[editing];
    els.ceMeterIn.style.width = `${clamp1(paramValue(conn.source)) * 100}%`;
    els.ceMeterOut.style.width = `${clamp1(shape(conn, editing)) * 100}%`;
  }
}

// ---- Orbit view: force-directed patch diagram ---------------------------
// An alternate read/write layout of the same patch. The ODD ball is a big node
// at the centre; every modulation signal (PARAMS) is a satellite orbiting it,
// each drawing its own labelled live histogram and ending in a little output
// port. Instruments are triangular targets that drift on the outer ring, and a
// patched connection is a cable pulling its instrument in toward the driving
// satellite. A light spring/repulsion simulation keeps it all arranged.
const orbit = {
  active: false,
  ctx: null,
  w: 0, h: 0, dpr: 1,
  nodes: [],
  byKey: {},
  ball: null,
  drag: null,          // { node, ox, oy, moved }
  link: null,          // { fromKey, x, y, over }
  built: false,
};

// Simulation tuning (per-frame units; forces are unit-less pushes on velocity).
const ORB = {
  REP: 2600,           // pairwise repulsion strength
  REP_MAX: 3.2,        // cap on a single repulsion push
  OVERLAP: 0.55,       // extra shove when two nodes overlap
  K_ORBIT: 0.010,      // satellite ↔ ball spring
  K_LINK: 0.020,       // instrument ↔ its driving satellite
  K_IDLE: 0.006,       // unpatched instrument ↔ ball (loose outer ring)
  DAMP: 0.85,
  MAXV: 20,
  RING: 0.27,          // satellite ring radius (× min(w,h))
  OUT: 0.45,           // idle instrument ring radius (× min(w,h))
  LINK_LEN: 118,
};

function initOrbit() {
  orbit.ctx = els.orbitCanvas.getContext("2d");
  els.orbitCanvas.addEventListener("pointerdown", onOrbitDown);
}

function resizeOrbit() {
  const cv = els.orbitCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return false;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  orbit.w = w; orbit.h = h; orbit.dpr = dpr;
  orbit.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

// (Re)build the node set from the current PARAMS + INSTRUMENTS, preserving the
// live positions of anything that already existed (so adding a gesture source
// doesn't scatter the whole diagram).
function buildOrbit() {
  const prev = orbit.byKey || {};
  const w = orbit.w || els.orbitCanvas.clientWidth || 860;
  const h = orbit.h || els.orbitCanvas.clientHeight || 520;
  const cx = w / 2, cy = h / 2;
  const R = Math.max(120, Math.min(w, h));
  const nodes = [], byKey = {};

  let ball = orbit.ball || { type: "ball", key: "__ball", vx: 0, vy: 0 };
  ball.type = "ball"; ball.label = "ODD"; ball.color = "#00e5ff";
  ball.x = cx; ball.y = cy; ball.vx = 0; ball.vy = 0; ball.r = 46; ball.rep = 3.4;
  orbit.ball = ball; nodes.push(ball);

  const pk = Object.keys(PARAMS);
  pk.forEach((key, i) => {
    const id = "p:" + key;
    const a = (i / pk.length) * Math.PI * 2 - Math.PI / 2;
    const n = prev[id] || {
      vx: 0, vy: 0,
      x: cx + Math.cos(a) * R * ORB.RING,
      y: cy + Math.sin(a) * R * ORB.RING,
    };
    n.type = "param"; n.key = key; n.label = PARAMS[key].label; n.color = PARAMS[key].color;
    n.pw = 90; n.ph = 52; n.r = 46; n.rep = 1.35;
    byKey[id] = n; nodes.push(n);
  });

  INSTRUMENTS.forEach((inst, i) => {
    const id = "i:" + inst.key;
    const a = (i / INSTRUMENTS.length) * Math.PI * 2;
    const n = prev[id] || {
      vx: 0, vy: 0,
      x: cx + Math.cos(a) * R * ORB.OUT,
      y: cy + Math.sin(a) * R * ORB.OUT,
    };
    n.type = "inst"; n.key = inst.key; n.label = inst.label; n.r = 21; n.rep = 0.85;
    byKey[id] = n; nodes.push(n);
  });

  orbit.nodes = nodes; orbit.byKey = byKey; orbit.built = true;
}

// Pull node `n` toward `target` so its distance relaxes to `rest`.
function orbSpring(n, target, rest, k) {
  let dx = target.x - n.x, dy = target.y - n.y;
  let d = Math.hypot(dx, dy) || 0.001;
  const f = (d - rest) * k;
  n.fx += (dx / d) * f;
  n.fy += (dy / d) * f;
}

function stepOrbit() {
  const N = orbit.nodes;
  if (!N.length) return;
  const cx = orbit.w / 2, cy = orbit.h / 2;
  const R = Math.max(120, Math.min(orbit.w, orbit.h));
  const ringR = R * ORB.RING, outR = R * ORB.OUT;

  if (orbit.ball && (!orbit.drag || orbit.drag.node !== orbit.ball)) {
    orbit.ball.x = cx; orbit.ball.y = cy; orbit.ball.vx = 0; orbit.ball.vy = 0;
  }
  for (const n of N) { n.fx = 0; n.fy = 0; }

  for (let i = 0; i < N.length; i++) {
    for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
      const d = Math.sqrt(d2);
      let f = Math.min(ORB.REP_MAX, ORB.REP * (a.rep || 1) * (b.rep || 1) / d2);
      const minD = a.r + b.r;
      if (d < minD) f += (minD - d) * ORB.OVERLAP;
      const ux = dx / d, uy = dy / d;
      a.fx += ux * f; a.fy += uy * f;
      b.fx -= ux * f; b.fy -= uy * f;
    }
  }

  for (const n of N) {
    if (n.type === "param") {
      orbSpring(n, orbit.ball, ringR, ORB.K_ORBIT);
    } else if (n.type === "inst") {
      const conn = connections[n.key];
      const src = conn && orbit.byKey["p:" + conn.source];
      if (src) orbSpring(n, src, ORB.LINK_LEN, ORB.K_LINK);
      else orbSpring(n, orbit.ball, outR, ORB.K_IDLE);
    }
  }

  for (const n of N) {
    if (n === orbit.ball) continue;
    if (orbit.drag && orbit.drag.node === n) continue;
    n.vx = (n.vx + n.fx) * ORB.DAMP;
    n.vy = (n.vy + n.fy) * ORB.DAMP;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > ORB.MAXV) { n.vx *= ORB.MAXV / sp; n.vy *= ORB.MAXV / sp; }
    n.x += n.vx; n.y += n.vy;
    const m = n.r + 4;
    if (n.x < m) { n.x = m; n.vx *= -0.4; }
    if (n.x > orbit.w - m) { n.x = orbit.w - m; n.vx *= -0.4; }
    if (n.y < m) { n.y = m; n.vy *= -0.4; }
    if (n.y > orbit.h - m) { n.y = orbit.h - m; n.vy *= -0.4; }
  }
}

// The little output port sits on the satellite edge facing away from the ball.
function orbPortOut(n) {
  const a = Math.atan2(n.y - orbit.ball.y, n.x - orbit.ball.x);
  return { x: n.x + Math.cos(a) * (n.pw / 2 + 4), y: n.y + Math.sin(a) * (n.ph / 2) };
}
// An instrument takes its cable on the edge facing the ball.
function orbPortIn(n) {
  const a = Math.atan2(orbit.ball.y - n.y, orbit.ball.x - n.x);
  return { x: n.x + Math.cos(a) * n.r, y: n.y + Math.sin(a) * n.r };
}

function orbCablePath(ctx, a, b, color, width, alpha) {
  const mx = (a.x + b.x) / 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const ORB_BARS = 18;
function drawSatellite(ctx, n) {
  const val = clamp1(paramValue(n.key));
  const x = n.x - n.pw / 2, y = n.y - n.ph / 2, w = n.pw, h = n.ph;
  ctx.save();
  // card
  roundRectPath(ctx, x, y, w, h, 9);
  ctx.fillStyle = "rgba(20,23,40,0.92)";
  ctx.fill();
  ctx.lineWidth = 1.4 + val * 2.2;
  ctx.strokeStyle = n.color;
  ctx.globalAlpha = 0.55 + val * 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;
  // label
  ctx.fillStyle = "#c9cdf0";
  ctx.font = "600 9px system-ui, sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  const label = n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label;
  ctx.fillText(label, x + 8, y + 6);
  // labelled histogram
  const hx = x + 8, hy = y + 19, hw = w - 16, hh = h - 26;
  const buf = sparkBuf[n.key];
  if (buf && buf.length > 1) {
    const bw = hw / ORB_BARS;
    for (let bxi = 0; bxi < ORB_BARS; bxi++) {
      const lo = Math.floor((bxi / ORB_BARS) * buf.length);
      const hi = Math.max(lo + 1, Math.floor(((bxi + 1) / ORB_BARS) * buf.length));
      let m = 0;
      for (let k = lo; k < hi && k < buf.length; k++) m = Math.max(m, buf[k]);
      const bh = Math.max(1, clamp1(m) * hh);
      ctx.fillStyle = n.color;
      ctx.globalAlpha = 0.3 + clamp1(m) * 0.6;
      ctx.fillRect(hx + bxi * bw + 0.5, hy + hh - bh, Math.max(1, bw - 1), bh);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  // output port
  const p = orbPortOut(n);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#0c0e1a";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = n.color;
  ctx.stroke();
}

function drawTriangle(ctx, n) {
  const conn = connections[n.key];
  const on = !!conn;
  const v = on ? shape(conn, n.key) : 0;
  const col = on ? (PARAMS[conn.source] ? PARAMS[conn.source].color : "#8b90b8") : "#6b7099";
  const a = Math.atan2(n.y - orbit.ball.y, n.x - orbit.ball.x); // apex points outward
  const r = n.r;
  ctx.save();
  ctx.translate(n.x, n.y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.7, r * 0.82);
  ctx.lineTo(-r * 0.7, -r * 0.82);
  ctx.closePath();
  ctx.fillStyle = on ? "rgba(24,27,46,0.96)" : "rgba(20,22,36,0.7)";
  ctx.fill();
  ctx.lineWidth = 1.5 + v * 3;
  ctx.strokeStyle = col;
  ctx.globalAlpha = on ? 0.7 + v * 0.3 : 0.5;
  ctx.stroke();
  if (v > 0.02) {
    ctx.globalAlpha = v * 0.5;
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();
  // label just outside the apex
  const lx = n.x + Math.cos(a) * (r + 9), ly = n.y + Math.sin(a) * (r + 9);
  ctx.save();
  ctx.font = "600 9.5px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = Math.cos(a) < -0.2 ? "right" : (Math.cos(a) > 0.2 ? "left" : "center");
  ctx.fillStyle = on ? "#e9ecff" : "#8b90b8";
  ctx.globalAlpha = orbit.link && orbit.link.over === n ? 1 : 0.92;
  ctx.fillText(n.label, lx, ly);
  ctx.restore();
}

function drawBall(ctx, n) {
  const g = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, n.r * 0.2, n.x, n.y, n.r);
  g.addColorStop(0, "#eafcff");
  g.addColorStop(0.4, "#00e5ff");
  g.addColorStop(1, "#5a2fe0");
  ctx.save();
  ctx.shadowColor = "rgba(0,229,255,0.5)";
  ctx.shadowBlur = 26;
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "rgba(6,8,18,0.85)";
  ctx.font = "800 15px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("ODD", n.x, n.y);
}

function drawOrbit() {
  const ctx = orbit.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, orbit.w, orbit.h);

  // faint orbital guide ring
  const R = Math.max(120, Math.min(orbit.w, orbit.h));
  ctx.beginPath();
  ctx.arc(orbit.ball.x, orbit.ball.y, R * ORB.RING, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // cables (behind nodes)
  for (const inst of INSTRUMENTS) {
    const conn = connections[inst.key];
    if (!conn) continue;
    const src = orbit.byKey["p:" + conn.source];
    const dst = orbit.byKey["i:" + inst.key];
    if (!src || !dst) continue;
    const v = shape(conn, inst.key);
    orbCablePath(ctx, orbPortOut(src), orbPortIn(dst),
      PARAMS[conn.source].color, 1.5 + v * 5, 0.28 + v * 0.7);
    if (editing === inst.key) {
      orbCablePath(ctx, orbPortOut(src), orbPortIn(dst), "#ffffff", 1.2, 0.5);
    }
  }

  // in-progress link
  if (orbit.link) {
    const src = orbit.byKey["p:" + orbit.link.fromKey];
    if (src) {
      const from = orbPortOut(src);
      ctx.save();
      ctx.setLineDash([5, 4]);
      orbCablePath(ctx, from, { x: orbit.link.x, y: orbit.link.y }, src.color, 2.5, 0.9);
      ctx.restore();
    }
  }

  drawBall(ctx, orbit.ball);
  for (const n of orbit.nodes) if (n.type === "inst") drawTriangle(ctx, n);
  for (const n of orbit.nodes) if (n.type === "param") drawSatellite(ctx, n);
}

// ---- Orbit pointer interaction ----
function orbitPoint(e) {
  const r = els.orbitCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function orbHitInst(x, y) {
  for (const n of orbit.nodes) {
    if (n.type !== "inst") continue;
    if (Math.hypot(x - n.x, y - n.y) <= n.r + 6) return n;
  }
  return null;
}

function orbTopNode(x, y) {
  // params first (drawn on top), then instruments, then ball
  for (const n of orbit.nodes) {
    if (n.type !== "param") continue;
    if (Math.abs(x - n.x) <= n.pw / 2 && Math.abs(y - n.y) <= n.ph / 2) return n;
  }
  const inst = orbHitInst(x, y);
  if (inst) return inst;
  if (Math.hypot(x - orbit.ball.x, y - orbit.ball.y) <= orbit.ball.r) return orbit.ball;
  return null;
}

// Distance from a point to a connection's cable, for click-to-edit. Samples the
// same cubic bezier that orbCablePath draws (control points at the mid-x).
function orbCableAt(x, y) {
  let best = null, bestD = 9;
  for (const inst of INSTRUMENTS) {
    const conn = connections[inst.key];
    if (!conn) continue;
    const src = orbit.byKey["p:" + conn.source];
    const dst = orbit.byKey["i:" + inst.key];
    if (!src || !dst) continue;
    const a = orbPortOut(src), b = orbPortIn(dst), mx = (a.x + b.x) / 2;
    const c1 = { x: mx, y: a.y }, c2 = { x: mx, y: b.y };
    for (let t = 0; t <= 1; t += 0.04) {
      const it = 1 - t;
      const w0 = it * it * it, w1 = 3 * it * it * t, w2 = 3 * it * t * t, w3 = t * t * t;
      const px = w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x;
      const py = w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y;
      const d = Math.hypot(x - px, y - py);
      if (d < bestD) { bestD = d; best = inst.key; }
    }
  }
  return best;
}

function onOrbitDown(e) {
  if (!orbit.active) return;
  const p = orbitPoint(e);
  e.preventDefault();

  // 1. output port of a satellite → begin a patch cable
  for (const n of orbit.nodes) {
    if (n.type !== "param") continue;
    const port = orbPortOut(n);
    if (Math.hypot(p.x - port.x, p.y - port.y) <= 11) {
      orbit.link = { fromKey: n.key, x: p.x, y: p.y, over: null };
      window.addEventListener("pointermove", onOrbitMove);
      window.addEventListener("pointerup", onOrbitUp);
      return;
    }
  }

  // 2. a node body → drag it around
  const node = orbTopNode(p.x, p.y);
  if (node) {
    orbit.drag = { node, ox: p.x - node.x, oy: p.y - node.y, downX: p.x, downY: p.y };
    node.vx = 0; node.vy = 0;
    window.addEventListener("pointermove", onOrbitMove);
    window.addEventListener("pointerup", onOrbitUp);
    return;
  }

  // 3. a cable → open its connection editor
  const inst = orbCableAt(p.x, p.y);
  if (inst) openEditor(inst, e.clientX, e.clientY);
}

function onOrbitMove(e) {
  const p = orbitPoint(e);
  if (orbit.link) {
    orbit.link.x = p.x; orbit.link.y = p.y;
    orbit.link.over = orbHitInst(p.x, p.y);
  } else if (orbit.drag) {
    const n = orbit.drag.node;
    n.x = p.x - orbit.drag.ox;
    n.y = p.y - orbit.drag.oy;
    n.vx = 0; n.vy = 0;
  }
}

function onOrbitUp(e) {
  window.removeEventListener("pointermove", onOrbitMove);
  window.removeEventListener("pointerup", onOrbitUp);
  const p = orbitPoint(e);
  if (orbit.link) {
    const inst = orbHitInst(p.x, p.y);
    if (inst && PARAMS[orbit.link.fromKey]) connect(orbit.link.fromKey, inst.key);
    orbit.link = null;
  } else if (orbit.drag) {
    const d = orbit.drag; orbit.drag = null;
    const moved = Math.hypot(p.x - d.downX, p.y - d.downY) > 5;
    if (!moved && d.node.type === "inst") previewInstrument(d.node.key);
    else if (moved) saveStateSoon();
  }
}

function setPatchView(mode) {
  orbit.active = mode === "orbit";
  els.graph.classList.toggle("graph--hidden", orbit.active);
  els.orbit.classList.toggle("orbit--hidden", !orbit.active);
  els.patchViews.querySelectorAll(".pv-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.patchview === mode));
  if (orbit.active) {
    resizeOrbit();
    if (!orbit.built) buildOrbit();
  } else {
    layoutGraph();
  }
  saveStateSoon();
}

function renderRoll() {
  const active = rollSpeed > 0;
  els.rollFill.style.width = `${rollRaw * 100}%`;
  els.rollFill.classList.toggle("active", active);
  els.rollVal.textContent = rollSpeed.toFixed(2);
  const rate = Math.round(rollRate);
  const gateRate = Math.round(ROLL_GATE * ROLL_SCALE);
  els.rollRate.innerHTML = active
    ? `<b>rolling</b> · ${rate}/s (gate ${gateRate}/s)`
    : `idle · ${rate}/s (gate ${gateRate}/s)`;
}

// Live CC state. We render a meter per controller as we first see it.
const cc = {};            // controller -> value (0..127)
const ccRows = {};        // controller -> { fill, val }

function ensureCcRow(ctrl) {
  if (ccRows[ctrl]) return ccRows[ctrl];
  const row = document.createElement("div");
  row.className = "cc-row";
  row.innerHTML = `
    <div class="cc-label">CC ${ctrl}</div>
    <div class="cc-track"><div class="cc-fill"></div></div>
    <div class="cc-val">0</div>`;
  // Keep rows ordered by controller number.
  const existing = Object.keys(ccRows).map(Number).sort((a, b) => a - b);
  let inserted = false;
  for (const c of existing) {
    if (ctrl < c) { els.ccMeters.insertBefore(row, ccRows[c].root); inserted = true; break; }
  }
  if (!inserted) els.ccMeters.appendChild(row);
  ccRows[ctrl] = {
    root: row,
    fill: row.querySelector(".cc-fill"),
    val: row.querySelector(".cc-val"),
  };
  return ccRows[ctrl];
}

function logEvent(html, cls = "") {
  const div = document.createElement("div");
  div.className = `ev ${cls}`;
  div.innerHTML = html;
  els.log.prepend(div);
  while (els.log.childElementCount > 80) els.log.lastChild.remove();
}

function setStatus(on, label) {
  els.status.textContent = label;
  els.status.className = `status ${on ? "status--on" : "status--off"}`;
}

function spawnRipple(velocity) {
  const r = document.createElement("div");
  r.className = "ripple";
  const scale = 0.6 + (velocity / 127) * 1.0;
  r.style.borderColor = `hsl(${180 + velocity}, 100%, 65%)`;
  r.style.transform = `scale(${scale})`;
  els.ripples.appendChild(r);
  setTimeout(() => r.remove(), 700);
}

// Drive the orb from the orientation CCs. Per docs/MIDI.md the ball reports
// X/Y/Z orientation on CC3/4/5; we use those for tilt X / tilt Y / roll, and
// overall motion energy for glow.
function updateOrb() {
  const v = (c, d = 64) => (cc[c] ?? d);
  const tiltX = (v(3) - 64) / 64;   // -1..1  (X orientation, CC3)
  const tiltY = (v(4) - 64) / 64;   //         (Y orientation, CC4)
  const roll = (v(5) - 64) / 64;    //         (Z orientation, CC5)
  // Glow tracks actual MOTION (updated each frame from gestActivity), not the
  // static tilt — so a still ball doesn't stay lit up at an angle.
  const energy = lastMotion;

  const rotX = (-tiltY * 35).toFixed(1);
  const rotY = (tiltX * 35).toFixed(1);
  const rotZ = (roll * 25).toFixed(1);
  const lift = (energy * -24).toFixed(1);
  const scale = (1 + energy * 0.08).toFixed(3);

  els.orb.style.transform =
    `translateY(${lift}px) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg) scale(${scale})`;
  els.orb.style.boxShadow =
    `0 ${20 + energy * 30}px ${60 + energy * 40}px rgba(108,92,231,${0.4 + energy * 0.4}), inset 0 -20px 40px rgba(0,0,0,0.35)`;
  const hue = 250 - energy * 90;
  els.orb.style.background =
    `radial-gradient(circle at 32% 28%, #fff 0%, #c7c2ff 12%, hsl(${hue},70%,60%) 48%, #2a2370 100%)`;

  els.shadow.style.transform = `translateX(${tiltX * 30}px) scale(${1 - energy * 0.25})`;
  els.shadow.style.opacity = `${0.5 - energy * 0.2}`;
}

let soundIntent = true; // desired on/off; audio may be gated by autoplay policy

function setSoundButton(on) {
  els.soundToggle.textContent = on ? "🔊 Sound on" : "🔇 Sound off";
  els.soundToggle.className = `sound-btn ${on ? "sound-btn--on" : "sound-btn--off"}`;
}

async function toggleSound() {
  soundIntent = !audio.enabled;
  if (audio.enabled) {
    audio.disable();
    setSoundButton(false);
  } else {
    await audio.enable();
    setSoundButton(true);
  }
  saveStateSoon();
}

// Default sound ON: reflect it in the UI and try to start immediately. Browser
// autoplay policy usually requires a gesture, so also arm a one-time listener
// that resumes the context on the first interaction anywhere on the page.
function armDefaultSound() {
  setSoundButton(true);
  const start = async () => {
    if (soundIntent && !audio.enabled) {
      await audio.enable();
      setSoundButton(true);
    }
  };
  start();
  const once = () => { start(); cleanup(); };
  const cleanup = () => {
    window.removeEventListener("pointerdown", once);
    window.removeEventListener("keydown", once);
  };
  window.addEventListener("pointerdown", once);
  window.addEventListener("keydown", once);
}

// ---- Secondary view toggles (drawer) ------------------------------------
function setView(view, on) {
  const side = document.querySelector(`.side[data-view="${view}"]`);
  const btn = document.querySelector(`.view-btn[data-view="${view}"]`);
  if (side) side.classList.toggle("side--hidden", !on);
  if (btn) btn.classList.toggle("is-active", on);
  const anyOn = [...document.querySelectorAll(".side")].some((s) => !s.classList.contains("side--hidden"));
  els.drawer.classList.toggle("is-empty", !anyOn);
  saveStateSoon();
}

function initViews() {
  els.viewToggles.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    setView(view, btn.classList.contains("is-active") ? false : true);
  });
  document.querySelectorAll(".side-close").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view, false));
  });
  // All secondary panels start hidden so the patch bay is the primary view.
  els.drawer.classList.add("is-empty");
}

function onMidiMessage(e) {
  const [status, d1, d2] = e.data;
  // System-realtime housekeeping (clock, active sensing) isn't musical data;
  // keep it out of the msg/s rate, the same way listen.py ignores it.
  if (status >= 0xf8) return;
  const type = status & 0xf0;
  msgCount++;
  // High-fidelity capture: log the raw message before any app-side filtering
  // (e.g. the CC7 drop below) so the file is a faithful record of the stream.
  if (rawRec) rawRecPush(e.data, e.target);

  if (type === 0x90 && d2 > 0) {            // note on
    const gesture = NOTE_GESTURE[d1];
    // Shake (note 1) and Twist (note 2) already report through CC0/CC1, so
    // only a Tap drives the tap envelope and the chimes — otherwise a vigorous
    // shake double-triggers as both a shake and a fake tap. Unknown notes are
    // treated as taps so a firmware with a remapped note table keeps working.
    const isTap = gesture === undefined || d1 === NOTE_TAP;
    if (isTap) tapEnv = Math.max(tapEnv, d2 / 127);
    els.lastNote.textContent = noteName(d1);
    els.lastNoteSub.textContent = `note ${d1} · velocity ${d2}${gesture ? ` · ${gesture.toLowerCase()}` : ""}`;
    els.orb.animate(
      [{ filter: "brightness(2.2)" }, { filter: "brightness(1)" }],
      { duration: 320, easing: "ease-out" }
    );
    spawnRipple(d2);
    // Pitch follows X orientation (CC3) so moving the ball plays different
    // notes. Only the direct tap→chimes patch fires from here; other sources
    // trigger chimes from their own value edges in updateChimes.
    if (isTap && chimeDirect(connections.chimes)) audio.hit(d2, (cc[3] ?? 64) / 127);
    logEvent(`<b>NOTE</b> ${noteName(d1)} (${d1}) vel ${d2}${gesture ? ` · ${gesture}` : ""}`, "note");
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {  // note off
    // (Quiet in the log to avoid clutter.)
  } else if (type === 0xb0) {               // control change
    // Drop CC7: the ball emits it, but CC7 is MIDI Channel Volume and would
    // otherwise pollute meters/gestures (and mutes DAWs). See docs/MIDI.md.
    if (d1 === 7) return;
    const id = (e.target && e.target.id) || "_";
    const dev = deviceCc[id] || (deviceCc[id] = {});
    const prevDev = dev[d1];
    // Roll delta is measured within a single device only.
    if (prevDev !== undefined && ROLL_CHANNELS.has(d1)) {
      rollAccum += Math.abs(d2 - prevDev);
    }
    // Gesture path length is per-device too, measured against the device's own
    // previous value — never the cross-device average, which would let a
    // second controller dilute (or fake) this ball's motion.
    if (prevDev !== undefined && GEST_CHANNELS.has(d1)) {
      gestPipe(id).featAccum += Math.abs(d2 - prevDev) / 127;
    }
    dev[d1] = d2;
    // Merge this controller across all bound devices for the shared value.
    cc[d1] = aggregateCc(d1);
    const row = ensureCcRow(d1);
    row.fill.style.width = `${(cc[d1] / 127) * 100}%`;
    row.val.textContent = Math.round(cc[d1]);
  } else if (type === 0xe0) {               // pitch bend
    logEvent(`<b>PITCH</b> ${((d2 << 7) | d1) - 8192}`);
  }
}

// Average a controller's value across every device that has reported it.
function aggregateCc(ctrl) {
  let sum = 0, n = 0;
  for (const id in deviceCc) {
    const v = deviceCc[id][ctrl];
    if (v !== undefined) { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

const isOdd = (input) => /odd/i.test(input.name);

// Bind onmidimessage to a list of Web MIDI inputs (and detach from all others)
// so any number of controllers can drive the app at once. BLE-paired balls feed
// the app directly (see connectBluetoothBall) and are merged in by syncActiveInputs.
function bindInputs(inputs) {
  if (midi) for (const inp of midi.inputs.values()) inp.onmidimessage = null;
  selectedWebInputs = inputs;
  for (const inp of inputs) inp.onmidimessage = onMidiMessage;
  syncActiveInputs();
  if (inputs.length) logEvent(`listening on <b>${escHtml(inputs.map((i) => i.name).join(", "))}</b>`);
}

// Recompute the combined active-input list (Web MIDI selection + BLE balls) and
// refresh status. Called whenever either source changes so the two stay merged.
function syncActiveInputs() {
  activeInputs = [...selectedWebInputs, ...bleInputs];
  // Drop stale per-device state so a removed controller stops contributing.
  for (const k in deviceCc) delete deviceCc[k];
  clearGestPipes();
  rollAccum = 0;
  if (activeInputs.length === 0) { setStatus(false, "disconnected"); return; }
  setStatus(true, activeInputs.length > 1 ? `connected · ${activeInputs.length}` : "connected");
  els.hint.classList.add("hide");
}

// Resolve a dropdown value ("all-odd" / "all" / a specific port id) to inputs.
function applySelection(value) {
  const inputs = [...midi.inputs.values()];
  let chosen;
  if (value === "all-odd") chosen = inputs.filter(isOdd);
  else if (value === "all") chosen = inputs;
  else { const one = midi.inputs.get(value); chosen = one ? [one] : []; }
  bindInputs(chosen);
}

function refreshPorts() {
  const prev = els.portSelect.value;
  els.portSelect.innerHTML = "";
  const inputs = [...midi.inputs.values()];
  if (inputs.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No MIDI inputs found";
    opt.value = "";
    els.portSelect.appendChild(opt);
    // Keep any Bluetooth-paired ball active; status reflects the combined total.
    selectedWebInputs = [];
    syncActiveInputs();
    return;
  }
  const oddInputs = inputs.filter(isOdd);
  const addOpt = (val, label) => {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    els.portSelect.appendChild(o);
  };
  // Grouped choices: all ODD Balls together, all inputs, then each port.
  if (oddInputs.length) addOpt("all-odd", oddInputs.length > 1 ? `All ODD Balls (${oddInputs.length})` : "ODD Ball");
  if (inputs.length > 1) addOpt("all", `All inputs (${inputs.length})`);
  for (const input of inputs) addOpt(input.id, input.name);

  // Keep the prior choice if still valid, else default to all ODD Balls.
  const values = [...els.portSelect.options].map((o) => o.value);
  const target = (prev && values.includes(prev)) ? prev
    : (oddInputs.length ? "all-odd" : inputs[0].id);
  els.portSelect.value = target;
  applySelection(target);
}

// ---- Bluetooth (BLE-MIDI) direct pairing -------------------------------------
// The ODD Ball is a BLE-MIDI controller. On macOS it normally has to be paired
// through Audio MIDI Setup before Web MIDI can see it. Web Bluetooth lets us skip
// that: connect straight to the standard BLE-MIDI GATT service and decode the
// packets ourselves, so a ball can be added from this page with one click.
const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const BLE_MIDI_CHAR = "7772e5db-3868-4112-a1a9-f2669d106bf3";

// Decode a BLE-MIDI packet into MIDI messages. The packet is a header byte, then
// one or more (timestamp byte + MIDI message) events; both header and timestamp
// bytes have bit 7 set, and running status may omit the status byte. See the
// BLE-MIDI spec (midi.org). We only need channel-voice + realtime messages here.
function decodeBleMidi(bytes) {
  const msgs = [];
  if (bytes.length < 3) return msgs;  // header + timestamp + at least one byte
  let status = 0;
  let i = 1;                          // byte 0 is the packet header
  while (i < bytes.length) {
    // A timestamp-low byte (bit 7 set) precedes each event; skip it if present.
    if (bytes[i] & 0x80) i++;
    if (i >= bytes.length) break;
    // System realtime (0xF8–0xFF): a lone status byte with no data.
    if (bytes[i] >= 0xf8) { msgs.push([bytes[i++]]); continue; }
    // Status byte (bit 7 set) starts a new message; otherwise running status.
    if (bytes[i] & 0x80) { status = bytes[i]; i++; }
    if (!status || i >= bytes.length) break;
    const type = status & 0xf0;
    if (type === 0xc0 || type === 0xd0) {          // program change / channel pressure
      msgs.push([status, bytes[i++]]);
    } else {                                         // note, CC, pitch bend, …
      if (i + 1 >= bytes.length) break;
      msgs.push([status, bytes[i], bytes[i + 1]]);
      i += 2;
    }
  }
  return msgs;
}

function removeBleInput(id) {
  const idx = bleInputs.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [port] = bleInputs.splice(idx, 1);
  delete deviceCc[id];
  delete gestPipes[id];
  syncActiveInputs();
  logEvent(`Bluetooth ball <b>${escHtml(port.name)}</b> disconnected`);
}

async function connectBluetoothBall() {
  if (!navigator.bluetooth) {
    els.hint.classList.remove("hide");
    els.hint.innerHTML = "<p><strong>Web Bluetooth unavailable.</strong> Open this page in Chrome or Edge over HTTPS (or localhost). On macOS you can still pair via Audio MIDI Setup and pick the port above.</p>";
    return;
  }
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      // Show BLE-MIDI devices, plus anything advertising as an ODD Ball (some
      // balls don't list the MIDI service UUID in their advertisement packet).
      filters: [{ services: [BLE_MIDI_SERVICE] }, { namePrefix: "ODD" }],
      optionalServices: [BLE_MIDI_SERVICE],
    });
  } catch (err) {
    if (err && err.name === "NotFoundError") return;  // user dismissed the chooser
    els.hint.classList.remove("hide");
    // Brave (and some managed Chrome installs) disable Web Bluetooth entirely,
    // so requestDevice rejects with a SecurityError before any chooser appears.
    // This is a *different* permission from "MIDI device control" — enabling MIDI
    // does nothing here. Point the user at Brave's flag rather than the raw error.
    const blocked = err && (err.name === "SecurityError" ||
      /permission has been blocked|globally disabled|Web Bluetooth API is not allowed/i.test(err.message || ""));
    if (blocked) {
      els.hint.innerHTML = "<p><strong>Web Bluetooth is blocked by your browser.</strong> " +
        "This is separate from “MIDI device control.” In <strong>Brave</strong>, open " +
        "<code>brave://flags/#brave-web-bluetooth-api</code>, set <em>Web Bluetooth API</em> to " +
        "<em>Enabled</em>, relaunch, then reload this page. (Plain Chrome or Edge work without any flag.) " +
        "You can also pair via <em>Audio MIDI Setup</em> and pick the port above.</p>";
      return;
    }
    els.hint.innerHTML = `<p><strong>Bluetooth pairing failed.</strong> ${escHtml(err)}</p>`;
    return;
  }
  const id = `ble:${device.id}`;
  if (bleInputs.some((p) => p.id === id)) { setStatus(true, "connected"); return; }
  try {
    setStatus(false, "connecting…");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
    const char = await service.getCharacteristic(BLE_MIDI_CHAR);
    const port = { id, name: device.name || "ODD Ball (BLE)", device };
    char.addEventListener("characteristicvaluechanged", (ev) => {
      // The characteristic value is a DataView that need not span its whole
      // ArrayBuffer — honor its offset/length or the packet bytes are wrong.
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (const msg of decodeBleMidi(bytes)) onMidiMessage({ data: msg, target: port });
    });
    device.addEventListener("gattserverdisconnected", () => removeBleInput(id));
    await char.startNotifications();
    bleInputs.push(port);
    syncActiveInputs();
    logEvent(`Bluetooth ball <b>${escHtml(port.name)}</b> connected`, "note");
  } catch (err) {
    try { device.gatt && device.gatt.disconnect(); } catch (_) {}
    els.hint.classList.remove("hide");
    els.hint.innerHTML = `<p><strong>Bluetooth connect failed.</strong> ${escHtml(err)}</p>`;
    syncActiveInputs();
  }
}

async function init() {
  // Gestures must load before the patch config so connections that reference a
  // gesture source ("g:<id>") validate against a PARAMS entry that exists.
  loadGestures();

  const saved = loadState();
  applySavedState(saved);

  loadProfiles();

  buildGraph();
  wireGraphEvents();
  initOrbit();
  renderGestures();
  renderProfiles();
  audio.chimesOn = !!connections.chimes;
  initViews();
  if (saved && saved.views) {
    for (const v in saved.views) setView(v, !!saved.views[v]);
  }

  els.patchViews.addEventListener("click", (e) => {
    const btn = e.target.closest(".pv-btn");
    if (btn) setPatchView(btn.dataset.patchview);
  });
  setPatchView(saved && saved.patchView === "orbit" ? "orbit" : "rack");
  window.addEventListener("resize", () => { if (orbit.active) resizeOrbit(); });

  setupHistory();
  if (saved && typeof saved.histOpen === "boolean") setHistOpen(saved.histOpen);
  els.histToggle.addEventListener("click", () => setHistOpen(!histOpen()));

  els.soundToggle.addEventListener("click", toggleSound);
  els.btBall.addEventListener("click", connectBluetoothBall);
  els.randomPatch.addEventListener("click", randomizePatch);
  els.clearPatch.addEventListener("click", clearPatch);
  els.saveProfile.addEventListener("click", saveCurrentProfile);
  els.saveProfilePanel.addEventListener("click", saveCurrentProfile);
  els.profileList.addEventListener("click", (e) => {
    const load = e.target.closest(".profile-load");
    if (load) { applyProfile(load.dataset.load); return; }
    const del = e.target.closest(".profile-del");
    if (del) {
      const p = profiles.find((x) => x.id === del.dataset.del);
      if (p && window.confirm(`Delete profile “${p.name}”?`)) deleteProfile(del.dataset.del);
    }
  });
  // Inline rename: edit the name field directly; save on blur / Enter.
  els.profileList.addEventListener("change", (e) => {
    const inp = e.target.closest(".profile-name");
    if (inp) commitProfileName(inp);
  });
  els.profileList.addEventListener("keydown", (e) => {
    const inp = e.target.closest(".profile-name");
    if (inp && e.key === "Enter") { e.preventDefault(); inp.blur(); }
  });
  els.recSession.addEventListener("click", toggleSessionRec);
  els.recRaw.addEventListener("click", toggleRawRec);
  els.recMove.addEventListener("click", toggleRecordMove);
  els.importMove.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importSessionFile(f);
    e.target.value = ""; // allow re-importing the same file
  });
  // Gesture list: sensitivity sliders + delete buttons (event delegation).
  els.gestureList.addEventListener("input", (e) => {
    const sl = e.target.closest(".g-sens");
    if (!sl) return;
    const g = gestures.find((x) => x.id === sl.dataset.id);
    if (g) { g.threshold = sensToThresh(+sl.value); g.thresholdManual = true; persistGestures(); if (editingGesture === g) updateEditorSettingLabels(); }
  });
  els.gestureList.addEventListener("click", (e) => {
    const del = e.target.closest(".g-del");
    if (del) { deleteGesture(del.dataset.id); if (editingGesture && editingGesture.id === del.dataset.id) closeGestureEditor(); return; }
    const edit = e.target.closest(".g-edit");
    if (edit) openGestureEditor(edit.dataset.id);
  });

  // Gesture editor wiring.
  els.geClose.addEventListener("click", closeGestureEditor);
  els.gestureBackdrop.addEventListener("click", closeGestureEditor);
  els.geName.addEventListener("input", () => {
    if (!editingGesture) return;
    editingGesture.name = els.geName.value || "Move";
    if (PARAMS["g:" + editingGesture.id]) PARAMS["g:" + editingGesture.id].label = "✋ " + editingGesture.name;
    renderGestures(); buildHistLegend();
    if (graph.srcNodes["g:" + editingGesture.id]) graph.srcNodes["g:" + editingGesture.id].querySelector(".glabel").textContent = "✋ " + editingGesture.name;
    persistGesturesSoon();
  });
  els.geSens.addEventListener("input", () => {
    if (!editingGesture) return;
    editingGesture.threshold = sensToThresh(+els.geSens.value);
    editingGesture.thresholdManual = true;
    updateEditorSettingLabels(); renderGestures(); persistGesturesSoon();
  });
  els.geCool.addEventListener("input", () => {
    if (!editingGesture) return;
    editingGesture.cooldown = +els.geCool.value;
    updateEditorSettingLabels(); persistGesturesSoon();
  });
  els.geRot.addEventListener("change", () => {
    if (!editingGesture) return;
    // Orientation-neutral matching is always on; this flag only opts the move
    // out of grip-direction tiebreaking against near-tie rivals (see recognize).
    editingGesture.rotInvariant = els.geRot.checked;
    persistGesturesSoon();
  });
  els.geAutoTrim.addEventListener("click", () => {
    const ex = currentExample();
    if (!ex) return;
    ex.crop = autoTrim(ex.raw);
    recomputeEditingTemplate(); drawGestureEditor();
  });
  els.geCropReset.addEventListener("click", () => {
    const ex = currentExample();
    if (!ex) return;
    ex.crop = { start: 0, end: RAW_N - 1 };
    recomputeEditingTemplate(); drawGestureEditor();
  });
  // Example strip: pick which captured rep to view/crop.
  els.geExStrip.addEventListener("click", (e) => {
    const chip = e.target.closest(".gedit-ex");
    if (!chip) return;
    editingExample = +chip.dataset.ex || 0;
    renderExampleStrip();
    updateEditorSettingLabels();
    drawGestureEditor();
  });
  els.geAddExample.addEventListener("click", toggleAddExample);
  els.geDelExample.addEventListener("click", deleteEditingExample);
  els.geDelete.addEventListener("click", () => {
    if (!editingGesture) return;
    const id = editingGesture.id;
    closeGestureEditor();
    deleteGesture(id);
  });
  els.geCanvas.addEventListener("pointerdown", onEditorPointerDown);
  els.geCanvas.addEventListener("pointermove", onEditorPointerMove);
  els.geCanvas.addEventListener("pointerup", onEditorPointerUp);
  window.addEventListener("resize", () => { if (editingGesture) drawGestureEditor(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && editingGesture) closeGestureEditor(); });
  els.sens.addEventListener("input", (e) => { applySensitivity(+e.target.value); saveStateSoon(); });
  applySensitivity(+els.sens.value);

  // Connection editor wiring.
  els.ceThresh.addEventListener("input", () => {
    if (editing && connections[editing]) { connections[editing].thresh = +els.ceThresh.value / 100; updateEditorLabels(); saveStateSoon(); }
  });
  els.ceAtten.addEventListener("input", () => {
    if (editing && connections[editing]) { connections[editing].atten = +els.ceAtten.value / 100; updateEditorLabels(); saveStateSoon(); }
  });
  els.ceDisconnect.addEventListener("click", () => { if (editing) disconnect(editing); });
  els.ceClose.addEventListener("click", closeEditor);
  // Playback controls (together vs. in-order, chain order + step spacing).
  els.ceModeTogether.addEventListener("click", () => setSeqMode("together"));
  els.ceModeSeq.addEventListener("click", () => setSeqMode("sequence"));
  els.ceSeqUp.addEventListener("click", () => { if (editing) { moveInSequence(editing, -1); updateSeqEditor(); } });
  els.ceSeqDown.addEventListener("click", () => { if (editing) { moveInSequence(editing, +1); updateSeqEditor(); } });
  els.ceSeqGap.addEventListener("input", () => {
    const conn = editing && connections[editing];
    if (!conn) return;
    const gap = +els.ceSeqGap.value;
    els.ceSeqGapVal.textContent = gap;
    const g = gestureBySource(conn.source);
    if (g) { g.seqGap = gap; persistGesturesSoon(); }
    else { seqConfig(conn.source).gap = gap; saveStateSoon(); }
  });
  // Click anywhere outside the editor / a cable closes it.
  window.addEventListener("pointerdown", (e) => {
    if (!editing) return;
    if (e.target.closest("#connEditor")) return;
    if (e.target.closest(".cable-hit")) return;
    closeEditor();
  });

  soundIntent = saved && typeof saved.sound === "boolean" ? saved.sound : true;
  if (soundIntent) armDefaultSound();
  else setSoundButton(false);

  // Everything restored — allow saves and persist the current state once.
  loading = false;
  saveState();

  if (!navigator.requestMIDIAccess) {
    setStatus(false, "no Web MIDI");
    els.hint.innerHTML = "<p><strong>This browser has no Web MIDI.</strong> Open this page in Chrome or Edge. You can still use <code>🔵 Connect ball</code> to pair over Bluetooth.</p>";
  } else {
    try {
      midi = await navigator.requestMIDIAccess({ sysex: false });
      refreshPorts();
      midi.onstatechange = refreshPorts;
      els.portSelect.addEventListener("change", (e) => applySelection(e.target.value));
    } catch (err) {
      setStatus(false, "permission denied");
      els.hint.innerHTML = `<p><strong>MIDI permission denied.</strong> Reload and allow MIDI access. (${escHtml(err)})</p>`;
    }
  }

  // Animation + rate loop.
  let lastRate = performance.now();
  let lastCount = 0;
  let lastFrame = performance.now();
  function loop(now) {
    updateOrb();

    // Convert CC change accumulated since last frame into a smoothed 0..1 speed.
    const dt = Math.max(0.001, (now - lastFrame) / 1000);
    lastFrame = now;
    // Average the per-device roll motion so binding N balls doesn't inflate
    // the rate N-fold (which would peg roll speed with several controllers).
    // Count devices that have actually sent CCs, not every bound port — a
    // silent extra input (IAC bus, keyboard) must not halve the rate and
    // effectively raise the gate on the one ball that is really rolling.
    const nDev = Math.max(1, Object.keys(deviceCc).length);
    const changePerSec = (rollAccum / nDev) / dt;  // CC units/second on channels 3-5
    rollAccum = 0;
    // The ball sends CC4-6 in tight bursts, so the per-frame rate is very
    // spiky. Use a time-weighted EMA (framerate-independent) so the smoothed
    // rate reflects the true average and idle jitter can't spike the drone.
    const a = 1 - Math.exp(-dt / ROLL_TAU);
    rollRate += (changePerSec - rollRate) * a;
    rollRaw = Math.min(1, rollRate / ROLL_SCALE);
    // Gate out idle drift: below ROLL_GATE -> silent, then remap the rest 0..1.
    rollSpeed = rollRaw <= ROLL_GATE ? 0 : (rollRaw - ROLL_GATE) / (1 - ROLL_GATE);
    tapEnv *= 0.88; // decay the tap envelope each frame

    // Gesture triggers: decay their envelopes, update the motion-activity
    // signal, then feed the segmenter (which fires a match or captures a move).
    for (const id in gestureEnv) gestureEnv[id] *= 0.85;
    for (const k in seqEnv) seqEnv[k] *= 0.85;
    // Release any staggered steps of a movement's chain that are now due.
    for (let i = seqQueue.length - 1; i >= 0; i--) {
      if (now >= seqQueue[i].at) { seqEnv[seqQueue[i].instKey] = 1; seqQueue.splice(i, 1); }
    }
    // Plain inputs set to "in order" fire their chain on each rising onset, so
    // e.g. a roll or tap plays its instruments one after another.
    for (const source in seqCfg) {
      if (seqCfg[source].mode !== "sequence") continue;
      if (siblingsOf(source).length < 2) continue;
      const val = paramValue(source);
      const st = seqOnset[source] || (seqOnset[source] = { prev: 0, last: 0 });
      if (st.prev < SEQ_ONSET_LO && val >= SEQ_ONSET_HI && now - st.last > SEQ_ONSET_COOLDOWN) {
        st.last = now;
        fireChain(source, seqCfg[source].gap);
      }
      st.prev = val;
    }
    // Per-device gesture pipelines: each ball runs its own activity signal and
    // segmenter over its own feature stream.
    let maxAct = 0;
    for (const id in gestPipes) {
      const pipe = gestPipes[id];
      const feat = deviceFeature(id);
      updateGestureActivity(pipe, now, dt, feat);
      if (pipe.activity > maxAct) maxAct = pipe.activity;
      handleSegment(pipe, now, feat);
    }
    // Motion energy is the smoothed orientation-change speed of the MOST
    // active ball, normalized 0..1 — a second, still controller must not
    // dilute the glow the way an averaged signal would.
    gestActivity = maxAct;
    lastMotion = clamp1(gestActivity / MOTION_SCALE);
    audio.setMotion(lastMotion);

    updateInstruments();
    renderRoll();
    sampleSparks();
    if (orbit.active) {
      if (resizeOrbit()) { if (!orbit.built) buildOrbit(); stepOrbit(); drawOrbit(); }
    } else {
      drawSparks();
    }
    drawHistory();
    updateEditorLive();
    sampleSession(now);
    if (rawRec) {
      els.recRaw.textContent =
        `⏹ Stop raw · ${((now - rawRec.start) / 1000).toFixed(1)}s · ${rawRec.msgs.length} msg`;
    }

    if (now - lastRate >= 1000) {
      const rate = Math.round((msgCount - lastCount) * 1000 / (now - lastRate));
      els.rate.textContent = `${rate} msg/s`;
      lastCount = msgCount;
      lastRate = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

init();
