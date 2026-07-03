# ODD Ball — gesture recording protocol

A scripted set of recordings that characterizes how the ball encodes
orientation on CC3–5 (Euler wrapping has been observed) and gathers the
material needed to build orientation-neutral gesture matching. Each test below
is one recording file. The analysis these feed: per-axis angle mapping and wrap
points, yaw observability, gimbal-seam location, noise floor, and
same-move/different-grip pairs for validating invariant features.

## Recording settings

- **Tool:** the web app's **⏺ Record** button (session recorder). One
  recording per test. Rename each downloaded file to the test ID, e.g.
  `A1-pitch-away.json`.
- **Port:** select the ball's port directly in the dropdown — not
  *All inputs* — so nothing else contributes.
- **Sound: OFF.** No moves armed (don't touch *✋ Record move*), no patch
  needed. Close the ODD phone app entirely — it must not hold the ball's
  connection.
- **Extra raw capture for the fast tests (B3 only):** the session recorder
  samples at ~20 Hz, which aliases fast spins. For B3 also capture full-rate
  raw output:

  ```bash
  .venv/bin/python listen.py --raw | tee B3-spin.txt
  ```

  On macOS both can listen at once if the ball is paired through Audio MIDI
  Setup. If you paired via the web-Bluetooth button instead, the browser owns
  the connection — run the B3 `listen.py` captures as a separate pass.
- **Every recording:** wake the ball first and wait until the msg/s counter is
  steady. Start with **2 s of stillness**, end with **2 s of stillness**.
  Between repetitions inside one recording, hold still **≥ 2 s** (the importer
  splits reps on stillness).
- Move smoothly from the wrist/elbow; don't bounce or tap mid-test.

## Reference frame — logo orientation

All instructions use this **HOME pose**. Sit facing your desk and hold the
ball in front of you:

- **Logo faces the ceiling** (logo up).
- **Text upright from your point of view**: the top of the "ODD" text points
  **away from you**.

Axis names used below (your frame, not the ball's):

- **PITCH** — tipping the logo **away from / toward you** (rotation about the
  left–right axis).
- **ROLL** — tipping the logo **left / right** (rotation about the axis
  pointing from you to the screen).
- **YAW / TWIST** — spinning about the **vertical** axis while the logo stays
  up (the text heading changes, the logo keeps facing the ceiling).

If a test says "logo toward you", the logo faces your chest; "logo down"
faces the floor, and so on.

## Part A — axis characterization (slow, one axis at a time)

Goal: which CC tracks which axis, its sign, its range, and where it wraps.
Each rotation should take **10–15 s** for a full turn — slow and continuous.

| ID | Recording | Details |
| --- | --- | --- |
| A1 | Full PITCH turn, away | From HOME, rotate the ball continuously away from you through a full 360° (logo up → away → down → toward you → up). Two full turns in one recording, 3 s still between them. |
| A2 | Full PITCH turn, toward | Same as A1 but rotating toward you. Two turns. |
| A3 | Full ROLL turn, right then left | From HOME, tip continuously to your right through 360°, pause 3 s, then 360° to the left. |
| A4 | Full YAW spin, both ways | Keep the logo flat up the whole time; spin about vertical 360° clockwise (viewed from above), pause 3 s, then 360° counter-clockwise. **This is the yaw-observability test** — note whether *any* CC moves. |
| A5 | Cardinal holds | One recording stepping through six poses, holding each **dead still for 4 s**, in this order: logo up → logo away → logo down → logo toward you → logo left → logo right. Move briskly between holds. |

## Part B — wrap and singularity probes

Goal: wrap glitch size and whether channels jump together (Euler gimbal seam).

| ID | Recording | Details |
| --- | --- | --- |
| B1 | Wrap dither | From A1/A3, identify the pose where a CC jumps 127→0 (or 0→127). Hold at that pose and rock gently ±10° across the seam, about once per second, for 10 s. If pitch and roll wrap at different poses, record one dither per seam (`B1-pitch.json`, `B1-roll.json`). |
| B2 | Pole crossing with twist | Slow full pitch turn (as A1) while continuously adding a gentle back-and-forth twist. Watch for a pose where the *other* channels swing violently as you pass through it — that's the gimbal seam. Two turns. |
| B3 | Fast spins | Three vigorous 1–2 s spins, one per axis (pitch, roll, yaw), 3 s still between each. **Capture with `listen.py --raw` too** (see settings). This measures aliasing and the ball's real message rate. |

## Part C — same move, different orientation (invariance material)

Goal: matched sets for building/validating orientation-neutral matching. The
**reference move** is: *from the starting pose, tip the ball 90° away from you
and smoothly return, about 1 second total.* Perform it identically every time —
only the grip/facing changes. **5 reps per recording**, ≥ 2 s still between reps.

| ID | Recording | Setup |
| --- | --- | --- |
| C1 | Reference move, HOME grip | Logo up, text away (HOME). |
| C2 | Reference move, twisted grip | Ball rotated 90° in your hand: **logo faces you**, then perform the identical physical move. |
| C3 | Reference move, logo down | Ball flipped: logo faces the floor. |
| C4 | Reference move, you rotated | HOME grip, but **you turn 90° to your left** and perform the move facing that wall. (Distinguishes grip changes from facing changes.) |
| C5 | Mirror move | HOME grip, but tip 90° **toward you** and back — the mirror image of the reference. Must **not** match C1 later. |
| C6 | Rotated-copy move | HOME grip, tip 90° **to your left** and back. This is the classic collision pair with C1 for invariant matching — recorded so the tiebreaker can be tested. |
| C7 | Signature curve, two grips | A lazy figure-8 traced with the logo (~2 s per rep): 5 reps in HOME grip, pause 5 s, then 5 reps with the logo facing you. High-curvature material for the curvature/torsion features. |

## Part D — noise floor

| ID | Recording | Details |
| --- | --- | --- |
| D1 | Resting | Wake the ball with one gentle tap, set it on a folded towel, hands off, record 30 s. |
| D2 | Held still | Hold the ball as still as you can in HOME pose for 15 s. |

## Checklist

```
A1  A2  A3  A4  A5
B1(-pitch, -roll as needed)  B2  B3 (+ listen.py raw)
C1  C2  C3  C4  C5  C6  C7
D1  D2
```

Sixteen-ish short recordings, ~15 minutes of work. Drop the JSON files (and
`B3-spin.txt`) anywhere in the repo or attach them to the PR — the analysis
scripts will take it from there.
