import type {
  CustomFieldValues,
  Finding,
  GeoPoint,
  GeoPrecision,
  GeoSource,
  Person,
  PersonEvent,
  PersonEventType,
} from "../types";
import { createId } from "./id.ts";

export const PERSON_EVENTS_META_KEY = "__trackerRoduPersonEvents";
export const FINDING_GEO_META_KEY = "geo";
export const GEO_MARKER_COLORS = [
  "#0f4a42",
  "#c49a32",
  "#b84e49",
  "#2f6f9f",
  "#6f5aa8",
  "#2f7d4f",
  "#9a5b20",
  "#1f2937",
] as const;
export const DEFAULT_GEO_MARKER_COLOR = GEO_MARKER_COLORS[0];

const eventLabels: Record<PersonEventType, string> = {
  birth: "Народження",
  baptism: "Хрещення",
  christening: "Хрещення",
  marriage: "Шлюб",
  divorce: "Розлучення",
  residence: "Проживання",
  census: "Перепис населення",
  revision_list: "Ревізька казка",
  confession_list: "Сповідний розпис",
  household_register: "Погосподарська книга",
  immigration: "Імміграція",
  emigration: "Еміграція",
  military: "Військова служба",
  occupation: "Професія або заняття",
  education: "Освіта",
  nationality: "Національність",
  death: "Смерть",
  burial: "Поховання",
  cremation: "Кремація",
  probate: "Спадкова справа",
  mention: "Згадка у джерелі",
  other: "Інша подія",
};

export const PERSON_EVENT_TYPES = Object.freeze(
  Object.keys(eventLabels) as PersonEventType[],
);

export function personEventLabel(type: PersonEventType): string {
  return eventLabels[type] ?? eventLabels.other;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;
}

export function shouldSearchGeoPlaces(query: string, value: GeoPoint | null | undefined): boolean {
  return !isValidCoordinate(value?.latitude, value?.longitude) && query.trim().length >= 3;
}

export function formatGeoCoordinates(
  value: Pick<GeoPoint, "latitude" | "longitude"> | null | undefined,
  precision = 6,
): string {
  if (!isValidCoordinate(value?.latitude, value?.longitude)) return "";
  return `${Number(value?.latitude).toFixed(precision)}, ${Number(value?.longitude).toFixed(precision)}`;
}

export function formatGeoSelectionLabel(
  placeName: string | null | undefined,
  value: Pick<GeoPoint, "displayName" | "latitude" | "longitude"> | null | undefined,
): string {
  const label = placeName?.trim() || value?.displayName?.trim() || "Точна точка на карті";
  const coordinates = formatGeoCoordinates(value);
  return coordinates ? `${label} · ${coordinates}` : label;
}

export function geoMarkerColor(value: unknown, fallback: string = DEFAULT_GEO_MARKER_COLOR): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return (GEO_MARKER_COLORS as readonly string[]).includes(normalized)
    ? normalized
    : fallback;
}

export function normalizeGeo(value: unknown): GeoPoint | null {
  const record = asRecord(value);
  if (!isValidCoordinate(record.latitude, record.longitude)) return null;
  const source = String(record.source ?? "unknown") as GeoSource;
  const precision = String(record.precision ?? "unknown") as GeoPrecision;
  return {
    displayName: typeof record.displayName === "string" && record.displayName.trim()
      ? record.displayName
      : null,
    latitude: Number(record.latitude),
    longitude: Number(record.longitude),
    source: ["search", "map_click", "import", "unknown"].includes(source) ? source : "unknown",
    precision: ["exact", "approximate", "settlement", "unknown"].includes(precision) ? precision : "unknown",
    provider: typeof record.provider === "string" ? record.provider : null,
    externalId: typeof record.externalId === "string" ? record.externalId : null,
    markerColor: geoMarkerColor(record.markerColor),
  };
}

function baseEvent(
  person: Pick<Person, "id" | "birthDate" | "birthPlace" | "marriageDate" | "marriagePlace" | "deathDate" | "deathPlace" | "residencePlaces">,
  type: PersonEventType,
  date: string,
  placeName: string,
): PersonEvent {
  return {
    id: type,
    personId: person.id,
    type,
    title: personEventLabel(type),
    date: date || null,
    placeName: placeName || null,
    geo: null,
    notes: null,
  };
}

export function standardPersonEvents(
  person: Pick<Person, "id" | "birthDate" | "birthPlace" | "marriageDate" | "marriagePlace" | "deathDate" | "deathPlace" | "residencePlaces">,
): PersonEvent[] {
  return [
    baseEvent(person, "birth", person.birthDate, person.birthPlace),
    baseEvent(person, "marriage", person.marriageDate, person.marriagePlace),
    baseEvent(person, "death", person.deathDate, person.deathPlace),
    baseEvent(person, "residence", "", person.residencePlaces),
  ];
}

function normalizePersonEvent(value: unknown, personId: string): PersonEvent | null {
  const record = asRecord(value);
  const type = String(record.type ?? "other") as PersonEventType;
  if (!Object.keys(eventLabels).includes(type)) return null;
  const id = typeof record.id === "string" && record.id ? record.id : createId();
  return {
    id,
    personId,
    type,
    title: typeof record.title === "string" ? record.title : personEventLabel(type),
    date: typeof record.date === "string" && record.date ? record.date : null,
    placeName: typeof record.placeName === "string" && record.placeName ? record.placeName : null,
    value: typeof record.value === "string" && record.value ? record.value : null,
    age: typeof record.age === "string" && record.age ? record.age : null,
    cause: typeof record.cause === "string" && record.cause ? record.cause : null,
    address: typeof record.address === "string" && record.address ? record.address : null,
    geo: normalizeGeo(record.geo),
    notes: typeof record.notes === "string" && record.notes ? record.notes : null,
  };
}

export function normalizePersonEvents(value: unknown, person: Pick<Person, "id" | "birthDate" | "birthPlace" | "marriageDate" | "marriagePlace" | "deathDate" | "deathPlace" | "residencePlaces">): PersonEvent[] {
  const saved = Array.isArray(value)
    ? value
        .map((item) => normalizePersonEvent(item, person.id))
        .filter((item): item is PersonEvent => Boolean(item))
    : [];
  const byType = groupPersonEventsByType(saved);
  const consumed = new Set<PersonEvent>();
  const standard = standardPersonEvents(person).flatMap((event) => {
    if (event.type === "residence" && (byType.get("residence")?.length ?? 0) > 0) return [];
    const candidates = byType.get(event.type) ?? [];
    const savedEvent = candidates.find((candidate) => candidate.id === event.id)
      ?? candidates.find((candidate) => sameCanonicalEvent(candidate, event));
    if (savedEvent) consumed.add(savedEvent);
    return [savedEvent
      ? {
          ...savedEvent,
          id: event.id,
          personId: person.id,
          title: event.title,
          date: event.date,
          placeName: event.placeName,
        }
      : event];
  });
  return [
    ...standard,
    ...saved.filter((event) => !consumed.has(event)),
  ];
}

export function syncPersonEventsFromFields(person: Person): PersonEvent[] {
  const currentEvents = person.events ?? [];
  const current = groupPersonEventsByType(currentEvents);
  const consumed = new Set<PersonEvent>();
  const standard = standardPersonEvents(person).flatMap((event) => {
    if (event.type === "residence" && (current.get("residence")?.length ?? 0) > 0) return [];
    const candidates = current.get(event.type) ?? [];
    const previous = candidates.find((candidate) => candidate.id === event.id)
      ?? candidates.find((candidate) => sameCanonicalEvent(candidate, event));
    if (previous) consumed.add(previous);
    return [previous
      ? {
          ...previous,
          id: event.id,
          personId: person.id,
          title: event.title,
          date: event.date,
          placeName: event.placeName,
        }
      : event];
  });
  return [
    ...standard,
    ...currentEvents.filter((event) => !consumed.has(event)),
  ];
}

function groupPersonEventsByType(events: PersonEvent[]): Map<PersonEventType, PersonEvent[]> {
  const result = new Map<PersonEventType, PersonEvent[]>();
  for (const event of events) {
    const group = result.get(event.type) ?? [];
    group.push(event);
    result.set(event.type, group);
  }
  return result;
}

function sameCanonicalEvent(first: PersonEvent, second: PersonEvent): boolean {
  return first.type === second.type
    && (first.date ?? "").trim() === (second.date ?? "").trim()
    && (first.placeName ?? "").trim() === (second.placeName ?? "").trim();
}

export function stripInternalGeoFields(values: CustomFieldValues): CustomFieldValues {
  const next = { ...values };
  delete next[PERSON_EVENTS_META_KEY];
  delete next[FINDING_GEO_META_KEY];
  return next;
}

export function findingGeo(finding: Finding): GeoPoint | null {
  return normalizeGeo(finding.geo);
}
