import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608270005_historical_person_names.sql",
    import.meta.url,
  ),
  "utf8",
);

test("historical names extend the existing person_names table without replacing persons", () => {
  assert.match(migration, /alter table public\.person_names[\s\S]*?add column if not exists full_normalized/i);
  assert.match(migration, /add column if not exists valid_from text/i);
  assert.match(migration, /add column if not exists valid_to text/i);
  assert.match(migration, /add column if not exists citation_id uuid/i);
  assert.match(migration, /add column if not exists document_fragment_id uuid/i);
  assert.doesNotMatch(migration, /drop table(?: if exists)? public\.person_names/i);
  assert.doesNotMatch(migration, /alter table public\.persons[\s\S]*?drop column/i);
  assert.doesNotMatch(migration, /person_names_valid_period_check/i);
  assert.match(migration, /comment on column public\.person_names\.original_text is[\s\S]*?Never normalized or overwritten/i);
});

test("legacy variant backfill is additive and keeps exact source text", () => {
  assert.match(migration, /regexp_split_to_table\([\s\S]*?person\.name_variants/i);
  assert.match(migration, /regexp_split_to_table\([\s\S]*?person\.surname_variants/i);
  assert.match(migration, /__trackerRoduMaidenSurname/i);
  assert.match(migration, /'\[;,\\n\\r\]\+'/i);
  assert.match(migration, /distinct on \(person\.id, btrim\(item\.value\)\)/i);
  assert.match(migration, /where not exists \([\s\S]*?from public\.person_names existing/i);
  assert.match(
    migration,
    /with missing_primary as \([\s\S]*?not exists \([\s\S]*?current_primary\.is_primary[\s\S]*?set is_primary = true/i,
  );
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf("-- Backfill only the newly added columns"),
      migration.indexOf("create or replace function security_private.prepare_historical_person_name_v1"),
    ),
    /update public\.persons/i,
  );
});

test("mixed-version metadata is backfilled without rewriting historical timestamps", () => {
  const backfill = migration.slice(
    migration.indexOf("-- Backfill only the newly added columns"),
    migration.indexOf("create or replace function security_private.prepare_historical_person_name_v1"),
  );
  assert.match(backfill, /tracker_person_name_v2,fullNormalized/i);
  assert.match(backfill, /name_type = case[\s\S]*?tracker_person_name_v2,nameType/i);
  assert.match(backfill, /tracker_person_name_v2,isSearchable/i);
  assert.match(backfill, /tracker_person_name_v2,documentFragmentId/i);
  assert.match(migration, /drop trigger if exists person_names_set_updated_at[\s\S]*?update public\.person_names/i);
  assert.match(backfill, /create trigger person_names_set_updated_at[\s\S]*?execute function public\.set_updated_at/i);
});

test("derived search forms never write original_text", () => {
  const prepare = migration.slice(
    migration.indexOf("create or replace function security_private.prepare_historical_person_name_v1"),
    migration.indexOf("drop trigger if exists person_names_10_prepare_historical"),
  );
  assert.match(prepare, /new\.original_tokens := public\.person_name_search_tokens_v1\(new\.original_text\)/i);
  assert.doesNotMatch(prepare, /new\.original_text\s*:=/i);
  assert.match(prepare, /v2_metadata := case[\s\S]*?tracker_person_name_v2/i);
  assert.match(prepare, /new\.name_type := v2_metadata ->> 'nameType'/i);
  assert.match(prepare, /new\.full_normalized := coalesce\(v2_metadata ->> 'fullNormalized'/i);
  assert.match(prepare, /new\.is_searchable := \(v2_metadata ->> 'isSearchable'\)::boolean/i);
  assert.match(migration, /person_names_search_text_trgm_idx[\s\S]*?gin_trgm_ops/i);
  assert.match(prepare, /PERSON_NAME_SOURCE_DOCUMENT_PROJECT_MISMATCH/i);
  assert.match(prepare, /PERSON_NAME_SOURCE_FINDING_PROJECT_MISMATCH/i);
  assert.match(prepare, /document\.project_id = new\.project_id/i);
  assert.match(prepare, /finding\.project_id = new\.project_id/i);
});

test("exact restore is project-scoped, trigger-safe, and validates every source form", () => {
  const restore = migration.slice(
    migration.indexOf("create or replace function security_private.restore_project_person_names_v1"),
    migration.indexOf("revoke all on function security_private.restore_project_person_names_v1"),
  );
  assert.match(migration, /create table if not exists security_private\.person_name_restore_context/i);
  assert.match(restore, /lock table public\.person_names in share row exclusive mode/i);
  assert.match(restore, /insert into security_private\.person_name_restore_context/i);
  assert.match(restore, /delete from security_private\.person_name_restore_context/i);
  assert.doesNotMatch(restore, /access exclusive|disable trigger|enable trigger/i);
  assert.match(restore, /restored\(source_type text, source_id uuid\)[\s\S]*?source_type = 'document'/i);
  assert.match(restore, /restored\(source_type text, source_id uuid\)[\s\S]*?source_type = 'finding'/i);
  assert.match(restore, /phonetic_key, search_text[\s\S]*?''::text/i);
  assert.match(migration, /for key share[\s\S]*?PERSON_NAME_SOURCE_DOCUMENT_PROJECT_MISMATCH/i);
  assert.match(restore, /from public\.projects project[\s\S]*?for update[\s\S]*?PERSON_NAMES_BACKUP_PRIMARY_REQUIRED/i);
  assert.match(migration, /create trigger person_names_detach_document_source[\s\S]*?before delete on public\.documents/i);
  assert.match(migration, /create trigger person_names_detach_finding_source[\s\S]*?before delete on public\.findings/i);
});

test("primary-name RPC is atomic, editor-scoped and never rewrites legacy persons", () => {
  assert.match(
    migration,
    /create or replace function security_private\.set_project_person_name_primary_v1\(\s*p_project_id uuid,\s*p_person_id uuid,\s*p_name_id uuid/i,
  );
  assert.match(migration, /create or replace function security_private\.set_project_person_name_primary_v1[\s\S]*?security definer/i);
  assert.match(migration, /create or replace function public\.set_project_person_name_primary_v1[\s\S]*?security invoker/i);
  assert.match(migration, /not public\.can_edit_project\(p_project_id\)/i);
  assert.match(migration, /from public\.persons person[\s\S]*?for update/i);
  assert.match(migration, /set is_primary = false[\s\S]*?set is_primary = true/i);
  const setPrimary = migration.slice(
    migration.indexOf("create or replace function security_private.set_project_person_name_primary_v1"),
    migration.indexOf("revoke all on function security_private.set_project_person_name_primary_v1"),
  );
  assert.doesNotMatch(setPrimary, /update public\.persons/i);
  assert.doesNotMatch(setPrimary, /original_text\s*=/i);
  assert.match(setPrimary, /'displayName', display_name/i);
  assert.doesNotMatch(migration, /tracker_rodu\.person_name_primary_switch/i);
});

test("primary-name invariant rejects direct editor changes but permits controlled cascades", () => {
  const guard = migration.slice(
    migration.indexOf("create or replace function security_private.guard_historical_person_name_primary_v1"),
    migration.indexOf("create or replace function security_private.prepare_historical_person_name_v1"),
  );
  assert.match(guard, /current_user <> 'authenticated'/i);
  assert.match(guard, /PERSON_NAME_PRIMARY_DIRECT_CHANGE_FORBIDDEN/i);
  assert.match(guard, /PERSON_NAME_PRIMARY_DELETE_FORBIDDEN/i);
  assert.match(guard, /PERSON_NAME_IDENTITY_MOVE_FORBIDDEN/i);
  assert.match(guard, /row\(old\.project_id, old\.person_id\)[\s\S]*?row\(new\.project_id, new\.person_id\)/i);
  assert.match(guard, /not exists \([\s\S]*?public\.projects[\s\S]*?not exists \([\s\S]*?public\.persons/i);
  assert.match(migration, /create trigger person_names_05_guard_primary[\s\S]*?before insert or update or delete/i);
});

test("legacy person projection owns only its generated name row", () => {
  const projection = migration.slice(
    migration.indexOf("create or replace function public.family_tree_sync_person_projection"),
    migration.indexOf("revoke all on function public.family_tree_sync_person_projection"),
  );
  assert.match(projection, /metadata ->> 'source'[\s\S]*?like 'persons_projection%'/i);
  assert.match(projection, /not has_primary_name[\s\S]*?not has_primary_name/i);
  const projectionUpdate = projection.slice(
    projection.indexOf("else\n    update public.person_names"),
    projection.indexOf("delete from public.person_timeline_events"),
  );
  assert.doesNotMatch(projectionUpdate, /original_text\s*=/i);
});

test("name search is project-scoped, indexed and reports match provenance", () => {
  assert.match(migration, /create or replace function public\.search_project_person_names_v1/i);
  assert.match(migration, /not public\.is_project_member\(p_project_id\)/i);
  assert.match(migration, /name\.project_id = p_project_id[\s\S]*?name\.is_searchable/i);
  assert.match(migration, /p_limit integer default 20/i);
  for (const key of ["personId", "personNameId", "displayName", "matchedName", "matchType", "score"]) {
    assert.match(migration, new RegExp(`'${key}'`, "i"));
  }
  for (const matchType of ["exact", "normalized", "variant", "fuzzy"]) {
    assert.match(migration, new RegExp(`'${matchType}'`, "i"));
  }
  assert.match(migration, /when 0 then 'exact'[\s\S]*?when 1 then 'normalized'/i);
  assert.ok(
    migration.indexOf("if char_length(raw_query) > 200")
      < migration.indexOf("normalized_query := public.person_name_search_normalize_v1"),
    "query length must be bounded before normalization and transliteration",
  );
});

test("normalization preview is read-only and project scoped", () => {
  const preview = migration.slice(
    migration.indexOf("create or replace function public.preview_project_person_name_normalization_v1"),
    migration.indexOf("create or replace function security_private.set_project_person_name_primary_v1"),
  );
  assert.match(preview, /security invoker/i);
  assert.match(preview, /public\.is_project_member\(p_project_id\)/i);
  assert.match(preview, /'normalized'[\s\S]*?'simplified'[\s\S]*?'transliteration'[\s\S]*?'tokens'/i);
  assert.doesNotMatch(preview, /\b(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\./i);
});

test("per-name history is trigger-owned and private", () => {
  assert.match(migration, /create table if not exists security_private\.person_name_audit_log/i);
  assert.match(migration, /create trigger person_names_90_audit_historical[\s\S]*?after insert or update or delete/i);
  assert.match(migration, /security_private\.audit_historical_person_name_v1/i);
  assert.match(migration, /revoke all on security_private\.person_name_audit_log[\s\S]*?from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /grant select on security_private\.person_name_audit_log to authenticated/i);
  const audit = migration.slice(
    migration.indexOf("create or replace function security_private.audit_historical_person_name_v1"),
    migration.indexOf("drop trigger if exists person_names_90_audit_historical"),
  );
  assert.match(audit, /tg_op = 'DELETE'[\s\S]*?not exists \([\s\S]*?public\.projects[\s\S]*?not exists \([\s\S]*?public\.persons/i);
});

test("historical-name RPCs are not anonymous and person_names keeps editor RLS", () => {
  assert.match(migration, /revoke all on function public\.search_project_person_names_v1\(uuid,text,integer\)[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.search_project_person_names_v1\(uuid,text,integer\)[\s\S]*?to authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.preview_project_person_name_normalization_v1\(uuid,text\)[\s\S]*?to authenticated, service_role/i);
  assert.match(migration, /create policy person_names_insert_editors[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /create policy person_names_update_editors[\s\S]*?public\.can_edit_project\(project_id\)/i);
  assert.match(migration, /create policy person_names_delete_editors[\s\S]*?public\.can_edit_project\(project_id\)/i);
});
