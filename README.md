# play-odd-ball

Receive and inspect MIDI data from an **ODD Ball** — a Bluetooth Low Energy (BLE) MIDI bouncing-ball controller.

## Pairing on macOS (one time)

BLE MIDI devices do **not** appear in System Settings → Bluetooth. Pair through Apple's MIDI tooling instead:

1. Wake the ball (bounce/move it) so its Bluetooth radio is advertising, and make sure it isn't held open by the ODD phone app.
2. Open **Audio MIDI Setup** (`/Applications/Utilities/`).
3. **Window → Show MIDI Studio** (⌘2).
4. Click the **Bluetooth** icon (top-right) and **Connect** the ODD Ball.

Once connected it appears as a MIDI input named something like `ODD 1 Bluetooth`.

### Skip the pairing dance in the web visualizer

The web app is deployed at **<https://kumavis.github.io/play-odd-ball/>**
(published from `web/` by GitHub Actions on every push to `main`).

The web app in [`web/`](web/) can pair a ball directly over Web Bluetooth — no
Audio MIDI Setup required. Open the page in Chrome or Edge (over HTTPS or
`localhost`), click **🔵 Connect ball**, and pick your ODD Ball from the browser
chooser. It streams straight into the visualizer. Balls already paired through
Audio MIDI Setup still show up in the port dropdown as before.

## Setup

Requires Python **3.10+** (`listen.py` uses modern type syntax).

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

Per the [ODD MIDI docs](https://oddballism.com/en-ww/pages/midi):

| Gesture | Sends |
| --- | --- |
| Tap / bounce | Note |
| Shake | Note + CC |
| Spin | Note + CC |
| Air (in the air) | CC |
| Point (logo up/down) | CC (like a knob) |

The ball also sends concrete note/CC numbers on **channel 1** (Note 0/1/2 =
Tap/Shake/Twist; CC0–2 = Shake/Twist/Freefall; **CC3–5 = X/Y/Z orientation**;
CC6 = Movement). It emits **CC7**, which is MIDI Volume and can mute a DAW — the
web app drops it and `listen.py` flags it in the output. See
[`docs/MIDI.md`](docs/MIDI.md) for the full reference, sources, and how to
verify the mapping against your own ball.
