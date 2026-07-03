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
- **Yaw (heading) is not observable — at any tilt, and inherently so.** Rotating
  about vertical is rotating about the gravity vector, which cannot change an
  accelerometer's reading. Confirmed upright (A4) and at 90° tilt from two
  different rolls (E1, E1B). The ball orients from gravity only; there is no
  magnetometer-style heading.
- **Direction-of-tilt gestures are ambiguous under an unknown grip.** Because grip
  yaw is invisible, "tip away" and "tip left" can produce the same signal (Series
  C) — orientation-invariant matching cannot rely on lean *direction* unless the
  grip is fixed/known.
- **Whole-arm "throw" gestures are the reliable grip-independent triggers.**
  `arm-catapult` and `backhand-invert` saturate `energy`/`movement`/`shake` (and
  emit Notes) identically at any onset orientation — the practical building block
  when the grip is unknown.
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

Source: `A4` (full spin about vertical, logo up), `E1`/`E1B` (spin about vertical
at ~90° tilt, from two different starting rolls).

- **Upright (A4):** no channel responded — CC3 span 0.08, CC4 0.10, CC5 0.00,
  `energy` peaked 0.07.
- **At 90° tilt (E1, E1B):** in both runs CC5 held steady at ~0.50 (tilt kept at
  ~90°) while CC3/CC4 only wandered ±~0.1 (imperfect hand-holding, not an azimuth
  sweep), and `roll_rate` stayed ~0.02–0.13 — i.e. the sensor saw essentially no
  motion even though the ball was physically spun 360°.
- **Why this is fundamental (not an execution artifact):** a pure yaw is a
  rotation *about the vertical/gravity axis*. An accelerometer reports gravity in
  the body frame, and rotating a vector about its own axis leaves it unchanged, so
  the accel reading — and therefore CC3/CC4/CC5 — is invariant under yaw at **any**
  tilt. The near-zero `roll_rate` is expected: the CCs truly aren't changing.
- **Conclusion: heading is not recoverable, period.** The device orients from
  gravity only (no magnetometer). Any yaw-only gesture is invisible, and
  orientation-neutral matching cannot use heading.

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

## Gesture matching & orientation invariance (Series C)

Source: `C1`–`C5`, the same "tip the ball ~90° and back" arm move (~5+ clean reps
each). C1–C3 are *positives* (same move, different grip); C4–C5 are *negatives*
(different tilt direction). Per-rep features (energy = speed, ΔCC5 = tilt
magnitude, lean-azimuth = `atan2(CC4−.5, CC3−.5)` at peak tilt):

| Rec | Grip / move | peak energy | ΔCC5 | lean-azimuth @ peak |
| --- | --- | --- | --- | --- |
| C1 | HOME, tip **away** (pos base) | 0.21 | 0.35 | **+135° ± 4** |
| C2 | rotated-in-hand, tip away (pos) | 0.23 | 0.37 | **+43° ± 3** |
| C3 | flipped (logo down), tip away (pos) | 0.25 | 0.45 | **−56° ± 23** |
| C4 | HOME, tip **toward** (neg mirror) | 0.27 | 0.45 | **−46° ± 1** |
| C5 | HOME, tip **left** (neg sideways) | 0.23 | 0.48 | **+47° ± 3** |

Findings:

- **Magnitude features are direction-blind.** peak energy (0.21–0.27) and ΔCC5
  (0.35–0.48) are nearly identical across *all five* — every rep is "a ~90° tip at
  similar speed." Speed/tilt-magnitude alone cannot tell any of these apart.
- **Raw lean-azimuth does NOT separate positives from negatives.** The three
  positives land at wildly different azimuths (+135°, +43°, −56°), while positive
  **C2 (+43°) collides with negative C5 (+47°)**, and positive C3 (−56°) sits
  right next to negative C4 (−46°). In raw CC space, same-gesture and
  different-gesture reps are interleaved.
- **The grip can't be pre-registered from the rest pose.** C1, C2, C4, C5 all rest
  at CC3≈0.5, CC4≈0.5, CC5≈0.00 — *identical* (all logo-up). Only C3 (flipped, CC5
  ≈0.99) is distinguishable at rest. So a matcher can't normalize by reading the
  grip before the move.
- **Root cause = the yaw blind spot.** C1 and C2 differ only by a spin about the
  (vertical) logo axis — an unobservable yaw — yet the same physical "tip away"
  then reads as +135° vs +43°. Equivalently, "tip away with a yawed grip" and "tip
  left with HOME grip" are the *same* motion up to an invisible yaw, so the ball
  literally cannot distinguish them (C2 ≈ C5).

**Implications for a matcher:** with the ball held logo-up in an unknown yaw,
lean-*direction* discrimination is impossible; usable invariants are the
tilt-*magnitude* profile, the speed/energy profile, and any multi-phase temporal
structure of the gesture. Reliable direction discrimination requires a
fixed/known grip (or a gesture that itself establishes a tilt reference first).

## Orientation-free gestures

The counterpart to Series C: whole-arm "throw" moves detected by the
intensity/event channels (`energy`, `movement`, `shake`, `freefall`, Notes), which
don't depend on orientation. These fire the *same* way regardless of how the ball
is held, so they are the natural building blocks for grip-independent triggers.

**Shared signature:** `movement` (CC6) pegged high (never below ~0.5) and
`energy`/`shake` saturating, while CC3/CC4/CC5 swing freely — i.e. the trigger
comes entirely from the orientation-independent channels. Both are trivially
separable from the Series C tips (energy ~0.2, movement low).

- **`arm-catapult`** (session JSON, 7 reps). Every rep hits `energy` = 1.00 and
  `movement` 0.71–1.00, with a **consistent `freefall` ≈ 0.34–0.39** (a genuine
  airborne phase) and `shake` up to 1.00. Onset tilt ranged CC5 **0.16 → 0.94**
  (upright through nearly inverted) with an **identical signature at every onset**
  — confirming orientation-independence directly. First recording to drive CC2
  Freefall meaningfully (B6's gentle drops only reached 0.22).
- **`backhand-invert`** (raw capture, 8.3 s, fast forward-then-back reversals).
  `movement` 0.57–1.00, `shake` (CC0) to 1.00, CC3/CC4/CC5 sweep the full 0.03–
  0.97 as the ball inverts. The sharp reversal emits **Notes**: 4× Shake at
  **velocity 127** plus 5 Taps and a Twist. `freefall` stays low (0.25) — no true
  airborne phase.

**Distinguishing the two:** the catapult has a sustained `freefall` (~0.4) and no
taps; the backhand-invert has near-zero freefall but Shake-note bursts (vel 127) +
Taps from the reversal. So freefall + Note pattern separate them even though both
saturate energy/movement.

## Custom recordings

- **`home-grip-twist`:** a repeated slow "doorknob" double-twist
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
- **Caveat:** the browser **⏺ Raw** button logged only ~94 msg/s during
  `backhand-invert`, far below `listen.py`'s 405 — the Web MIDI layer may coalesce
  rapid CC updates. Prefer `listen.py --raw` for authoritative timing until this is
  checked with a controlled side-by-side.

## Method & data

- Recordings live in `data/`: Series A (`A1`–`A5`, `A5B`), Series B
  (`B1-pitch`, `B1-roll`, `B1-roll2`, `B2`, `B3` + `B3-raw.txt`, `B4`–`B7`),
  Series C (`C1`–`C5`), noise floor (`D1`, `D2`), Series E (`E1`, `E1B`,
  `E4-raw.txt`), orientation-free gestures (`arm-catapult`, `backhand invert`),
  and the custom `home-grip-twist`.
- Session JSON files come from the web app's **⏺ Record** button; `*-raw.txt`
  from `.venv/bin/python listen.py --raw` (or the new **⏺ Raw** button).
- Analysis was per-channel spans, single-step deltas (wrap test), cross-channel
  correlation, and single-cycle sinusoid fits on the slow calibration sweeps.
- The Series C analysis used per-rep energy-threshold segmentation, with peak-tilt
  lean-azimuth and ΔCC5 per rep.
- Not yet done: D-drift over long runs; Series E's E2 (tilt staircase) / E3 (cone)
  were not recorded.

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
- Yaw-at-tilt is now **resolved** (E1 + E1B + the gravity-axis argument): heading
  is unobservable at any tilt.
- CC7 is MIDI Volume per `docs/MIDI.md` and was not exercised here.
