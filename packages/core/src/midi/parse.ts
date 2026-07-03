/** Raw MIDI bytes as delivered by Web MIDI / the BLE decoder. */
export type MidiBytes = ArrayLike<number>;

export type MidiEvent =
  | { kind: "noteOn"; channel: number; note: number; velocity: number }
  | { kind: "noteOff"; channel: number; note: number; velocity: number }
  | { kind: "controlChange"; channel: number; controller: number; value: number }
  | { kind: "pitchBend"; channel: number; value: number } // -8192..8191
  | { kind: "realtime"; status: number }
  | { kind: "other"; status: number; data: number[] };

/**
 * Decode one MIDI message into a typed event. Mirrors the subset the ODD Ball
 * emits; anything unrecognized comes back as `other` so callers can log it.
 * A note-on with velocity 0 is normalized to a note-off, per the MIDI spec.
 */
export function parseMidiMessage(data: MidiBytes): MidiEvent {
  const status = data[0] ?? 0;
  if (status >= 0xf8) return { kind: "realtime", status };
  const type = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;
  if (type === 0x90 && d2 > 0) return { kind: "noteOn", channel, note: d1, velocity: d2 };
  if (type === 0x80 || (type === 0x90 && d2 === 0)) return { kind: "noteOff", channel, note: d1, velocity: d2 };
  if (type === 0xb0) return { kind: "controlChange", channel, controller: d1, value: d2 };
  if (type === 0xe0) return { kind: "pitchBend", channel, value: ((d2 << 7) | d1) - 8192 };
  return { kind: "other", status, data: Array.from({ length: Math.max(0, data.length - 1) }, (_, i) => data[i + 1]) };
}
