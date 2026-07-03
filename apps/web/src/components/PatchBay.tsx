import { useEffect, useRef, useState } from "preact/hooks";
import {
  connections,
  connVersion,
  connEditorSig,
  INSTRUMENTS,
  paramByKey,
  paramsList,
  patchViewSig,
  sparkBuf,
  SPARK_MAX,
  clamp1,
} from "../runtime/state";
import { connect, previewInstrument, shape } from "../runtime/patch";
import { saveStateSoon } from "../runtime/persist";
import { useFrame } from "../hooks";
import { OrbitView } from "./OrbitView";
import { HistDock } from "./HistDock";

const SVGNS = "http://www.w3.org/2000/svg";
const SRC_W = 210;
const INST_W = 132;
const SRC_H = 46;
const INST_H = 34;
const GPAD = 16;

export function PatchBay() {
  const view = patchViewSig.value;
  return (
    <section class="patchbay">
      <div class="patch-head">
        <h2>
          Patch bay{" "}
          <span class="hint-inline">
            click a parameter then an instrument to connect (or drag) · click a cable to edit
          </span>
        </h2>
        <div class="patch-views">
          <button
            class={`pv-btn${view === "rack" ? " is-active" : ""}`}
            title="Classic rack view"
            onClick={() => {
              patchViewSig.value = "rack";
              saveStateSoon();
            }}
          >
            ▤ Rack
          </button>
          <button
            class={`pv-btn${view === "orbit" ? " is-active" : ""}`}
            title="Force-directed orbit view"
            onClick={() => {
              patchViewSig.value = "orbit";
              saveStateSoon();
            }}
          >
            ✷ Orbit
          </button>
        </div>
      </div>
      <RackGraph />
      <OrbitView />
      <HistDock />
    </section>
  );
}

interface LinkState {
  fromType: "out" | "in";
  fromKey: string;
  mode: "drag" | "armed";
  fromPort: HTMLElement;
  downX: number;
  downY: number;
  temp: SVGPathElement;
}

function RackGraph() {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const srcPorts = useRef(new Map<string, HTMLElement>());
  const instPorts = useRef(new Map<string, HTMLElement>());
  const sparkRefs = useRef(new Map<string, HTMLCanvasElement>());
  const valRefs = useRef(new Map<string, HTMLElement>());
  const cables = useRef(new Map<string, { line: SVGPathElement; hit: SVGPathElement }>());
  const link = useRef<LinkState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const hidden = patchViewSig.value === "orbit";
  connVersion.value; // subscribe: is-connected/is-off classes derive from connections
  const params = paramsList(); // reads gesturesSig → re-renders when moves change

  useEffect(() => {
    const el = boxRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- Cable geometry -------------------------------------------------------
  const portCenter = (port: HTMLElement) => {
    const node = port.offsetParent as HTMLElement; // the .gnode
    return {
      x: node.offsetLeft + port.offsetLeft + port.offsetWidth / 2,
      y: node.offsetTop + port.offsetTop + port.offsetHeight / 2,
    };
  };
  const cablePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };

  // ---- Per-frame: cables, live-value bars, sparklines -------------------------
  useFrame(() => {
    // When the orbit view is active the rack is display:none: its port nodes
    // report no layout, so skip all rack drawing (the orbit renderer draws the
    // cables instead). Audio levels are pushed by the runtime loop regardless.
    if (patchViewSig.peek() === "orbit") return;
    const svg = svgRef.current;
    if (!svg) return;
    for (const inst of INSTRUMENTS) {
      const conn = connections[inst.key];
      let c = cables.current.get(inst.key);
      if (conn) {
        const srcPort = srcPorts.current.get(conn.source);
        const instPort = instPorts.current.get(inst.key);
        if (!srcPort || !instPort) continue;
        if (!c) {
          const hit = document.createElementNS(SVGNS, "path");
          hit.setAttribute("class", "cable-hit");
          hit.dataset.inst = inst.key;
          const line = document.createElementNS(SVGNS, "path");
          line.setAttribute("class", "cable");
          svg.appendChild(hit);
          svg.appendChild(line);
          c = { line, hit };
          cables.current.set(inst.key, c);
        }
        const v = shape(conn, inst.key);
        const d = cablePath(portCenter(srcPort), portCenter(instPort));
        c.line.setAttribute("d", d);
        c.hit.setAttribute("d", d);
        c.line.setAttribute("stroke", paramByKey(conn.source)?.color || "#8b90b8");
        c.line.setAttribute("stroke-width", (1.5 + v * 5).toFixed(2));
        c.line.setAttribute("stroke-opacity", (0.3 + v * 0.7).toFixed(2));
        c.line.classList.toggle("is-selected", connEditorSig.peek()?.instKey === inst.key);
      } else if (c) {
        c.line.remove();
        c.hit.remove();
        cables.current.delete(inst.key);
      }
    }
    for (const p of paramsList()) {
      const bar = valRefs.current.get(p.key);
      if (bar) bar.style.width = `${p.get() * 100}%`;
      const cv = sparkRefs.current.get(p.key);
      if (cv) drawSpark(cv, p.key, p.color);
    }
  });

  // ---- Linking (click-click or drag) -------------------------------------------
  const clearLink = () => {
    const l = link.current;
    if (!l) return;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onLinkPointerUp);
    document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
    l.fromPort.classList.remove("is-source");
    l.temp.remove();
    link.current = null;
  };

  const completeLink = (p: HTMLElement) => {
    const l = link.current;
    if (l) {
      const srcKey = l.fromType === "out" ? l.fromKey : p.dataset.key!;
      const instKey = l.fromType === "out" ? p.dataset.key! : l.fromKey;
      if (paramByKey(srcKey) && connections[instKey] !== undefined) connect(srcKey, instKey);
    }
    clearLink();
  };

  const localPoint = (e: PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerMove = (e: PointerEvent) => {
    const l = link.current;
    if (!l) return;
    const fromPort = l.fromType === "out" ? srcPorts.current.get(l.fromKey) : instPorts.current.get(l.fromKey);
    if (!fromPort) return;
    l.temp.setAttribute("d", cablePath(portCenter(fromPort), localPoint(e)));
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const p = over && (over.closest(".gport") as HTMLElement | null);
    document.querySelectorAll(".gport.is-target").forEach((n) => n.classList.remove("is-target"));
    if (p && p.dataset.port !== l.fromType) p.classList.add("is-target");
  };

  const onLinkPointerUp = (e: PointerEvent) => {
    window.removeEventListener("pointerup", onLinkPointerUp);
    const l = link.current;
    if (!l) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const p = over && (over.closest(".gport") as HTMLElement | null);
    if (p && p.dataset.port !== l.fromType) {
      completeLink(p);
      return;
    }
    // Released without landing on a target: if it was basically a click (no
    // real drag), keep the link armed so the next click on a port finishes it.
    const moved = Math.hypot(e.clientX - l.downX, e.clientY - l.downY);
    if (moved < 6) l.mode = "armed"; // keep temp + pointermove trailing the cursor
    else clearLink();
  };

  const startLink = (port: HTMLElement, e: PointerEvent) => {
    e.preventDefault();
    const fromType = port.dataset.port as "out" | "in";
    const fromKey = port.dataset.key!;
    const temp = document.createElementNS(SVGNS, "path");
    temp.setAttribute("class", "cable-temp");
    temp.setAttribute("stroke", fromType === "out" ? paramByKey(fromKey)?.color || "#00e5ff" : "#00e5ff");
    temp.setAttribute("stroke-width", "2.5");
    svgRef.current!.appendChild(temp);
    port.classList.add("is-source");
    link.current = { fromType, fromKey, mode: "drag", fromPort: port, downX: e.clientX, downY: e.clientY, temp };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onLinkPointerUp);
    onPointerMove(e); // draw the initial stub immediately
  };

  const onGraphPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    const port = target.closest(".gport") as HTMLElement | null;
    // If a link is armed, this click lands it (or cancels).
    if (link.current && link.current.mode === "armed") {
      if (port && port.dataset.port !== link.current.fromType) completeLink(port);
      else clearLink();
      return;
    }
    if (port) {
      startLink(port, e);
      return;
    }
    // Click on a cable hit-area opens the connection editor for that link.
    const hit = target.closest(".cable-hit") as SVGPathElement | null;
    if (hit && hit.dataset.inst) connEditorSig.value = { instKey: hit.dataset.inst, x: e.clientX, y: e.clientY };
  };

  // A click anywhere off the graph (or Escape) cancels an armed connection.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (link.current?.mode === "armed" && !(e.target as HTMLElement).closest(".graph")) clearLink();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && link.current) clearLink();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ---- Layout ------------------------------------------------------------------
  const H = size.h || 0;
  const W = size.w || 0;
  const srcSlot = params.length ? (H - GPAD * 2) / params.length : 0;
  const instSlot = (H - GPAD * 2) / INSTRUMENTS.length;
  const ih = Math.max(18, Math.min(INST_H, instSlot - 4));
  const usedSrc = new Set(
    Object.values(connections)
      .filter(Boolean)
      .map((c) => c!.source)
  );

  return (
    <div class={`graph${hidden ? " graph--hidden" : ""}`} ref={boxRef} onPointerDown={onGraphPointerDown as any}>
      {/* Cable clicks bubble from the svg to the container handler. (The
          original attached the same handler to both, so a cable click ran it
          twice — see docs/CONVERSION-NOTES.md.) */}
      <svg class="graph-svg" ref={svgRef}></svg>
      {params.map((p, i) => (
        <div
          key={p.key}
          class="gnode gnode--src"
          style={{
            width: `${SRC_W}px`,
            left: `${GPAD}px`,
            top: `${GPAD + i * srcSlot + (srcSlot - SRC_H) / 2}px`,
            borderColor: p.color,
          }}
        >
          <span class="glabel">{p.label}</span>
          <canvas
            class="spark"
            ref={(el) => {
              if (el) sparkRefs.current.set(p.key, el);
              else sparkRefs.current.delete(p.key);
            }}
          ></canvas>
          <span
            class="gval"
            style={{ background: p.color }}
            ref={(el) => {
              if (el) valRefs.current.set(p.key, el);
              else valRefs.current.delete(p.key);
            }}
          ></span>
          <div
            class={`gport gport--out${usedSrc.has(p.key) ? " is-connected" : ""}`}
            data-port="out"
            data-key={p.key}
            ref={(el) => {
              if (el) srcPorts.current.set(p.key, el);
              else srcPorts.current.delete(p.key);
            }}
          ></div>
        </div>
      ))}
      {INSTRUMENTS.map((inst, i) => {
        const on = !!connections[inst.key];
        return (
          <div
            key={inst.key}
            class={`gnode gnode--inst${on ? "" : " is-off"}`}
            style={{
              width: `${INST_W}px`,
              height: `${ih}px`,
              left: `${W - INST_W - GPAD}px`,
              top: `${GPAD + i * instSlot + (instSlot - ih) / 2}px`,
            }}
          >
            <button
              class="gtest"
              title={`Preview ${inst.label}`}
              aria-label={`Preview ${inst.label}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLButtonElement;
                btn.classList.add("is-playing");
                setTimeout(() => btn.classList.remove("is-playing"), 1300);
                previewInstrument(inst.key);
              }}
            >
              ▶
            </button>
            <span class="glabel">{inst.label}</span>
            <span class="gval"></span>
            <div
              class={`gport gport--in${on ? " is-connected" : ""}`}
              data-port="in"
              data-key={inst.key}
              ref={(el) => {
                if (el) instPorts.current.set(inst.key, el);
                else instPorts.current.delete(inst.key);
              }}
            ></div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Per-parameter sparkline (inline history next to source nodes) -----------
function drawSpark(cv: HTMLCanvasElement, key: string, color: string): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  if (!cw || !ch) return;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const ctx = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const buf = sparkBuf[key];
  if (!buf || buf.length < 2) return;
  const pts = (i: number): [number, number] => [
    (i / (SPARK_MAX - 1)) * W,
    H - 1 - clamp1(buf[i]) * (H - 2),
  ];
  // Filled area under the curve.
  ctx.beginPath();
  ctx.moveTo(...pts(0));
  for (let i = 1; i < buf.length; i++) ctx.lineTo(...pts(i));
  const [lx] = pts(buf.length - 1);
  ctx.lineTo(lx, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  // Line.
  ctx.beginPath();
  ctx.moveTo(...pts(0));
  for (let i = 1; i < buf.length; i++) ctx.lineTo(...pts(i));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();
}
