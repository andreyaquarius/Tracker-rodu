import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608250006_zagulyaky_retire_private_import_pipelines.sql", import.meta.url),
  "utf8",
);

test("retires the private Facebook/XLSX pipelines without deleting catalogue records", () => {
  const retiredTables = [
    "zagulyaky_tabular_import_record_origins",
    "zagulyaky_tabular_import_card_records",
    "zagulyaky_tabular_import_qc",
    "zagulyaky_tabular_import_chunks",
    "zagulyaky_tabular_import_participants",
    "zagulyaky_tabular_import_event_sources",
    "zagulyaky_tabular_import_cards",
    "zagulyaky_tabular_import_events",
    "zagulyaky_tabular_import_source_posts",
    "zagulyaky_tabular_import_batches",
    "zagulyaky_ingestion_structured_candidates",
    "zagulyaky_structuring_tasks",
    "zagulyaky_structuring_runs",
    "zagulyaky_ingestion_audit_events",
    "zagulyaky_ingestion_item_records",
    "zagulyaky_ingestion_attachments",
    "zagulyaky_ingestion_links",
    "zagulyaky_extraction_jobs",
    "zagulyaky_ingestion_item_errors",
    "zagulyaky_ingestion_chunks",
    "zagulyaky_ingestion_batch_items",
    "zagulyaky_ingestion_media_assets",
    "zagulyaky_ingestion_items",
    "zagulyaky_ingestion_batches",
  ];

  for (const table of retiredTables) {
    assert.match(migration, new RegExp(`drop table if exists public\\.${table};`, "i"));
  }

  assert.doesNotMatch(migration, /drop table[^;]*zagulyaky_records/i);
  assert.doesNotMatch(migration, /drop table[^;]*zagulyaky_sources/i);
  assert.doesNotMatch(migration, /drop table[^;]*zagulyaky_record_sources/i);
  assert.doesNotMatch(migration, /drop\s+(?:table|function|trigger)[^;\n]*\bcascade\b/i);
});

test("moves the durable Facebook origin out of the retired tabular ledger", () => {
  assert.match(migration, /create table if not exists public\.zagulyaky_record_origins/i);
  assert.match(migration, /insert into public\.zagulyaky_record_origins[\s\S]*?from public\.zagulyaky_tabular_import_record_origins as legacy/i);
  assert.match(migration, /ZAGULYAKY_ORIGIN_TRANSFER_INCOMPLETE/);
  assert.match(migration, /insert into public\.zagulyaky_record_sources\(record_id, source_id, is_primary\)[\s\S]*?from public\.zagulyaky_record_origins as origin_row/i);
  assert.match(migration, /create or replace function security_private\.zagulyaky_public_facebook_origin_v1[\s\S]*?from public\.zagulyaky_record_origins as origin_row/i);
  assert.match(migration, /'originalPostUrl', origin_row\.original_post_url_private/);
  assert.match(migration, /public_link_status = 'approved'/);
});

test("keeps ordinary moderation but strips private workbook text from its review bundle", () => {
  const reviewBundleStart = migration.indexOf("create or replace function security_private.admin_get_zagulyaka_review_bundle_v1");
  const cleanupStart = migration.indexOf("drop trigger if exists zagulyaky_tabular_import_card_record_origin_capture");
  assert.ok(reviewBundleStart >= 0 && cleanupStart > reviewBundleStart);
  const reviewBundle = migration.slice(reviewBundleStart, cleanupStart);

  assert.match(reviewBundle, /'privateImportOrigins'/);
  assert.match(reviewBundle, /from public\.zagulyaky_record_origins as origin_row/i);
  assert.doesNotMatch(reviewBundle, /zagulyaky_tabular_import_/i);
  assert.doesNotMatch(reviewBundle, /post_original_text|event_original_text|workbook_row_private/i);
});

test("removes the retired import permission and restricts routine removal to import pipelines", () => {
  assert.match(migration, /delete from public\.admin_role_permissions\s+where permission_code = 'zagulyaky\.import'/i);
  assert.match(migration, /namespace_row\.nspname = 'public'/);
  assert.match(migration, /namespace_row\.nspname = 'security_private'/);
  assert.match(migration, /procedure_row\.proname like '%zagulyaky_ingestion%'/);
  assert.match(migration, /procedure_row\.proname like '%zagulyaky_structuring%'/);
  assert.match(migration, /procedure_row\.proname like '%zagulyaky_tabular%'/);
  assert.match(migration, /procedure_row\.proname like 'zagulyaky_commit_recovery_%'/);
  assert.match(migration, /procedure_row\.proname like 'zagulyaky_structured_candidate_%'/);
  assert.match(migration, /procedure_row\.proname like 'zagulyaky_import_%'/);
});
