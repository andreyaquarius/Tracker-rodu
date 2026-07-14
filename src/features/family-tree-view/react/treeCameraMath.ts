import type { CameraState } from "../types.ts";

export const MIN_TREE_ZOOM = 0.045;
export const MAX_TREE_ZOOM = 4;

export interface CameraViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CameraClientPoint {
  x: number;
  y: number;
}

export interface PinchGestureSnapshot {
  centerX: number;
  centerY: number;
  distance: number;
}

export function clampTreeZoom(value: number): number {
  return Math.min(MAX_TREE_ZOOM, Math.max(MIN_TREE_ZOOM, value));
}

function screenPoint(
  viewport: CameraViewportRect,
  point: CameraClientPoint,
): CameraClientPoint {
  return {
    x: point.x - viewport.left - viewport.width / 2,
    y: point.y - viewport.top - viewport.height / 2,
  };
}

export function zoomCameraAtClientPoint(
  camera: CameraState,
  viewport: CameraViewportRect,
  point: CameraClientPoint,
  factor: number,
): CameraState {
  const screen = screenPoint(viewport, point);
  const worldX = camera.x + screen.x / camera.zoom;
  const worldY = camera.y + screen.y / camera.zoom;
  const zoom = clampTreeZoom(camera.zoom * factor);
  return {
    x: worldX - screen.x / zoom,
    y: worldY - screen.y / zoom,
    zoom,
  };
}

export function applyPinchToCamera(
  camera: CameraState,
  viewport: CameraViewportRect,
  previous: PinchGestureSnapshot,
  current: PinchGestureSnapshot,
): CameraState {
  if (
    !Number.isFinite(previous.distance) ||
    !Number.isFinite(current.distance) ||
    previous.distance <= 0 ||
    current.distance <= 0
  ) {
    return camera;
  }
  const previousScreen = screenPoint(viewport, {
    x: previous.centerX,
    y: previous.centerY,
  });
  const currentScreen = screenPoint(viewport, {
    x: current.centerX,
    y: current.centerY,
  });
  const anchorWorldX = camera.x + previousScreen.x / camera.zoom;
  const anchorWorldY = camera.y + previousScreen.y / camera.zoom;
  const zoom = clampTreeZoom(
    camera.zoom * (current.distance / previous.distance),
  );
  return {
    x: anchorWorldX - currentScreen.x / zoom,
    y: anchorWorldY - currentScreen.y / zoom,
    zoom,
  };
}

export function wheelZoomFactor(input: {
  deltaY: number;
  deltaMode: number;
  viewportHeight: number;
  ctrlKey: boolean;
}): number {
  const multiplier = input.deltaMode === 1
    ? 16
    : input.deltaMode === 2
      ? Math.max(1, input.viewportHeight)
      : 1;
  const pixelDelta = Math.max(
    -240,
    Math.min(240, input.deltaY * multiplier),
  );
  const sensitivity = input.ctrlKey ? 0.008 : 0.0015;
  return Math.min(1.35, Math.max(0.74, Math.exp(-pixelDelta * sensitivity)));
}

export function pinchSnapshot(
  points: readonly CameraClientPoint[],
): PinchGestureSnapshot | undefined {
  if (points.length !== 2) return undefined;
  const [first, second] = points;
  if (!first || !second) return undefined;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}
