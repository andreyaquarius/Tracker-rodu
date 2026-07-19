import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Person, PersonEvent } from "../src/types/index.ts";
import {
  PERSON_EVENT_TYPES,
  GEO_MARKER_COLORS,
  formatGeoCoordinates,
  formatGeoSelectionLabel,
  normalizePersonEvents,
  personEventLabel,
  shouldSearchGeoPlaces,
} from "../src/utils/geo.ts";
import { updatePersonEventById } from "../src/utils/personEventGeo.ts";
import { PERSON_EVENT_VISUALS, personEventIconSvgMarkup } from "../src/utils/personEventVisuals.ts";
import type { PersonTimelineItem } from "../src/features/persons-v2/model.ts";
import { buildPersonTimeline } from "../src/features/persons-v2/model.ts";
import {
  buildPersonLifeMapStops,
  groupPersonLifeMapStops,
} from "../src/features/persons-v2/personLifeMapModel.ts";

test("defines a meaningful icon and supported marker color for every person event type", () => {
  assert.deepEqual(Object.keys(PERSON_EVENT_VISUALS).sort(), [...PERSON_EVENT_TYPES].sort());
  for (const type of PERSON_EVENT_TYPES) {
    const visual = PERSON_EVENT_VISUALS[type];
    assert.ok(visual.icon, `${type} should have an icon`);
    assert.ok(GEO_MARKER_COLORS.includes(visual.color as typeof GEO_MARKER_COLORS[number]));
  }
  assert.equal(personEventLabel("revision_list"), "Ревізька казка");
  assert.equal(PERSON_EVENT_VISUALS.birth.icon, "baby");
  assert.equal(PERSON_EVENT_VISUALS.marriage.icon, "heart");
  assert.equal(PERSON_EVENT_VISUALS.military.icon, "shield");
  assert.equal(PERSON_EVENT_VISUALS.death.icon, "cross");
});

test("renders trusted shared SVG markup for every person event type", () => {
  for (const type of PERSON_EVENT_TYPES) {
    const markup = personEventIconSvgMarkup(type);
    assert.match(markup, /^<svg\b[^>]*>.*<\/svg>$/u, `${type} should render an SVG`);
    assert.match(
      markup,
      new RegExp(`data-event-icon=["']${PERSON_EVENT_VISUALS[type].icon}["']`),
      `${type} should expose its semantic event icon`,
    );
    assert.doesNotMatch(markup, /<script\b|on\w+\s*=/iu);
  }
});

test("suppresses settlement autocomplete after exact coordinates are selected", () => {
  assert.equal(shouldSearchGeoPlaces("Kyiv", null), true);
  assert.equal(shouldSearchGeoPlaces("Ky", null), false);
  assert.equal(shouldSearchGeoPlaces("Kyiv", {
    displayName: "Kyiv",
    latitude: 50.4501,
    longitude: 30.5234,
    source: "map_click",
    precision: "exact",
    provider: "OpenStreetMap",
    externalId: null,
    markerColor: GEO_MARKER_COLORS[0],
  }), false);
});

test("formats exact positive and negative coordinates with a custom point label", () => {
  const point = {
    displayName: "Reverse-geocoded address",
    latitude: -33.8651432,
    longitude: -151.2099,
  };

  assert.equal(formatGeoCoordinates(point), "-33.865143, -151.209900");
  assert.match(formatGeoSelectionLabel("House #2", point), /^House #2.*-33\.865143, -151\.209900$/u);
  assert.match(formatGeoSelectionLabel("", point), /^Reverse-geocoded address.*-33\.865143, -151\.209900$/u);
});

test("updates one repeated event by id without changing its siblings", () => {
  const first = personEvent("military-1", "military", "1900");
  const second = personEvent("military-2", "military", "1914");
  const geo = {
    displayName: "Київ",
    latitude: 50.45,
    longitude: 30.52,
    source: "map_click" as const,
    precision: "settlement" as const,
    provider: "OpenStreetMap",
    externalId: null,
    markerColor: "#2f6f9f",
  };
  const updated = updatePersonEventById([first, second], second.id, { geo, placeName: "Київ" });

  assert.equal(updated[0].geo, null);
  assert.equal(updated[0].placeName, null);
  assert.deepEqual(updated[1].geo, geo);
  assert.equal(updated[1].placeName, "Київ");
});

test("keeps alternative vital events separate from the canonical scalar event", () => {
  const alternative = {
    ...personEvent("birth-alternative", "birth", "1899"),
    placeName: "Одеса",
  };
  const normalized = normalizePersonEvents([alternative], {
    id: "person-1",
    birthDate: "1900",
    birthPlace: "Київ",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathPlace: "",
    residencePlaces: "",
  });

  assert.equal(normalized.filter((event) => event.type === "birth").length, 2);
  assert.equal(normalized.find((event) => event.id === "birth")?.placeName, "Київ");
  assert.equal(normalized.find((event) => event.id === "birth-alternative")?.placeName, "Одеса");
});

test("builds ordered map stops, ignores invalid coordinates, and groups shared places", () => {
  const timeline: PersonTimelineItem[] = [
    timelineEvent("birth", "birth", 49.84, 24.03, "Львів"),
    timelineEvent("school", "education", 50.45, 30.52, "Київ"),
    timelineEvent("work", "occupation", 50.45, 30.52, "Київ"),
    {
      ...timelineEvent("invalid", "other", 0, 0, "Невідомо"),
      geo: { ...timelineEvent("invalid-geo", "other", 0, 0, "").geo!, latitude: 120 },
    },
  ];
  const stops = buildPersonLifeMapStops(timeline);
  const groups = groupPersonLifeMapStops(stops);

  assert.deepEqual(stops.map((stop) => stop.sequence), [1, 2, 3]);
  assert.deepEqual(stops.map((stop) => stop.eventId), ["birth", "school", "work"]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1].stops.map((stop) => stop.eventId), ["school", "work"]);
});

test("does not duplicate the scalar residence summary when explicit residence events exist", () => {
  const explicitResidence = {
    ...personEvent("residence-1901", "residence", "1901–1914"),
    placeName: "Біла Церква",
  };
  const timeline = buildPersonTimeline({
    id: "person-1",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "Біла Церква",
    events: [explicitResidence],
  } as Person);

  assert.deepEqual(timeline.filter((event) => event.type === "residence").map((event) => event.id), ["residence-1901"]);
});

test("wires map editing, event icons, mini-map, and person-filtered full map", () => {
  const editor = source("../src/features/persons-v2/PersonEditorV2.tsx");
  const timeline = source("../src/features/persons-v2/PersonTimelineV2.tsx");
  const miniMap = source("../src/features/persons-v2/PersonLifeMapV2.tsx");
  const profile = source("../src/features/persons-v2/PersonProfileV2.tsx");
  const mapPage = source("../src/pages/MapPage.tsx");
  const app = source("../src/App.tsx");
  const styles = source("../src/styles.css");

  assert.match(editor, /\+ Додати подію на карту/u);
  assert.match(editor, /updateEventGeo\(mapEvent\.id, geo\)/u);
  assert.match(editor, /key=\{mapEvent\.id\}/u);
  assert.match(timeline, /<PersonEventIconV2 type=\{event\.type\}/u);
  assert.doesNotMatch(styles, /persons-v2-timeline__marker::after/u);
  assert.match(miniMap, /L\.polyline/u);
  assert.match(miniMap, /map\.fitBounds/u);
  assert.match(profile, /<PersonLifeMapV2/u);
  assert.match(mapPage, /initialPersonId\?: string/u);
  assert.match(app, /\?personId=\$\{encodeURIComponent\(person\.id\)\}/u);
});

test("wires event-specific markers and exact manual map points through the UI", () => {
  const geoField = source("../src/components/GeoPlaceField.tsx");
  const editor = source("../src/features/persons-v2/PersonEditorV2.tsx");
  const miniMap = source("../src/features/persons-v2/PersonLifeMapV2.tsx");
  const mapPage = source("../src/pages/MapPage.tsx");

  assert.match(geoField, /eventType\?:\s*PersonEventType/u);
  assert.match(geoField, /shouldSearchGeoPlaces\(query,\s*value\)/u);
  assert.match(geoField, /draggable:\s*true/u);
  assert.match(geoField, /precision:\s*["']exact["']/u);
  assert.match(editor, /eventType=\{type\}/u);
  assert.match(editor, /eventType=\{mapEvent\.type\}/u);
  assert.match(miniMap, /personEventIconSvgMarkup\(first\.type\)/u);
  assert.match(mapPage, /eventType:\s*event\.type/u);
  assert.match(mapPage, /personEventIconSvgMarkup\(/u);
});

test("requests house-level reverse geocoding and preserves the provider display name", () => {
  const service = source("../src/services/placeSearch.ts");
  const edgeFunction = source("../supabase/functions/search-places/index.ts");

  for (const implementation of [service, edgeFunction]) {
    assert.match(implementation, /zoom:\s*["']18["']/u);
    assert.match(implementation, /displayName:\s*item\.display_name\s*\|\|\s*label/u);
  }
});

function personEvent(id: string, type: PersonEvent["type"], date: string): PersonEvent {
  return {
    id,
    personId: "person-1",
    type,
    title: personEventLabel(type),
    date,
    placeName: null,
    geo: null,
    notes: null,
  };
}

function timelineEvent(
  id: string,
  type: PersonEvent["type"],
  latitude: number,
  longitude: number,
  placeName: string,
): PersonTimelineItem {
  return {
    ...personEvent(id, type, "1900"),
    placeName,
    geo: {
      displayName: placeName,
      latitude,
      longitude,
      source: "import",
      precision: "settlement",
      provider: "test",
      externalId: null,
      markerColor: PERSON_EVENT_VISUALS[type].color,
    },
    source: "event",
    datePrecision: "year",
    sortTimestamp: Date.UTC(1900, 0, 1),
    deduplicatedEventIds: [],
  };
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
