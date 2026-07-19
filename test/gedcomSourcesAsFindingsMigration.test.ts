import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607190002_gedcom_sources_as_findings.sql",
    import.meta.url,
  ),
  "utf8",
);

test("GEDCOM source migration adds and backfills a dedicated safe source URL", () => {
  assert.match(migration, /add column if not exists source_url text not null default ''/i);
  assert.match(migration, /findings_source_url_http_check/i);
  assert.match(migration, /pg_catalog\.substring\([\s\S]*?coalesce\(value, ''\),[\s\S]*?\$url\$/i);
  assert.match(migration, /update public\.findings finding[\s\S]*?document\.url[\s\S]*?finding\.source_url = ''/i);
  assert.match(migration, /pg_temp\.gedcom_visible_text/i);
  assert.match(migration, /set[\s\S]*?file_reference = pg_temp\.gedcom_visible_text/i);
});

test("one-time standalone findings bypass only application-context insert checks", () => {
  const accessDisableAt = migration.indexOf("disable trigger findings_scoped_insert_access");
  const researchDisableAt = migration.indexOf("disable trigger findings_require_research_scope");
  const insertAt = migration.indexOf("insert into public.findings", accessDisableAt);
  const researchEnableAt = migration.indexOf("enable trigger findings_require_research_scope", insertAt);
  const accessEnableAt = migration.indexOf("enable trigger findings_scoped_insert_access", insertAt);

  assert.ok(accessDisableAt >= 0 && researchDisableAt > accessDisableAt);
  assert.ok(insertAt > researchDisableAt && researchEnableAt > insertAt && accessEnableAt > researchEnableAt);
  assert.doesNotMatch(migration, /disable trigger all/i);
  assert.doesNotMatch(migration, /disable trigger findings_insert_gedcom_import_write_fence/i);
  assert.match(migration, /jsonb_build_object\('__gedcomStandaloneSource', true\)/i);
  assert.match(migration, /not exists \([\s\S]*?finding\.custom_fields->>'__gedcomSourceXref'/i);
});

test("legacy GEDCOM documents are deleted only when pristine and unreferenced", () => {
  assert.match(migration, /delete from public\.documents document[\s\S]*?document\.updated_at = document\.created_at/i);
  assert.match(migration, /__trackerRoduDocumentScans/i);
  for (const table of [
    "attachments",
    "tasks",
    "year_matrix",
    "hypothesis_links",
    "record_links",
    "person_names",
    "person_timeline_events",
    "partner_relationships",
    "parent_child_relationships",
    "association_relationships",
    "findings",
  ]) {
    assert.match(migration, new RegExp(`public\\.${table}`));
  }
  assert.match(
    migration,
    /__trackerRoduFindingMeta,fragmentSelection,documentId/i,
  );
});

test("compact project search includes finding source URLs", () => {
  assert.match(migration, /create index findings_project_search_trgm_idx[\s\S]*?source_url/i);
  assert.match(migration, /public\.search_project_records\(uuid,text,integer\)/i);
  assert.match(migration, /finding\.source_url/i);
});
