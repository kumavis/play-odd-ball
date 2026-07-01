"use strict";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
const clamp1 = (v) => Math.max(0, Math.min(1, v));

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
  rollFill: document.getElementById("rollFill"),
  rollVal: document.getElementById("rollVal"),
  gateMark: document.getElementById("gateMark"),
  rollRate: document.getElementById("rollRate"),
  sens: document.getElementById("sens"),
  sensVal: document.getElementById("sensVal"),
  graph: document.getElementById("graph"),
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
};

let midi = null;
let currentInput = null;
let msgCount = 0;

const audio = new AudioEngine();
let lastMotion = 0;

// Rolling detection: accumulate absolute change of the ORIENTATION CCs (4-6)
// between animation frames, then smooth into a 0..1 "speed" that drives the
// alien bass drone. Measured on the device: idle sensor jitter is ~200-475
// units/sec even when still, active rolling is ~900-1300/sec — so we gate above
// the idle floor and only make sound when it's really rolling.
const ROLL_CHANNELS = new Set([4, 5, 6]);
const prevCc = {};
let rollAccum = 0;
let rollRate = 0;      // smoothed CC-units/sec on channels 4-6
let rollSpeed = 0;     // final gated 0..1 intensity sent to the synth
let rollRaw = 0;       // ungated normalized rate (0..1) for the meter
let ROLL_SCALE = 1300; // CC units/sec (on 4-6) that maps to full intensity
let ROLL_GATE = 0.5;   // fraction of ROLL_SCALE (~650/sec) below which it's silent
let ROLL_TAU = 0.22;   // seconds; smoothing time-constant for the rate

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
  tilt_x:     { label: "Orient X (CC0)", color: "hsl(20 75% 62%)", get: () => (cc[0] ?? 0) / 127 },
  tilt_y:     { label: "Orient Y (CC1)", color: "hsl(65 75% 62%)", get: () => (cc[1] ?? 0) / 127 },
  tilt_z:     { label: "Orient Z (CC2)", color: "hsl(110 75% 62%)", get: () => (cc[2] ?? 0) / 127 },
  cc3:        { label: "Spin (CC3)", color: "hsl(155 75% 62%)", get: () => (cc[3] ?? 0) / 127 },
  cc4:        { label: "CC4", color: "hsl(200 75% 62%)", get: () => (cc[4] ?? 0) / 127 },
  cc5:        { label: "CC5", color: "hsl(245 75% 62%)", get: () => (cc[5] ?? 0) / 127 },
  cc6:        { label: "CC6", color: "hsl(290 75% 62%)", get: () => (cc[6] ?? 0) / 127 },
};
const paramValue = (key) => (PARAMS[key] ? PARAMS[key].get() : 0);

// ---- Connections --------------------------------------------------------
// Each instrument input takes one parameter (or none). A connection carries a
// per-connection response curve: `thresh` gates out signal below a floor and
// `atten` scales the result, so you can tune how sensitive each link is.
//   shaped = ((raw - thresh) / (1 - thresh))  (clamped, 0 below thresh) * atten
const INSTRUMENTS = [...AudioEngine.INSTRUMENTS, { key: "chimes", label: "Chimes" }];
const mkConn = (source, atten = 1, thresh = 0) => ({ source, atten, thresh });
// Every instrument starts unpatched; a couple get sensible defaults.
const connections = {};
INSTRUMENTS.forEach((inst) => { connections[inst.key] = null; });
connections.bass = mkConn("roll_speed");
connections.chimes = mkConn("tap");

function shape(conn) {
  if (!conn) return 0;
  const raw = paramValue(conn.source);
  const t = conn.thresh;
  const gated = raw <= t ? 0 : (raw - t) / (1 - t);
  return clamp1(gated) * conn.atten;
}

// ---- Persistence: patch config + settings survive a reload ---------------
const STORAGE_KEY = "oddball.patchbay.v1";
let loading = true;        // suppress saves while restoring on startup
let saveTimer = null;

function serializeState() {
  const views = {};
  document.querySelectorAll(".side").forEach((s) => {
    views[s.dataset.view] = !s.classList.contains("side--hidden");
  });
  return {
    connections,
    sensitivity: +els.sens.value,
    sound: soundIntent,
    views,
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
    return raw ? JSON.parse(raw) : null;
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
      } else if (c === null) {
        connections[instKey] = null;
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

// ---- Patch-bay graph ----------------------------------------------------
const SVGNS = "http://www.w3.org/2000/svg";
const graph = {
  srcPorts: {}, srcNodes: {}, srcVals: {}, sparkCanvas: {}, sparkCtx: {},
  instPorts: {}, instNodes: {},
  cables: {}, temp: null, drag: null,
};

const SRC_W = 210, INST_W = 132, SRC_H = 46, INST_H = 34, GPAD = 16;

function buildGraph() {
  const el = els.graph;
  const svg = document.getElementById("graphSvg");
  const srcKeys = Object.keys(PARAMS);

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
      `<span class="glabel">${PARAMS[key].label}</span><canvas class="spark"></canvas><span class="gval"></span>`,
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

  // Instrument nodes (right) with input ports.
  INSTRUMENTS.forEach((inst) => {
    const { node, port } = makeNode(
      "gnode--inst",
      `<span class="glabel">${inst.label}</span><span class="gval"></span>`,
      "gport--in"
    );
    port.dataset.port = "in";
    port.dataset.key = inst.key;
    graph.instPorts[inst.key] = port;
    graph.instNodes[inst.key] = node;
  });

  layoutGraph();
  window.addEventListener("resize", layoutGraph);
  el.addEventListener("pointerdown", onGraphPointerDown);
  svg.addEventListener("pointerdown", onGraphPointerDown); // clicks on cables
  refreshConnectionStyles();
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
  connections[instKey] = mkConn(srcKey, prev?.atten ?? 1, prev?.thresh ?? 0);
  if (instKey === "chimes") audio.chimesOn = true;
  refreshConnectionStyles();
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

function onGraphPointerDown(e) {
  const port = e.target.closest(".gport");
  if (port) {
    e.preventDefault();
    graph.drag = { fromType: port.dataset.port, fromKey: port.dataset.key };
    graph.temp = document.createElementNS(SVGNS, "path");
    graph.temp.setAttribute("class", "cable-temp");
    graph.temp.setAttribute("stroke", "#00e5ff");
    graph.temp.setAttribute("stroke-width", "2.5");
    document.getElementById("graphSvg").appendChild(graph.temp);
    window.addEventListener("pointermove", onGraphPointerMove);
    window.addEventListener("pointerup", onGraphPointerUp);
    return;
  }
  // Click on a cable hit-area opens the connection editor for that link.
  const hit = e.target.closest(".cable-hit");
  if (hit) { openEditor(hit.dataset.inst, e.clientX, e.clientY); return; }
}

function localPoint(e) {
  const r = els.graph.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onGraphPointerMove(e) {
  if (!graph.drag) return;
  const from = graph.drag.fromType === "out"
    ? portCenter(graph.srcPorts[graph.drag.fromKey])
    : portCenter(graph.instPorts[graph.drag.fromKey]);
  graph.temp.setAttribute("d", cablePath(from, localPoint(e)));

  const over = document.elementFromPoint(e.clientX, e.clientY);
  const p = over && over.closest(".gport");
  document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
  if (p && p.dataset.port !== graph.drag.fromType) p.classList.add("is-target");
}

function onGraphPointerUp(e) {
  window.removeEventListener("pointermove", onGraphPointerMove);
  window.removeEventListener("pointerup", onGraphPointerUp);
  document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
  if (graph.temp) { graph.temp.remove(); graph.temp = null; }
  const d = graph.drag; graph.drag = null;
  if (!d) return;

  const over = document.elementFromPoint(e.clientX, e.clientY);
  const p = over && over.closest(".gport");
  if (!p || p.dataset.port === d.fromType) return; // dropped on nothing / same side
  const srcKey = d.fromType === "out" ? d.fromKey : p.dataset.key;
  const instKey = d.fromType === "out" ? p.dataset.key : d.fromKey;
  if (PARAMS[srcKey] && connections[instKey] !== undefined) connect(srcKey, instKey);
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

function updateInstruments() {
  const svg = document.getElementById("graphSvg");
  for (const inst of INSTRUMENTS) {
    const conn = connections[inst.key];
    const v = shape(conn);
    if (inst.key !== "chimes") audio.setVoice(inst.key, v);

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
  // Source node live-value bars.
  for (const key in graph.srcVals) {
    graph.srcVals[key].style.width = `${paramValue(key) * 100}%`;
  }
  // Live meter inside the connection editor.
  if (editing && connections[editing]) {
    const conn = connections[editing];
    els.ceMeterIn.style.width = `${clamp1(paramValue(conn.source)) * 100}%`;
    els.ceMeterOut.style.width = `${clamp1(shape(conn)) * 100}%`;
  }
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

// Drive the orb from whatever CCs are streaming. We use the first few
// controllers as tilt X / tilt Y / roll, and overall motion energy for glow.
function updateOrb() {
  const v = (c, d = 64) => (cc[c] ?? d);
  const tiltX = (v(0) - 64) / 64;   // -1..1
  const tiltY = (v(1) - 64) / 64;
  const roll = (v(2) - 64) / 64;
  const energy = Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY) + Math.abs(roll)) / 1.5);

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

  lastMotion = energy;
  audio.setMotion(energy);
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
  const type = status & 0xf0;
  msgCount++;

  if (type === 0x90 && d2 > 0) {            // note on
    tapEnv = Math.max(tapEnv, d2 / 127);
    els.lastNote.textContent = noteName(d1);
    els.lastNoteSub.textContent = `note ${d1} · velocity ${d2}`;
    els.orb.animate(
      [{ filter: "brightness(2.2)" }, { filter: "brightness(1)" }],
      { duration: 320, easing: "ease-out" }
    );
    spawnRipple(d2);
    // Pitch follows orientation (CC3) so moving the ball plays different notes.
    audio.hit(d2, (cc[3] ?? 64) / 127);
    logEvent(`<b>NOTE</b> ${noteName(d1)} (${d1}) vel ${d2}`, "note");
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {  // note off
    // (Quiet in the log to avoid clutter.)
  } else if (type === 0xb0) {               // control change
    if (prevCc[d1] !== undefined && ROLL_CHANNELS.has(d1)) {
      rollAccum += Math.abs(d2 - prevCc[d1]);
    }
    prevCc[d1] = d2;
    cc[d1] = d2;
    const row = ensureCcRow(d1);
    row.fill.style.width = `${(d2 / 127) * 100}%`;
    row.val.textContent = d2;
  } else if (type === 0xe0) {               // pitch bend
    logEvent(`<b>PITCH</b> ${((d2 << 7) | d1) - 8192}`);
  }
}

function selectInput(id) {
  if (currentInput) currentInput.onmidimessage = null;
  currentInput = midi.inputs.get(id);
  if (!currentInput) { setStatus(false, "disconnected"); return; }
  currentInput.onmidimessage = onMidiMessage;
  setStatus(true, `connected`);
  els.hint.classList.add("hide");
  logEvent(`listening on <b>${currentInput.name}</b>`);
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
    setStatus(false, "no devices");
    return;
  }
  for (const input of inputs) {
    const opt = document.createElement("option");
    opt.value = input.id;
    opt.textContent = input.name;
    els.portSelect.appendChild(opt);
  }
  // Prefer the ODD Ball, otherwise keep prior selection or first port.
  const odd = inputs.find((i) => /odd/i.test(i.name));
  const target = odd?.id || (inputs.some((i) => i.id === prev) ? prev : inputs[0].id);
  els.portSelect.value = target;
  selectInput(target);
}

async function init() {
  const saved = loadState();
  applySavedState(saved);

  buildGraph();
  audio.chimesOn = !!connections.chimes;
  initViews();
  if (saved && saved.views) {
    for (const v in saved.views) setView(v, !!saved.views[v]);
  }

  els.soundToggle.addEventListener("click", toggleSound);
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
    els.hint.innerHTML = "<p><strong>This browser has no Web MIDI.</strong> Open this page in Chrome or Edge.</p>";
  } else {
    try {
      midi = await navigator.requestMIDIAccess({ sysex: false });
      refreshPorts();
      midi.onstatechange = refreshPorts;
      els.portSelect.addEventListener("change", (e) => selectInput(e.target.value));
    } catch (err) {
      setStatus(false, "permission denied");
      els.hint.innerHTML = `<p><strong>MIDI permission denied.</strong> Reload and allow MIDI access. (${err})</p>`;
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
    const changePerSec = rollAccum / dt;      // CC units/second on channels 4-6
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

    updateInstruments();
    renderRoll();
    sampleSparks();
    drawSparks();

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
