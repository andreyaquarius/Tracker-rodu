import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  discoverHistoricalPlaces,
  normalizeHistoricalPlaceDiscoveryResponse,
  normalizeHistoricalPlaceDiscoveryResult,
  toConfirmedHistoricalPlaceDraft,
} from "../src/services/historicalPlaceDiscovery.ts";

const discoveryEdgeSource = readFileSync(
  new URL("../supabase/functions/discover-historical-places/index.ts", import.meta.url),
  "utf8",
);

test("server discovery uses hardened editor authorization and keeps KATOTTG authoritative", () => {
  assert.match(discoveryEdgeSource, /userClient\.rpc\(\s*"can_edit_project"/u);
  assert.doesNotMatch(discoveryEdgeSource, /\.from\("project_members"\)/u);
  assert.match(discoveryEdgeSource, /const preferAdditionKatottg = !baseHasKatottg && additionHasKatottg/u);
  assert.match(discoveryEdgeSource, /id: preferAdditionKatottg \? addition\.id : base\.id/u);
  assert.match(discoveryEdgeSource, /placeType: preferAdditionKatottg[\s\S]*?addition\.placeType/u);
});

test("runs discovery only through the authenticated server contract", async () => {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const result = await discoverHistoricalPlaces({
    query: "  Трубіївка  ",
    projectId: "project-1",
    limit: 99,
  }, {
    invoke: async (name, body) => {
      calls.push({ name, body });
      return {
        query: "Трубіївка",
        candidates: [{ canonicalName: "Трубіївка" }],
        warnings: ["OpenStreetMap тимчасово не відповів"],
        searchedProviders: ["katottg", "wikidata"],
        requiresConfirmation: true,
      };
    },
  });

  assert.deepEqual(calls, [{
    name: "discover-historical-places",
    body: { query: "Трубіївка", projectId: "project-1", limit: 10 },
  }]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.warnings, ["OpenStreetMap тимчасово не відповів"]);
  assert.deepEqual(result.searchedProviders, ["katottg", "wikidata"]);
  assert.equal(result.requiresConfirmation, true);
});

test("normalizes discovery envelope metadata without trusting unknown providers", () => {
  const result = normalizeHistoricalPlaceDiscoveryResult({
    candidates: [],
    warnings: ["частковий результат"],
    searched_providers: ["OpenStreetMap", "unknown-provider"],
    requires_confirmation: false,
  }, "Запит");
  assert.equal(result.query, "Запит");
  assert.deepEqual(result.warnings, ["частковий результат"]);
  assert.deepEqual(result.searchedProviders, ["openstreetmap", "other"]);
  assert.equal(result.requiresConfirmation, false);
});

test("normalizes a merged catalogue candidate and preserves safe source metadata", () => {
  const [candidate] = normalizeHistoricalPlaceDiscoveryResponse({
    candidates: [{
      stable_key: "katottg:UA05060130010012345",
      canonical_name: "Трубіївка",
      modern_name: "Трубіївка",
      category: "C",
      lat: "49.1234",
      lon: "28.5678",
      current_country: "Україна",
      admin_parts: ["Вінницька область", "Жмеринський район", "Шаргородська громада"],
      katottg_code: "UA05060130010012345",
      osm_id: "R12345",
      wikidata_id: "q98765",
      geonames_id: "123456",
      confidence: 0.92,
      match_reasons: ["збіг назви", "збіг громади"],
      sources: [{
        provider: "КАТОТТГ",
        label: "КАТОТТГ",
        external_id: "UA05060130010012345",
        dataset_version: "2026-08",
        source_url: "https://example.test/katottg/UA05060130010012345",
      }],
      field_sources: {
        canonical_name: ["katottg"],
        latitude: "OpenStreetMap",
      },
    }],
  });

  assert.ok(candidate);
  assert.equal(candidate.placeType, "village");
  assert.equal(candidate.latitude, 49.1234);
  assert.equal(candidate.longitude, 28.5678);
  assert.equal(candidate.currentAdmin, "Вінницька область, Жмеринський район, Шаргородська громада");
  assert.equal(candidate.wikidataId, "Q98765");
  assert.equal(candidate.geonamesId, "123456");
  assert.deepEqual(candidate.externalIds, {
    katottg: "UA05060130010012345",
    osm: "R12345",
  });
  assert.equal(candidate.confidence, 92);
  assert.deepEqual(candidate.fieldSources.canonicalName, ["katottg"]);
  assert.deepEqual(candidate.fieldSources.latitude, ["openstreetmap"]);
  assert.ok(candidate.sources.some((source) => source.provider === "openstreetmap"));
  assert.ok(candidate.sources.some((source) => source.provider === "wikidata"));
  assert.equal(candidate.sources[0]?.datasetVersion, "2026-08");
});

test("confirmed draft cannot overwrite source wording or a researcher description", () => {
  const [candidate] = normalizeHistoricalPlaceDiscoveryResponse([{
    id: "osm:N1",
    canonicalName: "Трубіївка",
    placeType: "village",
    latitude: 49,
    longitude: 28,
    currentCountry: "Україна",
    currentAdmin: "Вінницька область",
    externalIds: { osm: "N1", katottg: "UA1", wikidata: "Q11" },
    confidence: 87,
    sources: [{ provider: "openstreetmap", url: "javascript:alert(1)" }],
  }]);
  assert.ok(candidate);

  const draft = toConfirmedHistoricalPlaceDraft(candidate);
  assert.equal("originalText" in draft, false);
  assert.equal("description" in draft, false);
  assert.equal(draft.wikidataId, "Q11");
  assert.equal(draft.geonamesId, null);
  assert.deepEqual(draft.externalIds, { osm: "N1", katottg: "UA1" });
  assert.equal(draft.sourceMetadata.sources[0]?.url, null);

  draft.externalIds.osm = "changed";
  draft.sourceMetadata.matchReasons.push("changed");
  assert.equal(candidate.externalIds.osm, "N1");
  assert.deepEqual(candidate.matchReasons, []);
});

test("rejects incomplete coordinate pairs and deduplicates repeated candidates", () => {
  const candidates = normalizeHistoricalPlaceDiscoveryResponse({
    results: [
      {
        id: "katottg:UA1",
        name: "Приклад",
        latitude: 50,
        externalIds: { katottg: "UA1", osm: "relation/123" },
        sources: [{ provider: "katottg", externalId: "UA1" }],
      },
      {
        id: "katottg:UA1",
        name: "Приклад",
        longitude: 30,
        wikidataId: "Q123",
        sources: [{ provider: "wikidata", externalId: "Q123" }],
      },
      { id: "invalid", canonicalName: "" },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.latitude, null);
  assert.equal(candidates[0]?.longitude, null);
  assert.equal(candidates[0]?.wikidataId, "Q123");
  assert.deepEqual(candidates[0]?.sources.map((source) => source.provider), ["katottg", "openstreetmap", "wikidata"]);
  assert.equal(
    candidates[0]?.sources.find((source) => source.provider === "openstreetmap")?.url,
    "https://www.openstreetmap.org/relation/123",
  );
});
