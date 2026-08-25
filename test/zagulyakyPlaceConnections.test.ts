import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608250008_zagulyaky_public_place_connections.sql", import.meta.url),
  "utf8",
);
const exactCatalogueFilterMigration = readFileSync(
  new URL("../supabase/migrations/202608250009_zagulyaky_public_place_exact_catalog_filters.sql", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url),
  "utf8",
);
const explorer = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakyPlacesExplorer.tsx", import.meta.url),
  "utf8",
);
const explorerStyles = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakyPlacesExplorer.css", import.meta.url),
  "utf8",
);

test("public settlement connections use only confirmed person origin/found points", () => {
  assert.match(migration, /create or replace function security_private\.list_public_zagulyaky_places_v1/i);
  assert.match(migration, /create or replace function security_private\.get_public_zagulyaky_place_connections_v1/i);
  assert.match(migration, /record_row\.kind = 'person'/);
  assert.match(migration, /record_row\.status = 'published'/);
  assert.match(migration, /record_row\.privacy_status = 'cleared'/);
  assert.match(migration, /security_private\.zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/);
  assert.match(migration, /zagulyaky_public_place_point_v1\(record_row\.origin_geo\)/);
  assert.match(migration, /zagulyaky_public_place_point_v1\(record_row\.found_geo\)/);
  assert.match(migration, /and origin_point\.value is not null/);
  assert.match(migration, /and found_point\.value is not null/);
  assert.match(migration, /never free-text inference or archive locations/i);
  assert.doesNotMatch(migration, /source_location_(?:normalized|text).*ilike/i);
  assert.doesNotMatch(migration, /found_location_(?:normalized|text).*ilike/i);
});

test("the public RPC contract limits selectors and filters to safe confirmed facts", () => {
  assert.match(
    migration,
    /filter_key\.key_name not in \('eventType', 'eventRole', 'yearFrom', 'yearTo'\)/,
  );
  assert.match(migration, /INVALID_ZAGULYAKY_PLACE_KEY/);
  assert.match(migration, /ZAGULYAKY_PLACE_NOT_FOUND/);
  assert.match(migration, /'incoming', 'outgoing', 'local'/);
  assert.match(
    migration,
    /create or replace function public\.list_public_zagulyaky_places_v1[\s\S]*?security invoker/s,
  );
  assert.match(
    migration,
    /create or replace function public\.get_public_zagulyaky_place_connections_v1[\s\S]*?security invoker/s,
  );
  assert.match(
    migration,
    /grant execute on function[\s\S]*?public\.list_public_zagulyaky_places_v1[\s\S]*?to anon, authenticated, service_role/s,
  );
});

test("browser requests the public-only RPCs and passes only safe connection filters", () => {
  assert.match(service, /\.rpc\("list_public_zagulyaky_places_v1"/);
  assert.match(service, /\.rpc\("get_public_zagulyaky_place_connections_v1"/);
  assert.match(service, /p_place: \{ key: placeKey \}/);
  assert.match(service, /p_direction: direction/);
  assert.match(service, /safeFilters,\s*"all",\s*0,/s);
  assert.match(service, /eventType: filters\.eventType/);
  assert.match(service, /eventRole: filters\.eventRole/);
  assert.match(service, /yearFrom: filters\.yearFrom/);
  assert.match(service, /yearTo: filters\.yearTo/);
  assert.match(service, /originPlaceKey: filters\.originPlaceKey/);
  assert.match(service, /foundPlaceKey: filters\.foundPlaceKey/);
  assert.match(service, /ZAGULYAKY_PUBLIC_PLACE_CONNECTION_MAX_OFFSET = 10_000/);
  assert.match(service, /while \(hasMore && offset <= ZAGULYAKY_PUBLIC_PLACE_CONNECTION_MAX_OFFSET\)/);
  assert.match(service, /const geo = normalizeGeo\(value\(input, "geo"\)\)/);
  assert.doesNotMatch(service.slice(service.indexOf("loadPublicZagulyakyPlaceConnections"), service.indexOf("export async function searchZagulyakyPeople")), /from\("zagulyaky_records"\)/);
});

test("opening a settlement connection uses opaque map-point keys, not historic text matching", () => {
  assert.match(page, /originPlaceKey: connection\.direction === "incoming"/);
  assert.match(page, /foundPlaceKey: connection\.direction === "incoming"/);
  assert.match(page, /originPlaceKey: ""/);
  assert.match(page, /foundPlaceKey: ""/);
  assert.match(exactCatalogueFilterMigration, /INVALID_ZAGULYAKY_PLACE_KEY_FILTER/);
  assert.match(exactCatalogueFilterMigration, /zagulyaky_public_place_key_v1\(r\.origin_geo\)/);
  assert.match(exactCatalogueFilterMigration, /zagulyaky_public_place_key_v1\(r\.found_geo\)/);
  assert.match(exactCatalogueFilterMigration, /or p_filters \? 'originPlaceKey'/);
  assert.match(exactCatalogueFilterMigration, /or p_filters \? 'foundPlaceKey'/);
});

test("catalogue exposes settlement lists, a map, and direct relation semantics", () => {
  assert.match(page, /setTab\("places"\)/);
  assert.match(page, /loadPublicZagulyakyPlaceConnections/);
  assert.match(page, /<ZagulyakyPlacesExplorer/);
  assert.match(page, /openSettlementConnectionRecords/);
  assert.match(page, /connection\.direction === "incoming"/);
  assert.match(page, /eventRole: filters\.eventRole/);
  assert.match(explorer, /Звідки люди, знайдені в/);
  assert.match(explorer, /Де знайдено людей із/);
  assert.match(explorer, /В межах одного пункту/);
  assert.match(explorer, /Це не маршрут і не доказ переміщення людини/);
  assert.match(explorer, /function placePickerLabel/);
  assert.match(explorer, /згадок у межах цього пункту/);
  assert.match(explorer, /L\.polyline\(lineCoordinates/);
  assert.match(explorer, /onOpenRecords/);
});

test("the settlement map remains contained on narrow displays", () => {
  assert.match(
    explorerStyles,
    /\.zagulyaky-places-explorer__map\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*0;[\s\S]*?isolation:\s*isolate;[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(explorerStyles, /@media \(max-width: 620px\)/);
  assert.match(explorerStyles, /\.zagulyaky-places-explorer__map \{ height: min\(62vh, 390px\); min-height: 270px; \}/);
});
