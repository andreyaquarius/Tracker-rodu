"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  CameraState,
  LayoutBounds,
  LayoutNode,
  WorldViewport,
} from "../types.ts";

export interface TreeCameraController {
  containerRef: RefObject<HTMLDivElement | null>;
  camera: CameraState;
  viewportSize: { width: number; height: number };
  worldViewport: WorldViewport;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  zoomBy: (factor: number) => void;
  fitBounds: (bounds: LayoutBounds, padding?: number) => void;
  centerNode: (node: LayoutNode) => void;
  compensateWorldShift: (shift: { x: number; y: number }) => void;
}

const MIN_ZOOM = 0.045;
const MAX_ZOOM = 4;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function useTreeCamera(
  initial: CameraState = { x: 0, y: 0, zoom: 1 },
): TreeCameraController {
  const containerRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState(initial);
  const cameraRef = useRef(camera);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPinchDistance = useRef<number | undefined>(undefined);

  const updateCamera = useCallback((next: CameraState): void => {
    cameraRef.current = next;
    setCamera(next);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setViewportSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      const current = { x: event.clientX, y: event.clientY };
      pointers.current.set(event.pointerId, current);

      if (pointers.current.size === 1) {
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const active = cameraRef.current;
        updateCamera({
          ...active,
          x: active.x - dx / active.zoom,
          y: active.y - dy / active.zoom,
        });
        return;
      }

      if (pointers.current.size === 2) {
        const [first, second] = [...pointers.current.values()];
        const distance = Math.hypot(second!.x - first!.x, second!.y - first!.y);
        const previousDistance = lastPinchDistance.current;
        lastPinchDistance.current = distance;
        if (!previousDistance || previousDistance <= 0) return;
        const factor = distance / previousDistance;
        const active = cameraRef.current;
        updateCamera({ ...active, zoom: clampZoom(active.zoom * factor) });
      }
    },
    [updateCamera],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) lastPinchDistance.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const active = cameraRef.current;
      const screenX = event.clientX - rect.left - rect.width / 2;
      const screenY = event.clientY - rect.top - rect.height / 2;
      const worldX = active.x + screenX / active.zoom;
      const worldY = active.y + screenY / active.zoom;
      const zoom = clampZoom(active.zoom * Math.exp(-event.deltaY * 0.0015));
      updateCamera({
        x: worldX - screenX / zoom,
        y: worldY - screenY / zoom,
        zoom,
      });
    },
    [updateCamera],
  );

  const zoomBy = useCallback(
    (factor: number): void => {
      const active = cameraRef.current;
      updateCamera({ ...active, zoom: clampZoom(active.zoom * factor) });
    },
    [updateCamera],
  );

  const fitBounds = useCallback(
    (bounds: LayoutBounds, padding = 72): void => {
      const width = Math.max(1, bounds.right - bounds.left);
      const height = Math.max(1, bounds.bottom - bounds.top);
      const zoom = clampZoom(
        Math.min(
          Math.max(1, viewportSize.width - padding * 2) / width,
          Math.max(1, viewportSize.height - padding * 2) / height,
        ),
      );
      updateCamera({
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
        zoom,
      });
    },
    [updateCamera, viewportSize],
  );

  const centerNode = useCallback(
    (node: LayoutNode): void => {
      const active = cameraRef.current;
      updateCamera({
        ...active,
        x: node.x + node.width / 2,
        y: node.y + node.height / 2,
      });
    },
    [updateCamera],
  );

  const compensateWorldShift = useCallback(
    (shift: { x: number; y: number }): void => {
      const active = cameraRef.current;
      updateCamera({ ...active, x: active.x + shift.x, y: active.y + shift.y });
    },
    [updateCamera],
  );

  const worldViewport = useMemo<WorldViewport>(
    () => ({
      left: camera.x - viewportSize.width / (2 * camera.zoom),
      top: camera.y - viewportSize.height / (2 * camera.zoom),
      right: camera.x + viewportSize.width / (2 * camera.zoom),
      bottom: camera.y + viewportSize.height / (2 * camera.zoom),
    }),
    [camera, viewportSize],
  );

  return {
    containerRef,
    camera,
    viewportSize,
    worldViewport,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    zoomBy,
    fitBounds,
    centerNode,
    compensateWorldShift,
  };
}
