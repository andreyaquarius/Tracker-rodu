import { useEffect, useRef } from "react";
import type { CameraState } from "../types.ts";
import type { FamilyTreeChartColorScheme } from "../appearance/familyTreeChartColorScheme.ts";
import type { ConstellationScene } from "./constellationModel.ts";
import { constellationScreenPoint, constellationTone } from "./constellationPresentation.ts";
import type { ConstellationTimeSlice } from "./constellationTime.ts";

interface Props {
  scene: ConstellationScene;
  camera: CameraState;
  width: number;
  height: number;
  selectedId: string;
  colors: FamilyTreeChartColorScheme;
  textured: boolean;
  luminous?: boolean;
  timeSlice?: ConstellationTimeSlice;
}

/** Event-driven Canvas2D; no idle animation timer, remote textures or GPU dependency. */
export function ConstellationCanvas({ scene, camera, width, height, selectedId, colors, textured, timeSlice, luminous = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 1 || height <= 1) return;
    const frame = requestAnimationFrame(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const screen = (point: { x: number; y: number }) => constellationScreenPoint(point, camera, { width, height });
      if (textured) {
        // A stationary, sparse atlas texture. It never twinkles or follows the pointer.
        ctx.fillStyle = colors.grid;
        for (let i = 0; i < 72; i++) {
          const x = ((i * 239 + 53) % 997) / 997 * width;
          const y = ((i * 373 + 97) % 991) / 991 * height;
          ctx.globalAlpha = i % 7 === 0 ? 0.3 : 0.16;
          ctx.beginPath(); ctx.arc(x, y, i % 7 === 0 ? 1.2 : 0.65, 0, Math.PI * 2); ctx.fill();
          if (i % 7 === 0) {
            ctx.strokeStyle = colors.grid; ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y);
            ctx.moveTo(x, y - 3.5); ctx.lineTo(x, y + 3.5); ctx.stroke();
          }
        }
        const center = screen({ x: 0, y: 0 });
        ctx.strokeStyle = colors.grid; ctx.lineWidth = 0.7; ctx.globalAlpha = 0.24;
        for (const radius of scene.rings) {
          if (radius * camera.zoom > 12000) continue;
          ctx.beginPath(); ctx.arc(center.x, center.y, radius * camera.zoom, 0, Math.PI * 2); ctx.stroke();
        }
      }
      const path = scene.paths[selectedId];
      const highlightedEdges = new Set(path?.edgeIds ?? []);
      const highlightedPeople = new Set(path?.personIds ?? []);
      const eventPeople = new Set(timeSlice?.events.flatMap(({ event }) => event.personIds) ?? []);
      const nodesById = new Map(scene.nodes.map(node => [node.id, node]));
      for (const edge of scene.edges) {
        const source = nodesById.get(edge.source)!;
        const target = nodesById.get(edge.target)!;
        const a = screen(source); const b = screen(target);
        if ((a.x < -40 && b.x < -40) || (a.x > width + 40 && b.x > width + 40) || (a.y < -40 && b.y < -40) || (a.y > height + 40 && b.y > height + 40)) continue;
        const highlighted = highlightedEdges.has(edge.id);
        const tone = constellationTone(source.role === "ancestor" ? source : target, colors);
        ctx.strokeStyle = highlighted || luminous ? tone.stroke : colors.grid;
        ctx.globalAlpha = highlighted ? 1 : luminous ? 0.46 : 0.72;
        const unionState = edge.unionId ? timeSlice?.unions.get(edge.unionId) : undefined;
        if (timeSlice?.persons.get(source.id)?.state === "future" || timeSlice?.persons.get(target.id)?.state === "future" || unionState === "future") ctx.globalAlpha *= 0.22;
        else if (unionState === "ended" || unionState === "unknown") ctx.globalAlpha *= 0.5;
        ctx.lineWidth = highlighted ? 2.7 : 1.2;
        ctx.shadowColor = tone.stroke; ctx.shadowBlur = luminous && highlighted ? 7 : 0;
        const biological = ["biological", "genetic_father", "genetic_mother", "birth_parent"].includes(edge.relationshipKind ?? "");
        ctx.setLineDash(edge.kind === "partner" ? [7, 4] : biological ? [] : [2, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        if (edge.kind === "parent" && camera.zoom > 0.3) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const tip = { x: a.x + (b.x - a.x) * 0.64, y: a.y + (b.y - a.y) * 0.64 };
          ctx.beginPath(); ctx.moveTo(tip.x - Math.cos(angle - 0.5) * 6, tip.y - Math.sin(angle - 0.5) * 6);
          ctx.lineTo(tip.x, tip.y); ctx.lineTo(tip.x - Math.cos(angle + 0.5) * 6, tip.y - Math.sin(angle + 0.5) * 6); ctx.stroke();
        }
      }
      for (const node of scene.nodes) {
        const point = screen(node);
        if (point.x < -45 || point.x > width + 45 || point.y < -45 || point.y > height + 45) continue;
        const tone = constellationTone(node, colors);
        const radius = node.role === "focus" ? 23 : Math.max(3.2, Math.min(14, 14 * Math.sqrt(camera.zoom)));
        const highlighted = node.id === selectedId || highlightedPeople.has(node.id);
        const lifeState = timeSlice?.persons.get(node.id)?.state;
        const alpha = lifeState === "future" ? 0.3 : 1;
        ctx.globalAlpha = 1;
        if (highlighted || node.role === "focus") {
          ctx.globalAlpha = 0.13; ctx.fillStyle = tone.stroke;
          ctx.beginPath(); ctx.arc(point.x, point.y, radius + 9, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = alpha; ctx.fillStyle = lifeState === "deceased" ? colors.background : tone.fill; ctx.strokeStyle = tone.stroke;
        ctx.shadowColor = tone.stroke; ctx.shadowBlur = luminous ? highlighted ? 19 : 7 : 0;
        ctx.lineWidth = node.id === selectedId ? 2.6 : 1.5;
        ctx.setLineDash(lifeState === "unknown" ? [2, 3] : []);
        ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
        if (eventPeople.has(node.id)) {
          ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(point.x, point.y, radius + 4, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = alpha;
        if (radius >= 11) {
          ctx.fillStyle = lifeState === "deceased" ? colors.text : tone.foreground;
          ctx.font = `${node.role === "focus" ? 15 : 10}px system-ui, sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(node.person.displayName.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join(""), point.x, point.y + 0.5);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [scene, camera, width, height, selectedId, colors, textured, timeSlice, luminous]);
  return <canvas ref={ref} className="constellation-canvas" aria-hidden="true" />;
}
