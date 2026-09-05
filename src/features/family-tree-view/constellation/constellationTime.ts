import type { Person, PersonEvent, PersonEventType } from "../../../types/index.ts";
import type { FamilyGraphData } from "../types.ts";
import type { ConstellationEdge, ConstellationScene } from "./constellationModel.ts";
import { personEventLabel } from "../../../utils/geo.ts";
import { constellationDateAtYear, constellationProfileDate, parseConstellationDate, type ConstellationDate } from "./constellationDates.ts";
import { compatibleConstellationPlaces, constellationPlaceReference, type ConstellationPlaceReference } from "./constellationPlaceIdentity.ts";

export type ConstellationTimeProfile = Pick<Person, "id"> & Partial<Pick<Person,
  "birthDate" | "birthYearFrom" | "birthYearTo" | "birthPlace" | "deathDate" | "deathYearFrom" | "deathYearTo" | "deathPlace" | "marriageDate" | "marriagePlace" | "residencePlaces" | "isLiving">> & { events?: readonly PersonEvent[] };
export type ConstellationLifeState = "future" | "alive" | "deceased" | "unknown";
export const CONSTELLATION_LIFE_LABELS: Record<ConstellationLifeState, string> = {
  future: "Ще не народилась", alive: "Жила в цьому році", deceased: "Померла до цього року", unknown: "Недостатньо дат",
};
export interface ConstellationTimeEvent extends ConstellationPlaceReference {
  id: string; personIds: string[]; type: PersonEventType | "partnership" | "partnership_end";
  title: string; date: ConstellationDate; place: string;
}
interface PersonTime {
  birth: ConstellationDate; death: ConstellationDate; isLiving: boolean; masked: boolean;
  events: ConstellationTimeEvent[];
}
interface UnionTime { start: ConstellationDate; end: ConstellationDate }
export interface ConstellationTimeModel {
  persons: Map<string, PersonTime>;
  unions: Map<string, UnionTime>;
  events: ConstellationTimeEvent[];
  years: number[];
  range?: { min: number; max: number };
  currentYear: number;
}
export interface ConstellationTimeSlice {
  year: number;
  persons: Map<string, { state: ConstellationLifeState; conflict: boolean; lastPlaces: ConstellationTimeEvent[] }>;
  unions: Map<string, "future" | "started" | "ended" | "unknown">;
  events: { event: ConstellationTimeEvent; certainty: "dated" | "possible" | "approximate" }[];
  counts: Record<ConstellationLifeState, number>;
}
const dateText = (date?: { display?: string; sort?: string }) => date?.display?.trim() || date?.sort;
const isDated = (date: ConstellationDate) => date.precision !== "unknown";

/** Joins already-loaded, authorized profiles only to visible, unmasked nodes. No requests or mutations. */
export function buildConstellationTimeModel(scene: ConstellationScene | undefined, graph: FamilyGraphData,
  profiles: readonly ConstellationTimeProfile[], currentYear: number): ConstellationTimeModel {
  const model: ConstellationTimeModel = { persons: new Map(), unions: new Map(), events: [], years: [], currentYear };
  if (!scene) return model;
  const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
  for (const node of scene.nodes) {
    // isPrivate describes record visibility, not the viewer's permission. Both RPC versions
    // mark actually redacted records explicitly, including when a full profile is cached.
    const masked = node.person.badges?.privacy === "masked";
    const profile = masked ? undefined : profilesById.get(node.id);
    const rawEvents = profile?.events ?? [];
    const birth = masked ? parseConstellationDate() : constellationProfileDate(profile?.birthDate, profile?.birthYearFrom, profile?.birthYearTo,
      dateText(node.person.birth) || rawEvents.find(event => event.type === "birth")?.date || undefined);
    const death = masked ? parseConstellationDate() : constellationProfileDate(profile?.deathDate, profile?.deathYearFrom, profile?.deathYearTo,
      dateText(node.person.death) || rawEvents.find(event => event.type === "death")?.date || undefined);
    const info: PersonTime = { birth, death, masked, isLiving: !masked && (profile?.isLiving ?? node.person.isLiving) === true, events: [] };
    model.persons.set(node.id, info);
    if (info.masked) continue;
    const add = (event: ConstellationTimeEvent) => { info.events.push(event); model.events.push(event); };
    for (const [type, date, place] of [["birth", birth, profile?.birthPlace ?? ""], ["death", death, profile?.deathPlace ?? ""], ["marriage", parseConstellationDate(profile?.marriageDate), profile?.marriagePlace ?? ""]] as const) {
      if (!date.text && !place) continue;
      add({ id: `core:${node.id}:${type}`, personIds: [node.id], type, title: personEventLabel(type), date, place });
    }
    const seen = new Set<string>();
    for (const event of rawEvents) {
      if (event.personId !== node.id || seen.has(event.id)) continue;
      seen.add(event.id);
      const date = parseConstellationDate(event.date);
      const place = constellationPlaceReference(event);
      // Collapse only a core copy of the same dated fact, not distinct user-created events.
      const core = info.events.find(candidate => candidate.id.startsWith("core:") && candidate.type === event.type && date.text && candidate.date.key === date.key && compatibleConstellationPlaces(candidate, place));
      if (core) {
        if (!core.place) core.place = place.place;
        if (place.placeId) { core.placeId = place.placeId; core.placeCanonicalName = place.placeCanonicalName; }
        continue;
      }
      add({ id: `event:${node.id}:${event.id}`, personIds: [node.id], type: event.type, title: event.title?.trim() || personEventLabel(event.type), date, ...place });
    }
    // Legacy free text is one unlocated wording, not a list of geocoded settlements.
    if (profile?.residencePlaces?.trim() && !rawEvents.some(event => event.type === "residence" && event.personId === node.id)) {
      add({ id: `core:${node.id}:residence`, personIds: [node.id], type: "residence", title: "Місця проживання (старий запис)", date: parseConstellationDate(), place: profile.residencePlaces.trim() });
    }
  }
  const unionIds = new Set(scene.edges.filter(edge => edge.kind === "partner").map(edge => edge.unionId));
  for (const union of graph.unions) {
    if (union.kind !== "partnership" || !unionIds.has(union.id)) continue;
    const members = [...new Set(union.memberIds)].filter(id => model.persons.has(id));
    if (members.length < 2 || members.some(id => model.persons.get(id)!.masked)) continue;
    const start = parseConstellationDate(dateText(union.startDate));
    const end = parseConstellationDate(dateText(union.endDate));
    model.unions.set(union.id, { start, end });
    const married = /marri|шлюб/iu.test(union.relationshipType ?? "") || union.status === "married" || union.status === "divorced";
    for (const [suffix, date, type, title] of [
      ["start", start, married ? "marriage" : "partnership", married ? "Шлюб" : "Початок партнерства"],
      ["end", end, union.status === "divorced" ? "divorce" : "partnership_end", union.status === "divorced" ? "Розлучення" : "Завершення партнерства"],
    ] as const) {
      if (!date.text) continue;
      // Prefer one explicit union event to the legacy copies in both partners' core fields.
      const candidates = model.events.filter(event => event.id.startsWith("core:") && event.type === type && members.includes(event.personIds[0]!) && event.date.key === date.key);
      const locatedCopies = candidates.filter(candidate => candidate.place || candidate.placeId);
      const copies = locatedCopies.every(a => locatedCopies.every(b => compatibleConstellationPlaces(a, b))) ? candidates : [];
      const copyIds = new Set(copies.map(event => event.id));
      model.events = model.events.filter(event => !copyIds.has(event.id));
      const sourcePlace = copies.find(copy => copy.placeId) ?? copies.find(copy => copy.place);
      const event: ConstellationTimeEvent = { id: `union:${union.id}:${suffix}`, personIds: members, type, title, date,
        place: sourcePlace?.place ?? "", placeId: sourcePlace?.placeId, placeCanonicalName: sourcePlace?.placeCanonicalName };
      model.events.push(event);
      for (const id of members) {
        const info = model.persons.get(id)!;
        info.events = info.events.filter(candidate => !copyIds.has(candidate.id));
        info.events.push(event);
      }
    }
  }
  model.events.sort((a, b) => (a.date.reference ?? Infinity) - (b.date.reference ?? Infinity) || a.id.localeCompare(b.id));
  model.years = [...new Set(model.events.flatMap(event => isDated(event.date) ? [event.date.min, event.date.max, event.date.reference].filter((year): year is number => year !== undefined && year >= 1 && year <= 9999) : []))].sort((a, b) => a - b);
  if (model.years.length) model.range = { min: Math.max(1, model.years[0]! - 1), max: Math.min(9999, Math.max(currentYear, model.years[model.years.length - 1]!)) };
  return model;
}

function personAtYear(info: PersonTime, year: number, currentYear: number) {
  const { birth, death } = info;
  const disjoint = (a: ConstellationDate, b: ConstellationDate) =>
    (a.min !== undefined && b.max !== undefined && a.min > b.max) || (a.max !== undefined && b.min !== undefined && a.max < b.min);
  const conflict = (birth.min !== undefined && death.max !== undefined && birth.min > death.max)
    || (info.isLiving && death.max !== undefined && death.max < currentYear)
    || info.events.some(event => (event.type === "birth" && disjoint(birth, event.date)) || (event.type === "death" && disjoint(death, event.date)));
  let state: ConstellationLifeState = "unknown";
  if (!info.masked && !conflict) {
    if (birth.min !== undefined && year < birth.min) state = "future";
    else if (death.max !== undefined && death.max < year) state = "deceased";
    else if (birth.max !== undefined && birth.max <= year && ((death.min !== undefined && year <= death.min) || (info.isLiving && year <= currentYear))) state = "alive";
    // An exactly dated personal event establishes presence in its year, not an entire inferred lifespan.
    else if (info.events.some(event => ["birth", "death", "marriage", "divorce", "residence", "immigration", "emigration", "census"].includes(event.type) && event.date.min === year && event.date.max === year)) state = "alive";
  }
  const located = info.events.filter(event => event.place && event.date.max !== undefined && event.date.max <= year && ["birth", "death", "marriage", "residence", "immigration", "emigration", "census", "mention"].includes(event.type));
  const latest = located.reduce((year, event) => Math.max(year, event.date.max!), -Infinity);
  // Keep ties: year-only records do not establish an ordering between two settlements.
  return { state, conflict, lastPlaces: located.filter(event => event.date.max === latest) };
}

export function projectConstellationTime(model: ConstellationTimeModel, year: number): ConstellationTimeSlice {
  const slice: ConstellationTimeSlice = { year, persons: new Map(), unions: new Map(), events: [], counts: { future: 0, alive: 0, deceased: 0, unknown: 0 } };
  for (const [id, info] of model.persons) {
    const state = personAtYear(info, year, model.currentYear);
    slice.persons.set(id, state); slice.counts[state.state]++;
  }
  for (const [id, { start, end }] of model.unions) {
    const conflict = start.min !== undefined && end.max !== undefined && start.min > end.max;
    slice.unions.set(id, conflict ? "unknown" : start.min !== undefined && year < start.min ? "future" : end.max !== undefined && end.max < year ? "ended" : start.max !== undefined && start.max <= year ? "started" : "unknown");
  }
  for (const event of model.events) {
    const certainty = constellationDateAtYear(event.date, year);
    if (certainty) slice.events.push({ event, certainty });
  }
  return slice;
}

export const CONSTELLATION_UNION_TIME_LABELS = { future: "Початок зв’язку пізніше", started: "Після дати початку зв’язку", ended: "Зв’язок завершився раніше", unknown: "Дати зв’язку неповні" };

export function constellationTimeEdgeLabel(edge: ConstellationEdge | undefined, slice?: ConstellationTimeSlice): string {
  if (!edge) return "";
  if (!slice || edge.kind !== "partner") return edge.label;
  return `Партнерський зв’язок · ${CONSTELLATION_UNION_TIME_LABELS[slice.unions.get(edge.unionId ?? "") ?? "unknown"]}`;
}
