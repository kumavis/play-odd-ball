# Implementation review — July 2026

A full review of the `@oddball/core` + Preact webapp rewrite (post PR #6),
covering the core library, the webapp runtime/components/audio layers, and a
data-driven analysis of the gesture recognition system's false-positive
behavior. Everything listed under **Fixed** was applied on the branch that
added this document; **Follow-ups** are recommended but not yet built.

Verification at time of review: 34/34 vitest cases, both workspace
typechecks, and the production build all pass. Items already documented in
[`CONVERSION-NOTES.md`](CONVERSION-NOTES.md) were excluded.

## Bug findings

### Fixed

1. **HIGH — Re-pairing an already-connected BLE ball doubled its MIDI stream
   permanently.** (`apps/web/src/runtime/midi.ts`, `packages/core/src/midi/ble.ts`)
   The dedupe branch assumed a fresh GATT session replaces the old one, but a
   ball is only in `bleInputs` while the old session is still alive — so
   `gatt.connect()` was a no-op on the same device and `connectBleBall`
   stacked a second `characteristicvaluechanged` listener on the same cached
   characteristic. One accidental second click on "Connect Bluetooth" and
   every message was delivered twice (double chime hits, doubled msg/s,
   duplicated raw captures) with the fresh handle — the only way to detach —
   discarded. *Fix:* `connectBleBall` now tracks its listeners per
   characteristic/device (WeakMap) and replaces rather than stacks them, and
   the app replaces the stored handle on re-pair.

2. **MEDIUM — Disconnecting the last ball left CC-driven instruments droning
   forever.** (`packages/core/src/engine.ts`) `resetDevices()` cleared
   per-device state but never the aggregated `engine.cc` map that the
   webapp's param getters read, so `shake`/`tilt_*`/`movement` froze at their
   last non-zero values and kept streaming into the synth after the ball
   powered off. `removeDevice()` likewise left the departed device's
   contribution baked into the average. *Fix:* `resetDevices()` clears the
   aggregate; `removeDevice()` recomputes (or removes) each controller the
   device had reported.

3. **MEDIUM — Escape closed the gesture editor without disarming an active
   capture.** (`apps/web/src/components/GestureEditor.tsx`) The keydown
   effect (deps `[id]`) captured a stale `close` that saw `recMove` as null,
   so Escape skipped `finishRecordMove()`. Recording continued invisibly and
   the next "✋ Record move" click dumped every accidentally-captured motion
   into the old move, corrupting its templates and auto-threshold. *Fix:* the
   handler now calls the latest `close` through a ref.

4. **MEDIUM — Cricket voice ignored its envelope and played ~5-10× too
   loud.** (`apps/web/src/audio/engine.ts` `_chirp`) The ±0.5 tremolo LFO was
   *summed* into a gain whose envelope peaks at ≤ 0.11, so output swung
   between ≈ −0.44 and +0.56: the "off" half-cycle phase-inverted at nearly
   full amplitude instead of gating, the attack ramp was inaudible, and the
   driving value barely mattered. *Fix:* the tremolo now multiplies through
   its own 0..1 gain stage after the envelope.

5. **MEDIUM-LOW — Instrument preview didn't finish its release for glide
   voices.** (`apps/web/src/audio/engine.ts` `preview`) Teardown called
   `v.set(0)` once, which moves a glide voice ~10% toward zero; with sound
   off nothing else glided it down, so previewing e.g. Rainfall left it
   hissing for the rest of the 5 s resume window and again for ~1 s the next
   time sound was enabled. *Fix:* the preview keeps ticking `v.set(0)` until
   the voice is silent, then hard-zeros it.

6. **LOW — Counter-example captures became a *positive* move if the target
   was deleted mid-recording.** (`apps/web/src/runtime/gestures.ts`)
   `finishRecordMove()`'s missing-target fallback ignored `rec.kind` and
   saved the "must NOT fire" motions as a brand-new live move. *Fix:*
   counter captures whose target is gone are discarded with a log line.

7. **LOW — Disconnecting an instrument didn't purge its queued chain steps or
   trigger envelope.** (`apps/web/src/runtime/patch.ts`) A pending
   `seqQueue` entry could fire a spurious one-shot into a rewired patch.
   *Fix:* `disconnect()` drops that instrument's queued steps and envelope.

8. **LOW — Trigger-envelope decay was per-frame, not per-time.**
   (`apps/web/src/runtime/loop.ts`) `tapEnv`/`gestureEnv`/`seqEnv` decayed by
   a fixed factor per rAF, so tails were 2-2.4× shorter on 120/144 Hz
   displays than on 60 Hz — the only non-dt-corrected math in the loop.
   *Fix:* decays are now exponent-scaled by `dt` (identical behavior at
   60 Hz).

9. **LOW — Cancelling an armed cable leaked a window `pointermove` listener
   each time.** (`apps/web/src/components/PatchBay.tsx`) The Escape /
   click-outside effect (deps `[]`) held a first-render `clearLink` whose
   captured `onPointerMove`/`onLinkPointerUp` identities never matched the
   ones `startLink` attached, so `removeEventListener` was a no-op and each
   cancel left one more listener running `elementFromPoint` +
   `querySelectorAll` per pointermove. *Fix:* the attached handler
   identities are stored on the link state and removed from there.

10. **LOW — Session import rejected the app's own raw captures.**
    (`apps/web/src/runtime/gestures.ts`, `packages/core/src/session.ts`)
    "⏺ Raw" files (`oddball-raw-midi-1`) — the *higher*-fidelity format,
    which core's `isRawCapture` already recognizes — failed import with "no
    usable session samples", while ~20 Hz session files (documented to alias
    the ~400 msg/s stream) imported fine. *Fix:* new
    `rawCaptureFeatureFrames()` in core decodes the orientation CCs from a
    raw capture; import now accepts both formats.

### Verified non-issues (checked and cleared)

WebAudio node lifecycle (all one-shot sources stopped, orphaned subtrees
collectible), `exponentialRampToValueAtTime` targets (all strictly positive),
`enable()` re-entrancy, banded-DTW row reset semantics, gesture-id
uniqueness, localStorage migration ordering, profile data aliasing,
OrbitView listener balance, and the recognizer's early-fire/full-close
double-attempt guard.

## Gesture recognition: false-positive analysis

Motivated by real-world reports of moves firing on completely different
motions. Measured by cross-probing the four recorded motions in `data/`
(`home-grip-twist`, `arm-catapult`, `backhand invert`, `controller roll from
logo up`) through the real segmenter + matcher, plus background probes from
the protocol recordings. Key numbers (pre-fix scoring):

- **Solo evaluation** (the situation when a motion resembles no loaded move):
  "catapult" (auto-threshold 0.825) fired on **all 13** twist reps, both
  backhands and 7/8 rolls; "backhand" (0.856) fired on everything tested.
  Impostor distances sat at 0.30–0.62 — *below* the auto thresholds.
- **Honest recall vs impostors overlap:** leave-one-out genuine distances
  (twist 0.35–0.50) interleave with impostor distances (roll-vs-twist
  0.30–0.53). No threshold separates them; this is a representation limit,
  not a tuning miss. The invariant profile keeps only relative speed +
  turning per step — two smooth rotational motions look alike.
- **The margin competition already works:** with all four moves loaded,
  cross-fires were 1 in 27. Misfires come from motions that aren't any
  saved move, where the loosest-thresholded move wins by default.
- **Counter-examples work:** two roll captures as counters on "twist" cut
  its false fires 5/8 → 1/8 (recall cost 13/13 → 10/13, tunable via the
  veto margin).
- **Dead ends (measured, don't invest):** gating on the grip-dependent axis
  distance looked perfect in-sample but was training-set leakage — held-out
  genuine axis distances (0.24–1.24) fully overlap impostors. Rotation-
  aligned matching (Wahba/q-method + DTW on aligned sphere paths) made
  separation *worse*: the free rotation helps impostors as much as genuine
  reps.

### Fixed (measured, low-risk)

- **Arc gate reads true example arcs.** The gate's accepted band was derived
  from crop-variant template arcs (tight crops shrink arc, loose ones grow
  it), inflating an already-loose ±2× band. It now uses each example's
  as-cropped arc. Near-neutral on the benchmark (the ±2× ratio dominates)
  but the band no longer depends on cropping artifacts.
- **Separate counter-veto margin.** The veto reused `GEST_MARGIN` (the
  winner-vs-runner-up tiebreak constant); it's now its own
  `GEST_COUNTER_MARGIN` so the "how aggressively do counters veto" trade-off
  can be tuned without touching tiebreak behavior.
- **Raw-capture import** (bug #10 above) also removes the 20 Hz aliasing
  penalty from imported training examples.
- **Regression benchmark.** `packages/core/test/crossfire.test.ts` replays
  the cross-probe experiment against `data/` on every test run, pinning:
  full-recognizer cross-fire count, counter-example effectiveness, and
  genuine recall.

### Tested and NOT shipped: median-over-examples scoring

Scoring a candidate by the median of per-example best distances (instead of
the min over every crop-variant template) shrank the raw genuine/impostor
overlap ~30-50% with thresholds held fixed — but end-to-end it never beat
the baseline. Every variant was measured against `data/`:

- *Median matching + median-calibrated thresholds:* the auto-threshold
  formula (1.6× mean LOO fit) scales the larger median fits right back up
  (twist 0.633 → 0.734), returning solo false-positive rates to baseline.
- *Median matching + min-calibrated thresholds:* thresholds stay put, but
  2-example moves break — their LOO fit is a min against one example while
  live scoring medians over two, so genuine reps land above threshold (the
  end-to-end recorder test caught this).
- *Mixed aggregation (median at ≥3 examples, min below):* few-example moves
  get an unfairly low score in the winner-takes-all competition and steal
  matches (benchmark cross-fires went 1 → 2).
- *Lower-median (order statistic) everywhere:* internally consistent, all
  tests pass, but still worse than baseline on the benchmark (25/27 vs
  26/27 correct).

Consistent with the representation-limit finding above: aggregation tweaks
shuffle errors around. The false-positive lever is impostor-aware
calibration (below), not scoring aggregation.

### Follow-ups (recommended, not yet built)

1. **Impostor-aware threshold calibration + confusability display.** The
   auto-threshold only looks at a move's own spread. Other moves' examples
   and the live `recentCandidates` pool are free negatives: place the
   threshold at the operating point between the genuine-fit and impostor
   distributions, and when they overlap, say so in the editor ("not
   distinguishable from Roll — add counter-examples or re-record"). The
   attempt debugger already collects the data to render both distributions
   with the threshold as a draggable line.
2. **Auto-counter pool / background model.** Generalize counter-examples: a
   match must also beat the distance to a rolling pool of recent non-fired
   candidates by a margin.
3. **Practical guidance surfaced in-app:** more reps (8+) tighten both
   calibration and the median score; recording examples at live rate (or
   importing raw captures) avoids the session recorder's aliasing.
