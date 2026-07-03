# TypeScript / Preact conversion notes

The vanilla-JS webapp (`web/app.js` + `web/synth.js`, ~4,800 lines) was rewritten as:

- **`packages/core`** (`@oddball/core`) — a UI-free TypeScript library: MIDI parsing,
  BLE-MIDI decoding + Web Bluetooth pairing, per-device CC state and cross-device
  aggregation, roll/motion tracking, and the full gesture stack (segmenter,
  resampling, shared normalization, gravity-sphere invariant profiles, DTW,
  duration/arc gates, auto-thresholding, counter-examples, serialization with
  legacy-format migration, session import). Tested with vitest, including replay
  tests against the real recordings in `data/`.
- **`apps/web`** (`oddball-web`) — a Preact + TypeScript + Vite conversion of the
  webapp. Structural state lives in `@preact/signals`; the 60 fps hot paths
  (cables, sparklines, orb, canvases) stay imperative behind a single
  `requestAnimationFrame` loop, exactly like the original.

localStorage keys and formats (`oddball.patchbay.v1`, `oddball.gestures.v1`,
`oddball.profiles.v1`) are unchanged, including the v2 CC-mapping migration, so
existing users keep their patches, moves and profiles.

Every algorithm (segmentation thresholds, DTW band, invariant profile, tiebreak
margins, roll gating, synth voices) was ported value-for-value. The bugs and
issues found while reading the original are listed below.

## Bugs found and fixed during the conversion

1. **`autoTrim` mangled a perfectly flat capture.** When no sample cleared the
   activity threshold, the start scan ran past the end of the array and the
   "active span" collapsed to the last ~4 samples instead of the full range.
   Harmless in practice only because real sensor data always jitters.
   (`packages/core/src/gesture/math.ts` now returns the full span; found by a
   unit test.)
2. **Gesture-id collisions.** Ids were `"g" + Date.now().toString(36)` — two
   moves created in the same millisecond (easy via import) collided, which
   cross-wires `PARAMS`, envelopes and patch connections. The library appends a
   monotonic counter.
3. **Duplicate pointer handlers on the rack graph.** `onGraphPointerDown` was
   attached to both `#graph` and its child `#graphSvg`, so clicks on SVG targets
   ran the handler twice; a double `startLink` leaked an orphaned temp-cable
   `<path>` in the SVG that nothing could remove. The Preact version has a
   single delegated handler.
4. **Unbounded persistence churn from the gesture-list slider.** The list's
   sensitivity slider called `persistGestures()` (a full JSON serialization of
   every example of every move) on *every* `input` event during a drag; the
   editor's identical slider was debounced. Both are debounced now.
5. **Recognition re-rendered the gesture list mid-interaction.** Every completed
   motion segment called `renderGestures()`, which rebuilt the list's
   `innerHTML` — yanking a sensitivity slider out from under a drag if a move
   completed at the wrong moment. Keyed VDOM diffing in Preact updates text
   without recreating the inputs.
6. **`window.prompt` for profile names froze the audio/MIDI loop.** The original
   removed the blocking prompt from *move* naming for exactly this reason but
   kept it for profiles. Profiles now save with a default name and the Profiles
   panel focuses the inline rename field.
7. **XSS-prone log/DOM writes.** The log, hints, and several list renderers were
   built with `innerHTML` + a hand-rolled `escHtml`; one missed escape on a
   device/file/profile name is an injection. The Preact version renders
   untrusted strings as text nodes only.
8. **Missing favicon** produced a console 404 on every load (cosmetic).
9. **`#root` layout (conversion-specific).** The original styled `<body>` as the
   flex column; mounting the app under `#root` silently collapsed the orbit
   view to 2 px height. Worth calling out because *nothing errored* — the rack
   still worked (absolutely-positioned nodes). Caught by screenshotting in the
   browser smoke test.

## Pre-existing issues kept (documented, not fixed)

These are behaviors of the original that survive the conversion; changing them
is a product decision, not a port:

1. **Everything stops when the tab is hidden.** The whole pipeline (gesture
   segmentation, roll tracking, sequenced chain steps, session sampling, even
   audio envelope decay) hangs off `requestAnimationFrame`, which browsers
   pause for background tabs — while MIDI messages keep arriving and
   accumulating. On refocus the accumulated orientation path is averaged over
   one huge `dt` (usually fine), but a vigorous move performed while hidden can
   read as one spurious segment, and queued chain steps fire in a burst.
   A `setInterval` fallback or Page Visibility handling would fix it.
2. **Any input change resets every device's state.** `syncActiveInputs()` wipes
   per-device CC state and gesture pipelines whenever *any* port connects or
   disconnects (including `midi.onstatechange` firing for an unrelated device),
   dropping any in-flight motion segment or armed recording capture.
3. **Cross-device CC aggregation averages stale values.** A device that stops
   sending (but stays connected) keeps contributing its last value to the
   shared average forever.
4. **Cooldown suppression is invisible in the attempt debugger.** A match inside
   the retrigger gap is recorded as `fired` even though no sound played; a
   distinct "cooldown" outcome would make tuning clearer.
5. **The ~20 Hz session recorder aliases the ~400 msg/s stream** (documented in
   `docs/FINDINGS.md`); the import segmenter compensates by scaling thresholds
   to the recording's own peak. Raw capture exists for full fidelity.
6. **Sound-button state can lie until the first gesture.** Autoplay policy means
   "Sound on" is shown optimistically before the context can start; the first
   click anywhere (including on the button) actually starts it, so the button's
   first click appears to do nothing.
7. **Previewing an instrument while sound is off** resumes the AudioContext for
   ~5 s; any *other* patched continuous voices are audible during that window.
8. **Oldest legacy gesture format** (template-only, pre-raw-capture) is loaded
   by treating normalized template rows as a raw 0..1 capture — those moves
   match poorly until re-recorded (already true in the original).
9. **`window.confirm` on profile delete** still blocks the loop briefly.
10. **BLE decoder** handles channel-voice + realtime only (no SysEx, no
    multi-packet messages) — fine for the ODD Ball, worth knowing for reuse.

## New capabilities added during the conversion

- **Counter-examples** (negative training data) per move: captures that must
  NOT fire it. A candidate whose invariant-profile distance to a counter-example
  comes within the ambiguity margin (`GEST_MARGIN`) of its distance to the real
  examples is vetoed (`counter` outcome in the attempt debugger). The margin is
  deliberate: honest reps of the counter motion vary run-to-run, and a
  knife-edge rule let half of them through (measured in the browser smoke
  test). Counter-examples serialize with the move and into profiles.
  - Editor UI: a counter-example strip (capture live with *＋ Add counter*, crop
    them like examples) and a one-click **"🚫 Counter this attempt"** button on
    the attempt debugger — when a wrong move fires, the offending motion is
    already in the recent-candidate buffer and becomes a veto instantly.
- **Attempt debugger names the rival.** "Lost tiebreak" / "ambiguous" attempts
  now record *which* move they tied with or lost to, shown in the bar tooltip
  and info line.
- **Library + tests.** The recognizer semantics are pinned by 34 vitest cases,
  including an end-to-end live-segmentation test and cross-rep recognition
  replayed from the real `data/` recordings.
- A `window.__oddball.feed(deviceId, bytes)` debug hook drives the app with
  synthetic MIDI (used by the Playwright smoke test; handy in the console).
