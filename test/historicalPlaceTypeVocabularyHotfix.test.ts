import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const foundation = read(
  "../supabase/migrations/202608280001_historical_places_foundation.sql",
);
const hotfix = read(
  "../supabase/migrations/202608300005_historical_place_type_vocabulary_hotfix.sql",
);
const discovery = read("../src/services/historicalPlaceDiscovery.ts");
const page = read("../src/pages/HistoricalPlacesPage.tsx");
const aiContract = read(
  "../supabase/functions/extract-historical-place-context/contract.ts",
);

function seededPlaceTypeCodes(source: string): string[] {
  const codes: string[] = [];
  const inserts = source.matchAll(
    /insert into public\.place_types\s*\([^)]*\)\s*values([\s\S]*?)on conflict \(code\)/giu,
  );
  for (const insert of inserts) {
    for (const value of insert[1].matchAll(/\(\s*'([a-z][a-z0-9_]*)'\s*,/gu)) {
      codes.push(value[1]);
    }
  }
  return codes;
}

function stringArray(source: string, startMarker: string, endMarker: string): string[] {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return [...source.slice(start, end).matchAll(/"([a-z][a-z0-9_]*)"/gu)].map(
    (match) => match[1],
  );
}

test("every place type emitted by the UI or discovery is seeded in the database", () => {
  const seeded = new Set([
    ...seededPlaceTypeCodes(foundation),
    ...seededPlaceTypeCodes(hotfix),
  ]);
  const emitted = new Set([
    ...stringArray(discovery, "const INTERNAL_PLACE_TYPES = new Set([", "]);"),
    ...stringArray(page, "const PLACE_TYPE_OPTIONS = [", "] as const;"),
    ...stringArray(aiContract, "const placeTypes = [", "] as const;"),
  ]);

  const missing = [...emitted].filter((code) => !seeded.has(code));
  assert.deepEqual(missing, []);
  assert.equal(seeded.has("urban_settlement"), true);
});

test("urban-settlement hotfix is idempotent and only updates the vocabulary", () => {
  assert.match(
    hotfix,
    /insert into public\.place_types[\s\S]*?'urban_settlement'[\s\S]*?'селище'/u,
  );
  assert.match(hotfix, /on conflict \(code\) do update set/u);
  assert.match(hotfix, /is_active = true/u);
  assert.doesNotMatch(hotfix, /\b(?:alter|drop)\s+table\b/iu);
  assert.doesNotMatch(
    hotfix,
    /\b(?:insert into|update|delete from)\s+public\.(?!place_types\b)/iu,
  );
});
