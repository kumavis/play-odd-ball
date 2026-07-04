import { BLE_MIDI_SERVICE, BLE_MIDI_CHARACTERISTIC } from "./constants.js";

/**
 * Decode a BLE-MIDI packet into MIDI messages. The packet is a header byte,
 * then one or more (timestamp byte + MIDI message) events; both header and
 * timestamp bytes have bit 7 set, and running status may omit the status byte.
 * See the BLE-MIDI spec (midi.org). Only channel-voice + realtime messages are
 * handled — the ODD Ball doesn't send SysEx.
 */
export function decodeBleMidi(bytes: Uint8Array): number[][] {
  const msgs: number[][] = [];
  if (bytes.length < 3) return msgs; // header + timestamp + at least one byte
  let status = 0;
  let i = 1; // byte 0 is the packet header
  while (i < bytes.length) {
    // A timestamp-low byte (bit 7 set) precedes each event; skip it if present.
    if (bytes[i] & 0x80) i++;
    if (i >= bytes.length) break;
    // System realtime (0xF8–0xFF): a lone status byte with no data.
    if (bytes[i] >= 0xf8) {
      msgs.push([bytes[i++]]);
      continue;
    }
    // Status byte (bit 7 set) starts a new message; otherwise running status.
    if (bytes[i] & 0x80) {
      status = bytes[i];
      i++;
    }
    if (!status || i >= bytes.length) break;
    const type = status & 0xf0;
    if (type === 0xc0 || type === 0xd0) {
      // program change / channel pressure: one data byte
      msgs.push([status, bytes[i++]]);
    } else {
      // note, CC, pitch bend, …: two data bytes
      if (i + 1 >= bytes.length) break;
      msgs.push([status, bytes[i], bytes[i + 1]]);
      i += 2;
    }
  }
  return msgs;
}

export interface BleBall {
  /** Stable id for this pairing ("ble:<device id>"). */
  id: string;
  name: string;
  disconnect(): void;
}

export interface ConnectBleBallOptions {
  /** Called for each decoded MIDI message, tagged with the ball's id/name. */
  onMessage: (data: number[], ball: { id: string; name: string }) => void;
  /** Called when the GATT connection drops (including via disconnect()). */
  onDisconnect?: (ball: { id: string; name: string }) => void;
  /** Extra device-name prefix to include in the chooser (default "ODD"). */
  namePrefix?: string;
  bluetooth?: Bluetooth;
}

export type BleErrorKind = "cancelled" | "blocked" | "unavailable" | "error";

// Re-pairing an already-connected ball hands back the SAME cached device /
// characteristic objects (gatt.connect() on a live session is a no-op), so a
// second connectBleBall would stack a second value listener and every message
// would be delivered twice. Track our listeners per object and replace them.
const charListeners = new WeakMap<object, EventListener>();
const deviceListeners = new WeakMap<object, EventListener>();
const swapListener = (target: EventTarget, event: string, map: WeakMap<object, EventListener>, listener: EventListener) => {
  const prev = map.get(target);
  if (prev) target.removeEventListener(event, prev);
  map.set(target, listener);
  target.addEventListener(event, listener);
};

/** Thrown by connectBleBall with a classification the UI can message on. */
export class BleConnectError extends Error {
  kind: BleErrorKind;
  cause?: unknown;
  constructor(kind: BleErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "BleConnectError";
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Pair an ODD Ball directly over Web Bluetooth and stream its decoded MIDI
 * messages. Must be called from a user gesture (browser requirement).
 *
 * Errors are wrapped in BleConnectError with a `kind`:
 *  - "unavailable": no navigator.bluetooth at all
 *  - "cancelled":   the user dismissed the device chooser
 *  - "blocked":     Web Bluetooth is disabled by policy/flags (e.g. Brave)
 *  - "error":       anything else (pairing/GATT failure)
 */
export async function connectBleBall(opts: ConnectBleBallOptions): Promise<BleBall> {
  const bluetooth = opts.bluetooth ?? (typeof navigator !== "undefined" ? navigator.bluetooth : undefined);
  if (!bluetooth) throw new BleConnectError("unavailable", "Web Bluetooth is not available in this browser");

  let device: BluetoothDevice;
  try {
    device = await bluetooth.requestDevice({
      // Show BLE-MIDI devices, plus anything advertising as an ODD Ball (some
      // balls don't list the MIDI service UUID in their advertisement packet).
      filters: [{ services: [BLE_MIDI_SERVICE] }, { namePrefix: opts.namePrefix ?? "ODD" }],
      optionalServices: [BLE_MIDI_SERVICE],
    });
  } catch (err: any) {
    if (err && err.name === "NotFoundError") throw new BleConnectError("cancelled", "chooser dismissed", err);
    // Brave (and some managed Chrome installs) disable Web Bluetooth entirely,
    // so requestDevice rejects with a SecurityError before any chooser appears.
    const blocked =
      err &&
      (err.name === "SecurityError" ||
        /permission has been blocked|globally disabled|Web Bluetooth API is not allowed/i.test(err.message || ""));
    if (blocked) throw new BleConnectError("blocked", "Web Bluetooth is blocked by the browser", err);
    throw new BleConnectError("error", String(err), err);
  }

  const identity = { id: `ble:${device.id}`, name: device.name || "ODD Ball (BLE)" };
  try {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
    const char = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);
    swapListener(char, "characteristicvaluechanged", charListeners, (ev) => {
      // The characteristic value is a DataView that need not span its whole
      // ArrayBuffer — honor its offset/length or the packet bytes are wrong.
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value!;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (const msg of decodeBleMidi(bytes)) opts.onMessage(msg, identity);
    });
    swapListener(device, "gattserverdisconnected", deviceListeners, () => opts.onDisconnect?.(identity));
    await char.startNotifications();
    return {
      ...identity,
      disconnect: () => {
        try {
          device.gatt?.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  } catch (err) {
    try {
      device.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    throw new BleConnectError("error", String(err), err);
  }
}
