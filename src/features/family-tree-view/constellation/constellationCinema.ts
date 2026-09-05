import type { CameraState } from "../types.ts";
import type { FamilyTreeChartColorScheme } from "../appearance/familyTreeChartColorScheme.ts";
import { starryTreeColorScheme } from "../appearance/starrySkyTheme.ts";
import { constellationLife, type ConstellationScene } from "./constellationModel.ts";
import { CONSTELLATION_ROLE_LABELS } from "./constellationPresentation.ts";
import type { ConstellationTimeModel } from "./constellationTime.ts";
import { constellationPeopleCount, constellationRecordCount, type ConstellationPlacesScene } from "./constellationPlaces.ts";

export type ConstellationTheme = "night" | "light";
export type ConstellationMode = "family" | "time" | "places";
export const MAX_CONSTELLATION_TOUR_STEPS = 60;
export const CONSTELLATION_STAR_FPS = 30;

/** Display-only adaptation. Never changes or saves the user's ancestry palette. */
export function constellationThemeColors(scheme: FamilyTreeChartColorScheme, theme: ConstellationTheme): FamilyTreeChartColorScheme {
  return theme === "light" ? scheme : starryTreeColorScheme(scheme);
}

export interface ConstellationTourStep {
  id: string; title: string; detail: string; personId?: string; placeId?: string; year?: number;
  x: number; y: number;
}
export interface ConstellationTour { steps: ConstellationTourStep[]; total: number }

/** Deterministic highlights of the loaded scope, not an invented family narrative. */
export function buildConstellationTour(mode: ConstellationMode, scene: ConstellationScene | undefined, time: ConstellationTimeModel, places: ConstellationPlacesScene): ConstellationTour {
  if (!scene) return { steps: [], total: 0 };
  const nodes = new Map(scene.nodes.filter(node => node.person.badges?.privacy !== "masked").map(node => [node.id, node]));
  let steps: ConstellationTourStep[];
  if (mode === "places") steps = places.nodes.map(node => ({ id: node.id, placeId: node.id, x: node.x, y: node.y, title: node.place.label,
    detail: `${constellationPeopleCount(node.place.personIds.length)} · ${constellationRecordCount(node.place.events.length)} подій. Схема згадок, не географічна мапа.` }));
  else if (mode === "time") steps = time.events.filter(event => event.date.reference !== undefined && event.personIds.some(id => nodes.has(id)))
    .sort((a, b) => a.date.reference! - b.date.reference! || a.id.localeCompare(b.id)).map(event => {
      const node = nodes.get(event.personIds.find(id => nodes.has(id))!)!;
      return { id: event.id, personId: node.id, year: event.date.reference, x: node.x, y: node.y,
        title: `${event.date.text} · ${event.title}`, detail: `${node.person.displayName}${event.place ? ` · ${event.place}` : ""}` };
    });
  else steps = [...nodes.values()].sort((a, b) => a.distance - b.distance || a.generation - b.generation || a.id.localeCompare(b.id))
    .map(node => ({ id: node.id, personId: node.id, x: node.x, y: node.y, title: node.person.displayName,
      detail: [CONSTELLATION_ROLE_LABELS[node.role], constellationLife(node.person)].filter(Boolean).join(" · ") }));
  // Sample across the entire sequence rather than silently dropping the most recent years.
  const total = steps.length;
  if (total > MAX_CONSTELLATION_TOUR_STEPS) steps = Array.from({ length: MAX_CONSTELLATION_TOUR_STEPS }, (_, index) => steps[Math.round(index * (total - 1) / (MAX_CONSTELLATION_TOUR_STEPS - 1))]!);
  return { steps, total };
}

export function interpolateConstellationCamera(from: CameraState, to: CameraState, progress: number): CameraState {
  if (progress <= 0) return { ...from };
  if (progress >= 1) return { ...to };
  const t = Math.min(1, Math.max(0, progress)); const eased = t * t * (3 - 2 * t);
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased,
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * eased) };
}

export { skyStars as constellationStars, skyStarPoint as constellationStarPoint, type SkyStar as ConstellationStar } from "../appearance/skyStars.ts";
