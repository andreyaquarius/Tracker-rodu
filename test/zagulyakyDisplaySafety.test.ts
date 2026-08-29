import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { zagulyakyDisplayText } from "../src/utils/zagulyakyDisplayText.ts";

const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../supabase/migrations/202608290006_zagulyaky_my_records_display_fields.sql", import.meta.url),
  "utf8",
);

test("legacy table-title import instructions are never presented as places", () => {
  assert.equal(zagulyakyDisplayText("found_place_from_table_title"), "");
  assert.equal(zagulyakyDisplayText("Found-Place-From-Table-Title"), "");
  assert.equal(zagulyakyDisplayText("  Політанки  "), "Політанки");
});

test("private record summaries include compact place fallbacks without wide payloads", () => {
  assert.match(migration, /'found_location_text', r\.found_location_text/);
  assert.match(migration, /'found_location_normalized', r\.found_location_normalized/);
  assert.match(migration, /'source_location_text', r\.source_location_text/);
  assert.match(migration, /'source_location_normalized', r\.source_location_normalized/);
  assert.doesNotMatch(migration, /'payload', r\.payload|'original_text', r\.original_text/);
  assert.match(service, /title: zagulyakyDisplayText\(value\(row, "title"\)\)[\s\S]*?\|\| foundPlace[\s\S]*?\|\| originPlace/);
  assert.match(page, /const placeLabel = item\.foundPlace \|\| item\.originPlace/);
  assert.match(page, /const placeRole = item\.foundPlace \? "Де знайдено" : "Походження"/);
});

test("public people, documents, and detail mappings share the display sanitizer", () => {
  const uses = service.match(/zagulyakyDisplayText\(/g) ?? [];
  assert.ok(uses.length >= 10, "all catalogue and private display paths should be sanitised");
  assert.doesNotMatch(page, /found_place_from_table_title/i);
});
