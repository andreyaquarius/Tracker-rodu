import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607190003_person_and_gedcom_deletion.sql",
    import.meta.url,
  ),
  "utf8",
);
const moduleSource = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const catalog = readFileSync(
  new URL("../src/features/persons-v2/PersonsCatalogV2.tsx", import.meta.url),
  "utf8",
);
const profile = readFileSync(
  new URL("../src/features/persons-v2/PersonProfileV2.tsx", import.meta.url),
  "utf8",
);
const preview = readFileSync(
  new URL("../src/features/persons-v2/PersonPreviewDrawerV2.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("person deletion is an authorized atomic RPC with a root-person guard", () => {
  assert.match(migration, /create or replace function public\.delete_project_persons/u);
  assert.match(migration, /create or replace function security_private\.delete_project_persons[\s\S]*?security definer/iu);
  assert.match(migration, /create or replace function public\.delete_project_persons[\s\S]*?security invoker[\s\S]*?set search_path = pg_catalog/iu);
  assert.match(migration, /security_private\.can_edit_project\(target_project_id\)/u);
  assert.match(migration, /raise exception 'PERSON_IS_TREE_ROOT'/u);
  assert.match(migration, /raise exception 'PERSON_DELETE_TARGET_MISMATCH'/u);
  assert.match(migration, /__trackerRoduFindingMeta,personIds/u);
});

test("GEDCOM ownership survives person reconciliation and blocks a second import", () => {
  assert.match(migration, /create table if not exists private\.gedcom_import_datasets/u);
  assert.match(migration, /gedcom_import_operations_capture_dataset/u);
  assert.match(migration, /list_project_gedcom_import_datasets/u);
  assert.match(migration, /add column if not exists import_source_key text/u);
  assert.match(migration, /relation\.import_source_key = trim\(target_import_source_key\)/u);
  assert.match(migration, /finding\.custom_fields ->> '__gedcomImportSourceKey'/u);
  assert.match(migration, /tree\.settings ->> 'import_source_key'/u);
  assert.match(migration, /raise exception 'GEDCOM_IMPORT_ALREADY_EXISTS'/u);
  assert.match(migration, /from public\.person_relations relation[\s\S]*?nullif\(trim\(relation\.import_source_key\)/u);
});

test("persons catalogue exposes individual, bulk and GEDCOM-group deletion", () => {
  assert.match(catalog, /PersonsCatalogBulkActionV2 = "tag" \| "export" \| "merge" \| "delete"/u);
  assert.match(catalog, /Видалити вибраних/u);
  assert.match(catalog, /onDeletePerson\(person\)/u);
  assert.match(moduleSource, /GedcomImportManagerV2/u);
  assert.match(moduleSource, /Перед видаленням перегляньте й за потреби вручну відвʼяжіть важливі записи/u);
  assert.match(moduleSource, /самі файли на Google Drive не видаляються/u);
  assert.match(moduleSource, /кореневою для поточного родового дерева/u);
  assert.match(profile, /onDelete[\s\S]*?Видалити особу/u);
  assert.match(preview, /onDelete[\s\S]*?Видалити особу/u);
});

test("preview drawer compacts the table instead of exposing overlapping right columns", () => {
  assert.match(
    styles,
    /@container persons-catalog-shell \(max-width: 860px\)[\s\S]*?min-width:\s*250px[\s\S]*?th:nth-child\(8\)[\s\S]*?td:nth-child\(8\)/u,
  );
  assert.match(styles, /\.persons-v2-list__actions/u);
  assert.match(styles, /\.persons-v2-grid-card__controls/u);
});
