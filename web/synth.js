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
      { key: "theremin", label: "Theremin" },
      { key: "pad", label: "Warm pad" },
      { key: "wind", label: "Noise wind" },
      { key: "pluck", label: "Pluck arp" },
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
    this.voices.theremin = this._buildTheremin();
    this.voices.pad = this._buildPad();
    this.voices.wind = this._buildWind();
    this.voices.pluck = this._buildPluck();

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
    const v = this.voices[key];
    if (v) v.set(clamp01(value));
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
