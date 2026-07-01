# ODD Ball — MIDI reference

The **ODD Ball** is a Bluetooth Low Energy (BLE) MIDI controller. It reports
physical gestures as MIDI **Note** and **Control Change (CC)** messages, all on
**MIDI channel 1**.

## Sources

- **Official ODD MIDI page** — <https://oddballism.com/en-ww/pages/midi>.
  Describes gestures qualitatively (which gesture sends a Note vs. CC) but gives
  no note/CC numbers.
- **OmniMusic wiki** — <https://omnimusic.org.uk/wiki/odd-ball/>.
  The only public source with concrete note/CC numbers (mapping dated
  **2024-12-19**). The wiki explicitly notes the data "may not be accurate."
- **MIDI.org** / **vocode.io** — background only. The ball is a velocity-
  sensitive BLE MIDI controller; the companion app's sound engine is built in
  JUCE/C++.

> ⚠️ The concrete numbers below come from a third-party, undated-firmware source.
> Treat them as a strong default, but **verify empirically** against your own
> ball (see [Verifying the mapping](#verifying-the-mapping)) before relying on
> them. Firmware updates may change the assignments.

## Gesture overview (official)

| Gesture | Sends | Trigger |
| --- | --- | --- |
| Tap / bounce | Note | tapping or bouncing |
| Shake | Note + CC | shaking or moving |
| Spin / twist | Note + CC | twisting or spinning |
| Air | CC | while the ball is airborne |
| Point | CC (like a knob) | point the logo up or down |

## Notes (channel 1)

| Note # | Gesture |
| --- | --- |
| 0 | Tap |
| 1 | Shake |
| 2 | Twist |

Note-offs are sent automatically ~2 seconds after each note-on.

## Control Change (channel 1)

| CC # | Meaning |
| --- | --- |
| 0 | Shake |
| 1 | Twist |
| 2 | Freefall |
| 3 | X Orientation |
| 4 | Y Orientation |
| 5 | Z Orientation |
| 6 | Movement |
| 7 | ⚠️ Undocumented — see warning below |

### ⚠️ CC7 = MIDI Volume

The ball also emits data on **CC7**, which in the MIDI spec is **Channel Volume**
on most synths and DAWs. Left unfiltered this can drive volume to zero and cause
**unexplained silence**. Both tools in this repo ignore CC7:

- `listen.py` flags it in the decoded output.
- The web app (`web/app.js`) drops CC7 before it touches any meter, roll, or
  gesture logic.

If you route the ball into a DAW, filter CC7 there too.

## How this repo maps the CCs

`web/app.js` uses the documented orientation axes to drive the visuals and the
default synth voice:

- **Orientation X / Y / Z → CC3 / CC4 / CC5** — orb tilt/roll and note pitch.
- **Movement → CC6**, **Shake → CC0**, **Twist → CC1**, **Freefall → CC2** —
  available as modulation sources in the patch bay.
- **Roll detection** accumulates change across the orientation axes (CC3–5).

Patch-bay layouts and saved profiles created before this remap are migrated
automatically on load (schema v2): each old modulation source is repointed to
whatever routed the same CC before, so restored patches keep their exact
behaviour.

## Verifying the mapping

The mapping is the one uncertain part, so confirm it against your ball:

```bash
.venv/bin/python listen.py --raw
```

Then exercise one gesture at a time and watch which CC/Note reacts:

1. **Tap** the ball on a surface → expect Note 0.
2. **Shake** it → expect Note 1 and CC0 moving.
3. **Twist / spin** it → expect Note 2 and CC1 moving.
4. **Tilt slowly** on a single axis at a time → find which of CC3/4/5 tracks it.
5. **Drop** it (short freefall) → watch CC2.
6. **Roll / move** it around → watch CC6.

If your ball disagrees with the table above, update the constants in
`web/app.js` (the `PARAMS` block, `ROLL_CHANNELS`, and `updateOrb`) and the
`CC_GESTURE` / `NOTE_GESTURE` tables in `listen.py`.
