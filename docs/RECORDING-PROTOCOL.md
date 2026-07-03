# ODD Ball — gesture recording protocol

A scripted set of recordings that characterizes how the ball encodes
orientation on CC3–5 and gathers the material needed to build orientation-neutral
gesture matching. (An early Euler-wrap suspicion was **disproven** by the
A-series — the mapping is smooth and sinusoidal; see "What the A-series
established" below.) Each test below is one recording file. The analysis these
feed: per-axis angle mapping, the CC3/CC4/CC5 geometry, yaw observability, any
mapping degeneracy, noise floor, and same-move/different-grip pairs for
validating invariant features.

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

## What the A-series established (read before Part B)

The A1–A5 recordings (analyzed 2026-07-03) settled several things, and Part B is
retargeted around them:

- **The orientation encoding is smooth/sinusoidal — no Euler wrap.** The earlier
  "wrapping" suspicion did *not* hold up. Across A1/A2/A3 the largest single-step
  change in any orientation CC is only ~0.10–0.16 (≈13–20 CC units) and there are
  **zero** hard 0↔1 jumps; both edges of every CC5 bump ramp smoothly. What looks
  like a snap is a smooth rise-and-fall that simply bottoms out clamped at 0.
- **CC3 and CC4 are complementary (redundant).** In a pitch turn `corr(CC3,CC4) =
  −0.99` and `CC3 + CC4 ≈ 0.99` (constant) — CC4 ≈ 1 − CC3. They carry one shared
  sinusoid, not two independent axes. **CC5** is a rectified bump that peaks
  (≈1.0) exactly when CC3=CC4=0.5. Consistent with direction-vector / quaternion-
  style components, not three independent Euler angles.
- **Yaw is unobservable.** A full spin about vertical with the logo up (A4) moved
  no CC (CC3 span 0.08, CC4 0.10, CC5 0.00) and barely registered as motion at
  all (energy peaked 0.07). Heading is simply not encoded.
- **The event channels are completely untested.** CC0 (Shake), CC1 (Twist),
  CC2 (Freefall), CC6 (Movement) all sat at the noise floor (≤ 1–3 LSB) through
  all of Part A, because Part A is deliberately smooth and slow. We have **no**
  evidence they respond to anything yet — notably CC1 stayed dead even through
  the A4 yaw spin, so Twist is *not* raw yaw. Part B now characterizes them.
- **`roll_speed` reads 0** for slow moves by design (it's gated); use `roll_rate`
  as the ungated rate. Not a bug — don't chase it.

## Part B — transfer-function, singularity, and event-channel probes

Goal: now that we know the encoding is smooth (no wrap), pin down the actual
CC-vs-angle transfer function and the CC3/CC4/CC5 geometry, check for any pose
where the mapping degenerates, and — new — establish what drives the event
channels.

### B-orientation (transfer function + degeneracy)

| ID | Recording | Details |
| --- | --- | --- |
| B1 | Slow calibrated sweep | **Motion:** from HOME, rotate the ball through one full, continuous 360° about a single axis at a slow, *constant* rate — aim for **~15 s per turn** — then hold still 3 s and do a second identical turn. Don't pause or change speed mid-turn. Record each axis separately: for `B1-pitch.json` tip the logo away from you and keep going up-and-over until it returns; for `B1-roll.json` tip the logo to your right and keep going all the way around. **Why:** clean, evenly-sampled turns to fit the CC-vs-angle curve (sine? clamped? linear near center?) and confirm CC4 ≈ 1 − CC3 holds the whole way round. (This is the slow version of A1/A3, whose ~4–7 s turns were too fast to fit.) |
| B2 | Degeneracy / pole probe | **Motion:** from HOME, do a slow full 360° pitch turn (tip the logo away from you and continue up-and-over) and, *at the same time*, continuously rock the ball a little left and right (a small roll wobble) as you go. Two full turns. **Why:** since CC3/CC4 are redundant, watch for any pose where the wobble stops moving the CCs (the mapping flattens / loses a degree of freedom) or where CC5 pins at 0 or 1 — note that pose. |
| B3 | Fast spins | **Motion:** three vigorous ~1–2 s spins, one per axis, holding still 3 s between each: a fast pitch flip (logo tumbles away → over → toward you), a fast roll (logo tumbles left → right), and a fast yaw (spin about vertical, logo staying up). **Also capture `listen.py --raw`** (see settings). **Why:** measures aliasing and the ball's true message rate (the session recorder logged only ~15 Hz) and whether fast motion ever produces a real discontinuity the slow sweeps didn't. |

### B-event (do these deliberately — nothing in Part A moved them)

Sound **OFF**, port selected directly, as usual. Each is one recording: 2 s
still, then **5 distinct repetitions** of the action with ≥ 2 s still between
reps, then 2 s still. Watch the on-screen meters while recording and note which
CC (if any) lights up — the goal is to learn the trigger, so a "nothing moved"
result is itself a valid, useful outcome to record.

| ID | Recording | Details |
| --- | --- | --- |
| B4 | Shake → CC0 | 5 sharp back-and-forth shakes (the motion you'd use to "shake awake"). Characterizes CC0 (Shake), which never left 0 in Part A. |
| B5 | Twist → CC1 | 5 deliberate quick wrist *twists* about the axis the logo points along (a sharp "rev the throttle" snap, not a slow yaw). CC1 stayed dead through a full slow yaw spin, so this probes whether a *fast* twist is its real trigger. |
| B6 | Freefall → CC2 | 5 short drops or gentle toss-and-catch onto a cushion/bed (a few inches is plenty — protect the ball). Characterizes CC2 (Freefall). |
| B7 | Movement → CC6 | 5 reps of picking the ball up and walking a few steps / broad whole-arm sweeps, set down still between. Characterizes CC6 (Movement) vs. plain reorientation. |

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
A1  A2  A3  A4  A5                          [done]
B1-pitch  B1-roll  B2  B3 (+ listen.py raw)   [done] transfer fn / degeneracy
B4  B5  B6  B7                                [done, <5 reps] event channels
C1  C2  C3  C4  C5  C6  C7
D1  D2
```

Twenty-ish short recordings, ~20 minutes of work. Drop the JSON files (and
`B3-raw.txt`) anywhere in the repo or attach them to the PR — the analysis
scripts will take it from there.

Results so far (Series A + B) are written up in [`FINDINGS.md`](FINDINGS.md).
