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

/** Family: every loaded direct ancestor in generation order. Time/places: bounded highlights. */
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
  else steps = [...nodes.values()]
    .filter(node => node.id === scene.focusId || node.role === "ancestor")
    .sort((a, b) => Number(b.id === scene.focusId) - Number(a.id === scene.focusId)
      || Math.abs(a.generation) - Math.abs(b.generation)
      || (a.ancestorOrder ?? Number.MAX_SAFE_INTEGER) - (b.ancestorOrder ?? Number.MAX_SAFE_INTEGER)
      || (a.ancestorSlot ?? Number.MAX_SAFE_INTEGER) - (b.ancestorSlot ?? Number.MAX_SAFE_INTEGER)
      || a.person.displayName.localeCompare(b.person.displayName, "uk") || a.id.localeCompare(b.id))
    .map(node => {
      const generation = Math.abs(node.generation);
      const label = node.id === scene.focusId ? CONSTELLATION_ROLE_LABELS.focus
        : `${generation === 1 ? "Батьки" : generation === 2 ? "Дідусі та бабусі" : "Предки"} · покоління ${generation}`;
      return { id: node.id, personId: node.id, x: node.x, y: node.y, title: node.person.displayName,
        detail: [label, constellationLife(node.person)].filter(Boolean).join(" · ") };
    });
  // The family scene is already bounded to 1,000 people. Do not sample it:
  // that would skip parents or leave gaps inside a generation. Time/place
  // highlights still sample the entire sequence, retaining both endpoints.
  const total = steps.length;
  if (mode !== "family" && total > MAX_CONSTELLATION_TOUR_STEPS) steps = Array.from({ length: MAX_CONSTELLATION_TOUR_STEPS }, (_, index) => steps[Math.round(index * (total - 1) / (MAX_CONSTELLATION_TOUR_STEPS - 1))]!);
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
