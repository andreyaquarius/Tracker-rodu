import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607300001_external_pdf_viewer_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

test("external PDF source registry keeps stable metadata without binary payloads", () => {
  assert.match(migration, /create table if not exists public\.document_sources/i);
  assert.match(migration, /foreign key \(document_id, project_id\)[\s\S]*?references public\.documents\(id, project_id\)/i);
  assert.match(migration, /provider in \('google_drive', 'wikimedia', 'direct_pdf'\)/i);
  assert.match(migration, /original_url text not null/i);
  assert.match(migration, /access_mode in \('direct_cors', 'secure_proxy', 'google_drive_api'\)/i);
  assert.match(migration, /status in \('active', 'needs_auth', 'unavailable', 'changed', 'invalid'\)/i);
  assert.match(migration, /fingerprint jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /validation_metadata jsonb not null default '\{\}'::jsonb/i);
  assert.match(migration, /original_url is null or original_url ~\* '\^https:\/\/'/i);
  assert.doesNotMatch(migration, /\b(?:bytea|large object|base64)\b/i);
});

test("external PDF registry is indexed, timestamped and protected by project RLS", () => {
  assert.match(migration, /create unique index if not exists documents_id_project_unique/i);
  assert.match(migration, /create index if not exists document_sources_project_document_idx/i);
  assert.match(migration, /document_sources_set_updated_at[\s\S]*?public\.set_updated_at\(\)/i);
  assert.match(migration, /alter table public\.document_sources enable row level security/i);
  assert.match(migration, /for select to authenticated[\s\S]*?public\.is_project_member\(project_id\)/i);
  assert.match(migration, /for insert to authenticated[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /for update to authenticated[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /for delete to authenticated[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /revoke all on public\.document_sources from public, anon/i);
});

test("finding PDF provenance is additive, project-bound and keeps its source fingerprint immutable", () => {
  assert.match(migration, /create table if not exists public\.finding_document_references/i);
  assert.match(migration, /foreign key \(finding_id, project_id\)[\s\S]*?references public\.findings\(id, project_id\)/i);
  assert.match(migration, /foreign key \(document_source_id, project_id\)[\s\S]*?references public\.document_sources\(id, project_id\)/i);
  assert.match(migration, /page_index integer not null check \(page_index >= 1\)/i);
  assert.match(migration, /selection jsonb[\s\S]*?jsonb_typeof\(selection\) = 'object'/i);
  assert.match(migration, /source_fingerprint jsonb not null/i);
  assert.match(migration, /SOURCE_FINGERPRINT_IMMUTABLE/i);
  assert.match(migration, /snapshot_provider in \('google_drive', 'external'\)/i);
  assert.match(migration, /finding_document_references_set_updated_at[\s\S]*?public\.set_updated_at\(\)/i);
  assert.match(
    migration,
    /create unique index if not exists finding_document_references_retry_unique[\s\S]*?project_id[\s\S]*?finding_id[\s\S]*?document_source_id[\s\S]*?page_index/i,
  );
  assert.match(migration, /alter table public\.finding_document_references enable row level security/i);
  assert.match(migration, /finding_document_references_select_members[\s\S]*?public\.is_project_member\(project_id\)/i);
  assert.match(migration, /finding_document_references_insert_editors[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /Legacy findings\.custom_fields remains compatible/i);
});

test("external PDF viewer v2 is seeded off without overwriting a later rollout choice", () => {
  assert.match(migration, /'external_pdf_viewer_v2'[\s\S]*?false/i);
  assert.match(migration, /on conflict \(key\) do update[\s\S]*?title = excluded\.title[\s\S]*?description = excluded\.description/i);
  const conflictUpdate = migration.slice(migration.indexOf("on conflict (key) do update"));
  assert.doesNotMatch(conflictUpdate, /is_enabled\s*=/i);
  assert.match(migration, /Manual rollback plan/i);
});

test("new source tables participate in resumable project deletion before their parents", () => {
  assert.match(migration, /create or replace function private\.project_deletion_phase_names\(\)/i);
  const findingReferenceIndex = migration.lastIndexOf("'finding_document_references'");
  const findingsIndex = migration.lastIndexOf("'findings'");
  const sourceIndex = migration.lastIndexOf("'document_sources'");
  const documentIndex = migration.lastIndexOf("'documents'");
  assert.ok(findingReferenceIndex >= 0 && findingReferenceIndex < findingsIndex);
  assert.ok(sourceIndex >= 0 && sourceIndex < documentIndex);
});
