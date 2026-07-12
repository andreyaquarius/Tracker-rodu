import { useCallback, useEffect, useRef, useState } from "react";

export type FamilyTreeViewportState = {
  x: number;
  y: number;
  scale: number;
};

export type ViewportPoint = {
  x: number;
  y: number;
};

export const FAMILY_TREE_MIN_SCALE = 0.08;
export const FAMILY_TREE_MAX_SCALE = 2.5;

const DEFAULT_VIEWPORT: FamilyTreeViewportState = { x: 0, y: 0, scale: 1 };

export function familyTreeViewportStorageKey(input: {
  treeId: string;
  rootPersonId: string;
  mode: string;
}): string {
  return `family-tree-viewport:${input.treeId || "no-tree"}:${input.rootPersonId || "no-root"}:${input.mode}`;
}

export function serializeFamilyTreeViewport(value: FamilyTreeViewportState): string {
  return JSON.stringify({
    x: Math.round(value.x),
    y: Math.round(value.y),
    scale: Number(value.scale.toFixed(3)),
  });
}

export function parseFamilyTreeViewport(value: string | null): FamilyTreeViewportState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FamilyTreeViewportState>;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const scale = clampScale(Number(parsed.scale));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, scale };
  } catch {
    return null;
  }
}

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(FAMILY_TREE_MAX_SCALE, Math.max(FAMILY_TREE_MIN_SCALE, value));
}

export function zoomViewportAtPoint(
  viewport: FamilyTreeViewportState,
  point: ViewportPoint,
  nextScaleValue: number,
): FamilyTreeViewportState {
  const nextScale = clampScale(nextScaleValue);
  const worldX = (point.x - viewport.x) / viewport.scale;
  const worldY = (point.y - viewport.y) / viewport.scale;
  return {
    x: point.x - worldX * nextScale,
    y: point.y - worldY * nextScale,
    scale: nextScale,
  };
}

export function centerViewportOnRect(input: {
  viewportWidth: number;
  viewportHeight: number;
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
  scale: number;
}): FamilyTreeViewportState {
  const scale = clampScale(input.scale);
  return {
    x: input.viewportWidth / 2 - (input.targetX + input.targetWidth / 2) * scale,
    y: input.viewportHeight / 2 - (input.targetY + input.targetHeight / 2) * scale,
    scale,
  };
}

export function fitViewportToBounds(input: {
  viewportWidth: number;
  viewportHeight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  padding?: number;
}): FamilyTreeViewportState {
  const padding = input.padding ?? 80;
  const width = Math.max(1, input.maxX - input.minX);
  const height = Math.max(1, input.maxY - input.minY);
  const scale = clampScale(Math.min(
    (input.viewportWidth - padding * 2) / width,
    (input.viewportHeight - padding * 2) / height,
  ));
  return centerViewportOnRect({
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    targetX: input.minX,
    targetY: input.minY,
    targetWidth: width,
    targetHeight: height,
    scale,
  });
}

export function initialFamilyTreeViewport(input: {
  viewportWidth: number;
  viewportHeight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  rootX: number;
  rootY: number;
  rootWidth: number;
  rootHeight: number;
  padding?: number;
}): FamilyTreeViewportState {
  const layoutWidth = Math.max(1, input.maxX - input.minX);
  const layoutHeight = Math.max(1, input.maxY - input.minY);
  const shouldFitWholeTree =
    layoutWidth > input.viewportWidth * 1.25 ||
    layoutHeight > input.viewportHeight * 1.2;
  if (shouldFitWholeTree) {
    return fitViewportToBounds({
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
      minX: input.minX,
      minY: input.minY,
      maxX: input.maxX,
      maxY: input.maxY,
      padding: input.padding ?? 60,
    });
  }
  return centerViewportOnRect({
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    targetX: input.rootX,
    targetY: input.rootY,
    targetWidth: input.rootWidth,
    targetHeight: input.rootHeight,
    scale: 1,
  });
}

export function readStoredFamilyTreeViewport(storageKey: string): FamilyTreeViewportState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseFamilyTreeViewport(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

export function persistFamilyTreeViewport(storageKey: string, viewport: FamilyTreeViewportState): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(storageKey, serializeFamilyTreeViewport(viewport));
    return true;
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Storage can throw in quota/private modes; viewport persistence is optional.
    }
    return false;
  }
}

export function useFamilyTreeViewport(storageKey: string) {
  const [viewport, setViewport] = useState<FamilyTreeViewportState>(
    () => readStoredFamilyTreeViewport(storageKey) ?? DEFAULT_VIEWPORT,
  );
  const activeKeyRef = useRef(storageKey);
  const skipPersistRef = useRef(false);

  useEffect(() => {
    if (activeKeyRef.current === storageKey) return;
    activeKeyRef.current = storageKey;
    // Не записуємо старий viewport під новий ключ: спершу відновлюємо або скидаємо.
    skipPersistRef.current = true;
    setViewport(readStoredFamilyTreeViewport(storageKey) ?? DEFAULT_VIEWPORT);
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    persistFamilyTreeViewport(storageKey, viewport);
  }, [storageKey, viewport]);

  const reset = useCallback(() => {
    setViewport(DEFAULT_VIEWPORT);
  }, []);

  return {
    viewport,
    setViewport,
    reset,
  };
}
