import { mixChartHexColors, readableChartForeground, type FamilyTreeChartColorScheme, type FamilyTreeChartTone } from "./familyTreeChartColorScheme.ts";

/** Display-only adaptation: keep the saved hue without changing the saved palette. */
export function luminousTreeColor(hex: string): string {
  const values = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(...values); const min = Math.min(...values); const delta = max - min;
  if (delta < 0.025) return "#c7d3e8";
  const [r, g, b] = values as [number, number, number];
  const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) + 6) % 6;
  const light = 0.67; const chroma = (1 - Math.abs(2 * light - 1)) * 0.86;
  const x = chroma * (1 - Math.abs(hue % 2 - 1)); const m = light - chroma / 2;
  const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function starryTreeTone(color: string): FamilyTreeChartTone {
  const stroke = luminousTreeColor(color);
  const fill = mixChartHexColors(stroke, "#081021", 0.26);
  return { stroke, fill, foreground: readableChartForeground(fill, "#f3f7ff") };
}

export function starryTreeColorScheme(scheme: FamilyTreeChartColorScheme): FamilyTreeChartColorScheme {
  const tone = (source: FamilyTreeChartTone) => starryTreeTone(source.stroke);
  return { ...scheme, background: "#050814", text: "#f0f5ff", mutedText: "#aebed7", grid: "#6c83b0",
    lineage: scheme.lineage.map(tone) as unknown as FamilyTreeChartColorScheme["lineage"],
    lineageBase: tone(scheme.lineageBase), paternal: tone(scheme.paternal), maternal: tone(scheme.maternal),
    focus: tone(scheme.focus), duplicate: tone(scheme.duplicate) };
}

/** Exports show the whole diagram, not the last zoomed/panned screen rectangle. */
export function prepareStarrySkyForExport(svg: SVGSVGElement, bounds: { x: number; y: number; width: number; height: number }): void {
  svg.querySelectorAll<SVGSVGElement>("[data-starry-sky]").forEach(layer => {
    for (const key of ["x", "y", "width", "height"] as const) layer.setAttribute(key, String(bounds[key]));
  });
}

/** Cover SVG letterboxing too, without changing chart viewBox or camera math. */
export function starrySkyViewportBounds(bounds: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) {
  if (viewport.width <= 1 || viewport.height <= 1) return bounds;
  const scale = Math.min(viewport.width / bounds.width, viewport.height / bounds.height);
  if (!Number.isFinite(scale) || scale <= 0) return bounds;
  const width = viewport.width / scale; const height = viewport.height / scale;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
}
