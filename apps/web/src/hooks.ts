import { useEffect } from "preact/hooks";
import { onAppEvent, onFrame, type AppEvent, type FrameInfo } from "./runtime/state";

/** Run a callback on every animation frame (for imperative hot-path updates). */
export function useFrame(cb: (f: FrameInfo) => void, deps: unknown[] = []): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onFrame(cb), deps);
}

/** Subscribe to app-level one-shot events (note hits, gesture fires). */
export function useAppEvents(cb: (e: AppEvent) => void, deps: unknown[] = []): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onAppEvent(cb), deps);
}

/**
 * Match a canvas's backing store to its CSS size × devicePixelRatio.
 * Returns null when the canvas is not laid out (zero size).
 */
export function fitCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; W: number; H: number; dpr: number } | null {
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  if (!cw || !ch) return null;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  return { ctx: cv.getContext("2d")!, W: cv.width, H: cv.height, dpr };
}
