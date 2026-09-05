import type { CameraState } from "../types.ts";
import { lineageToneForAhnentafelSlot, type FamilyTreeChartColorScheme, type FamilyTreeChartTone } from "../appearance/familyTreeChartColorScheme.ts";
import type { ConstellationNode, ConstellationRole, ConstellationScene } from "./constellationModel.ts";

export const CONSTELLATION_ROLE_LABELS: Record<ConstellationRole, string> = {
  focus: "Центральна особа", ancestor: "Предок", descendant: "Нащадок", partner: "Партнер / партнерка", relative: "Родинне оточення",
};

export function constellationTone(node: ConstellationNode, scheme: FamilyTreeChartColorScheme): FamilyTreeChartTone {
  return node.role === "focus" ? scheme.focus
    : node.ancestorSlot !== undefined ? lineageToneForAhnentafelSlot(scheme, node.ancestorSlot)
    : scheme.lineageBase;
}

export function constellationScreenPoint(node: { x: number; y: number }, camera: CameraState, size: { width: number; height: number }) {
  return { x: (node.x - camera.x) * camera.zoom + size.width / 2, y: (node.y - camera.y) * camera.zoom + size.height / 2 };
}

export function constellationHitTest(scene: ConstellationScene, camera: CameraState, size: { width: number; height: number }, point: { x: number; y: number }): string | undefined {
  let nearest: string | undefined;
  let nearestDistance = 24;
  for (const node of scene.nodes) {
    const screen = constellationScreenPoint(node, camera, size);
    const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (distance <= nearestDistance) { nearest = node.id; nearestDistance = distance; }
  }
  return nearest;
}

/** Labels use screen pixels, independently of zoom. Lower-priority names yield space. */
export function constellationLabels(scene: ConstellationScene, camera: CameraState, size: { width: number; height: number }, selectedId: string) {
  const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
  return [...scene.nodes].sort((a, b) => (
    Number(b.id === selectedId) - Number(a.id === selectedId)
    || Number(b.id === scene.focusId) - Number(a.id === scene.focusId)
    || a.distance - b.distance || (a.id < b.id ? -1 : 1)
  )).flatMap(node => {
    const screen = constellationScreenPoint(node, camera, size);
    const important = node.id === selectedId || node.id === scene.focusId;
    if (screen.x < 16 || screen.y < 0 || screen.x > size.width - 16 || screen.y > size.height - 75) return [];
    if (!important && (camera.zoom < 0.23 || occupied.length >= 80)) return [];
    const width = Math.min(172, Math.max(64, node.person.displayName.length * 7.4 + 14), size.width - 16);
    const x = Math.min(size.width - width / 2 - 8, Math.max(width / 2 + 8, screen.x));
    const y = screen.y + (node.role === "focus" ? 30 : 20);
    const box = { left: x - width / 2 - 4, right: x + width / 2 + 4, top: y - 3, bottom: y + 52 };
    if (box.right > size.width - 180 && box.bottom > size.height - 76) return []; // Reserve the chart's branding corner.
    if (occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) return [];
    occupied.push(box);
    return [{ node, x, y, width }];
  });
}
