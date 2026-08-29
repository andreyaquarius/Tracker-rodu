import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NOMINATIM_PROVIDER,
  nominatimReverseCacheKey,
  nominatimSearchCacheKey,
  normalizeNominatimSearchKey,
} from "../supabase/functions/search-places/contract.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("normalizes deterministic Nominatim cache keys without mixing search modes", () => {
  assert.equal(NOMINATIM_PROVIDER, "nominatim");
  assert.equal(normalizeNominatimSearchKey("  ТРУБІЇВКА  "), "трубіївка");
  assert.equal(normalizeNominatimSearchKey("Кам’янець`Подільський"), "кам'янець'подільський");
  assert.equal(
    nominatimSearchCacheKey("  ТРУБІЇВКА  ", true),
    "search:uk:settlement:7:трубіївка",
  );
  assert.equal(
    nominatimSearchCacheKey("Трубіївка", false),
    "search:uk:all:7:трубіївка",
  );
  assert.notEqual(
    nominatimReverseCacheKey(49.12345641, 28.76543219, true),
    nominatimReverseCacheKey(49.12345641, 28.76543219, false),
  );
  assert.equal(
    nominatimReverseCacheKey(49.12345641, 28.76543219, true),
    "reverse:uk:settlement:15:49.123456:28.765432",
  );
});

test("keeps all public Nominatim traffic behind the authenticated Edge Function", () => {
  const client = source("../src/services/placeSearch.ts");
  const edgeFunction = source("../supabase/functions/search-places/index.ts");

  assert.match(client, /functions\.invoke\("search-places"/u);
  assert.doesNotMatch(client, /nominatim\.openstreetmap\.org/u);
  assert.doesNotMatch(client, /searchPlacesDirectly|reversePlaceDirectly/u);
  assert.doesNotMatch(client, /\bfetch\s*\(/u);

  assert.match(edgeFunction, /supabase\.auth\.getUser\(\)/u);
  assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(edgeFunction, /get_historical_place_discovery_cache_v1/u);
  assert.match(edgeFunction, /put_historical_place_discovery_cache_v1/u);
  assert.match(edgeFunction, /acquire_historical_place_provider_slot_v1/u);
  assert.match(edgeFunction, /p_provider: NOMINATIM_PROVIDER/u);
  assert.match(edgeFunction, /p_min_interval_ms: NOMINATIM_MIN_INTERVAL_MS/u);
  assert.doesNotMatch(edgeFunction, /p_provider:\s*["'](?:nominatim-search|nominatim-reverse)["']/u);
});
