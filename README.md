# play-odd-ball

Receive and inspect MIDI data from an **ODD Ball** — a Bluetooth Low Energy (BLE) MIDI bouncing-ball controller.

## Pairing on macOS (one time)

BLE MIDI devices do **not** appear in System Settings → Bluetooth. Pair through Apple's MIDI tooling instead:

1. Wake the ball (bounce/move it) so its Bluetooth radio is advertising, and make sure it isn't held open by the ODD phone app.
2. Open **Audio MIDI Setup** (`/Applications/Utilities/`).
3. **Window → Show MIDI Studio** (⌘2).
4. Click the **Bluetooth** icon (top-right) and **Connect** the ODD Ball.

Once connected it appears as a MIDI input named something like `ODD 1 Bluetooth`.

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

## Usage

```bash
.venv/bin/python listen.py            # auto-detect the ODD Ball and print decoded messages
.venv/bin/python listen.py --list     # list available MIDI input ports
.venv/bin/python listen.py --raw      # also show the raw mido message
.venv/bin/python listen.py --port "ODD 1 Bluetooth"   # force a specific port
```

Then bounce, shake, spin or point the ball and watch the messages stream in.

## Gesture → MIDI mapping

Per the [ODD MIDI docs](https://oddballism.com/en-us/pages/midi):

| Gesture | Sends |
| --- | --- |
| Tap / bounce | Note |
| Shake | Note + CC |
| Spin | Note + CC |
| Air (in the air) | CC |
| Point (logo up/down) | CC (like a knob) |
