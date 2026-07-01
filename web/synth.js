"use strict";

// Multi-voice synth for the ODD Ball.
//
// - "Chimes" is an event instrument: taps/notes trigger a pentatonic mallet.
// - The other instruments are continuous, parameter-driven "voices": each has a
//   generic set(v) (v in 0..1) that maps the value to gain/pitch/filter. The app
//   layer routes any calculated parameter (roll speed, tilt, energy, ...) into
//   any voice, so instruments can be freely patched to parameters.

const PENTATONIC = [0, 3, 5, 7, 10]; // minor pentatonic semitone offsets
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.filter = null;
    this.reverb = null;
    this.enabled = false;
    this.rootMidi = 57;    // A3-ish base for the chimes
    this.scaleSpread = 24; // semitone range mapped across the chime pitch CC
    this.voices = {};      // key -> { out, level, set(v) }
    this.chimesOn = true;  // tap/note mallet hits
  }

  // Instruments the UI can expose. `event: true` means tap-triggered (Chimes);
  // the rest are continuous voices driven by a routed parameter.
  static get INSTRUMENTS() {
    return [
      { key: "bass", label: "Alien bass" },
      { key: "engine", label: "Revving engine" },
      { key: "thunder", label: "Thunderstorm" },
      { key: "lightning", label: "Lightning strike" },
      { key: "rain", label: "Rainfall" },
      { key: "theremin", label: "Theremin" },
      { key: "choir", label: "Ghost choir" },
      { key: "pad", label: "Warm pad" },
      { key: "organ", label: "Drone organ" },
      { key: "bells", label: "Shimmer bells" },
      { key: "wind", label: "Noise wind" },
      { key: "pluck", label: "Pluck arp" },
      { key: "piano", label: "Piano walk" },
      { key: "acid", label: "Acid 303" },
      { key: "wobble", label: "Wobble bass" },
      { key: "growl", label: "Monster growl" },
      { key: "siren", label: "Siren" },
      { key: "laser", label: "Laser zaps" },
      { key: "bubbles", label: "Water bubbles" },
      { key: "whale", label: "Whale song" },
      { key: "crickets", label: "Crickets" },
      { key: "ufo", label: "UFO warble" },
      { key: "gamelan", label: "Gamelan" },
      { key: "geiger", label: "Geiger clicks" },
    ];
  }

  async enable() {
    if (this.ctx) {
      await this.ctx.resume();
      this.enabled = true;
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 6000;
    this.filter.Q.value = 0.8;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.8, 2.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    const dry = ctx.createGain();
    dry.gain.value = 0.85;

    this.filter.connect(dry).connect(this.master);
    this.filter.connect(this.reverb).connect(wet).connect(this.master);
    this.master.connect(ctx.destination);

    this.voices.bass = this._buildBass();
    this.voices.engine = this._buildEngine();
    this.voices.thunder = this._buildThunder();
    this.voices.lightning = this._buildLightning();
    this.voices.rain = this._buildRain();
    this.voices.theremin = this._buildTheremin();
    this.voices.choir = this._buildChoir();
    this.voices.pad = this._buildPad();
    this.voices.organ = this._buildOrgan();
    this.voices.bells = this._buildBells();
    this.voices.wind = this._buildWind();
    this.voices.pluck = this._buildPluck();
    this.voices.piano = this._buildPiano();
    this.voices.acid = this._buildAcid();
    this.voices.wobble = this._buildWobble();
    this.voices.growl = this._buildGrowl();
    this.voices.siren = this._buildSiren();
    this.voices.laser = this._buildLaser();
    this.voices.bubbles = this._buildBubbles();
    this.voices.whale = this._buildWhale();
    this.voices.crickets = this._buildCrickets();
    this.voices.ufo = this._buildUfo();
    this.voices.gamelan = this._buildGamelan();
    this.voices.geiger = this._buildGeiger();

    await ctx.resume();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.ctx) this.ctx.suspend();
  }

  // Route a 0..1 parameter value into a continuous voice.
  setVoice(key, value) {
    if (!this.enabled) return;
    if (this.previewing && this.previewing[key]) return; // a preview owns this voice
    const v = this.voices[key];
    if (v) v.set(clamp01(value));
  }

  // Play a short, representative demo of a single instrument so the user can
  // hear what it sounds like. Continuous voices get a swell; event/tap voices
  // (chimes, laser, lightning…) fire their hit(s) by being held "active".
  // While previewing, the per-frame setVoice updates are ignored for that key
  // so the demo envelope isn't immediately overwritten by the patch loop.
  preview(key) {
    if (!this.ctx) return;
    if (key === "chimes") {
      const pe = this.enabled, pc = this.chimesOn;
      this.enabled = true; this.chimesOn = true;
      this.hit(110, 0.45);
      this.chimesOn = pc; this.enabled = pe;
      return;
    }
    const v = this.voices[key];
    if (!v) return;
    if (!this.previewing) this.previewing = {};
    const id = (this.previewing[key] || 0) + 1;
    this.previewing[key] = id;

    const start = performance.now();
    const dur = 1300;          // total demo length in ms
    const attack = 90, release = 500;
    const tick = () => {
      if (this.previewing[key] !== id) return;          // cancelled/superseded
      const el = performance.now() - start;
      if (el >= dur) { v.set(0); this.previewing[key] = 0; return; }
      let val;
      if (el < attack) val = 0.95 * (el / attack);
      else if (el < dur - release) val = 0.95;
      else val = 0.95 * (1 - (el - (dur - release)) / release);
      v.set(clamp01(val));
      requestAnimationFrame(tick);
    };
    tick();
  }

  _out() {
    // A per-voice output gain wired to master (dry) + reverb (wet).
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    g.connect(this.reverb);
    return g;
  }

  // Asymmetric glide toward target (quick in, gentle out) to avoid clicks.
  _glide(voice, target, upK = 0.3, downK = 0.08) {
    const k = target > voice.level ? upK : downK;
    voice.level += (target - voice.level) * k;
    voice.out.gain.value = voice.level;
    return voice.level;
  }

  // ---- Voices -----------------------------------------------------------

  // Low, detuned, wobbling "alien" bass. Louder/higher/brighter with value.
  _buildBass() {
    const ctx = this.ctx, t = ctx.currentTime, baseHz = 33; // ~C1
    const out = this._out();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 220; filter.Q.value = 7;

    const am = ctx.createGain(); am.gain.value = 0.75;
    const amLfo = ctx.createOscillator(); amLfo.type = "sine"; amLfo.frequency.value = 6;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.25;
    amLfo.connect(amDepth).connect(am.gain); amLfo.start(t);

    const mix = ctx.createGain(); mix.gain.value = 0.32;
    const oscs = [];
    for (const [type, det] of [["sawtooth", -8], ["sawtooth", 7], ["square", 0]]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = baseHz; o.detune.value = det;
      o.connect(mix); o.start(t); oscs.push(o);
    }
    const sub = ctx.createOscillator();
    sub.type = "sine"; sub.frequency.value = baseHz / 2;
    const subGain = ctx.createGain(); subGain.gain.value = 0.5;
    sub.connect(subGain).connect(mix); sub.start(t); oscs.push(sub);

    const vibLfo = ctx.createOscillator(); vibLfo.type = "sine"; vibLfo.frequency.value = 5;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 10;
    vibLfo.connect(vibDepth); for (const o of oscs) vibDepth.connect(o.detune); vibLfo.start(t);

    mix.connect(am).connect(filter).connect(out);

    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.05 + v * 0.7 : 0, 0.35, 0.08);
      const hz = baseHz * (1 + v * 1.1);
      for (const o of oscs) o.frequency.value = o === sub ? hz / 2 : hz;
      filter.frequency.value = 180 + v * 1600;
      amLfo.frequency.value = 4 + v * 14;
      vibLfo.frequency.value = 4 + v * 6;
    };
    return voice;
  }

  // Revving combustion engine. The value is the throttle: it drives the firing
  // rate (RPM) so pitch climbs as you rev, an amplitude "chug" locked to that
  // rate (deep putt-putt at idle -> smooth roar high up), a distorted saw core
  // for combustion grit, an exhaust-noise bed, and a lowpass that opens up with
  // throttle. RPM chases its target with a little lag so it spins up/down.
  _buildEngine() {
    const ctx = this.ctx, t = ctx.currentTime, idleHz = 32, maxHz = 178;
    const out = this._out();

    const mix = ctx.createGain(); mix.gain.value = 0.4;
    const o1 = ctx.createOscillator(); o1.type = "sawtooth"; o1.frequency.value = idleHz;
    const o2 = ctx.createOscillator(); o2.type = "sawtooth"; o2.frequency.value = idleHz; o2.detune.value = 14;
    const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = idleHz / 2;
    const subG = ctx.createGain(); subG.gain.value = 0.5;
    o1.connect(mix); o2.connect(mix); sub.connect(subG).connect(mix);
    o1.start(t); o2.start(t); sub.start(t);

    // Exhaust grit: lowpassed noise mixed in, louder with throttle.
    const noiseLp = ctx.createBiquadFilter(); noiseLp.type = "lowpass"; noiseLp.frequency.value = 1400;
    const noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
    this._loopNoise(noiseLp); noiseLp.connect(noiseGain).connect(mix);

    // Combustion distortion.
    const shaper = ctx.createWaveShaper(); shaper.curve = this._shaper(6);

    // Amplitude "chug" locked to the firing rate.
    const am = ctx.createGain(); am.gain.value = 1;
    const amLfo = ctx.createOscillator(); amLfo.type = "sawtooth"; amLfo.frequency.value = idleHz;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.5;
    amLfo.connect(amDepth).connect(am.gain); amLfo.start(t);

    // Idle flutter so it doesn't sit dead still.
    const flutter = ctx.createOscillator(); flutter.type = "sine"; flutter.frequency.value = 7;
    const flutterDepth = ctx.createGain(); flutterDepth.gain.value = 4;
    flutter.connect(flutterDepth); flutterDepth.connect(o1.detune); flutterDepth.connect(o2.detune); flutter.start(t);

    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 500; lp.Q.value = 3;

    mix.connect(shaper).connect(am).connect(lp).connect(out);

    const voice = { out, level: 0, rpm: idleHz };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.06 + v * 0.5 : 0, 0.25, 0.09);
      const targetRpm = idleHz + v * (maxHz - idleHz);
      voice.rpm += (targetRpm - voice.rpm) * 0.15; // spin-up/down lag
      const hz = voice.rpm;
      o1.frequency.value = hz;
      o2.frequency.value = hz;
      sub.frequency.value = hz / 2;
      amLfo.frequency.value = hz;              // chug tracks the firing rate
      amDepth.gain.value = 0.55 - v * 0.42;    // deep at idle, smooth at high rev
      lp.frequency.value = 350 + v * 4400;
      noiseGain.gain.value = 0.05 + v * 0.22;
      flutter.frequency.value = 6 + v * 4;
    };
    return voice;
  }

  // Smooth sine "theremin": pitch glides over ~2 octaves, volume follows value.
  _buildTheremin() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = 220;
    const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 5.5;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 6;
    vib.connect(vibDepth).connect(osc.detune); vib.start(t);
    osc.connect(lp).connect(out); osc.start(t);

    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.24 : 0, 0.25, 0.12);
      osc.frequency.value = 130 * Math.pow(2, v * 2.2); // ~130Hz -> ~600Hz
    };
    return voice;
  }

  // Warm sustained pad: detuned saws + fifth through a lowpass; slow swell.
  _buildPad() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 800; lp.Q.value = 0.7;
    const mix = ctx.createGain(); mix.gain.value = 0.2;
    // Root (C3), slightly detuned pair, plus the fifth (G3).
    for (const [midi, det] of [[48, -6], [48, 6], [55, 0]]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = mtof(midi); o.detune.value = det;
      o.connect(mix); o.start(t);
    }
    mix.connect(lp).connect(out);

    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.2 : 0, 0.06, 0.04); // slow swell
      lp.frequency.value = 300 + v * 3500;
    };
    return voice;
  }

  // Airy filtered noise "wind": cutoff + resonance + level rise with value.
  _buildWind() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 600; bp.Q.value = 3;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    src.connect(bp).connect(out); src.start(t);

    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? v * 0.3 : 0, 0.2, 0.1);
      bp.frequency.value = 200 + v * 4500;
      bp.Q.value = 2 + v * 10;
    };
    return voice;
  }

  // Rhythmic pluck arpeggio: value sets both tempo and pitch of repeating plucks.
  _buildPluck() {
    const ctx = this.ctx;
    const out = this._out();
    out.gain.value = 1; // plucks manage their own envelopes; out is a bus
    const voice = { out, level: 0, last: 0, phase: 0, active: 0 };
    const scale = [0, 3, 5, 7, 10, 12]; // pentatonic-ish steps
    voice.set = (v) => {
      voice.active = v; // gate handled at trigger time
      const now = performance.now();
      if (v <= 0.02) { voice.last = now; return; }
      const interval = 260 - v * 190; // fast (70ms) when high, slow (260ms) when low
      if (now - voice.last >= interval) {
        voice.last = now;
        const deg = scale[voice.phase % scale.length] + 12 * Math.floor(v * 2);
        voice.phase++;
        this._pluck(mtof(52 + deg), 0.12 + v * 0.25, out);
      }
    };
    return voice;
  }

  _pluck(hz, gain, dest) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = hz;
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t); o.stop(t + 0.3);
    setTimeout(() => g.disconnect(), 400);
  }

  // ---- Piano walk -------------------------------------------------------
  // An event/tap voice: every trigger plays a piano note and advances a
  // walking position through a major scale (ping-ponging up and back down
  // ~2 octaves). So tapping repeatedly — or holding a parameter up so it
  // fires on the sustained clock — makes the keys being played keep changing.
  _buildPiano() {
    const out = this._out(); out.gain.value = 1;
    const scale = [0, 2, 4, 5, 7, 9, 11];   // major
    const span = 17;                        // steps up before turning back down
    const voice = { out, level: 0, last: 0, step: 0 };
    voice.set = (v) => {
      if (!this._due(voice, v, 170, 820)) return;
      const pos = voice.step % (span * 2);
      const idx = pos <= span ? pos : span * 2 - pos;   // 0..span..0 ping-pong
      const deg = scale[idx % scale.length] + 12 * Math.floor(idx / scale.length);
      voice.step++;
      const root = 48 + Math.round(v * 5);              // value nudges the register
      this._pianoNote(mtof(root + deg), 0.1 + v * 0.28, out);
    };
    return voice;
  }

  _pianoNote(hz, gain, dest) {
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 0;
    // Brightness fades over the note (mimics upper partials decaying first).
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.min(12000, hz * 8), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(600, hz * 2.4), t + 1.1);
    g.connect(lp).connect(dest);
    const decay = 1.6 + gain;
    for (const [mult, amp] of [[1, 1.0], [2, 0.55], [3, 0.3], [4, 0.16], [6, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = mult === 1 ? "triangle" : "sine";
      o.frequency.value = hz * mult * (1 + 0.0007 * mult * mult); // slight inharmonicity
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + decay + 0.2);
    }
    // Hammer thock: a very short band-passed noise transient.
    const noise = ctx.createBufferSource(); noise.buffer = this._noiseBuffer(0.04);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = hz * 3; bp.Q.value = 0.7;
    const ng = ctx.createGain(); ng.gain.value = 0;
    noise.connect(bp).connect(ng).connect(g);
    ng.gain.setValueAtTime(gain * 0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    noise.start(t); noise.stop(t + 0.06);
    // Master envelope: quick hammer attack, long exponential release.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    setTimeout(() => g.disconnect(), (decay + 0.3) * 1000);
  }

  // ---- Shared helpers for the extra voices ------------------------------

  _noiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _loopNoise(dest) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2);
    src.loop = true;
    src.connect(dest);
    src.start(this.ctx.currentTime);
    return src;
  }

  // Soft clipping curve for distortion voices.
  _shaper(amount) {
    const n = 1024, curve = new Float32Array(n), k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  // FM bell "ping": a bright metallic tone with an exponential decay.
  _ping(hz, gain, dest, decay = 1.4, ratio = 2.01) {
    const ctx = this.ctx, t = ctx.currentTime;
    const car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = hz;
    const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = hz * ratio;
    const modGain = ctx.createGain(); modGain.gain.value = hz * 3;
    mod.connect(modGain).connect(car.frequency);
    const g = ctx.createGain(); g.gain.value = 0;
    car.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    car.start(t); mod.start(t); car.stop(t + decay + 0.1); mod.stop(t + decay + 0.1);
    setTimeout(() => g.disconnect(), (decay + 0.3) * 1000);
  }

  // Random-trigger scheduler shared by the sprinkly/percussive voices. Returns
  // true (and advances voice.last) when it's time to fire an event.
  //
  // Two ways to fire:
  //   • Rising edge — a fast jump in value (a fresh tap / gesture spike) fires
  //     immediately, as long as we're past a short retrigger gap. This is what
  //     lets transient sources like the Tap envelope actually trigger one-shot
  //     voices (their spike is too brief to ever satisfy the sustained clock).
  //   • Sustained — while the value stays up, keep firing at an interval that
  //     shortens as the value grows.
  _due(voice, v, minMs, maxMs) {
    const now = performance.now();
    const prev = voice.prevV ?? 0;
    voice.prevV = v;
    if (v <= 0.02) return false;          // silent: don't fire, and don't reset the clock
    const sinceLast = now - voice.last;
    if (v - prev > 0.1 && sinceLast >= minMs * 0.5) { voice.last = now; return true; }
    const base = maxMs - v * (maxMs - minMs);
    const interval = base * (0.5 + Math.random());
    if (sinceLast >= interval) { voice.last = now; return true; }
    return false;
  }

  // ---- Thunderstorm -----------------------------------------------------
  // A rain bed that thickens with value, plus randomly cracking thunder that
  // gets more frequent and louder the higher the value.
  _buildThunder() {
    const ctx = this.ctx;
    const out = this._out(); out.gain.value = 1;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    const rain = ctx.createGain(); rain.gain.value = 0;
    this._loopNoise(hp); hp.connect(lp).connect(rain).connect(out);

    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => {
      const target = v > 0.01 ? 0.04 + v * 0.28 : 0;
      voice.level += (target - voice.level) * 0.08;
      rain.gain.value = voice.level;
      lp.frequency.value = 1200 + v * 4500;
      const now = performance.now();
      if (v > 0.04 && now - voice.last > 450) {
        if (Math.random() < 0.0015 + v * 0.02) { voice.last = now; this._thunderBoom(out, 0.35 + v * 0.6); }
      }
    };
    return voice;
  }

  _thunderBoom(dest, level) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noiseBuffer(2.6);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(80, t + 2.2);
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(lp).connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.04);
    g.gain.exponentialRampToValueAtTime(level * 0.4, t + 0.5);
    g.gain.linearRampToValueAtTime(level * 0.85, t + 0.85); // second rumble swell
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    src.start(t); src.stop(t + 2.6);
    setTimeout(() => g.disconnect(), 2800);
  }

  // ---- Lightning strike -------------------------------------------------
  // An event voice: each trigger is a single bolt — a bright crackling flicker
  // and a distorted electric snap, followed by a rolling thunder tail. Higher
  // value = louder, more frequent strikes.
  _buildLightning() {
    const out = this._out(); out.gain.value = 1;
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => { if (this._due(voice, v, 340, 2600)) this._lightningStrike(out, v); };
    return voice;
  }

  _lightningStrike(dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const level = 0.4 + v * 0.7;

    // 1) Bright crackle: several rapid highpassed noise spikes (the flicker).
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2400;
    const crackGain = ctx.createGain(); crackGain.gain.value = 0;
    const noise = ctx.createBufferSource(); noise.buffer = this._noiseBuffer(0.7);
    noise.connect(hp).connect(crackGain).connect(dest); noise.start(t);
    crackGain.gain.setValueAtTime(0, t);
    const flickers = 3 + Math.floor(Math.random() * 4);
    let ct = t;
    for (let i = 0; i < flickers; i++) {
      const st = t + i * (0.015 + Math.random() * 0.045);
      const amp = level * 1.15 * (1 - i * 0.13);
      crackGain.gain.setValueAtTime(0.0001, st);
      crackGain.gain.linearRampToValueAtTime(amp, st + 0.0015);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, st + 0.04 + Math.random() * 0.06);
      ct = st + 0.12;
    }
    noise.stop(ct + 0.3);

    // 2) Electric snap: a hard-distorted saw sweeping sharply downward.
    const o = ctx.createOscillator(); o.type = "sawtooth";
    o.frequency.setValueAtTime(3400 + Math.random() * 2600, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.28);
    const shaper = ctx.createWaveShaper(); shaper.curve = this._shaper(22);
    const og = ctx.createGain(); og.gain.value = 0;
    o.connect(shaper).connect(og).connect(dest);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(level * 0.6, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.start(t); o.stop(t + 0.36);

    // 3) THUNDER BOOM: a deep sub-bass impact that arrives just after the flash.
    const bt = t + 0.06 + Math.random() * 0.12;
    const sub = ctx.createOscillator(); sub.type = "sine";
    sub.frequency.setValueAtTime(72, bt);
    sub.frequency.exponentialRampToValueAtTime(28, bt + 0.9);
    const subG = ctx.createGain(); subG.gain.value = 0;
    sub.connect(subG).connect(dest);
    subG.gain.setValueAtTime(0.0001, bt);
    subG.gain.linearRampToValueAtTime(level * 1.1, bt + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.0001, bt + 1.1);
    sub.start(bt); sub.stop(bt + 1.2);

    // Boom body: distorted low noise burst for the concussive "crack" of the boom.
    const boom = ctx.createBufferSource(); boom.buffer = this._noiseBuffer(1.2);
    const blp = ctx.createBiquadFilter(); blp.type = "lowpass"; blp.Q.value = 2.5;
    blp.frequency.setValueAtTime(900, bt);
    blp.frequency.exponentialRampToValueAtTime(90, bt + 0.7);
    const bsh = ctx.createWaveShaper(); bsh.curve = this._shaper(6);
    const boomG = ctx.createGain(); boomG.gain.value = 0;
    boom.connect(blp).connect(bsh).connect(boomG).connect(dest);
    boomG.gain.setValueAtTime(0.0001, bt);
    boomG.gain.linearRampToValueAtTime(level * 0.85, bt + 0.03);
    boomG.gain.exponentialRampToValueAtTime(0.0001, bt + 1.0);
    boom.start(bt); boom.stop(bt + 1.2);

    // 4) Rolling thunder tail: lowpassed noise sweeping down, with a second swell.
    const rt = bt + 0.35 + Math.random() * 0.25;
    const rumble = ctx.createBufferSource(); rumble.buffer = this._noiseBuffer(2.8);
    const rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.Q.value = 1.2;
    rlp.frequency.setValueAtTime(380, rt);
    rlp.frequency.exponentialRampToValueAtTime(55, rt + 2.2);
    const rg = ctx.createGain(); rg.gain.value = 0;
    rumble.connect(rlp).connect(rg).connect(dest);
    rg.gain.setValueAtTime(0, rt);
    rg.gain.linearRampToValueAtTime(level * 0.6, rt + 0.08);
    rg.gain.exponentialRampToValueAtTime(level * 0.25, rt + 0.7);
    rg.gain.linearRampToValueAtTime(level * 0.42, rt + 1.1);
    rg.gain.exponentialRampToValueAtTime(0.0001, rt + 2.3);
    rumble.start(rt); rumble.stop(rt + 2.5);

    setTimeout(() => {
      crackGain.disconnect(); og.disconnect(); subG.disconnect();
      boomG.disconnect(); rg.disconnect();
    }, 3600);
  }

  // ---- Rainfall (gentle) ------------------------------------------------
  _buildRain() {
    const ctx = this.ctx;
    const out = this._out(); out.gain.value = 1;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3200; bp.Q.value = 0.6;
    const hiss = ctx.createGain(); hiss.gain.value = 0;
    this._loopNoise(bp); bp.connect(hiss).connect(out);

    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => {
      const target = v > 0.01 ? v * 0.18 : 0;
      voice.level += (target - voice.level) * 0.1;
      hiss.gain.value = voice.level;
      bp.frequency.value = 2200 + v * 3500;
      if (this._due(voice, v, 40, 220)) {                 // droplet pings
        const hz = 1400 + Math.random() * 2600;
        this._ping(hz, 0.03 + v * 0.05, out, 0.18, 3.1);
      }
    };
    return voice;
  }

  // ---- Ghost choir (vowel formants) -------------------------------------
  _buildChoir() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const src = ctx.createGain(); src.gain.value = 0.4;
    for (const [midi, det] of [[50, -7], [50, 7], [57, 0]]) {
      const o = ctx.createOscillator(); o.type = "sawtooth";
      o.frequency.value = mtof(midi); o.detune.value = det; o.connect(src); o.start(t);
    }
    const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 4.5;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 5;
    vib.connect(vibDepth); vib.start(t);
    // Three vowel formant bandpasses summed.
    for (const [f, q, g] of [[750, 8, 1], [1150, 9, 0.7], [2900, 11, 0.4]]) {
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
      const fg = ctx.createGain(); fg.gain.value = g;
      src.connect(bp).connect(fg).connect(out);
    }
    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.03 + v * 0.22 : 0, 0.05, 0.03);
      vibDepth.gain.value = 3 + v * 9;
    };
    return voice;
  }

  // ---- Drone organ (additive drawbars) ----------------------------------
  _buildOrgan() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const mix = ctx.createGain(); mix.gain.value = 0.18;
    const base = mtof(45);
    for (const [mult, g] of [[1, 1], [2, 0.6], [3, 0.5], [4, 0.3], [6, 0.25]]) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = base * mult;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(mix); o.start(t);
    }
    mix.connect(out);
    const voice = { out, level: 0 };
    voice.set = (v) => this._glide(voice, v > 0.01 ? 0.03 + v * 0.22 : 0, 0.12, 0.06);
    return voice;
  }

  // ---- Shimmer bells (random FM bells) ----------------------------------
  _buildBells() {
    const out = this._out(); out.gain.value = 1;
    const scale = [0, 2, 4, 7, 9, 12, 16];
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => {
      if (this._due(voice, v, 90, 700)) {
        const deg = scale[Math.floor(Math.random() * scale.length)] + 12 * Math.floor(Math.random() * 2);
        this._ping(mtof(72 + deg), 0.06 + v * 0.12, out, 1.2 + v * 1.8, 1.41);
      }
    };
    return voice;
  }

  // ---- Acid 303 (resonant saw arp with filter env) ----------------------
  _buildAcid() {
    const ctx = this.ctx;
    const out = this._out(); out.gain.value = 1;
    const scale = [0, 3, 5, 6, 7, 10];
    const voice = { out, level: 0, last: 0, phase: 0 };
    voice.set = (v) => {
      const now = performance.now();
      if (v <= 0.02) { voice.last = now; return; }
      const interval = 240 - v * 175;
      if (now - voice.last >= interval) {
        voice.last = now;
        const deg = scale[voice.phase % scale.length] + 12 * (voice.phase % 3 === 0 ? 1 : 0);
        voice.phase++;
        this._acidNote(mtof(40 + deg), 0.18 + v * 0.22, out, v);
      }
    };
    return voice;
  }

  _acidNote(hz, gain, dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 12 + v * 12;
    lp.frequency.setValueAtTime(hz * 2, t);
    lp.frequency.exponentialRampToValueAtTime(hz * (6 + v * 16), t + 0.04);
    lp.frequency.exponentialRampToValueAtTime(hz * 1.5, t + 0.22);
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(lp).connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.start(t); o.stop(t + 0.3);
    setTimeout(() => g.disconnect(), 400);
  }

  // ---- Wobble bass (LFO-swept resonant lowpass) -------------------------
  _buildWobble() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 400; lp.Q.value = 12;
    const mix = ctx.createGain(); mix.gain.value = 0.25;
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = mtof(31); o.detune.value = det;
      o.connect(mix); o.start(t);
    }
    const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = mtof(31) / 2;
    sub.connect(mix); sub.start(t);
    const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 3;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 600;
    lfo.connect(lfoDepth).connect(lp.frequency); lfo.start(t);
    mix.connect(lp).connect(out);
    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.05 + v * 0.5 : 0, 0.3, 0.08);
      lfo.frequency.value = 1 + v * 11;          // wobble speed
      lp.frequency.value = 250 + v * 500;
      lfoDepth.gain.value = 300 + v * 900;
    };
    return voice;
  }

  // ---- Monster growl (distorted formant) --------------------------------
  _buildGrowl() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = mtof(28);
    const growlLfo = ctx.createOscillator(); growlLfo.type = "square"; growlLfo.frequency.value = 30;
    const growlDepth = ctx.createGain(); growlDepth.gain.value = 20;
    growlLfo.connect(growlDepth).connect(o.detune); growlLfo.start(t);
    const shaper = ctx.createWaveShaper(); shaper.curve = this._shaper(18);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 4;
    o.connect(shaper).connect(bp).connect(out); o.start(t);
    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.03 + v * 0.3 : 0, 0.25, 0.1);
      growlLfo.frequency.value = 18 + v * 60;
      bp.frequency.value = 300 + v * 1400;
    };
    return voice;
  }

  // ---- Siren ------------------------------------------------------------
  _buildSiren() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = 600;
    const lfo = ctx.createOscillator(); lfo.type = "triangle"; lfo.frequency.value = 0.4;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 300;
    lfo.connect(lfoDepth).connect(o.frequency); lfo.start(t);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2500;
    o.connect(lp).connect(out); o.start(t);
    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.16 : 0, 0.2, 0.1);
      lfo.frequency.value = 0.2 + v * 4;
      o.frequency.value = 500 + v * 500;
    };
    return voice;
  }

  // ---- Laser zaps (random descending blips) -----------------------------
  _buildLaser() {
    const out = this._out(); out.gain.value = 1;
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => { if (this._due(voice, v, 60, 500)) this._zap(out, v); };
    return voice;
  }

  _zap(dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "square";
    const top = 1200 + Math.random() * 2600;
    o.frequency.setValueAtTime(top, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.18);
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.08 + v * 0.14, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.start(t); o.stop(t + 0.22);
    setTimeout(() => g.disconnect(), 300);
  }

  // ---- Water bubbles (random pitched bloops) ----------------------------
  _buildBubbles() {
    const out = this._out(); out.gain.value = 1;
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => { if (this._due(voice, v, 70, 500)) this._bloop(out, v); };
    return voice;
  }

  _bloop(dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "sine";
    const base = 200 + Math.random() * 700;
    o.frequency.setValueAtTime(base, t);
    o.frequency.exponentialRampToValueAtTime(base * (2 + Math.random() * 2), t + 0.09);
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 + v * 0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.start(t); o.stop(t + 0.16);
    setTimeout(() => g.disconnect(), 250);
  }

  // ---- Whale song (slow gliding low sine + harmonic) --------------------
  _buildWhale() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 120;
    const h = ctx.createOscillator(); h.type = "sine"; h.frequency.value = 240;
    const hg = ctx.createGain(); hg.gain.value = 0.35;
    const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 1.2;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 8;
    vib.connect(vibDepth); vibDepth.connect(o.detune); vibDepth.connect(h.detune); vib.start(t);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900;
    o.connect(lp); h.connect(hg).connect(lp); lp.connect(out); o.start(t); h.start(t);
    const voice = { out, level: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.05 + v * 0.28 : 0, 0.04, 0.03); // slow, mournful
      const hz = 80 * Math.pow(2, v * 1.6); // ~80Hz -> ~240Hz
      o.frequency.value = hz; h.frequency.value = hz * 2;
      vib.frequency.value = 0.6 + v * 2;
    };
    return voice;
  }

  // ---- Crickets (random high chirp bursts) ------------------------------
  _buildCrickets() {
    const out = this._out(); out.gain.value = 1;
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => { if (this._due(voice, v, 120, 900)) this._chirp(out, v); };
    return voice;
  }

  _chirp(dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = 4200 + Math.random() * 1500;
    const trem = ctx.createOscillator(); trem.type = "square"; trem.frequency.value = 45;
    const tremG = ctx.createGain(); tremG.gain.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 5000; bp.Q.value = 6;
    trem.connect(tremG).connect(g.gain); trem.start(t);
    o.connect(bp).connect(g).connect(dest); o.start(t);
    const dur = 0.12 + Math.random() * 0.14;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + v * 0.06, t + 0.02);
    g.gain.setValueAtTime(0.05 + v * 0.06, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.stop(t + dur + 0.02); trem.stop(t + dur + 0.02);
    setTimeout(() => g.disconnect(), (dur + 0.1) * 1000);
  }

  // ---- UFO warble (random FM sci-fi) ------------------------------------
  _buildUfo() {
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 500;
    const fm = ctx.createOscillator(); fm.type = "sine"; fm.frequency.value = 7;
    const fmDepth = ctx.createGain(); fmDepth.gain.value = 200;
    fm.connect(fmDepth).connect(o.frequency); fm.start(t);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200;
    o.connect(lp).connect(out); o.start(t);
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.16 : 0, 0.2, 0.1);
      fm.frequency.value = 3 + v * 18;
      fmDepth.gain.value = 80 + v * 500;
      const now = performance.now();
      if (now - voice.last > 900 + Math.random() * 1200) { // occasional pitch jumps
        voice.last = now;
        o.frequency.setTargetAtTime(300 + Math.random() * 900, this.ctx.currentTime, 0.08);
      }
    };
    return voice;
  }

  // ---- Gamelan (inharmonic metallic arp) --------------------------------
  _buildGamelan() {
    const out = this._out(); out.gain.value = 1;
    const scale = [0, 2, 5, 7, 9]; // slendro-ish
    const voice = { out, level: 0, last: 0, phase: 0 };
    voice.set = (v) => {
      const now = performance.now();
      if (v <= 0.02) { voice.last = now; return; }
      const interval = 360 - v * 250;
      if (now - voice.last >= interval) {
        voice.last = now;
        const deg = scale[voice.phase % scale.length] + 12 * (voice.phase % 2);
        voice.phase++;
        this._ping(mtof(60 + deg), 0.08 + v * 0.12, out, 0.9 + v * 1.2, 3.47); // inharmonic ratio
      }
    };
    return voice;
  }

  // ---- Geiger clicks (random impulse ticks) -----------------------------
  _buildGeiger() {
    const out = this._out(); out.gain.value = 1;
    const voice = { out, level: 0, last: 0 };
    voice.set = (v) => { if (this._due(voice, v, 25, 700)) this._tick(out, v); };
    return voice;
  }

  _tick(dest, v) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noiseBuffer(0.02);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(hp).connect(g).connect(dest);
    g.gain.setValueAtTime(0.12 + v * 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.start(t); src.stop(t + 0.04);
    setTimeout(() => g.disconnect(), 120);
  }

  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // motion: 0..1 sweeps the master low-pass (affects the tap chimes' brightness).
  setMotion(motion) {
    if (!this.enabled || !this.filter) return;
    const cutoff = 500 + Math.pow(clamp01(motion), 1.5) * 9000;
    this.filter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.05);
  }

  // Tap-triggered pentatonic mallet. velocity: 0..127, pitchPos: 0..1.
  hit(velocity, pitchPos) {
    if (!this.enabled || !this.ctx || !this.chimesOn) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vel = Math.max(0.05, velocity / 127);

    const degree = Math.floor((pitchPos ?? 0) * this.scaleSpread);
    const octave = Math.floor(degree / PENTATONIC.length);
    const semis = PENTATONIC[degree % PENTATONIC.length] + octave * 12;
    const hz = mtof(this.rootMidi + semis);

    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.filter);

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.9;
    oscGain.connect(out);
    for (const [type, det, g] of [["sine", 0, 0.7], ["triangle", 6, 0.35]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      o.frequency.setValueAtTime(hz * 1.5, t);
      o.frequency.exponentialRampToValueAtTime(hz, t + 0.04);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(oscGain);
      o.start(t);
      o.stop(t + 1.2);
    }

    const noiseLen = Math.floor(ctx.sampleRate * 0.05);
    const nbuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
    const noise = ctx.createBufferSource();
    noise.buffer = nbuf;
    const nGain = ctx.createGain();
    nGain.gain.value = 0.4 * vel;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass";
    nFilt.frequency.value = hz * 2;
    noise.connect(nFilt).connect(nGain).connect(out);
    noise.start(t);
    noise.stop(t + 0.06);

    const peak = 0.18 + vel * 0.7;
    const decay = 0.25 + vel * 0.55;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.004);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    setTimeout(() => out.disconnect(), (decay + 0.2) * 1000);
  }
}

window.AudioEngine = AudioEngine;
