import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Zagulyaky opt into canonical settlement search without changing exact map fields", () => {
  const placeSearch = source("../src/services/placeSearch.ts");
  const edgeFunction = source("../supabase/functions/search-places/index.ts");
  const geoField = source("../src/components/GeoPlaceField.tsx");
  const draftDialog = source("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx");
  const personEditor = source("../src/features/persons-v2/PersonEditorV2.tsx");

  assert.match(placeSearch, /export interface PlaceSearchOptions\s*\{\s*settlementOnly\?: boolean;/su);
  assert.match(placeSearch, /body:\s*\{ query: normalized, settlementOnly \}/u);
  assert.match(placeSearch, /body:\s*\{ latitude, longitude, settlementOnly \}/u);
  assert.doesNotMatch(placeSearch, /nominatim\.openstreetmap\.org/u);
  assert.doesNotMatch(placeSearch, /\bfetch\s*\(/u);
  assert.match(edgeFunction, /params\.set\("featureType", "settlement"\)/u);
  assert.match(edgeFunction, /zoom: canonicalSettlement \? "15" : "18"/u);
  assert.match(edgeFunction, /params\.set\("layer", "address"\)/u);

  assert.match(edgeFunction, /osm_type\?: string;/u);
  assert.match(edgeFunction, /function stableExternalId\(item: NominatimResult\)/u);
  assert.match(edgeFunction, /relation: "R"/u);
  assert.match(edgeFunction, /if \(prefix && osmId\) return `\$\{prefix\}\$\{osmId\}`;/u);
  assert.match(edgeFunction, /externalId: externalId \|\| null/u);
  assert.match(
    edgeFunction,
    /const resultLatitude = settlementOnly \? Number\(item\.lat\) : latitude;[\s\S]*?source: settlementOnly \? "search" : "map_click"/u,
  );

  assert.match(geoField, /canonicalSettlement = false/u);
  assert.match(geoField, /searchPlaces\(normalized, \{ settlementOnly: canonicalSettlement \}\)/u);
  assert.match(geoField, /reversePlace\(latitude, longitude, \{ settlementOnly: canonicalSettlement \}\)/u);
  assert.match(geoField, /if \(canonicalSettlement\) \{[\s\S]*?setDraft\(null\);/u);
  assert.match(geoField, /if \(canonicalSettlement && hasCoordinates\(resolvedGeo\)\) \{[\s\S]*?setMarker\(\[resolvedGeo\.latitude, resolvedGeo\.longitude\]\);/u);
  assert.match(geoField, /displayName: canonicalSettlement\s*\? geo\.displayName/u);
  assert.match(geoField, /Уточнюємо населений пункт; дочекайтеся результату перед збереженням/u);

  const canonicalUses = draftDialog.match(/canonicalSettlement/g) ?? [];
  assert.equal(canonicalUses.length, 2, "only the origin and found Zagulyaky fields opt in");
  assert.doesNotMatch(personEditor, /canonicalSettlement/u);
});
