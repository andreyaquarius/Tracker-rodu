import type { CameraState, LayoutBounds } from "../types.ts";
import type { ConstellationTimeEvent, ConstellationTimeModel } from "./constellationTime.ts";
import { constellationPlaceKey, normalizeConstellationPlaceText } from "./constellationPlaceIdentity.ts";
import { constellationScreenPoint } from "./constellationPresentation.ts";

export const MAX_CONSTELLATION_PLACES = 120;
export const MAX_CONSTELLATION_PLACE_LINKS = 600;
export const constellationCount = (count: number, forms: readonly [string, string, string]) => `${count} ${forms[count % 100 >= 11 && count % 100 <= 14 ? 2 : count % 10 === 1 ? 0 : count % 10 >= 2 && count % 10 <= 4 ? 1 : 2]}`;
export const constellationPeopleCount = (count: number) => constellationCount(count, ["особа", "особи", "осіб"]);
export const constellationRecordCount = (count: number) => constellationCount(count, ["запис", "записи", "записів"]);
export interface ConstellationPlace {
  id: string; label: string; canonicalId?: string; aliases: string[];
  personIds: string[]; events: ConstellationTimeEvent[]; migrationEventCount: number;
}
export interface PlaceObservation { id: string; personId: string; placeId: string; event: ConstellationTimeEvent }
export interface PlaceSequenceGroup {
  id: string; earliest: number; latest: number; placeIds: string[]; observations: PlaceObservation[];
}
export interface PlaceTransition {
  id: string; personId: string; source: string; target: string;
  from: PlaceObservation; to: PlaceObservation; hasMigrationEvent: boolean;
}
export interface PlaceJourney {
  observations: PlaceObservation[]; groups: PlaceSequenceGroup[]; transitions: PlaceTransition[];
  unsequenced: PlaceObservation[]; ambiguousGroupCount: number;
}
export interface ConstellationPlaceLink { id: string; source: string; target: string; personIds: string[]; transitions: PlaceTransition[] }
export interface ConstellationPlacesModel {
  places: Map<string, ConstellationPlace>; journeys: Map<string, PlaceJourney>; links: ConstellationPlaceLink[];
  personCount: number; peopleWithoutPlaces: number; maskedPeople: number; eventCount: number;
}
export interface ConstellationPlaceNode { id: string; place: ConstellationPlace; x: number; y: number; radius: number }
export interface ConstellationPlacesScene {
  nodes: ConstellationPlaceNode[]; links: ConstellationPlaceLink[]; bounds: LayoutBounds; centerId?: string; omittedCount: number;
}
export const isConstellationMigration = (event: ConstellationTimeEvent) => event.type === "immigration" || event.type === "emigration";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const observationOrder = (a: PlaceObservation, b: PlaceObservation) => (a.event.date.earliest ?? Infinity) - (b.event.date.earliest ?? Infinity)
  || (a.event.date.latest ?? Infinity) - (b.event.date.latest ?? Infinity) || compare(a.id, b.id);

/** Overlapping dates form one unordered group. Never skip an ambiguous group to invent a route. */
export function buildConstellationPlaceJourney(observations: readonly PlaceObservation[]): PlaceJourney {
  const ordered = [...observations].sort(observationOrder);
  const groups: PlaceSequenceGroup[] = [];
  const unsequenced: PlaceObservation[] = [];
  for (const observation of ordered) {
    const { earliest, latest } = observation.event.date;
    if (earliest === undefined || latest === undefined || earliest > latest) { unsequenced.push(observation); continue; }
    const previous = groups.at(-1);
    if (previous && earliest <= previous.latest) {
      previous.latest = Math.max(previous.latest, latest);
      previous.observations.push(observation);
      if (!previous.placeIds.includes(observation.placeId)) previous.placeIds.push(observation.placeId);
    } else groups.push({ id: observation.id, earliest, latest, placeIds: [observation.placeId], observations: [observation] });
  }
  const transitions: PlaceTransition[] = [];
  for (let index = 1; index < groups.length; index++) {
    const previous = groups[index - 1]!; const next = groups[index]!;
    if (previous.placeIds.length !== 1 || next.placeIds.length !== 1 || previous.placeIds[0] === next.placeIds[0]) continue;
    const from = [...previous.observations].sort((a, b) => b.event.date.latest! - a.event.date.latest! || compare(a.id, b.id))[0]!;
    const to = next.observations[0]!;
    transitions.push({ id: JSON.stringify([from.personId, from.id, to.id]), personId: from.personId, source: from.placeId, target: to.placeId, from, to,
      hasMigrationEvent: [...previous.observations, ...next.observations].some(observation => isConstellationMigration(observation.event)) });
  }
  return { observations: ordered, groups, transitions, unsequenced, ambiguousGroupCount: groups.filter(group => group.placeIds.length > 1).length };
}

/** No geocoder, remote tiles, guessed administrative areas or surname-based locations. */
export function buildConstellationPlacesModel(time: ConstellationTimeModel): ConstellationPlacesModel {
  const places = new Map<string, ConstellationPlace>();
  const observations = new Map<string, PlaceObservation[]>();
  const memberSets = new Map<string, Set<string>>();
  const aliasSets = new Map<string, Set<string>>();
  const canonicalLabels = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const event of time.events) {
    if ((!event.place.trim() && !event.placeId) || seen.has(event.id)) continue;
    const personIds = [...new Set(event.personIds)].filter(id => time.persons.has(id) && !time.persons.get(id)!.masked);
    if (!personIds.length) continue;
    seen.add(event.id);
    const id = constellationPlaceKey(event);
    let place = places.get(id);
    if (!place) {
      place = { id, label: "", canonicalId: event.placeId, aliases: [], personIds: [], events: [], migrationEventCount: 0 };
      places.set(id, place); memberSets.set(id, new Set()); aliasSets.set(id, new Set()); canonicalLabels.set(id, new Set());
    }
    if (event.place.trim()) aliasSets.get(id)!.add(event.place.trim().replace(/\s+/gu, " "));
    if (event.placeCanonicalName?.trim()) canonicalLabels.get(id)!.add(event.placeCanonicalName.trim());
    place.events.push(event);
    if (isConstellationMigration(event)) place.migrationEventCount++;
    for (const personId of personIds) {
      memberSets.get(id)!.add(personId);
      const list = observations.get(personId) ?? [];
      list.push({ id: JSON.stringify([personId, event.id]), personId, placeId: id, event }); observations.set(personId, list);
    }
  }
  for (const [id, place] of places) {
    place.aliases = [...aliasSets.get(id)!].sort(compare);
    place.label = [...canonicalLabels.get(id)!].sort(compare)[0] || place.aliases[0] || "Місце без назви";
    place.personIds = [...memberSets.get(id)!].sort(compare);
    place.events.sort((a, b) => (a.date.earliest ?? Infinity) - (b.date.earliest ?? Infinity) || compare(a.id, b.id));
  }
  const journeys = new Map([...observations].sort(([a], [b]) => compare(a, b)).map(([id, records]) => [id, buildConstellationPlaceJourney(records)]));
  const links = new Map<string, ConstellationPlaceLink>();
  for (const journey of journeys.values()) for (const transition of journey.transitions) {
    const id = JSON.stringify([transition.source, transition.target]);
    const link = links.get(id) ?? { id, source: transition.source, target: transition.target, personIds: [], transitions: [] };
    link.transitions.push(transition);
    if (!link.personIds.includes(transition.personId)) link.personIds.push(transition.personId);
    links.set(id, link);
  }
  return { places, journeys, links: [...links.values()].sort((a, b) => compare(a.id, b.id)), personCount: observations.size,
    peopleWithoutPlaces: [...time.persons].filter(([id, person]) => !person.masked && !observations.has(id)).length,
    maskedPeople: [...time.persons.values()].filter(person => person.masked).length, eventCount: seen.size };
}

export function buildConstellationPlacesScene(model: ConstellationPlacesModel, onlyPersonId?: string, pinnedPlaceId?: string): ConstellationPlacesScene {
  const ranked = [...model.places.values()].filter(place => !onlyPersonId || place.personIds.includes(onlyPersonId)).sort((a, b) =>
    Number(b.id === pinnedPlaceId) - Number(a.id === pinnedPlaceId) || b.personIds.length - a.personIds.length || b.events.length - a.events.length || compare(a.id, b.id));
  const visible = ranked.slice(0, MAX_CONSTELLATION_PLACES);
  const nodes: ConstellationPlaceNode[] = [];
  let ring = 0; let position = 0;
  for (const [index, place] of visible.entries()) {
    if (index && position >= 6 * ring) { ring++; position = 0; }
    const capacity = Math.min(6 * ring, visible.length - (1 + 3 * (ring - 1) * ring));
    const angle = -Math.PI / 2 + (position / Math.max(1, capacity)) * Math.PI * 2 + (ring % 2 ? 0.15 : 0);
    nodes.push({ id: place.id, place, x: index ? Math.cos(angle) * ring * 300 : 0, y: index ? Math.sin(angle) * ring * 260 : 0,
      radius: 28 + Math.min(24, Math.log2(place.personIds.length + 1) * 6) });
    if (index) position++;
  }
  const ids = new Set(nodes.map(node => node.id));
  const bounds = nodes.reduce((bounds, node) => ({ left: Math.min(bounds.left, node.x - 130), right: Math.max(bounds.right, node.x + 130),
    top: Math.min(bounds.top, node.y - 100), bottom: Math.max(bounds.bottom, node.y + 180) }), { left: -130, right: 130, top: -100, bottom: 180 });
  return { nodes, links: model.links.filter(link => ids.has(link.source) && ids.has(link.target)), bounds, centerId: nodes[0]?.id, omittedCount: ranked.length - nodes.length };
}

export const constellationPlaceRadius = (node: ConstellationPlaceNode, zoom: number) => Math.max(9, Math.min(52, node.radius * Math.sqrt(zoom)));
export function constellationPlaceHitTest(scene: ConstellationPlacesScene, camera: CameraState, size: { width: number; height: number }, point: { x: number; y: number }) {
  let id: string | undefined; let distance = Infinity;
  for (const node of scene.nodes) {
    const screen = constellationScreenPoint(node, camera, size);
    const delta = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (delta <= Math.max(22, constellationPlaceRadius(node, camera.zoom)) && delta < distance) { id = node.id; distance = delta; }
  }
  return id;
}
export function constellationPlaceLabels(scene: ConstellationPlacesScene, camera: CameraState, size: { width: number; height: number }, selectedPlaceId?: string) {
  const boxes: { left: number; right: number; top: number; bottom: number }[] = [];
  return [...scene.nodes].sort((a, b) => Number(b.id === selectedPlaceId) - Number(a.id === selectedPlaceId) || Number(b.id === scene.centerId) - Number(a.id === scene.centerId) || b.place.personIds.length - a.place.personIds.length || compare(a.id, b.id)).flatMap(node => {
    const point = constellationScreenPoint(node, camera, size);
    if (point.x < 12 || point.x > size.width - 12 || point.y < 8 || point.y > size.height - 105 || boxes.length >= 60) return [];
    if (camera.zoom < 0.16 && node.id !== selectedPlaceId && node.id !== scene.centerId) return [];
    const width = Math.min(240, Math.max(144, node.place.label.length * 9 + 32), size.width - 16);
    const x = Math.max(width / 2 + 8, Math.min(size.width - width / 2 - 8, point.x));
    const y = point.y + constellationPlaceRadius(node, camera.zoom) + 9;
    const box = { left: x - width / 2 - 4, right: x + width / 2 + 4, top: y - 2, bottom: y + 57 };
    if (box.right > size.width - 180 && box.bottom > size.height - 76) return []; // Keep labels clear of the logo.
    if (box.bottom > size.height - 8 || boxes.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) return [];
    boxes.push(box); return [{ node, x, y, width }];
  });
}
export function searchConstellationPlaces(model: ConstellationPlacesModel, query: string) {
  const normalized = normalizeConstellationPlaceText(query);
  return [...model.places.values()].filter(place => !normalized || [place.label, ...place.aliases].some(text => normalizeConstellationPlaceText(text).includes(normalized)))
    .sort((a, b) => b.personIds.length - a.personIds.length || compare(a.id, b.id));
}

/** Prioritize the selected person's sequence; large aggregates must not turn into an unbounded hairball. */
export function constellationVisiblePlaceLinks(scene: ConstellationPlacesScene, selectedPersonId: string, showOthers: boolean) {
  const eligible = scene.links.filter(link => showOthers || link.personIds.includes(selectedPersonId)).sort((a, b) =>
    Number(b.personIds.includes(selectedPersonId)) - Number(a.personIds.includes(selectedPersonId)) || b.personIds.length - a.personIds.length || compare(a.id, b.id));
  return { links: eligible.slice(0, MAX_CONSTELLATION_PLACE_LINKS), omittedCount: Math.max(0, eligible.length - MAX_CONSTELLATION_PLACE_LINKS) };
}
