"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type {
  CameraState,
  LayoutBounds,
  LayoutNode,
  WorldViewport,
} from "../types.ts";
import {
  applyPinchToCamera,
  clampTreeZoom,
  pinchSnapshot,
  wheelZoomFactor,
  zoomCameraAtClientPoint,
  type CameraViewportRect,
  type PinchGestureSnapshot,
} from "./treeCameraMath.ts";

export interface TreeCameraController {
  containerRef: RefObject<HTMLDivElement | null>;
  camera: CameraState;
  viewportSize: { width: number; height: number };
  worldViewport: WorldViewport;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  zoomBy: (factor: number) => void;
  fitBounds: (bounds: LayoutBounds, padding?: number) => void;
  centerNode: (node: LayoutNode) => void;
  compensateWorldShift: (shift: { x: number; y: number }) => void;
}

function viewportRect(element: HTMLDivElement): CameraViewportRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function isInteractiveMouseTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("button, a, input, select, textarea, [role='button']"),
  );
}

export function useTreeCamera(
  initial: CameraState = { x: 0, y: 0, zoom: 1 },
): TreeCameraController {
  const containerRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState(initial);
  const cameraRef = useRef(camera);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPinch = useRef<PinchGestureSnapshot | undefined>(undefined);

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

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const preventBrowserGesture = (event: Event): void => {
      if (event.cancelable) event.preventDefault();
    };
    const preventTouchZoom = (event: TouchEvent): void => {
      if (event.touches.length >= 2 && event.cancelable) event.preventDefault();
    };
    const handleWheel = (event: WheelEvent): void => {
      if (event.cancelable) event.preventDefault();
      const factor = wheelZoomFactor({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        viewportHeight: element.clientHeight,
        ctrlKey: event.ctrlKey,
      });
      updateCamera(
        zoomCameraAtClientPoint(
          cameraRef.current,
          viewportRect(element),
          { x: event.clientX, y: event.clientY },
          factor,
        ),
      );
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    element.addEventListener("touchmove", preventTouchZoom, { passive: false });
    element.addEventListener("gesturestart", preventBrowserGesture, { passive: false });
    element.addEventListener("gesturechange", preventBrowserGesture, { passive: false });
    element.addEventListener("gestureend", preventBrowserGesture, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("touchmove", preventTouchZoom);
      element.removeEventListener("gesturestart", preventBrowserGesture);
      element.removeEventListener("gesturechange", preventBrowserGesture);
      element.removeEventListener("gestureend", preventBrowserGesture);
    };
  }, [updateCamera]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.pointerType === "mouse") {
        if (event.button !== 0 || isInteractiveMouseTarget(event.target)) return;
      }
      if (pointers.current.has(event.pointerId)) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture may be unavailable for a pointer that ended between events.
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      lastPinch.current = pinchSnapshot([...pointers.current.values()]);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      if (event.pointerType !== "mouse" && event.cancelable) event.preventDefault();
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
        const currentPinch = pinchSnapshot([...pointers.current.values()]);
        const previousPinch = lastPinch.current;
        lastPinch.current = currentPinch;
        if (!currentPinch || !previousPinch) return;
        updateCamera(
          applyPinchToCamera(
            cameraRef.current,
            viewportRect(event.currentTarget),
            previousPinch,
            currentPinch,
          ),
        );
      }
    },
    [updateCamera],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      pointers.current.delete(event.pointerId);
      lastPinch.current = pinchSnapshot([...pointers.current.values()]);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const zoomBy = useCallback(
    (factor: number): void => {
      const active = cameraRef.current;
      updateCamera({ ...active, zoom: clampTreeZoom(active.zoom * factor) });
    },
    [updateCamera],
  );

  const fitBounds = useCallback(
    (bounds: LayoutBounds, padding = 72): void => {
      const width = Math.max(1, bounds.right - bounds.left);
      const height = Math.max(1, bounds.bottom - bounds.top);
      const zoom = clampTreeZoom(
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
    zoomBy,
    fitBounds,
    centerNode,
    compensateWorldShift,
  };
}
