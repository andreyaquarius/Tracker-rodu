import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { GeoPoint } from "../src/types/index.ts";
import {
  buildZagulyakaRouteMapStops,
  hasZagulyakaRouteMapLine,
} from "../src/features/zagulyaky/zagulyakaRouteMapModel.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/202608230003_zagulyaky_map_coordinates.sql", import.meta.url),
  "utf8",
);
const draftDialog = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const detailDialog = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);

const origin: GeoPoint = {
  displayName: "с. Хороше",
  latitude: 48.25,
  longitude: 35.1,
  source: "search",
  precision: "settlement",
  provider: "OpenStreetMap Nominatim",
  externalId: "node/1",
};
const found: GeoPoint = {
  displayName: "м. Трипілля",
  latitude: 50.118,
  longitude: 30.781,
  source: "map_click",
  precision: "approximate",
  provider: "OpenStreetMap",
  externalId: null,
};

test("map model draws a straight link only between two distinct valid points", () => {
  const twoStops = buildZagulyakaRouteMapStops({
    origin,
    found,
    originPlaceLabel: "Полтавська губернія, Кишенська волость",
    foundPlaceLabel: "Трипілля",
  });
  assert.equal(twoStops.length, 2);
  assert.equal(twoStops[0]?.role, "origin");
  assert.equal(twoStops[1]?.role, "found");
  assert.equal(hasZagulyakaRouteMapLine(twoStops), true);

  const oneStop = buildZagulyakaRouteMapStops({ origin, found: null });
  assert.equal(oneStop.length, 1);
  assert.equal(hasZagulyakaRouteMapLine(oneStop), false);

  const samePlace = buildZagulyakaRouteMapStops({ origin, found: { ...origin, source: "map_click" } });
  assert.equal(samePlace.length, 2);
  assert.equal(hasZagulyakaRouteMapLine(samePlace), false);

  const invalid = buildZagulyakaRouteMapStops({
    origin: { ...origin, latitude: 123 },
    found: null,
  });
  assert.deepEqual(invalid, []);
});

test("draft pins are optional and never overwrite the historical source-place text", () => {
  assert.match(draftDialog, /Історичний текст вище залишається без змін/);
  assert.match(draftDialog, /label=\{draft\.kind === "person" \? "Точка: звідки людина" : "Точка: місце документа"\}/);
  assert.match(draftDialog, /label="Точка: де знайдено запис"/);
  assert.match(draftDialog, /onChange=\{\(value\) => update\("originGeo", value\)\}/);
  assert.match(draftDialog, /onChange=\{\(value\) => update\("foundGeo", value\)\}/);
  assert.doesNotMatch(
    draftDialog.slice(draftDialog.indexOf("<section className=\"zagulyaky-map-points"), draftDialog.indexOf("<label className=\"field-wide\"", draftDialog.indexOf("<section className=\"zagulyaky-map-points"))),
    /onPlaceNameChange=/,
  );
});

test("map data is validated server-side, removed from generic payload and protected by public visibility gates", () => {
  assert.match(migration, /add column if not exists origin_geo jsonb/i);
  assert.match(migration, /add column if not exists found_geo jsonb/i);
  assert.match(migration, /normalize_zagulyaky_geo_point_v1/i);
  assert.match(migration, /ZAGULYAKA_GEO_COORDINATES_OUT_OF_RANGE/);
  assert.match(migration, /'displayName', 'latitude', 'longitude', 'source', 'precision', 'provider', 'externalId'/);
  assert.match(migration, /new\.payload := new\.payload - array\['originGeo', 'foundGeo'\]/);
  assert.match(migration, /'originGeo', record_row\.origin_geo/);
  assert.match(migration, /'foundGeo', record_row\.found_geo/);
  assert.match(migration, /security_private\.zagulyaky_has_living_person_clearance_v1/);
  assert.match(migration, /security_private\.zagulyaky_public_facebook_origin_v1/);
  assert.match(migration, /'id', attachment\.value -> 'id'/);
  assert.doesNotMatch(migration, /markerColor/);
});

test("client sends canonical pins, maps public pins and renders a card map", () => {
  assert.match(service, /originGeo: mapPointPayload\(input\.originGeo\)/);
  assert.match(service, /foundGeo: mapPointPayload\(input\.foundGeo\)/);
  assert.match(service, /originGeo: normalizeGeo\(value\(row, "originGeo", "origin_geo"\)\)/);
  assert.match(service, /foundGeo: normalizeGeo\(value\(row, "foundGeo", "found_geo"\)\)/);
  assert.match(service, /value\(subject, "originText", "origin_text"\),\s*text\(value\(row, "sourceLocationNormalized"/s);
  assert.match(detailDialog, /<ZagulyakaRouteMap/);
  assert.match(detailDialog, /origin=\{detail\.originGeo\}/);
  assert.match(detailDialog, /found=\{detail\.foundGeo\}/);
});
