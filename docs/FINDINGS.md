# ODD Ball — CC encoding findings

What the ball actually puts on each MIDI CC, derived from the scripted
recordings in `data/` (Series A–E + noise floor, recorded & analyzed 2026-07-03).
Method and caveats are at the bottom. This supersedes the earlier
"Euler wrapping" assumption in `docs/MIDI.md` / the recording protocol.

All CC values below are normalized 0–1 (raw MIDI 0–127 ÷ 127). The reference
frame ("HOME", pitch/roll/yaw) is defined in `docs/RECORDING-PROTOCOL.md`.

## TL;DR

- **Orientation is smooth and sinusoidal — there is no Euler wrap / seam.** The
  largest single-sample change in any orientation CC is ~0.10–0.16; there are
  zero hard 0↔1 jumps.
- **CC3 and CC5 behave like a quadrature (sin/cos) pair**, so orientation within
  a turn is unambiguous and continuous.
- **CC3/CC4 coupling is axis-dependent** — anti-correlated in pitch, positively
  correlated in roll — so the CC3/CC4 pair does carry 2 DOF (it is *not* purely
  redundant, as an early look suggested).
- **Yaw (heading, logo kept up) is not observable** on any channel.
- **The event channels work, but need fast/sharp motion and cross-talk heavily.**
  CC0 Shake, CC1 Twist, CC2 Freefall, CC6 Movement all sat at zero through the
  slow Series A; Series B triggered them. CC6 in particular is a broadband
  "something is moving" signal, not a clean gesture flag.
- **True message rate ≈ 405 msg/s (~58 full CC frames/s)** — the browser session
  recorder logs only ~15–20 Hz, so it aliases fast motion ~3–4×.
- **Tap is a MIDI Note, not a CC** — note number 0, with velocity encoding
  strength. Shake/Twist also arrive as notes (1/2) in addition to their CCs.
- **The noise floor is tiny** — resting on a surface the CCs are essentially
  frozen (< 0.2 CC-unit stdev); even hand-held the drift is < 1 CC unit.

## Orientation channels (CC3 X, CC4 Y, CC5 Z)

Source: `B1-pitch`, `B1-roll`, `B1-roll2` (slow ~15 s/turn calibration sweeps),
plus Series A.

- **No wrap.** Both edges of every CC5 excursion ramp smoothly; a true Euler wrap
  would show a one-step 0.99→0.00 cliff, which never appears (max single-step Δ
  ≈ 0.10–0.16 ≈ 13–20 CC units).
- **CC3 ⟂ CC5 (quadrature).** CC5 reaches its extremes (≈0 or ≈1) exactly when
  CC3 is at mid-scale (≈0.5), i.e. ~90° out of phase. Together they trace a
  circle through a rotation, which is what makes the angle recoverable without a
  wrap.
- **CC5 is one-sided.** It rides at 0 for roughly half a turn and humps up to ≈1
  for the other half (clamped floor, not a wrap valley).
- **CC3/CC4 coupling depends on the axis:**
  - Pitch (`B1-pitch`): `corr(CC3,CC4) = −0.99`, and `CC3 + CC4 ≈ 0.99`
    (constant) → complementary.
  - Roll (`B1-roll`): `corr(CC3,CC4) = +0.99` (they swing together).
  - So the *sign* of the CC3/CC4 relationship distinguishes pitch from roll.
- Overall this is consistent with **direction-vector / quaternion-style
  components**, not three independent Euler angles.

### Fitted transfer function

Fitting a single-cycle sinusoid to each CC over one full turn (θ = rotation
angle, 0→360°) fits almost perfectly — **R² = 0.96–1.00** — which is the
strongest evidence there is no wrap: a wrap could never fit a smooth sine.
With `cos(θ−90°) = sin θ`:

| CC | Pitch turn | Roll turn |
| --- | --- | --- |
| CC3 | `0.50 + 0.37·sin θ` | `0.50 + 0.33·sin θ` |
| CC4 | `0.50 − 0.34·sin θ` (anti-phase to CC3) | `0.50 + 0.37·sin θ` (in-phase with CC3) |
| CC5 | `0.50 − 0.49·cos θ` | `0.50 − 0.50·cos θ` |

Reading this as a **tilt-magnitude + azimuth** decomposition:

- **CC5 = tilt from vertical.** It is the *same* function for pitch and roll —
  `CC5 ≈ (1 − cos θ_tilt)/2` — so it depends only on *how far* the logo is from
  straight-up, not the direction. It uses the full 0–1 range and is monotonic
  over 0°→180° (0 = logo up, 0.5 = on its side, 1 = inverted). This is why yaw
  (which keeps tilt = 0) moves nothing.
- **CC3 & CC4 = lean azimuth.** They ride at 0.5 and swing ±~0.35 with `sin θ`,
  always ~90° out of phase with CC5. The CC3↔CC4 phase relationship carries the
  *direction* of the lean: anti-phase for a forward/back pitch, in-phase for a
  left/right roll.

**Decoding recipe (per frame):**

- tilt from vertical: `θ_tilt = acos(1 − 2·CC5)` → 0–180°.
- lean direction: `atan2(CC4 − 0.5, CC3 − 0.5)` (azimuth, up to a fixed offset).
- heading/yaw: **not recoverable** (not encoded).

## Yaw / heading

Source: `A4` (full spin about vertical, logo up), `E1` (spin about vertical at
~90° tilt).

- **Upright (A4):** no channel responded — CC3 span 0.08, CC4 0.10, CC5 0.00,
  `energy` peaked 0.07. Heading is not encoded when the logo is up.
- **At 90° tilt (E1):** CC5 held steady at ~0.50 (tilt constant, good) while
  CC3/CC4 barely moved (spans < 0.2, no full azimuth sweep). This is consistent
  with heading being unobservable off-vertical too — **but** `roll_rate` stayed
  ~0.01–0.12 throughout, so the intended plumb-vertical 360° spin may not have
  been cleanly executed. Leaning "not observable," not yet confirmed; E1 is worth
  a redo with a deliberate spin (watch CC5 stay put while heading changes).
- Working conclusion: **heading is not recoverable.** Any yaw-only gesture is
  invisible, and orientation-neutral matching cannot rely on yaw.

## Event channels (CC0, CC1, CC2, CC6)

These are intensity/event signals. They stayed at the noise floor (≤ ~0.02)
through all of slow Series A; Series B exercised them directly. Peak normalized
value observed per recording:

| Channel | Trigger recording | Peak | Also fires on | Verdict |
| --- | --- | --- | --- | --- |
| CC0 Shake | B4 shake | **1.00** | B7 movement (0.46), B2 (0.08) | Full-scale on a sharp shake; partial on any brisk handling. |
| CC1 Twist | B3 fast spins | **1.00** | B5 wrist twist (0.48) | Responds to fast angular rate, *not* a distinct gesture. Dead for slow turns and even a slow yaw spin. |
| CC2 Freefall | B6 drops | **0.22** | B7 movement (0.16) | Only weakly triggered — the test drops were gentle. Needs a cleaner drop test to confirm range. |
| CC6 Movement | B3 / B4 | **1.00** | B5 (0.48), B7 (0.45), B6 (0.28) | Broadband motion-intensity: lights up on essentially any vigorous motion. Not gesture-specific. |

- **Cross-talk is significant.** A shake drives CC0 *and* CC6 to full; a fast
  spin drives CC1 and CC6; general movement nudges CC0/CC2/CC6 together. The
  event channels are not cleanly isolated per gesture.
- **CC1 Twist is real** — the earlier "dead CC1" was just because slow Series A
  never produced fast rotation. It is best understood as a fast-rotation-rate
  signal, and it correlates with `roll_rate` / `movement` rather than being an
  independent twist detector.

## Note messages — Tap / Shake / Twist

Source: `E4-raw.txt` (`listen.py --raw` capture of deliberate taps).

- **Tap = MIDI Note 0**, velocity = strength. 10 taps all came through as
  `note_on note=0`, velocities 16–64 (mean 34). Shake and Twist also emit notes
  1 and 2 (seen incidentally in `B3-raw.txt`) *on top of* their CCs.
- The browser session recorder discards notes entirely, so Tap only shows up as
  the derived `tap` envelope — use a raw capture (or the new **⏺ Raw** button) to
  see note number + velocity.

## Noise floor

Source: `D1` (resting on a towel, 30 s), `D2` (held still in hand, 15 s).

- **At rest (D1):** the CCs are essentially frozen — per-channel stdev
  ≤ ~0.002 normalized (< 0.2 CC units); CC5 and all event channels 0.
- **Hand-held (D2):** slightly higher from tremor — CC3/CC4 stdev ~0.006
  (< 1 CC unit); event channels still ~0.
- Implication: real motion sits far above the noise, so gesture thresholds can be
  aggressive; there is no meaningful idle drift to filter.

## Gesture-matching material (Series C + custom)

Not analytic findings yet — raw material captured for building/validating an
orientation-invariant matcher:

- **`C1`–`C5`:** the tip-away move in different grips (positives C1–C3) and
  different directions (negatives C4–C5). Each has ≥ 5 reps. As expected, the raw
  CC trajectories differ between grips (e.g. peak-tilt lean-azimuth ranges from
  +40° to +139° across the positives) — that difference is exactly what an
  invariant matcher must learn to ignore. Evaluating a matcher on these is TODO.
- **`home-grip-twist` (custom):** a repeated slow "doorknob" double-twist
  performed continuously around a full arm-extended pitch loop (arm down → up →
  over → back). Finding: the twist **recurs at all arm pitches** (good for
  orientation independence) but registers only weakly on CC1 (peak 0.17) and its
  `roll_rate`/`energy` is indistinguishable from the loop's own motion — a slow
  twist embedded in a big orientation move is hard to isolate. Sharp twists with
  the arm briefly still would separate better.

## Derived signals (`roll_speed`, `roll_rate`, `energy`)

- `roll_speed` is a **gated** version of `roll_rate` (`web/app.js`): below
  `ROLL_GATE` it is forced to 0. Slow moves (Series A, B1, B2) read 0 by design;
  fast moves (B3/B4/B5/B6) push it up. Not a bug.
- Use `roll_rate` (ungated) as the continuous rate signal.

## Message rate / sampling

Source: `data/B3-raw.txt` (full-rate `listen.py --raw` capture).

- **≈ 405 MIDI messages/s**, i.e. ~58 full 7-CC frames/s.
- The in-browser **session recorder logs only ~15–20 Hz**, undersampling ~3–4×.
  Fast gestures alias badly in the session JSON; use the raw capture for any
  timing/rate analysis.

## Method & data

- Recordings live in `data/`: Series A (`A1`–`A5`, `A5B`), Series B
  (`B1-pitch`, `B1-roll`, `B1-roll2`, `B2`, `B3` + `B3-raw.txt`, `B4`–`B7`),
  Series C (`C1`–`C5`), noise floor (`D1`, `D2`), Series E (`E1`, `E4-raw.txt`),
  and the custom `home-grip-twist`.
- Session JSON files come from the web app's **⏺ Record** button; `*-raw.txt`
  from `.venv/bin/python listen.py --raw` (or the new **⏺ Raw** button).
- Analysis was per-channel spans, single-step deltas (wrap test), cross-channel
  correlation, and single-cycle sinusoid fits on the slow calibration sweeps.
- Not yet done: C2/C3 grip positives beyond spans, D-drift over long runs, and
  Series E's E2 (tilt staircase) / E3 (cone) were not recorded.

## Caveats / open questions

- **Series B was recorded with fewer than the planned 5 reps per test**, so the
  event-channel results are qualitative (trigger yes/no + rough peak), not
  statistics. Re-run B4–B7 with clean reps to quantify thresholds and ranges.
- **CC2 Freefall** is under-characterized (peaked only 0.22); needs a proper
  drop test.
- The CC-vs-angle transfer function **is now fit** (see above): pure single-cycle
  sine, R² 0.96–1.00. Remaining nuance: CC3/CC4 amplitude (~0.35) is smaller than
  CC5's (~0.50), so the horizontal (azimuth) gain differs from the tilt gain —
  worth confirming with a rotation about a perfectly horizontal axis.
- The azimuth decode assumes a single-axis lean; a compound tilt (pitch+roll at
  once, as in B2) should be checked against the `atan2` recipe.
- **E1 (yaw at tilt) is inconclusive** — redo with a clear vertical-axis spin to
  confirm heading is unobservable off-vertical.
- The Series C matcher evaluation (do positives cluster, negatives separate?) has
  not been run yet.
- CC7 is MIDI Volume per `docs/MIDI.md` and was not exercised here.
