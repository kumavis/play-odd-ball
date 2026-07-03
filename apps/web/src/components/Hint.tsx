import { hintSig } from "../runtime/state";

export function Hint() {
  const hint = hintSig.value;
  if (!hint.kind) return <div class="hint hide" />;
  let body;
  switch (hint.kind) {
    case "no-midi":
      body = (
        <p>
          <strong>This browser has no Web MIDI.</strong> Open this page in Chrome or Edge. You can still use{" "}
          <code>🔵 Connect ball</code> to pair over Bluetooth.
        </p>
      );
      break;
    case "midi-denied":
      body = (
        <p>
          <strong>MIDI permission denied.</strong> Reload and allow MIDI access. ({hint.detail})
        </p>
      );
      break;
    case "bt-unavailable":
      body = (
        <p>
          <strong>Web Bluetooth unavailable.</strong> Open this page in Chrome or Edge over HTTPS (or localhost). On
          macOS you can still pair via Audio MIDI Setup and pick the port above.
        </p>
      );
      break;
    case "bt-blocked":
      // Brave (and some managed Chrome installs) disable Web Bluetooth entirely.
      // This is a *different* permission from "MIDI device control".
      body = (
        <p>
          <strong>Web Bluetooth is blocked by your browser.</strong> This is separate from “MIDI device control.” In{" "}
          <strong>Brave</strong>, open <code>brave://flags/#brave-web-bluetooth-api</code>, set{" "}
          <em>Web Bluetooth API</em> to <em>Enabled</em>, relaunch, then reload this page. (Plain Chrome or Edge work
          without any flag.) You can also pair via <em>Audio MIDI Setup</em> and pick the port above.
        </p>
      );
      break;
    case "bt-failed":
      body = (
        <p>
          <strong>Bluetooth pairing failed.</strong> {hint.detail}
        </p>
      );
      break;
    default:
      body = (
        <p>
          <strong>Connect a ball.</strong> Click <code>🔵 Connect ball</code> to pair over Bluetooth right here (Chrome
          or Edge) — no macOS MIDI setup needed. Already paired in <em>Audio MIDI Setup</em>? Pick its port above
          instead. Then bounce / shake / spin the ball.
        </p>
      );
  }
  return <div class="hint">{body}</div>;
}
