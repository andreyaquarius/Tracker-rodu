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
import { createId } from "./id";

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
  marriage: "Шлюб",
  residence: "Проживання",
  military: "Військова служба",
  death: "Смерть",
  burial: "Поховання",
  other: "Інша подія",
};

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
  const byType = new Map(saved.map((event) => [event.type, event]));
  const standard = standardPersonEvents(person).map((event) => {
    const savedEvent = byType.get(event.type);
    return savedEvent
      ? {
          ...savedEvent,
          id: event.id,
          personId: person.id,
          title: event.title,
          date: event.date,
          placeName: event.placeName,
        }
      : event;
  });
  const standardTypes = new Set(standard.map((event) => event.type));
  return [
    ...standard,
    ...saved.filter((event) => !standardTypes.has(event.type)),
  ];
}

export function syncPersonEventsFromFields(person: Person): PersonEvent[] {
  const current = new Map((person.events ?? []).map((event) => [event.type, event]));
  return standardPersonEvents(person).map((event) => {
    const previous = current.get(event.type);
    return previous
      ? {
          ...previous,
          id: event.id,
          personId: person.id,
          title: event.title,
          date: event.date,
          placeName: event.placeName,
        }
      : event;
  });
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
