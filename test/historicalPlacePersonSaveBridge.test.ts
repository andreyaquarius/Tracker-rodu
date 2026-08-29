import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizePersonEvents } from "../src/utils/geo.ts";
import {
  changePersonEventDisplayPlace,
  exactPersonEventDateForPlaceLookup,
  personEventTemporalContextForPlaceLookup,
} from "../src/utils/personEventGeo.ts";
import { isMissingHistoricalPlaceEventColumnsError } from "../src/utils/historicalPlaceEventCompatibility.ts";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608280005_historical_places_person_save_bridge.sql",
    import.meta.url,
  ),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../src/services/historicalPlacesService.ts", import.meta.url),
  "utf8",
);
const editorSource = readFileSync(
  new URL("../src/components/PersonEventsEditor.tsx", import.meta.url),
  "utf8",
);
const personEditorSource = readFileSync(
  new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url),
  "utf8",
);
const repositorySource = readFileSync(
  new URL("../src/services/familyTreeGraphRepository.ts", import.meta.url),
  "utf8",
);

const person = {
  id: "person-1",
  birthDate: "",
  birthPlace: "",
  marriageDate: "",
  marriagePlace: "",
  deathDate: "",
  deathPlace: "",
  residencePlaces: "",
};

test("person event normalization preserves display, exact and canonical place values independently", () => {
  const events = normalizePersonEvents([{
    id: "event-1",
    type: "census",
    title: "Перепис",
    date: "1862–1865",
    placeName: "Трубіївка, повіт",
    placeId: "fb500000-0000-4000-8000-000000000001",
    placeOriginalText: "въ селѣ Трубіевкѣ",
    placeResolutionStatus: "confirmed",
    placeCanonicalName: "Трубіївка",
  }], person);
  const event = events.find((item) => item.id === "event-1");
  assert.equal(event?.placeName, "Трубіївка, повіт");
  assert.equal(event?.placeOriginalText, "въ селѣ Трубіевкѣ");
  assert.equal(event?.placeId, "fb500000-0000-4000-8000-000000000001");
  assert.equal(event?.placeResolutionStatus, "confirmed");
  assert.equal(event?.placeCanonicalName, "Трубіївка");
});

test("legacy person events keep additive place fields absent instead of explicitly unlinking", () => {
  const events = normalizePersonEvents([{
    id: "event-legacy",
    type: "census",
    title: "Перепис",
    placeName: "Трубіївка",
  }], person);
  const event = events.find((item) => item.id === "event-legacy");
  assert.ok(event);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "placeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "placeOriginalText"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "placeResolutionStatus"), false);
});

test("core field projection retains an additive historical-place link", () => {
  const events = normalizePersonEvents([{
    id: "birth",
    type: "birth",
    title: "Народження",
    date: "1862-07-01",
    placeName: "Старе карткове значення",
    placeId: "fb500000-0000-4000-8000-000000000001",
    placeOriginalText: "села Трубіевки",
    placeResolutionStatus: "confirmed",
    placeCanonicalName: "Трубіївка",
  }], {
    ...person,
    birthDate: "1862-07-02",
    birthPlace: "Трубіївка (для картки)",
  });
  const birth = events.find((event) => event.id === "birth");
  assert.equal(birth?.date, "1862-07-02");
  assert.equal(birth?.placeName, "Трубіївка (для картки)");
  assert.equal(birth?.placeId, "fb500000-0000-4000-8000-000000000001");
  assert.equal(birth?.placeOriginalText, "села Трубіевки");
  assert.equal(birth?.placeResolutionStatus, "confirmed");
});

test("person editor normalization round-trips every core place and a custom event losslessly", () => {
  const sourceEvents = [
    {
      id: "birth",
      type: "birth" as const,
      placeName: "Народження: старе відображення",
      placeId: "fb500000-0000-4000-8000-000000000001",
      placeOriginalText: "уродився въ Трубіевкѣ",
      placeResolutionStatus: "confirmed" as const,
      placeCanonicalName: "Трубіївка",
    },
    {
      id: "marriage",
      type: "marriage" as const,
      placeName: "Шлюб: старе відображення",
      placeId: "fb500000-0000-4000-8000-000000000001",
      placeOriginalText: "въ церкви села Трубіевки",
      placeResolutionStatus: "confirmed" as const,
      placeCanonicalName: "Трубіївка",
    },
    {
      id: "death",
      type: "death" as const,
      placeName: "Смерть: старе відображення",
      placeId: "fb500000-0000-4000-8000-000000000001",
      placeOriginalText: "умеръ въ селѣ Трубіевкѣ",
      placeResolutionStatus: "confirmed" as const,
      placeCanonicalName: "Трубіївка",
    },
    {
      id: "custom-census",
      type: "census" as const,
      title: "Перепис",
      placeName: "Перепис: старе відображення",
      placeId: "fb500000-0000-4000-8000-000000000001",
      placeOriginalText: "приписанъ къ селу Трубіевкѣ",
      placeResolutionStatus: "needs_review" as const,
      placeCanonicalName: "Трубіївка",
    },
  ];
  const firstPass = normalizePersonEvents(sourceEvents, {
    ...person,
    birthPlace: "Народження: нове відображення",
    marriagePlace: "Шлюб: нове відображення",
    deathPlace: "Смерть: нове відображення",
  });
  const secondPass = normalizePersonEvents(firstPass, {
    ...person,
    birthPlace: "Народження: фінальне відображення",
    marriagePlace: "Шлюб: фінальне відображення",
    deathPlace: "Смерть: фінальне відображення",
  });

  for (const [eventId, expectedDisplay, expectedOriginal, expectedStatus] of [
    ["birth", "Народження: фінальне відображення", "уродився въ Трубіевкѣ", "confirmed"],
    ["marriage", "Шлюб: фінальне відображення", "въ церкви села Трубіевки", "confirmed"],
    ["death", "Смерть: фінальне відображення", "умеръ въ селѣ Трубіевкѣ", "confirmed"],
    ["custom-census", "Перепис: старе відображення", "приписанъ къ селу Трубіевкѣ", "needs_review"],
  ] as const) {
    const event = secondPass.find((item) => item.id === eventId);
    assert.equal(event?.placeName, expectedDisplay);
    assert.equal(event?.placeId, "fb500000-0000-4000-8000-000000000001");
    assert.equal(event?.placeOriginalText, expectedOriginal);
    assert.equal(event?.placeResolutionStatus, expectedStatus);
    assert.equal(event?.placeCanonicalName, "Трубіївка");
  }
});

test("place lookup receives only complete exact dates and never an invented day", () => {
  assert.equal(exactPersonEventDateForPlaceLookup("1862-07-01"), "1862-07-01");
  assert.equal(exactPersonEventDateForPlaceLookup("01.07.1862"), "1862-07-01");
  assert.equal(exactPersonEventDateForPlaceLookup("1862"), null);
  assert.equal(exactPersonEventDateForPlaceLookup("1862–1865"), null);
  assert.equal(exactPersonEventDateForPlaceLookup("близько 1862"), null);
});

test("place lookup preserves year, range and approximate precision as periods", () => {
  assert.deepEqual(personEventTemporalContextForPlaceLookup("1862"), {
    periodFrom: "1862-01-01",
    periodTo: "1862-12-31",
    originalText: "1862",
    precision: "year",
  });
  assert.deepEqual(personEventTemporalContextForPlaceLookup("1881–1886"), {
    periodFrom: "1881-01-01",
    periodTo: "1886-12-31",
    originalText: "1881–1886",
    precision: "range",
  });
  assert.deepEqual(personEventTemporalContextForPlaceLookup("близько 1900"), {
    periodFrom: "1900-01-01",
    periodTo: "1900-12-31",
    originalText: "близько 1900",
    precision: "circa",
  });
  assert.deepEqual(personEventTemporalContextForPlaceLookup("до 1862"), {
    periodFrom: "0001-01-01",
    periodTo: "1862-12-31",
    originalText: "до 1862",
    precision: "before",
  });
  assert.deepEqual(personEventTemporalContextForPlaceLookup("after 1900"), {
    periodFrom: "1900-01-01",
    periodTo: "9999-12-31",
    originalText: "after 1900",
    precision: "after",
  });
  assert.deepEqual(personEventTemporalContextForPlaceLookup("01.07.1862"), {
    exactDate: "1862-07-01",
    originalText: "01.07.1862",
    precision: "day",
  });
});

test("manual display-place edits clear stale identity but preserve exact source wording", () => {
  const [changed] = changePersonEventDisplayPlace([{
    id: "birth",
    personId: "person-1",
    type: "birth",
    placeName: "Трубіївка для картки",
    placeId: "fb500000-0000-4000-8000-000000000001",
    placeOriginalText: "села Трубіевки",
    placeResolutionStatus: "confirmed",
    placeCanonicalName: "Трубіївка",
  }], "birth", "Інше місце для картки");
  assert.equal(changed.placeName, "Інше місце для картки");
  assert.equal(changed.placeId, null);
  assert.equal(changed.placeResolutionStatus, "unresolved");
  assert.equal(changed.placeCanonicalName, null);
  assert.equal(changed.placeOriginalText, "села Трубіевки");
});

test("person save bridge is atomic, stable by client id and fails closed on duplicates", () => {
  assert.match(
    migration,
    /after (?:insert|update)[\s\S]*?on public\.persons[\s\S]*?sync_person_event_places_from_person_v1/iu,
  );
  assert.match(migration, /person_event_projection_id_v1[\s\S]*?client_event_id/iu);
  assert.match(migration, /PERSON_EVENT_CLIENT_ID_DUPLICATE/iu);
  assert.match(migration, /PERSON_EVENT_PROJECTION_AMBIGUOUS/iu);
  assert.match(
    migration,
    /metadata\s*->>\s*'clientEventId'[\s\S]*?persons_custom_event_projection/iu,
  );
  assert.doesNotMatch(migration, /date_trunc\s*\(\s*'year'/iu);
  assert.doesNotMatch(migration, /make_date\s*\([^,]+,\s*1\s*,\s*1\s*\)/iu);
});

test("frontend uses exact versioned event-link RPC contracts from migration 003", () => {
  assert.match(
    serviceSource,
    /rpc\("set_person_event_place_v1",\s*\{[\s\S]*?p_event_id:[\s\S]*?p_place_id:[\s\S]*?p_place_original_text:[\s\S]*?p_resolution_status:[\s\S]*?p_expected_updated_at:/u,
  );
  assert.match(
    serviceSource,
    /rpc\("clear_person_event_place_v1",\s*\{[\s\S]*?p_event_id:[\s\S]*?p_preserve_original_text:[\s\S]*?p_expected_updated_at:/u,
  );
});

test("event editor keeps legacy display text and canonical source selection as separate controls", () => {
  assert.match(editorSource, /Місце для картки та старих експортів/u);
  assert.match(editorSource, /<HistoricalPlaceField/u);
  assert.match(editorSource, /placeOriginalText:\s*placeValue\.originalText/u);
  assert.match(editorSource, /placeName\s*\?\?\s*""/u);
  assert.match(editorSource, /exactPersonEventDateForPlaceLookup\(event\.date\)/u);
  assert.match(editorSource, /temporalContext=\{personEventTemporalContextForPlaceLookup\(event\.date\)\}/u);
  assert.match(
    personEditorSource,
    /CORE_MAP_EVENT_TYPES[\s\S]*?<HistoricalPlaceField[\s\S]*?patchEvent\(type,[\s\S]*?placeOriginalText:\s*placeValue\.originalText/u,
  );
});

test("family graph timeline projection selects and maps canonical place fields", () => {
  assert.match(
    repositorySource,
    /place_name, place_id, place_original_text, place_resolution_status, geo/u,
  );
  assert.match(repositorySource, /placeId:\s*row\.place_id/u);
  assert.match(repositorySource, /placeOriginalText:\s*row\.place_original_text/u);
  assert.match(repositorySource, /placeResolutionStatus:\s*row\.place_resolution_status/u);
});

test("family graph falls back only when the additive historical-place columns are missing", () => {
  assert.equal(isMissingHistoricalPlaceEventColumnsError({
    code: "42703",
    message: 'column "place_id" does not exist',
  }), true);
  assert.equal(isMissingHistoricalPlaceEventColumnsError({
    code: "PGRST204",
    message: "Could not find the 'place_resolution_status' column of 'person_timeline_events'",
  }), true);
  assert.equal(isMissingHistoricalPlaceEventColumnsError({
    code: "42703",
    message: 'column "unrelated_column" does not exist',
  }), false);
  assert.equal(isMissingHistoricalPlaceEventColumnsError({
    code: "57014",
    message: "statement timeout while reading person_timeline_events",
  }), false);
  assert.match(repositorySource, /PERSON_TIMELINE_EVENT_LEGACY_SELECT/u);
  assert.match(
    repositorySource,
    /catch \(error\)[\s\S]*?isMissingHistoricalPlaceEventColumnsError\(error\)[\s\S]*?readWithSelect\(PERSON_TIMELINE_EVENT_LEGACY_SELECT\)/u,
  );
});
