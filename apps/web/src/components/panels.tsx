import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  engine,
  lastNoteSig,
  live,
  logSig,
  profilesSig,
  sensitivitySig,
  viewsSig,
} from "../runtime/state";
import { applyProfile, deleteProfile, renameProfile, saveCurrentProfile } from "../runtime/profiles";
import { saveStateSoon } from "../runtime/persist";
import { useAppEvents, useFrame } from "../hooks";
import { setView } from "./TopBar";

// ---- Save profile (from the top bar or the panel) ---------------------------
const revealProfileId = signal<string | null>(null);
export function saveProfileAndReveal(): void {
  revealProfileId.value = saveCurrentProfile();
  setView("profiles", true);
}

export function Drawer() {
  const views = viewsSig.value;
  const anyOn = Object.values(views).some(Boolean);
  return (
    <aside class={`drawer${anyOn ? "" : " is-empty"}`}>
      <Panel view="ball" title="Ball">
        <BallPanel />
      </Panel>
      <Panel view="roll" title="Roll speed">
        <RollPanel />
      </Panel>
      <Panel view="cc" title="Control Change · live">
        <CcPanel />
      </Panel>
      <Panel view="log" title="Activity">
        <LogPanel />
      </Panel>
      <Panel view="profiles" title="Profiles">
        <ProfilesPanel />
      </Panel>
    </aside>
  );
}

function Panel(props: { view: string; title: string; children: preact.ComponentChildren }) {
  const on = !!viewsSig.value[props.view];
  return (
    <section class={`side${on ? "" : " side--hidden"}`} data-view={props.view}>
      <div class="side-head">
        <h2>{props.title}</h2>
        <button class="side-close" onClick={() => setView(props.view, false)}>
          ×
        </button>
      </div>
      {props.children}
    </section>
  );
}

// ---- Ball: the 3D-ish orb driven by orientation + motion --------------------
function BallPanel() {
  const orbRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const ripplesRef = useRef<HTMLDivElement>(null);
  const last = lastNoteSig.value;

  useFrame(() => {
    const orb = orbRef.current;
    const shadow = shadowRef.current;
    if (!orb || !shadow) return;
    const v = (c: number, d = 64) => engine.cc[c] ?? d;
    const tiltX = (v(3) - 64) / 64; // -1..1  (X orientation, CC3)
    const tiltY = (v(4) - 64) / 64;
    const roll = (v(5) - 64) / 64;
    // Glow tracks actual MOTION, not the static tilt — so a still ball doesn't
    // stay lit up at an angle.
    const energy = live.motion;

    const rotX = (-tiltY * 35).toFixed(1);
    const rotY = (tiltX * 35).toFixed(1);
    const rotZ = (roll * 25).toFixed(1);
    const lift = (energy * -24).toFixed(1);
    const scale = (1 + energy * 0.08).toFixed(3);

    orb.style.transform = `translateY(${lift}px) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg) scale(${scale})`;
    orb.style.boxShadow = `0 ${20 + energy * 30}px ${60 + energy * 40}px rgba(108,92,231,${0.4 + energy * 0.4}), inset 0 -20px 40px rgba(0,0,0,0.35)`;
    const hue = 250 - energy * 90;
    orb.style.background = `radial-gradient(circle at 32% 28%, #fff 0%, #c7c2ff 12%, hsl(${hue},70%,60%) 48%, #2a2370 100%)`;

    shadow.style.transform = `translateX(${tiltX * 30}px) scale(${1 - energy * 0.25})`;
    shadow.style.opacity = `${0.5 - energy * 0.2}`;
  });

  useAppEvents((e) => {
    if (e.kind !== "note") return;
    const orb = orbRef.current;
    const box = ripplesRef.current;
    if (orb) orb.animate([{ filter: "brightness(2.2)" }, { filter: "brightness(1)" }], { duration: 320, easing: "ease-out" });
    if (box) {
      const r = document.createElement("div");
      r.className = "ripple";
      const scale = 0.6 + (e.velocity / 127) * 1.0;
      r.style.borderColor = `hsl(${180 + e.velocity}, 100%, 65%)`;
      r.style.transform = `scale(${scale})`;
      box.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }
  });

  return (
    <>
      <div class="orb-scene">
        <div class="ripples" ref={ripplesRef}></div>
        <div class="orb" ref={orbRef}>
          <div class="orb-gloss"></div>
          <div class="orb-logo">ODD</div>
        </div>
        <div class="orb-shadow" ref={shadowRef}></div>
      </div>
      <div class="note-readout">
        <div class="note-big">{last.name}</div>
        <div class="note-sub">{last.sub}</div>
      </div>
    </>
  );
}

// ---- Roll speed ---------------------------------------------------------------
function RollPanel() {
  const fillRef = useRef<HTMLDivElement>(null);
  const valRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<HTMLDivElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const sens = sensitivitySig.value;

  useFrame(() => {
    const active = live.rollSpeed > 0;
    if (fillRef.current) {
      fillRef.current.style.width = `${live.rollRaw * 100}%`;
      fillRef.current.classList.toggle("active", active);
    }
    if (valRef.current) valRef.current.textContent = live.rollSpeed.toFixed(2);
    if (gateRef.current) gateRef.current.style.left = `${engine.roll.gate * 100}%`;
    if (rateRef.current) {
      const rate = Math.round(live.rollRate);
      const gateRate = Math.round(engine.roll.gate * engine.roll.scale);
      rateRef.current.innerHTML = active
        ? `<b>rolling</b> · ${rate}/s (gate ${gateRate}/s)`
        : `idle · ${rate}/s (gate ${gateRate}/s)`;
    }
  });

  return (
    <div class="roll">
      <div class="cc-row">
        <div class="cc-label">speed</div>
        <div class="cc-track roll-track">
          <div class="cc-fill" ref={fillRef}></div>
          <div class="gate-mark" title="bass triggers past here" ref={gateRef}></div>
        </div>
        <div class="cc-val" ref={valRef}>
          0
        </div>
      </div>
      <div class="cc-row">
        <div class="cc-label">sensitivity</div>
        <input
          class="sens"
          type="range"
          min="0"
          max="100"
          value={sens}
          onInput={(e) => {
            sensitivitySig.value = +(e.target as HTMLInputElement).value;
            saveStateSoon();
          }}
        />
        <div class="cc-val">{Math.round(sens)}</div>
      </div>
      <div class="roll-rate" ref={rateRef}>
        idle
      </div>
    </div>
  );
}

// ---- Control-change meters -------------------------------------------------------
function CcPanel() {
  // Render a meter per controller as we first see it (ordered numerically);
  // fill widths update imperatively each frame.
  const [controllers, setControllers] = useState<number[]>([]);
  const rowRefs = useRef(new Map<number, { fill: HTMLDivElement | null; val: HTMLDivElement | null }>());

  useFrame(() => {
    const seen = Object.keys(engine.cc).map(Number);
    if (seen.length !== controllers.length) {
      setControllers(seen.sort((a, b) => a - b));
      return;
    }
    for (const ctrl of controllers) {
      const refs = rowRefs.current.get(ctrl);
      const v = engine.cc[ctrl] ?? 0;
      if (refs?.fill) refs.fill.style.width = `${(v / 127) * 100}%`;
      if (refs?.val) refs.val.textContent = String(Math.round(v));
    }
  }, [controllers]);

  return (
    <div class="cc-meters">
      {controllers.map((ctrl) => (
        <div class="cc-row" key={ctrl}>
          <div class="cc-label">CC {ctrl}</div>
          <div class="cc-track">
            <div
              class="cc-fill"
              ref={(el) => {
                const entry = rowRefs.current.get(ctrl) || { fill: null, val: null };
                entry.fill = el;
                rowRefs.current.set(ctrl, entry);
              }}
            ></div>
          </div>
          <div
            class="cc-val"
            ref={(el) => {
              const entry = rowRefs.current.get(ctrl) || { fill: null, val: null };
              entry.val = el;
              rowRefs.current.set(ctrl, entry);
            }}
          >
            0
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Activity log -------------------------------------------------------------------
function LogPanel() {
  return (
    <div class="log">
      {logSig.value.map((e) => (
        <div class={`ev ${e.cls}`} key={e.id}>
          {e.tag ? <b>{e.tag}</b> : null}
          {e.tag ? " " : ""}
          {e.text}
        </div>
      ))}
    </div>
  );
}

// ---- Profiles -----------------------------------------------------------------------
function ProfilesPanel() {
  const profiles = profilesSig.value;
  const reveal = revealProfileId.value;

  // Focus + select the name of a just-saved profile for instant renaming.
  useEffect(() => {
    if (!reveal) return;
    const input = document.querySelector<HTMLInputElement>(`.profile-name[data-id="${reveal}"]`);
    if (input) {
      input.focus();
      input.select();
    }
    revealProfileId.value = null;
  }, [reveal, profiles]);

  return (
    <div class="profiles">
      <button class="prof-save" onClick={saveProfileAndReveal}>
        💾 Save current layout…
      </button>
      <div class="profile-list">
        {!profiles.length ? (
          <div class="profile-empty">No saved profiles yet. Build a patch, then save it.</div>
        ) : (
          profiles.map((p) => {
            const nSounds = Object.values(p.connections || {}).filter(Boolean).length;
            const nMoves = Array.isArray(p.gestures) ? p.gestures.length : 0;
            return (
              <div class="profile" key={p.id}>
                <div class="profile-main">
                  <input
                    class="profile-name"
                    data-id={p.id}
                    spellcheck={false}
                    title="Tap to rename"
                    defaultValue={p.name}
                    onChange={(e) => {
                      const input = e.target as HTMLInputElement;
                      if (!input.value.trim()) input.value = p.name; // empty reverts
                      else renameProfile(p.id, input.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <div class="profile-meta">
                    {nSounds} sound{nSounds === 1 ? "" : "s"} · {nMoves} move{nMoves === 1 ? "" : "s"}
                  </div>
                </div>
                <button class="profile-load" onClick={() => applyProfile(p.id)}>
                  Load
                </button>
                <button
                  class="profile-del"
                  title="Delete profile"
                  onClick={() => {
                    if (window.confirm(`Delete profile “${p.name}”?`)) deleteProfile(p.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
