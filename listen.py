#!/usr/bin/env python3
"""Listen to an ODD Ball (BLE MIDI) and print decoded messages in real time.

Usage:
    python listen.py                # auto-detect the ODD Ball port
    python listen.py --list         # just list available MIDI input ports
    python listen.py --port "ODD 1 Bluetooth"   # force a specific port
    python listen.py --raw          # also print the raw mido message
"""

import argparse
import sys
import time

import mido

# ODD Ball gesture -> MIDI mapping (all on channel 1). Qualitative overview is at
# oddballism.com/pages/midi; the concrete note/CC numbers below come from the
# OmniMusic wiki (dated 2024-12-19) and are documented in docs/MIDI.md. They may
# vary by firmware, so verify with --raw against your own ball.
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Documented gesture behind each note number and CC number.
NOTE_GESTURE = {0: "Tap", 1: "Shake", 2: "Twist"}
CC_GESTURE = {
    0: "Shake",
    1: "Twist",
    2: "Freefall",
    3: "X Orientation",
    4: "Y Orientation",
    5: "Z Orientation",
    6: "Movement",
    7: "!! MIDI Volume - may mute DAWs",
}


def note_name(note: int) -> str:
    return f"{NOTE_NAMES[note % 12]}{note // 12 - 1}"


def pick_port(preferred: str | None) -> str:
    ports = mido.get_input_names()
    if not ports:
        sys.exit("No MIDI input ports found. Is the ODD Ball paired and awake?")
    if preferred:
        for p in ports:
            if preferred.lower() in p.lower():
                return p
        sys.exit(f"No port matching {preferred!r}. Available: {ports}")
    # Auto-detect: prefer anything that looks like the ODD Ball.
    for p in ports:
        if "odd" in p.lower():
            return p
    return ports[0]


def describe(msg: mido.Message) -> str:
    if msg.type == "note_on" and msg.velocity > 0:
        bar = "#" * round(msg.velocity / 127 * 20)
        gesture = NOTE_GESTURE.get(msg.note, "?")
        return (
            f"NOTE ON   {note_name(msg.note):<4} ({msg.note:>3}) vel {msg.velocity:>3} "
            f"|{bar:<20}| {gesture}"
        )
    if msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
        return f"note off  {note_name(msg.note):<4} ({msg.note:>3})"
    if msg.type == "control_change":
        bar = "#" * round(msg.value / 127 * 20)
        gesture = CC_GESTURE.get(msg.control, "?")
        return f"CC        ctrl {msg.control:>3}      val {msg.value:>3} |{bar:<20}| {gesture}"
    if msg.type == "pitchwheel":
        return f"PITCH     {msg.pitch}"
    return str(msg)


def main() -> None:
    parser = argparse.ArgumentParser(description="ODD Ball MIDI listener")
    parser.add_argument("--list", action="store_true", help="list ports and exit")
    parser.add_argument("--port", help="substring of the MIDI input port name to use")
    parser.add_argument("--raw", action="store_true", help="also print raw mido message")
    args = parser.parse_args()

    mido.set_backend("mido.backends.rtmidi")

    if args.list:
        print("MIDI input ports:")
        for p in mido.get_input_names():
            print(f"  - {p}")
        return

    port_name = pick_port(args.port)
    print(f"Listening on: {port_name}")
    print("Bounce, shake, spin or point the ball. Press Ctrl+C to stop.\n")

    count = 0
    start = time.monotonic()
    with mido.open_input(port_name) as inport:
        try:
            for msg in inport:
                if msg.type == "clock":
                    continue
                count += 1
                t = time.monotonic() - start
                line = f"[{t:7.2f}s] {describe(msg)}"
                if args.raw:
                    line += f"   <{msg}>"
                print(line)
        except KeyboardInterrupt:
            print(f"\nStopped. Received {count} messages.")


if __name__ == "__main__":
    main()
