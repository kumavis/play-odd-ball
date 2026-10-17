// Multi-voice synth for the ODD Ball.
//
// - "Chimes" is an event instrument: taps/notes trigger a pentatonic mallet.
// - The other instruments are continuous, parameter-driven "voices": each has a
//   generic set(v) (v in 0..1) that maps the value to gain/pitch/filter. The app
//   layer routes any calculated parameter (roll speed, tilt, energy, ...) into
//   any voice, so instruments can be freely patched to parameters.
// - The psytrance voices are tempo-locked: while their input is up they play a
//   pattern on the shared 16th-note grid (see clock.ts), so a kick, a rolling
//   bass and an arp patched to different movements still groove together. The
//   value sets intensity (level, filter, density) rather than timing.

import { TempoClock, dueSteps, type StepCursor } from "./clock";

const PENTATONIC = [0, 3, 5, 7, 10]; // minor pentatonic semitone offsets
// The psytrance and new melodic voices stay on the white keys (E phrygian —
// also raag Bhairavi — A minor, C major pentatonic), the same notes the chimes,
// piano, bells and gamelan already use, so anything patched together stays
// consonant.
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const PSY_ROOT = 40; // E2
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Map a 0..1 note position onto `octaves` octaves of a scale (low → high). */
const scaleDeg = (scale: number[], note: number, octaves = 2): number => {
  const steps = scale.length * octaves;
  const k = Math.min(steps - 1, Math.floor(clamp01(note) * steps));
  return scale[k % scale.length] + 12 * Math.floor(k / scale.length);
};

export type InstrumentGroup = "psy" | "melodic" | "bass" | "fx";

/** Display order + labels for the instrument groups (the rack's headers). */
export const INSTRUMENT_GROUPS: { key: InstrumentGroup; label: string; about: string }[] = [
  { key: "psy", label: "Psytrance", about: "locked to the BPM in the top bar — they groove together" },
  { key: "melodic", label: "Melodic", about: "pitched instruments; most take a note input" },
  { key: "bass", label: "Bass & pads", about: "sustained low end and textures" },
  { key: "fx", label: "Sound FX", about: "weather, machines and creatures" },
];

export interface InstrumentDef {
  key: string;
  label: string;
  group: InstrumentGroup;
  /** Accepts an optional second "note" input that picks the pitch of each
   * event (e.g. tap triggers the piano, Orient X chooses the note). */
  noted?: boolean;
}

interface Voice {
  out: GainNode;
  level: number;
  /** `note` (0..1), when provided, overrides the voice's own pitch choice —
   * only the `noted` instruments read it. */
  set: (v: number, note?: number) => void;
  // per-voice scratch state used by the event/arp voices
  last?: number;
  phase?: number;
  step?: number;
  active?: number;
  rpm?: number;
  prevV?: number;
  /** Tempo-locked voices: the next grid step not yet scheduled. */
  cursor?: StepCursor;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  filter: BiquadFilterNode | null = null;
  reverb: ConvolverNode | null = null;
  enabled = false;
  rootMidi = 57; // A3-ish base for the chimes
  scaleSpread = 24; // semitone range mapped across the chime pitch CC
  voices: Record<string, Voice> = {};
  chimesOn = true; // tap/note mallet hits
  /** Shared 16th-note grid for the tempo-locked voices. */
  readonly clock = new TempoClock();
  /** One second of white noise, reused by the drum voices' hits. */
  private noise: AudioBuffer | null = null;
  /** Karplus–Strong sitar strings, rendered once per pitch. */
  private ksCache = new Map<number, AudioBuffer>();
  private previewing: Record<string, number> | null = null;

  // Instruments the UI can expose, grouped musical-first. Chimes is added by
  // the app layer (it's an event instrument rather than a continuous voice).
  static get INSTRUMENTS(): InstrumentDef[] {
    return [
      { key: "psykick", label: "Psy kick", group: "psy" },
      { key: "rollbass", label: "Rolling bass", group: "psy", noted: true },
      { key: "psyhats", label: "Offbeat hats", group: "psy" },
      { key: "psyclap", label: "Clap", group: "psy" },
      { key: "goaarp", label: "Goa arp", group: "psy", noted: true },
      { key: "supersaw", label: "Trance gate", group: "psy", noted: true },
      { key: "riser", label: "Noise riser", group: "psy" },
      { key: "piano", label: "Piano walk", group: "melodic", noted: true },
      { key: "epiano", label: "Electric piano", group: "melodic", noted: true },
      { key: "sitar", label: "Sitar", group: "melodic", noted: true },
      { key: "kalimba", label: "Kalimba", group: "melodic", noted: true },
      { key: "flute", label: "Pan flute", group: "melodic", noted: true },
      { key: "pluck", label: "Pluck arp", group: "melodic", noted: true },
      { key: "bells", label: "Shimmer bells", group: "melodic", noted: true },
      { key: "gamelan", label: "Gamelan", group: "melodic", noted: true },
      { key: "acid", label: "Acid 303", group: "melodic", noted: true },
      { key: "theremin", label: "Theremin", group: "melodic" },
      { key: "bass", label: "Alien bass", group: "bass" },
      { key: "wobble", label: "Wobble bass", group: "bass" },
      { key: "pad", label: "Warm pad", group: "bass" },
      { key: "organ", label: "Drone organ", group: "bass" },
      { key: "choir", label: "Ghost choir", group: "bass" },
      { key: "engine", label: "Revving engine", group: "fx" },
      { key: "thunder", label: "Thunderstorm", group: "fx" },
      { key: "thunderclap", label: "Thunderclap", group: "fx" },
      { key: "lightning", label: "Lightning strike", group: "fx" },
      { key: "rain", label: "Rainfall", group: "fx" },
      { key: "wind", label: "Noise wind", group: "fx" },
      { key: "growl", label: "Monster growl", group: "fx" },
      { key: "siren", label: "Siren", group: "fx" },
      { key: "laser", label: "Laser zaps", group: "fx" },
      { key: "bubbles", label: "Water bubbles", group: "fx" },
      { key: "whale", label: "Whale song", group: "fx" },
      { key: "crickets", label: "Crickets", group: "fx" },
      { key: "ufo", label: "UFO warble", group: "fx" },
      { key: "geiger", label: "Geiger clicks", group: "fx" },
    ];
  }

  async enable(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      this.enabled = true;
      return;
    }
    // iOS Safari 17+: play Web Audio as media, so the ring/silent switch
    // doesn't mute it (by default it's treated like a UI sound effect).
    const session = (navigator as any).audioSession;
    if (session && session.type !== "playback") {
      try {
        session.type = "playback";
      } catch {
        /* older WebKit: read-only or unsupported */
      }
    }
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.ctx = ctx;
    this.noise = this._noiseBuffer(1);
    this.clock.origin = ctx.currentTime + 0.05;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    // Brick-wall safety limiter: layered voices (kick + bass + lead) would
    // otherwise sum past full scale and hard-clip, harshest on phone speakers.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;

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
    this.master.connect(limiter).connect(ctx.destination);

    this.voices.psykick = this._buildPsyKick();
    this.voices.rollbass = this._buildRollBass();
    this.voices.psyhats = this._buildPsyHats();
    this.voices.psyclap = this._buildPsyClap();
    this.voices.goaarp = this._buildGoaArp();
    this.voices.supersaw = this._buildSupersaw();
    this.voices.riser = this._buildRiser();
    this.voices.epiano = this._buildEpiano();
    this.voices.sitar = this._buildSitar();
    this.voices.kalimba = this._buildKalimba();
    this.voices.flute = this._buildFlute();
    this.voices.bass = this._buildBass();
    this.voices.engine = this._buildEngine();
    this.voices.thunder = this._buildThunder();
    this.voices.thunderclap = this._buildThunderclap();
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

  disable(): void {
    this.enabled = false;
    if (this.ctx) this.ctx.suspend();
  }

  /** Tempo of the BPM-locked voices. Works before audio starts, too. */
  setBpm(bpm: number): void {
    this.clock.setBpm(bpm, this.ctx?.currentTime ?? 0);
  }

  /** Current position in beats on the shared grid, or null while silent. */
  beatPosition(): number | null {
    if (!this.ctx || !this.enabled || this.ctx.state !== "running") return null;
    return this.clock.position(this.ctx.currentTime) / 4;
  }

  /** Route a 0..1 parameter value into a continuous voice. `note` (0..1),
   * when given, picks the pitch of the noted instruments' next event. */
  setVoice(key: string, value: number, note?: number): void {
    if (!this.enabled) return;
    if (this.previewing && this.previewing[key]) return; // a preview owns this voice
    const v = this.voices[key];
    if (v) v.set(clamp01(value), note);
  }

  // Play a short, representative demo of a single instrument so the user can
  // hear what it sounds like. While previewing, the per-frame setVoice updates
  // are ignored for that key so the demo envelope isn't immediately
  // overwritten by the patch loop.
  preview(key: string): void {
    if (!this.ctx) return;
    if (key === "chimes") {
      const pe = this.enabled;
      const pc = this.chimesOn;
      this.enabled = true;
      this.chimesOn = true;
      this.hit(110, 0.45);
      this.chimesOn = pc;
      this.enabled = pe;
      return;
    }
    const v = this.voices[key];
    if (!v) return;
    if (!this.previewing) this.previewing = {};
    const id = (this.previewing[key] || 0) + 1;
    this.previewing[key] = id;

    const start = performance.now();
    const dur = 1300; // total demo length in ms
    const attack = 90;
    const release = 500;
    const tick = () => {
      if (!this.previewing || this.previewing[key] !== id) return; // cancelled/superseded
      const el = performance.now() - start;
      if (el >= dur) {
        // Glide voices move only ~10% toward zero per set(0); with sound off
        // nothing else glides them down, so keep ticking until silent (the
        // preview keeps owning the voice) then hard-zero. Event voices keep
        // level at exactly 0 and a fixed out gain — leave those alone.
        v.set(0);
        if (v.level > 0.001) {
          requestAnimationFrame(tick);
          return;
        }
        if (v.level > 0) {
          v.level = 0;
          v.out.gain.value = 0;
        }
        this.previewing[key] = 0;
        return;
      }
      let val: number;
      if (el < attack) val = 0.95 * (el / attack);
      else if (el < dur - release) val = 0.95;
      else val = 0.95 * (1 - (el - (dur - release)) / release);
      v.set(clamp01(val));
      requestAnimationFrame(tick);
    };
    tick();
  }

  private _out(reverb = 1): GainNode {
    // A per-voice output gain wired to master (dry) + reverb (wet). Kicks and
    // basses pass reverb = 0: a reverberant low end turns to mud.
    const g = this.ctx!.createGain();
    g.gain.value = 0;
    g.connect(this.master!);
    if (reverb >= 1) g.connect(this.reverb!);
    else if (reverb > 0) {
      const send = this.ctx!.createGain();
      send.gain.value = reverb;
      g.connect(send).connect(this.reverb!);
    }
    return g;
  }

  /** Asymmetric glide toward target (quick in, gentle out) to avoid clicks. */
  private _glide(voice: Voice, target: number, upK = 0.3, downK = 0.08): number {
    const k = target > voice.level ? upK : downK;
    voice.level += (target - voice.level) * k;
    voice.out.gain.value = voice.level;
    return voice.level;
  }

  /** Drive a tempo-locked voice: hand `play` every grid step that falls inside
   * the lookahead window while the input is up. The cursor advances even while
   * silent, so a voice that comes back in lands on the same grid as the rest. */
  private _onGrid(voice: Voice, v: number, play: (step: number, t: number) => void): void {
    const cursor = voice.cursor ?? (voice.cursor = { next: null });
    for (const { step, time } of dueSteps(this.clock, cursor, this.ctx!.currentTime)) {
      if (v > 0.02) play(step, time);
    }
  }

  /** Disconnect a one-shot's nodes once a note starting at `t` has rung out. */
  private _release(t: number, dur: number, ...nodes: AudioNode[]): void {
    const ms = (t - this.ctx!.currentTime + dur + 0.2) * 1000;
    setTimeout(() => nodes.forEach((n) => n.disconnect()), ms);
  }

  /** A burst of the shared noise buffer, from a random offset, starting at `t`. */
  private _noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * Math.max(0, 0.95 - dur), dur);
    return src;
  }

  // ---- Psytrance (tempo-locked) ---------------------------------------------

  // Four-on-the-floor kick: tight pitch drop, short tail, and a click on top so
  // it still cuts through a phone speaker that can't reproduce the sub.
  private _buildPsyKick(): Voice {
    const out = this._out(0);
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) =>
      this._onGrid(voice, v, (step, t) => {
        if (step % 4 === 0) this._kick(t, 0.5 + v * 0.4, out);
      });
    return voice;
  }

  private _kickCurve: Float32Array<ArrayBuffer> | null = null;

  private _kick(t: number, level: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(330, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.035);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.26);
    const drive = ctx.createWaveShaper();
    drive.curve = this._kickCurve ?? (this._kickCurve = this._shaper(2.5));
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    g.gain.setValueAtTime(level, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(drive).connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.32);
    const click = this._noiseSrc(t, 0.015);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    cg.gain.setValueAtTime(level * 0.3, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    click.connect(hp).connect(cg).connect(dest);
    this._release(t, 0.32, g, cg);
  }

  // Rolling bassline: three staccato 16ths after every kick (K-B-B-B), each with
  // its own snappy filter envelope. Value opens the filter and pushes the
  // resonance; a note input moves the root around E phrygian.
  private _buildRollBass(): Voice {
    const out = this._out(0);
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v, note) =>
      this._onGrid(voice, v, (step, t) => {
        if (step % 4 === 0) return; // the kick owns the downbeat
        const deg = typeof note === "number" ? scaleDeg(PHRYGIAN, note, 1) : 0;
        // Gallop up an octave on the bar's last 16th when driven hard.
        const oct = v > 0.7 && step % 16 === 15 ? 12 : 0;
        this._bassNote(mtof(PSY_ROOT + deg + oct), t, v, out);
      });
    return voice;
  }

  private _bassNote(hz: number, t: number, v: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const len = this.clock.stepDur * 0.8;
    const level = 0.22 + v * 0.18;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.setValueAtTime(level, t + len * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    // Two cascaded lowpasses ≈ a 24 dB/oct ladder, swept down on every note.
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    lp1.type = "lowpass";
    lp2.type = "lowpass";
    lp1.Q.value = 2 + v * 5;
    lp2.Q.value = 0.7;
    const peak = Math.min(12000, hz * (4 + v * 18));
    for (const lp of [lp1, lp2]) {
      lp.frequency.setValueAtTime(peak, t);
      lp.frequency.exponentialRampToValueAtTime(hz * 1.4, t + len);
    }
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = hz;
    const body = ctx.createOscillator(); // a sine at the fundamental for weight
    body.type = "sine";
    body.frequency.value = hz;
    const bodyG = ctx.createGain();
    bodyG.gain.value = 0.5;
    saw.connect(lp1).connect(lp2).connect(g);
    body.connect(bodyG).connect(g);
    g.connect(dest);
    for (const o of [saw, body]) {
      o.start(t);
      o.stop(t + len + 0.02);
    }
    this._release(t, len, g);
  }

  // Hats: an open hat on every offbeat; driven harder, closed 16ths fill in.
  private _buildPsyHats(): Voice {
    const out = this._out(0.35);
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) =>
      this._onGrid(voice, v, (step, t) => {
        if (step % 4 === 2) this._hat(t, 0.1 + v * 0.12, 0.08 + v * 0.1, out);
        else if (v > 0.45 && step % 2 === 1) this._hat(t, 0.035 + v * 0.04, 0.025, out);
      });
    return voice;
  }

  private _hat(t: number, level: number, decay: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = this._noiseSrc(t, decay + 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 10500;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(hp).connect(bp).connect(g).connect(dest);
    this._release(t, decay, g);
  }

  // Clap on beats 2 and 4: three fast noise slaps, then a short room tail.
  private _buildPsyClap(): Voice {
    const out = this._out(0.6);
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) =>
      this._onGrid(voice, v, (step, t) => {
        if (step % 8 === 4) this._clap(t, 0.34 + v * 0.32, out);
      });
    return voice;
  }

  private _clap(t: number, level: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = this._noiseSrc(t, 0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1400;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = 0;
    for (let i = 0; i < 3; i++) {
      const st = t + i * 0.011;
      g.gain.setValueAtTime(level, st);
      g.gain.exponentialRampToValueAtTime(level * 0.12, st + 0.009);
    }
    g.gain.setValueAtTime(level * 0.85, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    src.connect(bp).connect(g).connect(dest);
    this._release(t, 0.3, g);
  }

  // Goa arp: a 16th-note figure — root/octave pedal against a moving line —
  // through a squelchy resonant filter into a tempo-synced dotted-8th echo.
  // Gentle input plays 8ths; a note input transposes the figure.
  private _buildGoaArp(): Voice {
    const ctx = this.ctx!;
    const out = this._out();
    out.gain.value = 1;
    const bus = ctx.createGain();
    bus.connect(out);
    const delay = ctx.createDelay(2);
    let echo = this.clock.stepDur * 3;
    delay.delayTime.value = echo;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2600;
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    bus.connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    damp.connect(wet).connect(out);
    const figure = [0, 12, 7, 12, 0, 13, 8, 12, 0, 12, 7, 10, 8, 7, 5, 3]; // semitones over E4
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v, note) => {
      const dt = this.clock.stepDur * 3;
      if (dt !== echo) {
        echo = dt;
        delay.delayTime.setTargetAtTime(dt, ctx.currentTime, 0.05);
      }
      this._onGrid(voice, v, (step, t) => {
        if (v < 0.35 && step % 2 === 1) return;
        const root = PSY_ROOT + 24 + (typeof note === "number" ? scaleDeg(PHRYGIAN, note, 1) : 0);
        this._goaNote(mtof(root + figure[step % 16]), t, v, bus);
      });
    };
    return voice;
  }

  private _goaNote(hz: number, t: number, v: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const len = this.clock.stepDur * 0.95;
    const level = 0.06 + v * 0.06;
    const a = ctx.createOscillator();
    a.type = "sawtooth";
    a.frequency.value = hz;
    const b = ctx.createOscillator();
    b.type = "square";
    b.frequency.value = hz;
    b.detune.value = 9;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 8 + v * 9;
    lp.frequency.setValueAtTime(Math.min(14000, hz * (3 + v * 9)), t);
    lp.frequency.exponentialRampToValueAtTime(hz * 1.1, t + len);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    a.connect(lp);
    b.connect(lp);
    lp.connect(g).connect(dest);
    for (const o of [a, b]) {
      o.start(t);
      o.stop(t + len + 0.02);
    }
    this._release(t, len, g);
  }

  // Trance-gate lead: a detuned supersaw chord (root, diatonic fifth, octave)
  // chopped by a 16-step gate pattern locked to the grid. Value fades it in and
  // opens the filter; a note input moves the chord around E phrygian.
  private _buildSupersaw(): Voice {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const out = this._out();
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1200;
    lp.Q.value = 0.9;
    const mix = ctx.createGain();
    mix.gain.value = 0.13;
    const root0 = PSY_ROOT + 12;
    const chord = (k: number) => {
      const up = k + 4; // a fifth, counted in scale steps so it stays diatonic
      const fifth = PHRYGIAN[up % 7] + (up >= 7 ? 12 : 0) - PHRYGIAN[k];
      return [0, fifth, 12];
    };
    const oscs: OscillatorNode[][] = [[], [], []];
    chord(0).forEach((semis, i) => {
      for (const det of [-14, 0, 14]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = mtof(root0 + semis);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(mix);
        o.start(t0);
        oscs[i].push(o);
      }
    });
    mix.connect(lp).connect(gate).connect(out);
    const pattern = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1];
    let degree = 0;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v, note) => {
      this._glide(voice, v > 0.01 ? 0.06 + v * 0.38 : 0, 0.3, 0.06);
      lp.frequency.value = 700 + v * v * 6500;
      const k = typeof note === "number" ? Math.min(6, Math.floor(clamp01(note) * 7)) : 0;
      if (k !== degree) {
        degree = k;
        const intervals = chord(k);
        oscs.forEach((group, i) => {
          const hz = mtof(root0 + PHRYGIAN[k] + intervals[i]);
          for (const o of group) o.frequency.setTargetAtTime(hz, ctx.currentTime, 0.02);
        });
      }
      // The gate keeps running while silent, so it stays phase-locked.
      const sd = this.clock.stepDur;
      this._onGrid(voice, 1, (step, t) => {
        if (pattern[step % 16]) {
          gate.gain.setTargetAtTime(1, t, 0.003);
          gate.gain.setTargetAtTime(0.06, t + sd * 0.6, 0.012);
        } else gate.gain.setTargetAtTime(0.06, t, 0.01);
      });
    };
    return voice;
  }

  // Noise riser: the build-up whoosh. Value sweeps a resonant band of noise
  // upward and swells it — roll faster and the build climbs.
  private _buildRiser(): Voice {
    const ctx = this.ctx!;
    const out = this._out();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 200;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 400;
    bp.Q.value = 3;
    this._loopNoise(hp);
    hp.connect(bp).connect(out);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.08 + v * 0.6 : 0, 0.08, 0.05);
      bp.frequency.setTargetAtTime(300 * Math.pow(30, v), ctx.currentTime, 0.06); // 300 Hz → 9 kHz
      bp.Q.value = 2 + v * 6;
      hp.frequency.value = 150 + v * 1500;
    };
    return voice;
  }

  // ---- Melodic ------------------------------------------------------------------

  // Electric piano: a two-operator FM tine — the modulation index decays, so
  // each note starts bell-bright and mellows to a round tone. Notes come from
  // A minor pentatonic; driven harder it adds a fifth above.
  private _buildEpiano(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 3, 5, 7, 10];
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v, note) => {
      if (!this._due(voice, v, 160, 900)) return;
      const deg =
        typeof note === "number"
          ? scaleDeg(scale, note)
          : scale[Math.floor(Math.random() * scale.length)] + 12 * Math.floor(Math.random() * 2);
      const gain = 0.1 + v * 0.14;
      this._epNote(mtof(57 + deg), gain, out);
      if (v > 0.6 && Math.random() < 0.5) this._epNote(mtof(57 + deg + 7), gain * 0.6, out);
    };
    return voice;
  }

  private _epNote(hz: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const decay = 1.4 + 220 / hz; // low notes ring longer
    const car = ctx.createOscillator();
    car.type = "sine";
    car.frequency.value = hz;
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = hz;
    const index = ctx.createGain();
    index.gain.setValueAtTime(hz * 2.2, t);
    index.gain.exponentialRampToValueAtTime(hz * 0.12, t + 0.9);
    mod.connect(index).connect(car.frequency);
    // The "tine bark": a high, very short modulator on the attack.
    const bark = ctx.createOscillator();
    bark.type = "sine";
    bark.frequency.value = hz * 14;
    const barkIdx = ctx.createGain();
    barkIdx.gain.setValueAtTime(hz * 0.8, t);
    barkIdx.gain.exponentialRampToValueAtTime(0.01, t + 0.06);
    bark.connect(barkIdx).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    car.connect(g).connect(dest);
    for (const o of [car, mod, bark]) {
      o.start(t);
      o.stop(t + decay + 0.05);
    }
    this._release(t, decay, g);
  }

  // Sitar: a Karplus–Strong plucked string (rendered once per pitch) through a
  // buzzing jawari bridge, with a little meend — the pitch slides up into each
  // note. It wanders raag Bhairavi, which shares E phrygian's notes.
  private _buildSitar(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, step: 7, set: () => {} };
    voice.set = (v, note) => {
      if (!this._due(voice, v, 180, 950)) return;
      let idx: number;
      if (typeof note === "number") idx = Math.min(13, Math.floor(clamp01(note) * 14));
      else {
        // Wander a step or two, drifting home to Sa (the tonic) now and then.
        const jump = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2));
        idx = Math.random() < 0.2 ? 7 : Math.max(0, Math.min(13, voice.step! + jump));
        voice.step = idx;
      }
      const midi = PSY_ROOT + 12 + PHRYGIAN[idx % 7] + 12 * Math.floor(idx / 7);
      this._sitarNote(midi, 0.2 + v * 0.22, out);
    };
    return voice;
  }

  private _jawari: Float32Array<ArrayBuffer> | null = null;

  private _sitarNote(midi: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const string = this._ksString(midi);
    src.buffer = string;
    src.playbackRate.setValueAtTime(0.97, t);
    src.playbackRate.exponentialRampToValueAtTime(1, t + 0.09);
    if (!this._jawari) {
      // Asymmetric curve: soft saturation plus an even-harmonic term (the buzz).
      const n = 1024;
      this._jawari = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        this._jawari[i] = Math.tanh(1.8 * x) / Math.tanh(1.8) + 0.3 * x * x;
      }
    }
    const jawari = ctx.createWaveShaper();
    jawari.curve = this._jawari;
    const dc = ctx.createBiquadFilter(); // the even term adds DC; strip it
    dc.type = "highpass";
    dc.frequency.value = 70;
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2800;
    presence.Q.value = 1.2;
    presence.gain.value = 7;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(jawari).connect(dc).connect(presence).connect(g).connect(dest);
    src.start(t);
    this._release(t, string.duration, g);
  }

  /** Render a plucked string with Karplus–Strong, cached per MIDI note. An
   * allpass supplies the fractional part of the loop delay so high notes stay
   * in tune (integer-only loops drift sharp by up to ~20 cents up there). */
  private _ksString(midi: number): AudioBuffer {
    const cached = this.ksCache.get(midi);
    if (cached) return cached;
    const rate = this.ctx!.sampleRate;
    const len = Math.floor(rate * 2.2);
    const buf = this.ctx!.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    // Loop delay = n samples (ring) − 0.5 (two-point average) + d (allpass).
    const period = rate / mtof(midi);
    const n = Math.max(2, Math.floor(period));
    const d = period - n + 0.5;
    const c = (1 - d) / (1 + d);
    const ring = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.6 * (Math.random() * 2 - 1 - lp); // softened noise: a plectrum, not a hammer
      ring[i] = lp;
    }
    let apX = 0;
    let apY = 0;
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const next = idx + 1 === n ? 0 : idx + 1;
      const cur = ring[idx];
      const avg = 0.5 * (cur + ring[next]) * 0.996;
      const y = c * avg + apX - c * apY;
      apX = avg;
      apY = y;
      out[i] = cur;
      ring[idx] = y;
      idx = next;
    }
    const fade = Math.floor(rate * 0.05); // no click where the buffer ends
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
    this.ksCache.set(midi, buf);
    return buf;
  }

  // Kalimba: a soft sine tine with a quick inharmonic overtone and a thumb
  // click, picking C major pentatonic in the left/right zig-zag of real tines.
  private _buildKalimba(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 2, 4, 7, 9];
    const order = [0, 2, 4, 1, 3, 5, 7, 6, 8, 5, 3, 1]; // positions on a 2-octave layout
    const voice: Voice = { out, level: 0, last: 0, phase: 0, set: () => {} };
    voice.set = (v, note) => {
      if (!this._due(voice, v, 120, 760)) return;
      let deg: number;
      if (typeof note === "number") deg = scaleDeg(scale, note);
      else {
        const k = order[voice.phase!++ % order.length];
        deg = scale[k % 5] + 12 * Math.floor(k / 5);
      }
      this._tine(mtof(60 + deg), 0.16 + v * 0.18, out);
    };
    return voice;
  }

  private _tine(hz: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const decay = 1.1 + 200 / hz;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.connect(dest);
    for (const [mult, amp, d] of [
      [1, 1, decay],
      [5.4, 0.25, 0.1],
      [8.9, 0.1, 0.05],
    ]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = hz * mult;
      const og = ctx.createGain();
      og.gain.value = 0;
      og.gain.setValueAtTime(amp, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    const click = this._noiseSrc(t, 0.008);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = hz * 3;
    const cg = ctx.createGain();
    cg.gain.value = gain * 0.5;
    click.connect(bp).connect(cg).connect(g);
    this._release(t, decay, g);
  }

  // Pan flute: a breathy legato line. A note input picks the pitch; otherwise
  // the value plays it like a slide whistle quantized to E minor pentatonic —
  // louder AND higher as you push, gliding between notes.
  private _buildFlute(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const scale = [0, 3, 5, 7, 10];
    const root = 64; // E4
    const steps = scale.length * 2;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3500;
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 4;
    vib.connect(vibDepth);
    vib.start(t);
    const partials: [OscillatorNode, number][] = [];
    for (const [mult, amp] of [
      [1, 1],
      [2, 0.09],
      [3, 0.05],
    ]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = mtof(root) * mult;
      const og = ctx.createGain();
      og.gain.value = amp;
      vibDepth.connect(o.detune);
      o.connect(og).connect(lp);
      o.start(t);
      partials.push([o, mult]);
    }
    // Breath: noise band-passed around the second harmonic.
    const breath = ctx.createBiquadFilter();
    breath.type = "bandpass";
    breath.frequency.value = mtof(root) * 2;
    breath.Q.value = 1.4;
    const breathG = ctx.createGain();
    breathG.gain.value = 0.16;
    this._loopNoise(breath);
    breath.connect(breathG).connect(lp);
    lp.connect(out);
    let cur = -1;
    let curHz = 0;
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v, note) => {
      this._glide(voice, v > 0.01 ? 0.04 + v * 0.22 : 0, 0.12, 0.06);
      const pos = (typeof note === "number" ? clamp01(note) : v) * steps;
      // Hysteresis: a value hovering on a boundary doesn't warble between notes.
      if (cur < 0 || pos < cur - 0.15 || pos > cur + 1.15) cur = Math.min(steps - 1, Math.floor(pos));
      const hz = mtof(root + scale[cur % 5] + 12 * Math.floor(cur / 5));
      if (hz !== curHz) {
        curHz = hz;
        const now = ctx.currentTime;
        for (const [o, mult] of partials) o.frequency.setTargetAtTime(hz * mult, now, 0.035);
        breath.frequency.setTargetAtTime(hz * 2, now, 0.035);
      }
      vibDepth.gain.value = 3 + v * 9;
    };
    return voice;
  }

  // ---- Voices -----------------------------------------------------------

  // Low, detuned, wobbling "alien" bass. Louder/higher/brighter with value.
  private _buildBass(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const baseHz = 33; // ~C1
    const out = this._out();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    filter.Q.value = 7;

    const am = ctx.createGain();
    am.gain.value = 0.75;
    const amLfo = ctx.createOscillator();
    amLfo.type = "sine";
    amLfo.frequency.value = 6;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.25;
    amLfo.connect(amDepth).connect(am.gain);
    amLfo.start(t);

    const mix = ctx.createGain();
    mix.gain.value = 0.32;
    const oscs: OscillatorNode[] = [];
    for (const [type, det] of [["sawtooth", -8], ["sawtooth", 7], ["square", 0]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = baseHz;
      o.detune.value = det;
      o.connect(mix);
      o.start(t);
      oscs.push(o);
    }
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = baseHz / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    sub.connect(subGain).connect(mix);
    sub.start(t);
    oscs.push(sub);

    const vibLfo = ctx.createOscillator();
    vibLfo.type = "sine";
    vibLfo.frequency.value = 5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 10;
    vibLfo.connect(vibDepth);
    for (const o of oscs) vibDepth.connect(o.detune);
    vibLfo.start(t);

    mix.connect(am).connect(filter).connect(out);

    const voice: Voice = { out, level: 0, set: () => {} };
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

  // Revving combustion engine: value is the throttle (RPM, chug, grit, filter).
  private _buildEngine(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const idleHz = 32;
    const maxHz = 178;
    const out = this._out();

    const mix = ctx.createGain();
    mix.gain.value = 0.4;
    const o1 = ctx.createOscillator();
    o1.type = "sawtooth";
    o1.frequency.value = idleHz;
    const o2 = ctx.createOscillator();
    o2.type = "sawtooth";
    o2.frequency.value = idleHz;
    o2.detune.value = 14;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = idleHz / 2;
    const subG = ctx.createGain();
    subG.gain.value = 0.5;
    o1.connect(mix);
    o2.connect(mix);
    sub.connect(subG).connect(mix);
    o1.start(t);
    o2.start(t);
    sub.start(t);

    // Exhaust grit: lowpassed noise mixed in, louder with throttle.
    const noiseLp = ctx.createBiquadFilter();
    noiseLp.type = "lowpass";
    noiseLp.frequency.value = 1400;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    this._loopNoise(noiseLp);
    noiseLp.connect(noiseGain).connect(mix);

    // Combustion distortion.
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._shaper(6);

    // Amplitude "chug" locked to the firing rate.
    const am = ctx.createGain();
    am.gain.value = 1;
    const amLfo = ctx.createOscillator();
    amLfo.type = "sawtooth";
    amLfo.frequency.value = idleHz;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.5;
    amLfo.connect(amDepth).connect(am.gain);
    amLfo.start(t);

    // Idle flutter so it doesn't sit dead still.
    const flutter = ctx.createOscillator();
    flutter.type = "sine";
    flutter.frequency.value = 7;
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 4;
    flutter.connect(flutterDepth);
    flutterDepth.connect(o1.detune);
    flutterDepth.connect(o2.detune);
    flutter.start(t);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    lp.Q.value = 3;

    mix.connect(shaper).connect(am).connect(lp).connect(out);

    const voice: Voice = { out, level: 0, rpm: idleHz, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.06 + v * 0.5 : 0, 0.25, 0.09);
      const targetRpm = idleHz + v * (maxHz - idleHz);
      voice.rpm! += (targetRpm - voice.rpm!) * 0.15; // spin-up/down lag
      const hz = voice.rpm!;
      o1.frequency.value = hz;
      o2.frequency.value = hz;
      sub.frequency.value = hz / 2;
      amLfo.frequency.value = hz; // chug tracks the firing rate
      amDepth.gain.value = 0.55 - v * 0.42; // deep at idle, smooth at high rev
      lp.frequency.value = 350 + v * 4400;
      noiseGain.gain.value = 0.05 + v * 0.22;
      flutter.frequency.value = 6 + v * 4;
    };
    return voice;
  }

  // Smooth sine "theremin": pitch glides over ~2 octaves, volume follows value.
  private _buildTheremin(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 5.5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 6;
    vib.connect(vibDepth).connect(osc.detune);
    vib.start(t);
    osc.connect(lp).connect(out);
    osc.start(t);

    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.24 : 0, 0.25, 0.12);
      osc.frequency.value = 130 * Math.pow(2, v * 2.2); // ~130Hz -> ~600Hz
    };
    return voice;
  }

  // Warm sustained pad: detuned saws + fifth through a lowpass; slow swell.
  private _buildPad(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 800;
    lp.Q.value = 0.7;
    const mix = ctx.createGain();
    mix.gain.value = 0.2;
    // Root (C3), slightly detuned pair, plus the fifth (G3).
    for (const [midi, det] of [[48, -6], [48, 6], [55, 0]]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = mtof(midi);
      o.detune.value = det;
      o.connect(mix);
      o.start(t);
    }
    mix.connect(lp).connect(out);

    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.2 : 0, 0.06, 0.04); // slow swell
      lp.frequency.value = 300 + v * 3500;
    };
    return voice;
  }

  // Airy filtered noise "wind": cutoff + resonance + level rise with value.
  private _buildWind(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 600;
    bp.Q.value = 3;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(bp).connect(out);
    src.start(t);

    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? v * 0.3 : 0, 0.2, 0.1);
      bp.frequency.value = 200 + v * 4500;
      bp.Q.value = 2 + v * 10;
    };
    return voice;
  }

  // Rhythmic pluck arpeggio: value sets both tempo and pitch of repeating plucks.
  private _buildPluck(): Voice {
    const out = this._out();
    out.gain.value = 1; // plucks manage their own envelopes; out is a bus
    const voice: Voice = { out, level: 0, last: 0, phase: 0, active: 0, set: () => {} };
    const scale = [0, 3, 5, 7, 10, 12]; // pentatonic-ish steps
    voice.set = (v, note) => {
      voice.active = v; // gate handled at trigger time
      const now = performance.now();
      if (v <= 0.02) {
        voice.last = now;
        return;
      }
      const interval = 260 - v * 190; // fast (70ms) when high, slow (260ms) when low
      if (now - voice.last! >= interval) {
        voice.last = now;
        const deg =
          typeof note === "number"
            ? scaleDeg(scale, note)
            : scale[voice.phase!++ % scale.length] + 12 * Math.floor(v * 2);
        this._pluck(mtof(52 + deg), 0.12 + v * 0.25, out);
      }
    };
    return voice;
  }

  private _pluck(hz: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t);
    o.stop(t + 0.3);
    setTimeout(() => g.disconnect(), 400);
  }

  // ---- Piano walk: every trigger advances a ping-ponging walk up a major scale.
  private _buildPiano(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 2, 4, 5, 7, 9, 11]; // major
    const span = 17; // steps up before turning back down
    const voice: Voice = { out, level: 0, last: 0, step: 0, set: () => {} };
    voice.set = (v, note) => {
      if (!this._due(voice, v, 170, 820)) return;
      let idx: number;
      let root: number;
      if (typeof note === "number") {
        // A note input plays the keyboard directly: the walk pauses and the
        // register stays put so pitch tracks ONLY the note parameter.
        idx = Math.round(clamp01(note) * span);
        root = 48;
      } else {
        const pos = voice.step! % (span * 2);
        idx = pos <= span ? pos : span * 2 - pos; // 0..span..0 ping-pong
        voice.step!++;
        root = 48 + Math.round(v * 5); // value nudges the register
      }
      const deg = scale[idx % scale.length] + 12 * Math.floor(idx / scale.length);
      this._pianoNote(mtof(root + deg), 0.1 + v * 0.28, out);
    };
    return voice;
  }

  private _pianoNote(hz: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = 0;
    // Brightness fades over the note (mimics upper partials decaying first).
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.min(12000, hz * 8), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(600, hz * 2.4), t + 1.1);
    g.connect(lp).connect(dest);
    const decay = 1.6 + gain;
    for (const [mult, amp] of [[1, 1.0], [2, 0.55], [3, 0.3], [4, 0.16], [6, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = mult === 1 ? "triangle" : "sine";
      o.frequency.value = hz * mult * (1 + 0.0007 * mult * mult); // slight inharmonicity
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + decay + 0.2);
    }
    // Hammer thock: a very short band-passed noise transient.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(0.04);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = hz * 3;
    bp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    noise.connect(bp).connect(ng).connect(g);
    ng.gain.setValueAtTime(gain * 0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    noise.start(t);
    noise.stop(t + 0.06);
    // Master envelope: quick hammer attack, long exponential release.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    setTimeout(() => g.disconnect(), (decay + 0.3) * 1000);
  }

  // ---- Shared helpers for the extra voices ------------------------------

  private _noiseBuffer(seconds: number): AudioBuffer {
    const rate = this.ctx!.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx!.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private _loopNoise(dest: AudioNode): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this._noiseBuffer(2);
    src.loop = true;
    src.connect(dest);
    src.start(this.ctx!.currentTime);
    return src;
  }

  /** Soft clipping curve for distortion voices. */
  private _shaper(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /** FM bell "ping": a bright metallic tone with an exponential decay. */
  private _ping(hz: number, gain: number, dest: AudioNode, decay = 1.4, ratio = 2.01): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const car = ctx.createOscillator();
    car.type = "sine";
    car.frequency.value = hz;
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = hz * ratio;
    const modGain = ctx.createGain();
    modGain.gain.value = hz * 3;
    mod.connect(modGain).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.value = 0;
    car.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    car.start(t);
    mod.start(t);
    car.stop(t + decay + 0.1);
    mod.stop(t + decay + 0.1);
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
  private _due(voice: Voice, v: number, minMs: number, maxMs: number): boolean {
    const now = performance.now();
    const prev = voice.prevV ?? 0;
    voice.prevV = v;
    if (v <= 0.02) return false; // silent: don't fire, and don't reset the clock
    const sinceLast = now - voice.last!;
    if (v - prev > 0.1 && sinceLast >= minMs * 0.5) {
      voice.last = now;
      return true;
    }
    const base = maxMs - v * (maxMs - minMs);
    const interval = base * (0.5 + Math.random());
    if (sinceLast >= interval) {
      voice.last = now;
      return true;
    }
    return false;
  }

  // ---- Thunderstorm: rain bed + randomly cracking thunder ----------------
  private _buildThunder(): Voice {
    const ctx = this.ctx!;
    const out = this._out();
    out.gain.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    const rain = ctx.createGain();
    rain.gain.value = 0;
    this._loopNoise(hp);
    hp.connect(lp).connect(rain).connect(out);

    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      const target = v > 0.01 ? 0.04 + v * 0.28 : 0;
      voice.level += (target - voice.level) * 0.08;
      rain.gain.value = voice.level;
      lp.frequency.value = 1200 + v * 4500;
      const now = performance.now();
      if (v > 0.04 && now - voice.last! > 450) {
        if (Math.random() < 0.0015 + v * 0.02) {
          voice.last = now;
          this._thunderBoom(out, 0.35 + v * 0.6);
        }
      }
    };
    return voice;
  }

  private _thunderBoom(dest: AudioNode, level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2.6);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(80, t + 2.2);
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.04);
    g.gain.exponentialRampToValueAtTime(level * 0.4, t + 0.5);
    g.gain.linearRampToValueAtTime(level * 0.85, t + 0.85); // second rumble swell
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    src.start(t);
    src.stop(t + 2.6);
    setTimeout(() => g.disconnect(), 2800);
  }

  // ---- Lightning strike: crackle + snap + boom + rolling tail ------------
  private _buildLightning(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 340, 2600)) this._lightningStrike(out, v);
    };
    return voice;
  }

  private _lightningStrike(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const level = 0.4 + v * 0.7;

    // 1) Bright crackle: several rapid highpassed noise spikes (the flicker).
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2400;
    const crackGain = ctx.createGain();
    crackGain.gain.value = 0;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(0.7);
    noise.connect(hp).connect(crackGain).connect(dest);
    noise.start(t);
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
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(3400 + Math.random() * 2600, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.28);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._shaper(22);
    const og = ctx.createGain();
    og.gain.value = 0;
    o.connect(shaper).connect(og).connect(dest);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(level * 0.6, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.start(t);
    o.stop(t + 0.36);

    // 3) THUNDER BOOM: a deep sub-bass impact just after the flash.
    const bt = t + 0.06 + Math.random() * 0.12;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(72, bt);
    sub.frequency.exponentialRampToValueAtTime(28, bt + 0.9);
    const subG = ctx.createGain();
    subG.gain.value = 0;
    sub.connect(subG).connect(dest);
    subG.gain.setValueAtTime(0.0001, bt);
    subG.gain.linearRampToValueAtTime(level * 1.1, bt + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.0001, bt + 1.1);
    sub.start(bt);
    sub.stop(bt + 1.2);

    // Boom body: distorted low noise burst for the concussive "crack".
    const boom = ctx.createBufferSource();
    boom.buffer = this._noiseBuffer(1.2);
    const blp = ctx.createBiquadFilter();
    blp.type = "lowpass";
    blp.Q.value = 2.5;
    blp.frequency.setValueAtTime(900, bt);
    blp.frequency.exponentialRampToValueAtTime(90, bt + 0.7);
    const bsh = ctx.createWaveShaper();
    bsh.curve = this._shaper(6);
    const boomG = ctx.createGain();
    boomG.gain.value = 0;
    boom.connect(blp).connect(bsh).connect(boomG).connect(dest);
    boomG.gain.setValueAtTime(0.0001, bt);
    boomG.gain.linearRampToValueAtTime(level * 0.85, bt + 0.03);
    boomG.gain.exponentialRampToValueAtTime(0.0001, bt + 1.0);
    boom.start(bt);
    boom.stop(bt + 1.2);

    // 4) Rolling thunder tail: lowpassed noise sweeping down, second swell.
    const rt = bt + 0.35 + Math.random() * 0.25;
    const rumble = ctx.createBufferSource();
    rumble.buffer = this._noiseBuffer(2.8);
    const rlp = ctx.createBiquadFilter();
    rlp.type = "lowpass";
    rlp.Q.value = 1.2;
    rlp.frequency.setValueAtTime(380, rt);
    rlp.frequency.exponentialRampToValueAtTime(55, rt + 2.2);
    const rg = ctx.createGain();
    rg.gain.value = 0;
    rumble.connect(rlp).connect(rg).connect(dest);
    rg.gain.setValueAtTime(0, rt);
    rg.gain.linearRampToValueAtTime(level * 0.6, rt + 0.08);
    rg.gain.exponentialRampToValueAtTime(level * 0.25, rt + 0.7);
    rg.gain.linearRampToValueAtTime(level * 0.42, rt + 1.1);
    rg.gain.exponentialRampToValueAtTime(0.0001, rt + 2.3);
    rumble.start(rt);
    rumble.stop(rt + 2.5);

    setTimeout(() => {
      crackGain.disconnect();
      og.disconnect();
      subG.disconnect();
      boomG.disconnect();
      rg.disconnect();
    }, 3600);
  }

  // ---- Thunderclap: one sharp CLOSE crack-boom per trigger ----------------
  private _buildThunderclap(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 320, 2400)) this._thunderclap(out, v);
    };
    return voice;
  }

  private _thunderclap(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const level = 0.55 + v * 0.8;

    // 1) The rip/crack: bright distorted noise transient with a razor attack.
    const crack = ctx.createBufferSource();
    crack.buffer = this._noiseBuffer(0.5);
    const chp = ctx.createBiquadFilter();
    chp.type = "highpass";
    chp.frequency.value = 750;
    chp.frequency.exponentialRampToValueAtTime(220, t + 0.18);
    const csh = ctx.createWaveShaper();
    csh.curve = this._shaper(10);
    const crackG = ctx.createGain();
    crackG.gain.value = 0;
    crack.connect(chp).connect(csh).connect(crackG).connect(dest);
    crackG.gain.setValueAtTime(0.0001, t);
    crackG.gain.linearRampToValueAtTime(level * 1.2, t + 0.004); // instant snap
    crackG.gain.exponentialRampToValueAtTime(level * 0.3, t + 0.09);
    crackG.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    crack.start(t);
    crack.stop(t + 0.5);

    // 2) Concussive boom body: low distorted noise, arrives immediately (close).
    const boom = ctx.createBufferSource();
    boom.buffer = this._noiseBuffer(1.4);
    const blp = ctx.createBiquadFilter();
    blp.type = "lowpass";
    blp.Q.value = 3;
    blp.frequency.setValueAtTime(700, t);
    blp.frequency.exponentialRampToValueAtTime(70, t + 0.9);
    const bsh = ctx.createWaveShaper();
    bsh.curve = this._shaper(7);
    const boomG = ctx.createGain();
    boomG.gain.value = 0;
    boom.connect(blp).connect(bsh).connect(boomG).connect(dest);
    boomG.gain.setValueAtTime(0.0001, t);
    boomG.gain.linearRampToValueAtTime(level, t + 0.02);
    boomG.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    boom.start(t);
    boom.stop(t + 1.4);

    // 3) Sub thump: the chest-hitting low end of a nearby clap.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(84, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.55);
    const subG = ctx.createGain();
    subG.gain.value = 0;
    sub.connect(subG).connect(dest);
    subG.gain.setValueAtTime(0.0001, t);
    subG.gain.linearRampToValueAtTime(level * 1.15, t + 0.015);
    subG.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    sub.start(t);
    sub.stop(t + 0.9);

    setTimeout(() => {
      crackG.disconnect();
      boomG.disconnect();
      subG.disconnect();
    }, 1800);
  }

  // ---- Rainfall (gentle): heavy roar + sizzle wash + slow gusting ---------
  private _buildRain(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    out.gain.value = 1;

    const roarHp = ctx.createBiquadFilter();
    roarHp.type = "highpass";
    roarHp.frequency.value = 110;
    const roarLp = ctx.createBiquadFilter();
    roarLp.type = "lowpass";
    roarLp.frequency.value = 900;
    roarLp.Q.value = 0.5;
    const roarG = ctx.createGain();
    roarG.gain.value = 0;
    this._loopNoise(roarHp);
    roarHp.connect(roarLp).connect(roarG).connect(out);

    const sizBp = ctx.createBiquadFilter();
    sizBp.type = "bandpass";
    sizBp.frequency.value = 1400;
    sizBp.Q.value = 0.35;
    const sizG = ctx.createGain();
    sizG.gain.value = 0;
    this._loopNoise(sizBp);
    sizBp.connect(sizG).connect(out);

    const gust = ctx.createOscillator();
    gust.type = "sine";
    gust.frequency.value = 0.16;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 0;
    gust.connect(gustDepth).connect(roarG.gain);
    gust.start(t);

    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      const target = v > 0.01 ? 0.12 + v * 0.58 : 0; // loud when driven
      voice.level += (target - voice.level) * (target > voice.level ? 0.12 : 0.06);
      roarG.gain.value = voice.level;
      sizG.gain.value = voice.level * 0.42; // sizzle sits under the roar
      roarLp.frequency.value = 650 + v * 950;
      sizBp.frequency.value = 1200 + v * 900;
      gustDepth.gain.value = voice.level * 0.33; // gust swing scales with level
    };
    return voice;
  }

  // ---- Ghost choir (vowel formants) --------------------------------------
  private _buildChoir(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const src = ctx.createGain();
    src.gain.value = 0.4;
    for (const [midi, det] of [[50, -7], [50, 7], [57, 0]]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = mtof(midi);
      o.detune.value = det;
      o.connect(src);
      o.start(t);
    }
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 4.5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 5;
    vib.connect(vibDepth);
    vib.start(t);
    // Three vowel formant bandpasses summed.
    for (const [f, q, g] of [[750, 8, 1], [1150, 9, 0.7], [2900, 11, 0.4]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = g;
      src.connect(bp).connect(fg).connect(out);
    }
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.03 + v * 0.22 : 0, 0.05, 0.03);
      vibDepth.gain.value = 3 + v * 9;
    };
    return voice;
  }

  // ---- Drone organ (additive drawbars) ------------------------------------
  private _buildOrgan(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const mix = ctx.createGain();
    mix.gain.value = 0.18;
    const base = mtof(45);
    for (const [mult, g] of [[1, 1], [2, 0.6], [3, 0.5], [4, 0.3], [6, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = base * mult;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(mix);
      o.start(t);
    }
    mix.connect(out);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.03 + v * 0.22 : 0, 0.12, 0.06);
    };
    return voice;
  }

  // ---- Shimmer bells (random FM bells) ------------------------------------
  private _buildBells(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 2, 4, 7, 9, 12, 16];
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v, note) => {
      if (this._due(voice, v, 90, 700)) {
        const deg =
          typeof note === "number"
            ? scaleDeg(scale, note)
            : scale[Math.floor(Math.random() * scale.length)] + 12 * Math.floor(Math.random() * 2);
        this._ping(mtof(72 + deg), 0.06 + v * 0.12, out, 1.2 + v * 1.8, 1.41);
      }
    };
    return voice;
  }

  // ---- Acid 303 (resonant saw arp with filter env) ------------------------
  private _buildAcid(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 3, 5, 6, 7, 10];
    const voice: Voice = { out, level: 0, last: 0, phase: 0, set: () => {} };
    voice.set = (v, note) => {
      const now = performance.now();
      if (v <= 0.02) {
        voice.last = now;
        return;
      }
      const interval = 240 - v * 175;
      if (now - voice.last! >= interval) {
        voice.last = now;
        const deg =
          typeof note === "number"
            ? scaleDeg(scale, note)
            : scale[voice.phase! % scale.length] + 12 * (voice.phase! % 3 === 0 ? 1 : 0);
        voice.phase!++;
        this._acidNote(mtof(40 + deg), 0.18 + v * 0.22, out, v);
      }
    };
    return voice;
  }

  private _acidNote(hz: number, gain: number, dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = hz;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 12 + v * 12;
    lp.frequency.setValueAtTime(hz * 2, t);
    lp.frequency.exponentialRampToValueAtTime(hz * (6 + v * 16), t + 0.04);
    lp.frequency.exponentialRampToValueAtTime(hz * 1.5, t + 0.22);
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(lp).connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.start(t);
    o.stop(t + 0.3);
    setTimeout(() => g.disconnect(), 400);
  }

  // ---- Wobble bass (LFO-swept resonant lowpass) ----------------------------
  private _buildWobble(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    lp.Q.value = 12;
    const mix = ctx.createGain();
    mix.gain.value = 0.25;
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = mtof(31);
      o.detune.value = det;
      o.connect(mix);
      o.start(t);
    }
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = mtof(31) / 2;
    sub.connect(mix);
    sub.start(t);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 3;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 600;
    lfo.connect(lfoDepth).connect(lp.frequency);
    lfo.start(t);
    mix.connect(lp).connect(out);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.05 + v * 0.5 : 0, 0.3, 0.08);
      lfo.frequency.value = 1 + v * 11; // wobble speed
      lp.frequency.value = 250 + v * 500;
      lfoDepth.gain.value = 300 + v * 900;
    };
    return voice;
  }

  // ---- Monster growl (distorted formant) -----------------------------------
  private _buildGrowl(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = mtof(28);
    const growlLfo = ctx.createOscillator();
    growlLfo.type = "square";
    growlLfo.frequency.value = 30;
    const growlDepth = ctx.createGain();
    growlDepth.gain.value = 20;
    growlLfo.connect(growlDepth).connect(o.detune);
    growlLfo.start(t);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._shaper(18);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 4;
    o.connect(shaper).connect(bp).connect(out);
    o.start(t);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.03 + v * 0.3 : 0, 0.25, 0.1);
      growlLfo.frequency.value = 18 + v * 60;
      bp.frequency.value = 300 + v * 1400;
    };
    return voice;
  }

  // ---- Siren ---------------------------------------------------------------
  private _buildSiren(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = 600;
    const lfo = ctx.createOscillator();
    lfo.type = "triangle";
    lfo.frequency.value = 0.4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 300;
    lfo.connect(lfoDepth).connect(o.frequency);
    lfo.start(t);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2500;
    o.connect(lp).connect(out);
    o.start(t);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.16 : 0, 0.2, 0.1);
      lfo.frequency.value = 0.2 + v * 4;
      o.frequency.value = 500 + v * 500;
    };
    return voice;
  }

  // ---- Laser zaps (random descending blips) --------------------------------
  private _buildLaser(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 60, 500)) this._zap(out, v);
    };
    return voice;
  }

  private _zap(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "square";
    const top = 1200 + Math.random() * 2600;
    o.frequency.setValueAtTime(top, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.18);
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.08 + v * 0.14, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.start(t);
    o.stop(t + 0.22);
    setTimeout(() => g.disconnect(), 300);
  }

  // ---- Water bubbles (random pitched bloops) --------------------------------
  private _buildBubbles(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 70, 500)) this._bloop(out, v);
    };
    return voice;
  }

  private _bloop(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    const base = 200 + Math.random() * 700;
    o.frequency.setValueAtTime(base, t);
    o.frequency.exponentialRampToValueAtTime(base * (2 + Math.random() * 2), t + 0.09);
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 + v * 0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.start(t);
    o.stop(t + 0.16);
    setTimeout(() => g.disconnect(), 250);
  }

  // ---- Whale song (slow gliding low sine + harmonic) -------------------------
  private _buildWhale(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 120;
    const h = ctx.createOscillator();
    h.type = "sine";
    h.frequency.value = 240;
    const hg = ctx.createGain();
    hg.gain.value = 0.35;
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 1.2;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 8;
    vib.connect(vibDepth);
    vibDepth.connect(o.detune);
    vibDepth.connect(h.detune);
    vib.start(t);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    o.connect(lp);
    h.connect(hg).connect(lp);
    lp.connect(out);
    o.start(t);
    h.start(t);
    const voice: Voice = { out, level: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.05 + v * 0.28 : 0, 0.04, 0.03); // slow, mournful
      const hz = 80 * Math.pow(2, v * 1.6); // ~80Hz -> ~240Hz
      o.frequency.value = hz;
      h.frequency.value = hz * 2;
      vib.frequency.value = 0.6 + v * 2;
    };
    return voice;
  }

  // ---- Crickets (random high chirp bursts) -----------------------------------
  private _buildCrickets(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 120, 900)) this._chirp(out, v);
    };
    return voice;
  }

  private _chirp(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 4200 + Math.random() * 1500;
    // Tremolo must MULTIPLY the enveloped signal (its own 0..1 gain stage),
    // not sum into g.gain: the ±0.5 LFO summed onto a ≤0.11 envelope swung
    // the gain between ≈−0.44 and +0.56 — ~5-10× louder than every other
    // one-shot, phase-inverting instead of gating, envelope inaudible.
    const trem = ctx.createOscillator();
    trem.type = "square";
    trem.frequency.value = 45;
    const tremG = ctx.createGain();
    tremG.gain.value = 0.5; // ±1 square × 0.5 + 0.5 base → gates 0..1
    const tremStage = ctx.createGain();
    tremStage.gain.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 5000;
    bp.Q.value = 6;
    trem.connect(tremG).connect(tremStage.gain);
    trem.start(t);
    o.connect(bp).connect(g).connect(tremStage).connect(dest);
    o.start(t);
    const dur = 0.12 + Math.random() * 0.14;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + v * 0.06, t + 0.02);
    g.gain.setValueAtTime(0.05 + v * 0.06, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.stop(t + dur + 0.02);
    trem.stop(t + dur + 0.02);
    setTimeout(() => {
      g.disconnect();
      tremStage.disconnect();
    }, (dur + 0.1) * 1000);
  }

  // ---- UFO warble (random FM sci-fi) -------------------------------------------
  private _buildUfo(): Voice {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this._out();
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 500;
    const fm = ctx.createOscillator();
    fm.type = "sine";
    fm.frequency.value = 7;
    const fmDepth = ctx.createGain();
    fmDepth.gain.value = 200;
    fm.connect(fmDepth).connect(o.frequency);
    fm.start(t);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    o.connect(lp).connect(out);
    o.start(t);
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      this._glide(voice, v > 0.01 ? 0.02 + v * 0.16 : 0, 0.2, 0.1);
      fm.frequency.value = 3 + v * 18;
      fmDepth.gain.value = 80 + v * 500;
      const now = performance.now();
      if (now - voice.last! > 900 + Math.random() * 1200) {
        // occasional pitch jumps
        voice.last = now;
        o.frequency.setTargetAtTime(300 + Math.random() * 900, this.ctx!.currentTime, 0.08);
      }
    };
    return voice;
  }

  // ---- Gamelan (inharmonic metallic arp) -----------------------------------------
  private _buildGamelan(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const scale = [0, 2, 5, 7, 9]; // slendro-ish
    const voice: Voice = { out, level: 0, last: 0, phase: 0, set: () => {} };
    voice.set = (v, note) => {
      const now = performance.now();
      if (v <= 0.02) {
        voice.last = now;
        return;
      }
      const interval = 360 - v * 250;
      if (now - voice.last! >= interval) {
        voice.last = now;
        const deg =
          typeof note === "number" ? scaleDeg(scale, note) : scale[voice.phase! % scale.length] + 12 * (voice.phase! % 2);
        voice.phase!++;
        this._ping(mtof(60 + deg), 0.08 + v * 0.12, out, 0.9 + v * 1.2, 3.47); // inharmonic ratio
      }
    };
    return voice;
  }

  // ---- Geiger clicks (random impulse ticks) ----------------------------------------
  private _buildGeiger(): Voice {
    const out = this._out();
    out.gain.value = 1;
    const voice: Voice = { out, level: 0, last: 0, set: () => {} };
    voice.set = (v) => {
      if (this._due(voice, v, 25, 700)) this._tick(out, v);
    };
    return voice;
  }

  private _tick(dest: AudioNode, v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(g).connect(dest);
    g.gain.setValueAtTime(0.12 + v * 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.start(t);
    src.stop(t + 0.04);
    setTimeout(() => g.disconnect(), 120);
  }

  private _makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx!.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx!.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** motion: 0..1 sweeps the master low-pass (affects the tap chimes' brightness). */
  setMotion(motion: number): void {
    if (!this.enabled || !this.filter) return;
    const cutoff = 500 + Math.pow(clamp01(motion), 1.5) * 9000;
    this.filter.frequency.setTargetAtTime(cutoff, this.ctx!.currentTime, 0.05);
  }

  /** Tap-triggered pentatonic mallet. velocity: 0..127, pitchPos: 0..1. */
  hit(velocity: number, pitchPos: number): void {
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
    out.connect(this.filter!);

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.9;
    oscGain.connect(out);
    for (const [type, det, g] of [["sine", 0, 0.7], ["triangle", 6, 0.35]] as const) {
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
