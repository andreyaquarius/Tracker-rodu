import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  isZagulyakaTitleAutofillActive,
  nextZagulyakaTitleFromNormalizedName,
  ZAGULYAKA_TITLE_MAX_LENGTH,
} from "../src/utils/zagulyakyTitleAutofill.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/202608250001_zagulyaky_saved_places_and_sources.sql", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const dialog = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/pages/ZagulyakyPage.css", import.meta.url),
  "utf8",
);

test("saved places and source presets are private owner-scoped snapshots", () => {
  assert.match(migration, /create table if not exists public\.zagulyaky_saved_places/i);
  assert.match(migration, /create table if not exists public\.zagulyaky_saved_source_presets/i);
  assert.match(migration, /owner_id uuid not null references auth\.users\(id\) on delete cascade/i);
  assert.match(migration, /alter table public\.zagulyaky_saved_places enable row level security/i);
  assert.match(migration, /alter table public\.zagulyaky_saved_source_presets enable row level security/i);
  assert.match(migration, /current_user_id uuid := auth\.uid\(\)/i);
  assert.match(migration, /normalize_zagulyaky_geo_point_v1\(p_place -> 'geo'\)/i);
  assert.match(migration, /zagulyaky_geo_point_is_canonical_v1\(geo\)/i);
  assert.match(migration, /revoke all on table public\.zagulyaky_saved_places[\s\S]*?authenticated/s);
  assert.match(migration, /revoke all on table public\.zagulyaky_saved_source_presets[\s\S]*?authenticated/s);
  assert.match(migration, /delete from public\.zagulyaky_saved_places[\s\S]*?owner_id = current_user_id/s);
  assert.match(migration, /delete from public\.zagulyaky_saved_source_presets[\s\S]*?owner_id = current_user_id/s);
  assert.ok(
    existsSync(new URL("../supabase/tests/zagulyaky_saved_inputs_test.sql", import.meta.url)),
    "the owner-bound database contract has a pgTAP regression test",
  );
});

test("client uses protected saved-input RPCs rather than browser table access", () => {
  for (const rpc of [
    "list_my_zagulyaky_saved_places_v1",
    "upsert_my_zagulyaky_saved_place_v1",
    "delete_my_zagulyaky_saved_place_v1",
    "list_my_zagulyaky_saved_source_presets_v1",
    "upsert_my_zagulyaky_saved_source_preset_v1",
    "delete_my_zagulyaky_saved_source_preset_v1",
  ]) {
    assert.match(service, new RegExp(`client\\.rpc\\("${rpc}"`));
  }
  assert.doesNotMatch(service, /\.from\("zagulyaky_saved_(?:places|source_presets)"\)/);
});

test("choosing a saved shortcut copies only the intended draft fields", () => {
  const placeHandlerStart = dialog.indexOf("const chooseSavedPlace");
  const placeHandlerEnd = dialog.indexOf("const saveCurrentFoundPlace", placeHandlerStart);
  const placeHandler = dialog.slice(placeHandlerStart, placeHandlerEnd);
  assert.match(placeHandler, /foundPlace: selected\.name/);
  assert.match(placeHandler, /foundGeo: \{ \.\.\.selected\.geo \}/);
  assert.doesNotMatch(placeHandler, /originPlace|originGeo/);

  const sourceHandlerStart = dialog.indexOf("const chooseSavedSourcePreset");
  const sourceHandlerEnd = dialog.indexOf("const saveCurrentSourcePreset", sourceHandlerStart);
  const sourceHandler = dialog.slice(sourceHandlerStart, sourceHandlerEnd);
  for (const field of ["institutionName", "archiveReference", "sourceTitle", "sourceUrl"]) {
    assert.match(sourceHandler, new RegExp(`${field}: selected\\.${field}`));
  }
  assert.doesNotMatch(sourceHandler, /pageLabel|pageRange/);
  assert.match(dialog, /Зберегти поточне місце/);
  assert.match(dialog, /Зберегти цю справу/);
  assert.match(styles, /\.zagulyaky-saved-inputs-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.zagulyaky-saved-inputs-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test("a blank person title follows Ukrainian normalized name until edited manually", () => {
  assert.equal(isZagulyakaTitleAutofillActive("person", ""), true);
  assert.equal(isZagulyakaTitleAutofillActive("person", "  "), true);
  assert.equal(isZagulyakaTitleAutofillActive("person", "Іван Каленський"), false);
  assert.equal(isZagulyakaTitleAutofillActive("document", ""), false);
  assert.equal(nextZagulyakaTitleFromNormalizedName("", "Іван Каленський", true), "Іван Каленський");
  assert.equal(
    nextZagulyakaTitleFromNormalizedName("Іван Каленський — шлюб 1874", "Іван Калинський", false),
    "Іван Каленський — шлюб 1874",
  );
  assert.equal(
    nextZagulyakaTitleFromNormalizedName("", "І".repeat(ZAGULYAKA_TITLE_MAX_LENGTH + 1), true).length,
    ZAGULYAKA_TITLE_MAX_LENGTH,
  );
  assert.match(dialog, /const updateNormalizedNameUk/);
  assert.match(dialog, /nextZagulyakaTitleFromNormalizedName/);
  assert.match(dialog, /const updateTitle/);
  assert.match(dialog, /Назва автоматично підставляється з нормалізованого ПІБ українською/);
  assert.match(dialog, /За потреби доповніть її подією, роком чи іншою деталлю/);
});
