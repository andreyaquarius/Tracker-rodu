import { useEffect, useRef } from "react";
import type { CameraState } from "../types.ts";
import type { FamilyTreeChartColorScheme } from "../appearance/familyTreeChartColorScheme.ts";
import { constellationScreenPoint } from "./constellationPresentation.ts";
import { constellationPlaceRadius, type ConstellationPlacesScene, type ConstellationPlaceLink } from "./constellationPlaces.ts";

interface Props {
  scene: ConstellationPlacesScene; camera: CameraState; width: number; height: number;
  selectedPlaceId?: string; selectedPersonId?: string; links: readonly ConstellationPlaceLink[];
  colors: FamilyTreeChartColorScheme; textured: boolean; luminous?: boolean; personColors: ReadonlyMap<string, string>;
}
/** A schematic atlas, never geographic coordinates or a moving force simulation. */
export function ConstellationPlacesCanvas({ scene, camera, width, height, selectedPlaceId, selectedPersonId, links, colors, textured, personColors, luminous = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 1 || height <= 1) return;
    const frame = requestAnimationFrame(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      const screen = (point: { x: number; y: number }) => constellationScreenPoint(point, camera, { width, height });
      if (textured) {
        ctx.strokeStyle = colors.grid; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.16;
        // Quiet atlas contours with no implied borders, distances or coordinates.
        for (let line = 0; line < 7; line++) {
          ctx.beginPath();
          ctx.ellipse(width * 0.37, height * 0.57, width * (0.22 + line * 0.055), height * (0.2 + line * 0.07), -0.24, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = colors.grid;
        for (let i = 0; i < 50; i++) { ctx.beginPath(); ctx.arc(((i * 227 + 97) % 991) / 991 * width, ((i * 317 + 31) % 997) / 997 * height, 0.8, 0, Math.PI * 2); ctx.fill(); }
      }
      const nodes = new Map(scene.nodes.map(node => [node.id, node]));
      const sortedLinks = [...links].sort((a, b) => Number(a.personIds.includes(selectedPersonId ?? "")) - Number(b.personIds.includes(selectedPersonId ?? "")));
      for (const link of sortedLinks) {
        const selectedTransitions = link.transitions.filter(transition => transition.personId === selectedPersonId);
        const highlighted = selectedTransitions.length > 0;
        const source = nodes.get(link.source)!; const target = nodes.get(link.target)!;
        const a = screen(source); const b = screen(target);
        if ((a.x < -160 && b.x < -160) || (a.x > width + 160 && b.x > width + 160) || (a.y < -160 && b.y < -160) || (a.y > height + 160 && b.y > height + 160)) continue;
        const length = Math.hypot(b.x - a.x, b.y - a.y); if (length < 1) continue;
        const bend = Math.min(105, length * 0.17);
        const control = { x: (a.x + b.x) / 2 - (b.y - a.y) / length * bend, y: (a.y + b.y) / 2 + (b.x - a.x) / length * bend };
        ctx.strokeStyle = highlighted ? selectedTransitions.some(transition => transition.hasMigrationEvent) ? colors.focus.stroke : colors.lineageBase.stroke : colors.grid;
        ctx.globalAlpha = highlighted ? 0.92 : 0.24; ctx.lineWidth = highlighted ? 2.4 : 1;
        ctx.shadowColor = colors.focus.stroke; ctx.shadowBlur = luminous && highlighted ? 7 : 0;
        ctx.setLineDash(highlighted ? [7, 4] : [3, 5]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(control.x, control.y, b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        const t = 0.68; const u = 1 - t;
        const tip = { x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y };
        const angle = Math.atan2(u * (control.y - a.y) + t * (b.y - control.y), u * (control.x - a.x) + t * (b.x - control.x));
        ctx.beginPath(); ctx.moveTo(tip.x - Math.cos(angle - 0.5) * 7, tip.y - Math.sin(angle - 0.5) * 7); ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(tip.x - Math.cos(angle + 0.5) * 7, tip.y - Math.sin(angle + 0.5) * 7); ctx.stroke();
      }
      for (const node of scene.nodes) {
        const point = screen(node); const radius = constellationPlaceRadius(node, camera.zoom);
        if (point.x < -80 || point.x > width + 80 || point.y < -80 || point.y > height + 80) continue;
        const selected = node.id === selectedPlaceId;
        const visited = node.place.personIds.includes(selectedPersonId ?? "");
        const tone = selected ? colors.focus : colors.lineageBase;
        ctx.globalAlpha = visited || selected ? 0.15 : 0.05; ctx.fillStyle = tone.stroke;
        ctx.beginPath(); ctx.arc(point.x, point.y, radius + (visited ? 15 : 8), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.fillStyle = tone.fill; ctx.strokeStyle = tone.stroke; ctx.lineWidth = selected ? 2.7 : 1.4;
        ctx.shadowColor = tone.stroke; ctx.shadowBlur = luminous ? selected || visited ? 18 : 7 : 0;
        ctx.setLineDash(node.place.canonicalId ? [] : [3, 3]);
        ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        if (visited) { ctx.globalAlpha = 0.65; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2); ctx.stroke(); }
        if (radius > 19) for (const [index, id] of node.place.personIds.slice(0, 24).entries()) {
          const angle = index / Math.min(24, node.place.personIds.length) * Math.PI * 2 - Math.PI / 2;
          ctx.globalAlpha = 0.85; ctx.fillStyle = personColors.get(id) ?? colors.lineageBase.stroke;
          ctx.beginPath(); ctx.arc(point.x + Math.cos(angle) * (radius - 7), point.y + Math.sin(angle) * (radius - 7), 1.8, 0, Math.PI * 2); ctx.fill();
        }
        if (radius >= 12) {
          ctx.globalAlpha = 1; ctx.fillStyle = tone.foreground; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = `600 ${radius > 25 ? 19 : 12}px Georgia, serif`; ctx.fillText(String(node.place.personIds.length), point.x, point.y + 1);
        }
        if (node.place.migrationEventCount) {
          ctx.globalAlpha = 1; ctx.fillStyle = colors.focus.stroke;
          const x = point.x + radius * 0.8; const y = point.y - radius * 0.8;
          ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [scene, camera, width, height, selectedPlaceId, selectedPersonId, links, colors, textured, personColors, luminous]);
  return <canvas ref={ref} className="constellation-canvas constellation-places-canvas" aria-hidden="true" />;
}
