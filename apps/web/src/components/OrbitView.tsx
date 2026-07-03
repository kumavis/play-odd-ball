// Orbit view: force-directed patch diagram. The ODD ball is a big node at the
// centre; every modulation signal is a satellite orbiting it, each drawing its
// own labelled live histogram and ending in a little output port. Instruments
// are triangular targets that drift on the outer ring, and a patched
// connection is a cable pulling its instrument in toward the driving
// satellite. A light spring/repulsion simulation keeps it all arranged.
import { useEffect, useRef } from "preact/hooks";
import {
  clamp1,
  connections,
  connEditorSig,
  gesturesSig,
  INSTRUMENTS,
  paramByKey,
  paramsList,
  patchViewSig,
  sparkBuf,
} from "../runtime/state";
import { connect, previewInstrument, shape } from "../runtime/patch";
import { saveStateSoon } from "../runtime/persist";
import { useFrame } from "../hooks";

// Simulation tuning (per-frame units; forces are unit-less pushes on velocity).
const ORB = {
  REP: 2600, // pairwise repulsion strength
  REP_MAX: 3.2, // cap on a single repulsion push
  OVERLAP: 0.55, // extra shove when two nodes overlap
  K_ORBIT: 0.01, // satellite ↔ ball spring
  K_LINK: 0.02, // instrument ↔ its driving satellite
  K_IDLE: 0.006, // unpatched instrument ↔ ball (loose outer ring)
  DAMP: 0.85,
  MAXV: 20,
  RING: 0.27, // satellite ring radius (× min(w,h))
  OUT: 0.45, // idle instrument ring radius (× min(w,h))
  LINK_LEN: 118,
};
const ORB_BARS = 18;

interface OrbNode {
  type: "ball" | "param" | "inst";
  key: string;
  label: string;
  color?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
  r: number;
  rep: number;
  pw?: number;
  ph?: number;
}

class Orbit {
  ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  dpr = 1;
  nodes: OrbNode[] = [];
  byKey: Record<string, OrbNode> = {};
  ball: OrbNode;
  drag: { node: OrbNode; ox: number; oy: number; downX: number; downY: number } | null = null;
  link: { fromKey: string; x: number; y: number; over: OrbNode | null } | null = null;
  built = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.ball = {
      type: "ball",
      key: "__ball",
      label: "ODD",
      color: "#00e5ff",
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 46,
      rep: 3.4,
    };
  }

  resize(): boolean {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return false;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /** (Re)build the node set, preserving live positions of existing nodes. */
  build(): void {
    const prev = this.byKey || {};
    const w = this.w || this.canvas.clientWidth || 860;
    const h = this.h || this.canvas.clientHeight || 520;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.max(120, Math.min(w, h));
    const nodes: OrbNode[] = [];
    const byKey: Record<string, OrbNode> = {};

    this.ball.x = cx;
    this.ball.y = cy;
    this.ball.vx = 0;
    this.ball.vy = 0;
    nodes.push(this.ball);

    const params = paramsList();
    params.forEach((p, i) => {
      const id = "p:" + p.key;
      const a = (i / params.length) * Math.PI * 2 - Math.PI / 2;
      const n =
        prev[id] ||
        ({
          vx: 0,
          vy: 0,
          x: cx + Math.cos(a) * R * ORB.RING,
          y: cy + Math.sin(a) * R * ORB.RING,
        } as OrbNode);
      n.type = "param";
      n.key = p.key;
      n.label = p.label;
      n.color = p.color;
      n.pw = 90;
      n.ph = 52;
      n.r = 46;
      n.rep = 1.35;
      byKey[id] = n;
      nodes.push(n);
    });

    INSTRUMENTS.forEach((inst, i) => {
      const id = "i:" + inst.key;
      const a = (i / INSTRUMENTS.length) * Math.PI * 2;
      const n =
        prev[id] ||
        ({
          vx: 0,
          vy: 0,
          x: cx + Math.cos(a) * R * ORB.OUT,
          y: cy + Math.sin(a) * R * ORB.OUT,
        } as OrbNode);
      n.type = "inst";
      n.key = inst.key;
      n.label = inst.label;
      n.r = 21;
      n.rep = 0.85;
      byKey[id] = n;
      nodes.push(n);
    });

    this.nodes = nodes;
    this.byKey = byKey;
    this.built = true;
  }

  private spring(n: OrbNode, target: OrbNode, rest: number, k: number): void {
    const dx = target.x - n.x;
    const dy = target.y - n.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const f = (d - rest) * k;
    n.fx! += (dx / d) * f;
    n.fy! += (dy / d) * f;
  }

  step(): void {
    const N = this.nodes;
    if (!N.length) return;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.max(120, Math.min(this.w, this.h));
    const ringR = R * ORB.RING;
    const outR = R * ORB.OUT;

    if (!this.drag || this.drag.node !== this.ball) {
      this.ball.x = cx;
      this.ball.y = cy;
      this.ball.vx = 0;
      this.ball.vy = 0;
    }
    for (const n of N) {
      n.fx = 0;
      n.fy = 0;
    }

    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        const a = N[i];
        const b = N[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const d = Math.sqrt(d2);
        let f = Math.min(ORB.REP_MAX, (ORB.REP * (a.rep || 1) * (b.rep || 1)) / d2);
        const minD = a.r + b.r;
        if (d < minD) f += (minD - d) * ORB.OVERLAP;
        const ux = dx / d;
        const uy = dy / d;
        a.fx! += ux * f;
        a.fy! += uy * f;
        b.fx! -= ux * f;
        b.fy! -= uy * f;
      }
    }

    for (const n of N) {
      if (n.type === "param") {
        this.spring(n, this.ball, ringR, ORB.K_ORBIT);
      } else if (n.type === "inst") {
        const conn = connections[n.key];
        const src = conn && this.byKey["p:" + conn.source];
        if (src) this.spring(n, src, ORB.LINK_LEN, ORB.K_LINK);
        else this.spring(n, this.ball, outR, ORB.K_IDLE);
      }
    }

    for (const n of N) {
      if (n === this.ball) continue;
      if (this.drag && this.drag.node === n) continue;
      n.vx = (n.vx + n.fx!) * ORB.DAMP;
      n.vy = (n.vy + n.fy!) * ORB.DAMP;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > ORB.MAXV) {
        n.vx *= ORB.MAXV / sp;
        n.vy *= ORB.MAXV / sp;
      }
      n.x += n.vx;
      n.y += n.vy;
      const m = n.r + 4;
      if (n.x < m) {
        n.x = m;
        n.vx *= -0.4;
      }
      if (n.x > this.w - m) {
        n.x = this.w - m;
        n.vx *= -0.4;
      }
      if (n.y < m) {
        n.y = m;
        n.vy *= -0.4;
      }
      if (n.y > this.h - m) {
        n.y = this.h - m;
        n.vy *= -0.4;
      }
    }
  }

  /** The little output port sits on the satellite edge facing away from the ball. */
  portOut(n: OrbNode) {
    const a = Math.atan2(n.y - this.ball.y, n.x - this.ball.x);
    return { x: n.x + Math.cos(a) * (n.pw! / 2 + 4), y: n.y + Math.sin(a) * (n.ph! / 2) };
  }
  /** An instrument takes its cable on the edge facing the ball. */
  portIn(n: OrbNode) {
    const a = Math.atan2(this.ball.y - n.y, this.ball.x - n.x);
    return { x: n.x + Math.cos(a) * n.r, y: n.y + Math.sin(a) * n.r };
  }

  private cable(a: { x: number; y: number }, b: { x: number; y: number }, color: string, width: number, alpha: number) {
    const ctx = this.ctx;
    const mx = (a.x + b.x) / 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawSatellite(n: OrbNode) {
    const ctx = this.ctx;
    const val = clamp1(paramByKey(n.key)?.get() ?? 0);
    const x = n.x - n.pw! / 2;
    const y = n.y - n.ph! / 2;
    const w = n.pw!;
    const h = n.ph!;
    ctx.save();
    this.roundRect(x, y, w, h, 9);
    ctx.fillStyle = "rgba(20,23,40,0.92)";
    ctx.fill();
    ctx.lineWidth = 1.4 + val * 2.2;
    ctx.strokeStyle = n.color!;
    ctx.globalAlpha = 0.55 + val * 0.45;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#c9cdf0";
    ctx.font = "600 9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const label = n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label;
    ctx.fillText(label, x + 8, y + 6);
    // labelled histogram
    const hx = x + 8;
    const hy = y + 19;
    const hw = w - 16;
    const hh = h - 26;
    const buf = sparkBuf[n.key];
    if (buf && buf.length > 1) {
      const bw = hw / ORB_BARS;
      for (let bxi = 0; bxi < ORB_BARS; bxi++) {
        const lo = Math.floor((bxi / ORB_BARS) * buf.length);
        const hi = Math.max(lo + 1, Math.floor(((bxi + 1) / ORB_BARS) * buf.length));
        let m = 0;
        for (let k = lo; k < hi && k < buf.length; k++) m = Math.max(m, buf[k]);
        const bh = Math.max(1, clamp1(m) * hh);
        ctx.fillStyle = n.color!;
        ctx.globalAlpha = 0.3 + clamp1(m) * 0.6;
        ctx.fillRect(hx + bxi * bw + 0.5, hy + hh - bh, Math.max(1, bw - 1), bh);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // output port
    const p = this.portOut(n);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#0c0e1a";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = n.color!;
    ctx.stroke();
  }

  private drawTriangle(n: OrbNode) {
    const ctx = this.ctx;
    const conn = connections[n.key];
    const on = !!conn;
    const v = on ? shape(conn, n.key) : 0;
    const col = on ? paramByKey(conn!.source)?.color || "#8b90b8" : "#6b7099";
    const a = Math.atan2(n.y - this.ball.y, n.x - this.ball.x); // apex points outward
    const r = n.r;
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.7, r * 0.82);
    ctx.lineTo(-r * 0.7, -r * 0.82);
    ctx.closePath();
    ctx.fillStyle = on ? "rgba(24,27,46,0.96)" : "rgba(20,22,36,0.7)";
    ctx.fill();
    ctx.lineWidth = 1.5 + v * 3;
    ctx.strokeStyle = col;
    ctx.globalAlpha = on ? 0.7 + v * 0.3 : 0.5;
    ctx.stroke();
    if (v > 0.02) {
      ctx.globalAlpha = v * 0.5;
      ctx.fillStyle = col;
      ctx.fill();
    }
    ctx.restore();
    // label just outside the apex
    const lx = n.x + Math.cos(a) * (r + 9);
    const ly = n.y + Math.sin(a) * (r + 9);
    ctx.save();
    ctx.font = "600 9.5px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = Math.cos(a) < -0.2 ? "right" : Math.cos(a) > 0.2 ? "left" : "center";
    ctx.fillStyle = on ? "#e9ecff" : "#8b90b8";
    ctx.globalAlpha = this.link && this.link.over === n ? 1 : 0.92;
    ctx.fillText(n.label, lx, ly);
    ctx.restore();
  }

  private drawBall() {
    const ctx = this.ctx;
    const n = this.ball;
    const g = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, n.r * 0.2, n.x, n.y, n.r);
    g.addColorStop(0, "#eafcff");
    g.addColorStop(0.4, "#00e5ff");
    g.addColorStop(1, "#5a2fe0");
    ctx.save();
    ctx.shadowColor = "rgba(0,229,255,0.5)";
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(6,8,18,0.85)";
    ctx.font = "800 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ODD", n.x, n.y);
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // faint orbital guide ring
    const R = Math.max(120, Math.min(this.w, this.h));
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, R * ORB.RING, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // cables (behind nodes)
    for (const inst of INSTRUMENTS) {
      const conn = connections[inst.key];
      if (!conn) continue;
      const src = this.byKey["p:" + conn.source];
      const dst = this.byKey["i:" + inst.key];
      if (!src || !dst) continue;
      const v = shape(conn, inst.key);
      this.cable(this.portOut(src), this.portIn(dst), paramByKey(conn.source)?.color || "#8b90b8", 1.5 + v * 5, 0.28 + v * 0.7);
      if (connEditorSig.peek()?.instKey === inst.key) {
        this.cable(this.portOut(src), this.portIn(dst), "#ffffff", 1.2, 0.5);
      }
    }

    // in-progress link
    if (this.link) {
      const src = this.byKey["p:" + this.link.fromKey];
      if (src) {
        this.ctx.save();
        this.ctx.setLineDash([5, 4]);
        this.cable(this.portOut(src), { x: this.link.x, y: this.link.y }, src.color!, 2.5, 0.9);
        this.ctx.restore();
      }
    }

    this.drawBall();
    for (const n of this.nodes) if (n.type === "inst") this.drawTriangle(n);
    for (const n of this.nodes) if (n.type === "param") this.drawSatellite(n);
  }

  // ---- pointer interaction ----
  point(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitInst(x: number, y: number): OrbNode | null {
    for (const n of this.nodes) {
      if (n.type !== "inst") continue;
      if (Math.hypot(x - n.x, y - n.y) <= n.r + 6) return n;
    }
    return null;
  }

  topNode(x: number, y: number): OrbNode | null {
    // params first (drawn on top), then instruments, then ball
    for (const n of this.nodes) {
      if (n.type !== "param") continue;
      if (Math.abs(x - n.x) <= n.pw! / 2 && Math.abs(y - n.y) <= n.ph! / 2) return n;
    }
    const inst = this.hitInst(x, y);
    if (inst) return inst;
    if (Math.hypot(x - this.ball.x, y - this.ball.y) <= this.ball.r) return this.ball;
    return null;
  }

  /** Distance from a point to a connection's cable, for click-to-edit. */
  cableAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = 9;
    for (const inst of INSTRUMENTS) {
      const conn = connections[inst.key];
      if (!conn) continue;
      const src = this.byKey["p:" + conn.source];
      const dst = this.byKey["i:" + inst.key];
      if (!src || !dst) continue;
      const a = this.portOut(src);
      const b = this.portIn(dst);
      const mx = (a.x + b.x) / 2;
      const c1 = { x: mx, y: a.y };
      const c2 = { x: mx, y: b.y };
      for (let t = 0; t <= 1; t += 0.04) {
        const it = 1 - t;
        const w0 = it * it * it;
        const w1 = 3 * it * it * t;
        const w2 = 3 * it * t * t;
        const w3 = t * t * t;
        const px = w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x;
        const py = w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y;
        const d = Math.hypot(x - px, y - py);
        if (d < bestD) {
          bestD = d;
          best = inst.key;
        }
      }
    }
    return best;
  }
}

export function OrbitView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbitRef = useRef<Orbit | null>(null);
  const active = patchViewSig.value === "orbit";
  gesturesSig.value; // rebuild the node set when the moves change

  useEffect(() => {
    if (orbitRef.current && orbitRef.current.built) orbitRef.current.build();
  }, [gesturesSig.value]);

  useEffect(() => {
    const cv = canvasRef.current!;
    const orbit = (orbitRef.current = new Orbit(cv));

    const onMove = (e: PointerEvent) => {
      const p = orbit.point(e);
      if (orbit.link) {
        orbit.link.x = p.x;
        orbit.link.y = p.y;
        orbit.link.over = orbit.hitInst(p.x, p.y);
      } else if (orbit.drag) {
        const n = orbit.drag.node;
        n.x = p.x - orbit.drag.ox;
        n.y = p.y - orbit.drag.oy;
        n.vx = 0;
        n.vy = 0;
      }
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const p = orbit.point(e);
      if (orbit.link) {
        const inst = orbit.hitInst(p.x, p.y);
        if (inst && paramByKey(orbit.link.fromKey)) connect(orbit.link.fromKey, inst.key);
        orbit.link = null;
      } else if (orbit.drag) {
        const d = orbit.drag;
        orbit.drag = null;
        const moved = Math.hypot(p.x - d.downX, p.y - d.downY) > 5;
        if (!moved && d.node.type === "inst") previewInstrument(d.node.key);
        else if (moved) saveStateSoon();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (patchViewSig.peek() !== "orbit") return;
      const p = orbit.point(e);
      e.preventDefault();
      // 1. output port of a satellite → begin a patch cable
      for (const n of orbit.nodes) {
        if (n.type !== "param") continue;
        const port = orbit.portOut(n);
        if (Math.hypot(p.x - port.x, p.y - port.y) <= 11) {
          orbit.link = { fromKey: n.key, x: p.x, y: p.y, over: null };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          return;
        }
      }
      // 2. a node body → drag it around
      const node = orbit.topNode(p.x, p.y);
      if (node) {
        orbit.drag = { node, ox: p.x - node.x, oy: p.y - node.y, downX: p.x, downY: p.y };
        node.vx = 0;
        node.vy = 0;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }
      // 3. a cable → open its connection editor
      const inst = orbit.cableAt(p.x, p.y);
      if (inst) connEditorSig.value = { instKey: inst, x: e.clientX, y: e.clientY };
    };
    cv.addEventListener("pointerdown", onDown);
    return () => {
      cv.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useFrame(() => {
    const orbit = orbitRef.current;
    if (!orbit || patchViewSig.peek() !== "orbit") return;
    if (orbit.resize()) {
      if (!orbit.built) orbit.build();
      orbit.step();
      orbit.draw();
    }
  });

  return (
    <div class={`orbit${active ? "" : " orbit--hidden"}`}>
      <canvas class="orbit-canvas" ref={canvasRef}></canvas>
      <div class="orbit-hint">
        drag the halo dot on a signal onto a triangle to patch it · click a cable to edit · drag nodes to rearrange
      </div>
    </div>
  );
}
