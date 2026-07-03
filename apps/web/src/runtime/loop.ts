// The animation + rate loop: advance the engine, decay envelopes, release
// sequenced chain steps, push audio levels, sample sparklines, then let every
// registered frame callback (canvases, cables, meters) redraw.
import { rollSensitivity } from "@oddball/core";
import {
  audio,
  connections,
  engine,
  gestureEnv,
  INSTRUMENTS,
  live,
  paramValue,
  rateSig,
  runFrameCbs,
  sensitivitySig,
  seqCfg,
  seqEnv,
  seqOnset,
  seqQueue,
  SEQ_ONSET_COOLDOWN,
  SEQ_ONSET_HI,
  SEQ_ONSET_LO,
  sparkBuf,
  SPARK_MAX,
  paramsList,
} from "./state";
import { fireChain, shape, siblingsOf, updateChimes } from "./patch";
import { sampleSession, tickRawRec } from "./recording";

function sampleSparks(): void {
  for (const p of paramsList()) {
    const buf = sparkBuf[p.key] || (sparkBuf[p.key] = []);
    buf.push(p.get());
    if (buf.length > SPARK_MAX) buf.shift();
  }
}

/** Push shaped values into the synth (chimes get edge-triggered separately). */
function updateInstruments(now: number): void {
  for (const inst of INSTRUMENTS) {
    const conn = connections[inst.key];
    const v = shape(conn, inst.key);
    if (inst.key !== "chimes") audio.setVoice(inst.key, v);
    else updateChimes(conn, v, now);
  }
}

export function applySensitivity(pct: number): void {
  const { gate, scale } = rollSensitivity(pct);
  engine.roll.gate = gate;
  engine.roll.scale = scale;
}

let started = false;

export function startLoop(): void {
  if (started) return;
  started = true;

  let lastRate = performance.now();
  let lastCount = 0;

  // Keep the roll sensitivity mapped whenever the slider changes.
  applySensitivity(sensitivitySig.peek());
  sensitivitySig.subscribe((pct) => applySensitivity(pct));

  function loop(now: number): void {
    const snap = engine.tick(now);
    live.rollRate = snap.rollRate;
    live.rollRaw = snap.rollRaw;
    live.rollSpeed = snap.rollSpeed;
    live.motion = snap.motion;
    live.tapEnv *= 0.88; // decay the tap envelope each frame

    // Gesture + per-instrument trigger envelopes decay each frame.
    for (const id in gestureEnv) gestureEnv[id] *= 0.85;
    for (const k in seqEnv) seqEnv[k] *= 0.85;
    // Release any staggered steps of a movement's chain that are now due.
    for (let i = seqQueue.length - 1; i >= 0; i--) {
      if (now >= seqQueue[i].at) {
        seqEnv[seqQueue[i].instKey] = 1;
        seqQueue.splice(i, 1);
      }
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

    audio.setMotion(live.motion);
    updateInstruments(now);
    sampleSparks();
    sampleSession(now);
    tickRawRec(now);
    runFrameCbs({ now, dt: snap.dt });

    if (now - lastRate >= 1000) {
      rateSig.value = Math.round(((engine.msgCount - lastCount) * 1000) / (now - lastRate));
      lastCount = engine.msgCount;
      lastRate = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
