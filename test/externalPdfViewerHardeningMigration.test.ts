import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607300003_external_pdf_viewer_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);

test("hardening migration rejects credentialed and signed URLs at the database boundary", () => {
  assert.match(migration, /create or replace function private\.external_pdf_url_is_persistence_safe/u);
  assert.ok(migration.includes("or target_url ~* '^https://[^/?#]*@'"));
  assert.match(migration, /normalized_name like 'xamz%'/u);
  assert.match(migration, /normalized_name like 'xgoog%'/u);
  assert.match(migration, /pg_catalog\.strpos\(normalized_name, 'token'\) > 0/u);
  assert.match(migration, /pg_catalog\.strpos\(normalized_name, 'signature'\) > 0/u);
  assert.match(
    migration,
    /query_text := case[\s\S]*?pg_catalog\.strpos\(target_url, '\?'\)[\s\S]*?pg_catalog\.substr/u,
  );
  assert.match(
    migration,
    /query_text := case[\s\S]*?pg_catalog\.strpos\(cleaned_url, '\?'\)[\s\S]*?pg_catalog\.substr/u,
  );
  assert.match(migration, /document_sources_persistence_safe_urls_check/u);
  assert.match(migration, /finding_document_references_persistence_safe_snapshot_check/u);
  assert.match(
    migration,
    /drop constraint if exists document_sources_persistence_safe_urls_check/u,
    "a same-named weaker constraint must not bypass hardening",
  );
  assert.match(
    migration,
    /drop constraint if exists finding_document_references_persistence_safe_snapshot_check/u,
    "a same-named weaker snapshot constraint must not bypass hardening",
  );
  assert.match(migration, /validate constraint document_sources_persistence_safe_urls_check/u);
  assert.match(migration, /validate constraint finding_document_references_persistence_safe_snapshot_check/u);
  assert.match(
    migration,
    /grant execute on function private\.external_pdf_url_is_persistence_safe\(text\)[\s\S]*?to authenticated, service_role/u,
  );
});

test("unsafe legacy URLs are scrubbed without copying secrets into remediation or audit tables", () => {
  assert.match(migration, /create table if not exists private\.external_pdf_url_remediation_queue/u);
  assert.match(migration, /unsafe_columns text\[\] not null/u);
  assert.doesNotMatch(
    /create table if not exists private\.external_pdf_url_remediation_queue[\s\S]*?\);/u.exec(migration)?.[0] ?? "",
    /\b(?:url|value|payload)\s+(?:text|jsonb)/u,
  );
  assert.match(migration, /create or replace function private\.scrub_external_pdf_persistence_url/u);
  assert.match(migration, /SENSITIVE_URL_NOT_PERSISTABLE/u);
  assert.match(migration, /set[\s\S]*?snapshot_provider = null[\s\S]*?snapshot_url = null/u);

  const auditTable = /create table if not exists private\.document_source_merge_audit[\s\S]*?\);/u
    .exec(migration)?.[0] ?? "";
  assert.doesNotMatch(auditTable, /original_url|canonical_url|source_page_url|snapshot_url/u);
  assert.match(migration, /pg_catalog\.to_jsonb\(duplicate\)[\s\S]*?- 'original_url'[\s\S]*?- 'canonical_url'[\s\S]*?- 'source_page_url'/u);
  assert.match(migration, /pg_catalog\.to_jsonb\(reference\) - 'snapshot_url'/u);
  assert.match(migration, /create table if not exists private\.document_source_reference_merge_audit/u);
  assert.match(
    migration,
    /insert into private\.document_source_reference_merge_audit[\s\S]*?where ranked\.merge_rank > 1/u,
  );
  assert.match(
    migration,
    /delete from private\.external_pdf_url_remediation_queue as queue[\s\S]*?queue\.table_name = 'document_sources'[\s\S]*?not exists/u,
    "reruns must clear resolved source remediation entries",
  );
  assert.match(
    migration,
    /delete from private\.external_pdf_url_remediation_queue as queue[\s\S]*?queue\.table_name = 'finding_document_references'[\s\S]*?not exists/u,
    "reruns must clear resolved snapshot remediation entries",
  );
  assert.match(
    migration,
    /source\.status = 'invalid'[\s\S]*?requiresUrlRemediation[\s\S]*?= 'true'/u,
    "a scrubbed source stays queued until its remediation marker is explicitly cleared",
  );
  assert.match(
    migration,
    /queue\.table_name = 'finding_document_references'[\s\S]*?reference\.snapshot_url is null/u,
    "a scrubbed snapshot stays queued until a safe replacement exists",
  );

  const sourceMutation = /update public\.document_sources as source[\s\S]*?insert into private\.external_pdf_url_remediation_queue/u
    .exec(migration)?.[0] ?? "";
  assert.match(sourceMutation, /not private\.external_pdf_url_is_persistence_safe\(source\.original_url\)/u);
  const snapshotMutation = /update public\.finding_document_references as reference[\s\S]*?do \$\$/u
    .exec(migration)?.[0] ?? "";
  assert.match(snapshotMutation, /reference\.snapshot_url is not null/u);
  assert.match(snapshotMutation, /not private\.external_pdf_url_is_persistence_safe\(reference\.snapshot_url\)/u);
});

test("document source identity is backfilled, deterministically merged and uniquely indexed", () => {
  assert.match(migration, /create or replace function private\.document_source_identity_key/u);
  assert.match(migration, /pg_catalog\.sha256/u);
  assert.match(migration, /generated always as/u);
  assert.match(migration, /attribute\.attgenerated = 's'/u);
  assert.match(migration, /DOCUMENT_SOURCE_IDENTITY_COLUMN_DEFINITION_MISMATCH/u);
  assert.match(migration, /pg_catalog\.first_value\(source\.id\) over identity_group/u);
  assert.match(
    migration,
    /pg_catalog\.count\(\*\) over \(\s*partition by source\.project_id, source\.document_id, source\.source_identity_key\s*\)/u,
  );
  assert.match(migration, /order by[\s\S]*?case source\.status[\s\S]*?source\.created_at[\s\S]*?source\.id/u);
  assert.match(migration, /with best_duplicate as/u);
  assert.match(migration, /update public\.document_sources as survivor[\s\S]*?from best_duplicate as best/u);

  const referenceDelete = migration.indexOf("delete from public.finding_document_references");
  const referenceUpdate = migration.indexOf("update public.finding_document_references as reference", referenceDelete);
  const sourceDelete = migration.indexOf("delete from public.document_sources");
  const uniqueIndex = migration.indexOf("document_sources_natural_identity_unique");
  assert.ok(referenceDelete >= 0);
  assert.ok(referenceUpdate > referenceDelete);
  assert.ok(sourceDelete > referenceUpdate);
  assert.ok(uniqueIndex > sourceDelete);
  assert.match(
    migration,
    /create unique index if not exists document_sources_natural_identity_unique[\s\S]*?project_id[\s\S]*?document_id[\s\S]*?source_identity_key/u,
  );
  assert.match(migration, /DOCUMENT_SOURCE_IDENTITY_INDEX_DEFINITION_MISMATCH/u);
  assert.match(
    migration,
    /grant execute on function private\.document_source_identity_key\(text, text, text, text\)[\s\S]*?to authenticated, service_role/u,
  );
});

test("created_by is authenticated-user owned, immutable, and has an explicit service path", () => {
  assert.match(migration, /create or replace function private\.enforce_external_pdf_created_by/u);
  assert.match(migration, /new\.created_by is distinct from old\.created_by/u);
  assert.match(migration, /message = 'CREATED_BY_IMMUTABLE'/u);
  assert.match(migration, /new\.created_by is distinct from request_user_id/u);
  assert.match(migration, /message = 'CREATED_BY_MUST_MATCH_AUTH_USER'/u);
  assert.match(migration, /'postgres', 'service_role', 'supabase_admin'/u);
  assert.match(migration, /coalesce\(auth\.role\(\), ''\) = 'service_role'/u);
  assert.match(migration, /document_sources_enforce_created_by/u);
  assert.match(migration, /finding_document_references_enforce_created_by/u);
  assert.match(
    migration,
    /document_sources_insert_editors[\s\S]*?created_by = \(select auth\.uid\(\)\)/u,
  );
  assert.match(
    migration,
    /finding_document_references_insert_editors[\s\S]*?created_by = \(select auth\.uid\(\)\)/u,
  );
});

test("fingerprint and validation JSON cannot retain arbitrary secret-bearing metadata", () => {
  assert.match(migration, /create or replace function private\.external_pdf_fingerprint_is_persistence_safe/u);
  for (const key of ["sha1", "md5", "etag", "revisionId", "modifiedTime", "lastModified", "contentLength"]) {
    assert.ok(migration.includes(`'${key}'`));
  }
  assert.match(migration, /pg_catalog\.pg_column_size\(payload\) <= 8192/u);
  assert.match(migration, /create or replace function private\.external_pdf_validation_metadata_is_persistence_safe/u);
  assert.match(migration, /entry\.key <> 'requiresUrlRemediation'/u);
  assert.match(migration, /drop constraint if exists document_sources_safe_metadata_check/u);
  assert.match(migration, /drop constraint if exists finding_document_references_safe_fingerprint_check/u);
  assert.match(
    migration,
    /grant execute on function private\.external_pdf_fingerprint_is_persistence_safe\(jsonb\)[\s\S]*?to authenticated, service_role/u,
  );
});
