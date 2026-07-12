"use client";

import { useLayoutEffect, useRef, type ReactElement } from "react";
import type {
  CameraState,
  GenerationBand,
  LayoutEdge,
  LayoutUnion,
  WorldViewport,
} from "../types.ts";

export interface TreeEdgeCanvasProps {
  width: number;
  height: number;
  camera: CameraState;
  worldViewport: WorldViewport;
  edges: readonly LayoutEdge[];
  unions: readonly LayoutUnion[];
  generationBands: readonly GenerationBand[];
}

function edgeBounds(edge: LayoutEdge): WorldViewport {
  const xs = edge.points.map(point => point.x);
  const ys = edge.points.map(point => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function intersects(a: WorldViewport, b: WorldViewport): boolean {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

interface EdgePalette {
  accent: string;
  muted: string;
  warm: string;
  danger: string;
  structure: string;
  partnership: string;
  continuation: string;
  generation: string;
  generationLabel: string;
  junction: string;
}

function edgeStyle(kind: LayoutEdge["kind"], palette: EdgePalette): {
  color: string;
  width: number;
  minimumWidth: number;
  dash: number[];
} {
  switch (kind) {
    case "adoptive":
    case "legal_parent":
    case "social_parent":
      return { color: palette.accent, width: 2, minimumWidth: 1.2, dash: [8, 5] };
    case "foster":
      return { color: palette.warm, width: 2, minimumWidth: 1.2, dash: [3, 5] };
    case "guardian":
      return { color: palette.accent, width: 2, minimumWidth: 1.2, dash: [10, 4, 2, 4] };
    case "donor":
      return { color: palette.danger, width: 2, minimumWidth: 1.2, dash: [2, 4] };
    case "surrogate":
      return { color: palette.warm, width: 2, minimumWidth: 1.2, dash: [12, 4, 2, 4] };
    case "step":
      return { color: palette.muted, width: 2, minimumWidth: 1.2, dash: [6, 5] };
    case "separated-partnership":
      return { color: palette.muted, width: 2, minimumWidth: 1.2, dash: [4, 5] };
    case "continuation":
      return {
        color: palette.continuation,
        width: 1.2,
        minimumWidth: 0.75,
        dash: [2.5, 5.5],
      };
    case "partnership":
      return { color: palette.partnership, width: 2.2, minimumWidth: 1.5, dash: [] };
    case "union-stem":
    case "siblings-bus":
      return { color: palette.structure, width: 2.05, minimumWidth: 1.35, dash: [] };
    case "biological":
    case "genetic_father":
    case "genetic_mother":
    case "gestational_parent":
    case "birth_parent":
    case "presumed":
      return { color: palette.structure, width: 2, minimumWidth: 1.35, dash: [] };
    default:
      return { color: palette.muted, width: 1.8, minimumWidth: 1.1, dash: [5, 4] };
  }
}

function edgePaintOrder(kind: LayoutEdge["kind"]): number {
  return kind === "continuation" ? 0 : 1;
}

export function TreeEdgeCanvas({
  width,
  height,
  camera,
  worldViewport,
  edges,
  unions,
  generationBands,
}: TreeEdgeCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    const computedStyle = window.getComputedStyle(canvas);
    const cssColor = (name: string, fallback: string): string =>
      computedStyle.getPropertyValue(name).trim() || fallback;
    const palette: EdgePalette = {
      accent: cssColor("--ft-accent", "#22574d"),
      muted: cssColor("--ft-muted", "#4f5f5a"),
      warm: cssColor("--ft-warm-accent", "#c98b34"),
      danger: cssColor("--ft-danger", "#b84e49"),
      structure: cssColor("--ft-edge-structure", "rgba(54, 70, 65, 0.88)"),
      partnership: cssColor("--ft-edge-partnership", "rgba(34, 75, 67, 0.92)"),
      continuation: cssColor(
        "--ft-edge-continuation",
        "rgba(157, 116, 52, 0.42)",
      ),
      generation: cssColor("--ft-edge-generation", "rgba(79, 95, 90, 0.11)"),
      generationLabel: cssColor(
        "--ft-edge-generation-label",
        "rgba(79, 95, 90, 0.7)",
      ),
      junction: cssColor("--ft-edge-junction", "rgba(54, 70, 65, 0.84)"),
    };
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const toScreen = (x: number, y: number): { x: number; y: number } => ({
      x: (x - camera.x) * camera.zoom + width / 2,
      y: (y - camera.y) * camera.zoom + height / 2,
    });

    context.save();
    context.font = `600 11px ${computedStyle.fontFamily || "system-ui, sans-serif"}`;
    context.textBaseline = "bottom";
    for (const band of generationBands) {
      if (band.bottom < worldViewport.top || band.top > worldViewport.bottom) continue;
      const top = toScreen(0, band.top).y;
      context.strokeStyle = palette.generation;
      context.lineWidth = 1;
      context.setLineDash([6, 8]);
      context.beginPath();
      context.moveTo(0, top);
      context.lineTo(width, top);
      context.stroke();
      if (camera.zoom >= 0.34) {
        context.fillStyle = palette.generationLabel;
        context.fillText(band.label, 14, top - 5);
      }
    }
    context.restore();

    const paintOrderedEdges = [...edges].sort(
      (left, right) => edgePaintOrder(left.kind) - edgePaintOrder(right.kind),
    );
    for (const edge of paintOrderedEdges) {
      if (edge.points.length < 2 || !intersects(edgeBounds(edge), worldViewport)) {
        continue;
      }
      const style = edgeStyle(edge.kind, palette);
      context.save();
      context.strokeStyle = style.color;
      context.lineWidth = Math.max(
        style.minimumWidth,
        style.width * Math.min(1.25, camera.zoom),
      );
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash(style.dash.map(value => value * Math.max(0.65, camera.zoom)));
      context.beginPath();
      edge.points.forEach((point, index) => {
        const screen = toScreen(point.x, point.y);
        if (index === 0) context.moveTo(screen.x, screen.y);
        else context.lineTo(screen.x, screen.y);
      });
      context.stroke();
      context.restore();
    }

    context.save();
    context.fillStyle = palette.junction;
    const renderedJunctions = new Set<string>();
    for (const union of unions) {
      if (
        union.x < worldViewport.left ||
        union.x > worldViewport.right ||
        union.y < worldViewport.top ||
        union.y > worldViewport.bottom
      ) {
        continue;
      }
      // A partnership and its per-child ParentSets intentionally retain their
      // semantic LayoutUnion records while sharing one visual family junction.
      // Paint that co-located junction once so translucent dots do not stack.
      const junctionKey = `${union.x}:${union.y}`;
      if (renderedJunctions.has(junctionKey)) continue;
      renderedJunctions.add(junctionKey);
      const screen = toScreen(union.x, union.y);
      context.beginPath();
      context.arc(screen.x, screen.y, Math.max(1.15, 1.75 * camera.zoom), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }, [camera, edges, generationBands, height, unions, width, worldViewport]);

  return <canvas ref={canvasRef} className="ft-edge-canvas" aria-hidden="true" />;
}
