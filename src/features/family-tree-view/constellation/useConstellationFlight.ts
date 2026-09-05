import { useCallback, useEffect, useRef } from "react";
import type { TreeCameraController } from "../react/useTreeCamera.ts";
import type { CameraState } from "../types.ts";
import { interpolateConstellationCamera } from "./constellationCinema.ts";

/** Short, cancelable camera flight. Normal pan/pinch always takes control immediately. */
export function useConstellationFlight(camera: TreeCameraController) {
  const active = useRef(camera); active.current = camera;
  const frame = useRef(0);
  const cancel = useCallback(() => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);
  const fly = useCallback((target: CameraState, animated: boolean) => {
    cancel(); const controller = active.current; const from = { ...controller.camera }; let previous = from;
    const update = (next: CameraState) => {
      controller.compensateWorldShift({ x: next.x - previous.x, y: next.y - previous.y });
      controller.zoomBy(next.zoom / previous.zoom); previous = next;
    };
    if (!animated) { update(target); return; }
    const start = performance.now();
    const tick = (now: number) => {
      if (document.hidden) { cancel(); return; }
      const progress = Math.min(1, (now - start) / 850);
      update(interpolateConstellationCamera(from, target, progress));
      if (progress < 1) frame.current = requestAnimationFrame(tick); else frame.current = 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  return { fly, cancel };
}
