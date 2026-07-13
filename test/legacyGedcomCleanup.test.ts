import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const snapshotMigration = readFileSync(new URL(
  "../supabase/migrations/202607140001_resumable_legacy_gedcom_cleanup.sql",
  import.meta.url,
), "utf8");
const processorMigration = readFileSync(new URL(
  "../supabase/migrations/202607140002_process_legacy_gedcom_cleanup.sql",
  import.meta.url,
), "utf8");
const queueMigration = readFileSync(new URL(
  "../supabase/migrations/202607140003_queue_confirmed_legacy_gedcom_cleanups.sql",
  import.meta.url,
), "utf8");
const worker = readFileSync(new URL(
  "../supabase/functions/process-legacy-gedcom-cleanups/index.ts",
  import.meta.url,
), "utf8");
const workflow = readFileSync(new URL(
  "../.github/workflows/legacy-gedcom-cleanups.yml",
  import.meta.url,
), "utf8");
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");

test("legacy cleanup snapshots an exact source and protects every non-target person", () => {
  assert.match(snapshotMigration, /create table if not exists private\.legacy_gedcom_cleanup_jobs/i);
  assert.match(snapshotMigration, /create table if not exists private\.legacy_gedcom_cleanup_entities/i);
  assert.match(snapshotMigration, /custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key/i);
  assert.match(snapshotMigration, /GEDCOM_SOURCE_PERSON_COUNT_MISMATCH:expected=%,actual=%/i);
  const snapshotLock = snapshotMigration.match(/lock table[\s\S]*?in share mode;/i)?.[0] ?? "";
  for (const table of [
    "public.projects",
    "private.gedcom_import_operations",
    "storage.objects",
    "public.persons",
    "public.findings",
    "public.documents",
    "public.attachments",
    "public.activity_log",
    "public.record_links",
    "public.hypothesis_links",
    "public.family_tree_merge_history",
    "public.tree_layout_positions",
    "public.family_tree_research_issues",
    "public.person_timeline_events",
    "public.person_names",
    "public.task_persons",
    "public.archive_request_persons",
    "public.finding_participants",
  ]) {
    assert.ok(snapshotLock.includes(table), `${table} must be snapshot-locked`);
  }
  assert.match(
    snapshotMigration,
    /in share mode;[\s\S]*?PROJECT_NOT_FOUND_OR_DELETING[\s\S]*?GEDCOM_IMPORT_ALREADY_ACTIVE/i,
  );
  assert.match(snapshotMigration, /preserved_person_count integer not null/i);
  assert.match(snapshotMigration, /preserved_person_checksum text not null/i);
  assert.match(snapshotMigration, /md5\(coalesce\(string_agg\(person\.id::text, ',' order by person\.id\), ''\)\)/i);
  assert.match(processorMigration, /LEGACY_GEDCOM_CLEANUP_PRESERVE_INVARIANT_FAILED/i);
});

test("cleanup is dependency ordered, source filtered, and bounded to 500 root rows", () => {
  assert.match(snapshotMigration, /'storage_objects',[\s\S]*?'activity_log',[\s\S]*?'record_links'/i);
  assert.match(snapshotMigration, /'findings',[\s\S]*?'documents',[\s\S]*?'persons'/i);
  assert.match(processorMigration, /safe_batch_size integer := greatest\(1, least\(coalesce\(batch_size, 250\), 500\)\)/i);
  assert.match(processorMigration, /join private\.legacy_gedcom_cleanup_entities entity[\s\S]*?entity\.entity_type = 'finding'/i);
  assert.match(processorMigration, /when 'activity_log' then[\s\S]*?delete from public\.activity_log/i);
  assert.match(processorMigration, /when 'record_links' then[\s\S]*?when 'hypothesis_links'/i);
  assert.match(processorMigration, /when 'gedcom_xref_maps' then/i);
  assert.match(processorMigration, /when 'orphan_family_groups' then/i);
  assert.match(
    processorMigration,
    /when 'orphan_family_groups' then[\s\S]*?primary_partner_1_id is null[\s\S]*?primary_partner_2_id is null[\s\S]*?public\.parent_child_relationships[\s\S]*?family_group_id = family_group\.id/i,
  );
  assert.match(
    processorMigration,
    /when 'deleted_container_activity_log' then[\s\S]*?not exists \([\s\S]*?public\.parent_sets[\s\S]*?public\.family_groups/i,
  );
  assert.match(processorMigration, /when 'deleted_container_record_links' then/i);
  assert.match(processorMigration, /when 'deleted_container_xrefs' then/i);
  assert.doesNotMatch(
    processorMigration.match(/when 'activity_log' then[\s\S]*?when 'record_links' then/i)?.[0] ?? "",
    /entity\.entity_type = 'parent_set'|entity\.entity_type = 'family_group'/i,
  );
  assert.match(processorMigration, /LEGACY_GEDCOM_CLEANUP_SNAPSHOT_ROWS_REMAIN/i);
  assert.doesNotMatch(processorMigration, /delete from public\.projects/i);
  assert.doesNotMatch(processorMigration, /delete from public\.family_trees/i);
  assert.doesNotMatch(snapshotMigration, /delete from public\.projects/i);
  assert.doesNotMatch(snapshotMigration, /delete from public\.family_trees/i);
});

test("normal project writes and same-source imports are fenced until cleanup completes", () => {
  assert.match(
    snapshotMigration,
    /create or replace function public\.can_edit_project[\s\S]*?private\.legacy_gedcom_cleanup_jobs[\s\S]*?'paused'/i,
  );
  assert.match(snapshotMigration, /create or replace function private\.enforce_legacy_gedcom_cleanup_source_fence/i);
  assert.match(snapshotMigration, /create trigger persons_insert_legacy_gedcom_cleanup_fence/i);
  assert.match(snapshotMigration, /create trigger gedcom_import_operations_legacy_cleanup_fence/i);
  assert.match(snapshotMigration, /create trigger projects_legacy_gedcom_cleanup_delete_fence/i);
  assert.match(
    snapshotMigration,
    /create or replace function public\.clear_project_records_for_restore[\s\S]*?pg_advisory_xact_lock[\s\S]*?private\.legacy_gedcom_cleanup_jobs[\s\S]*?LEGACY_GEDCOM_CLEANUP_ACTIVE/i,
  );
  assert.equal((snapshotMigration.match(/hashtextextended\(target_project_id::text, 7419\)/g) ?? []).length, 2);
  assert.match(snapshotMigration, /resumable_job_id is not null[\s\S]*?can_manage_legacy_gedcom_cleanup/i);
});

test("the service worker removes Storage objects before attachment metadata", () => {
  assert.match(snapshotMigration, /create table if not exists private\.legacy_gedcom_cleanup_storage_objects/i);
  assert.match(snapshotMigration, /attachment\.storage_bucket = 'project-attachments'/i);
  assert.match(snapshotMigration, /storage_project_id\(attachment\.storage_path\)[\s\S]*?is distinct from target_project_id/i);
  assert.match(snapshotMigration, /Google Drive and other external providers are not Supabase Storage/i);
  assert.match(processorMigration, /current_phase = 'storage_objects'[\s\S]*?deleted_at is null/i);
  assert.match(
    processorMigration,
    /entity\.entity_type = 'attachment'[\s\S]*?attachment\.storage_bucket <> 'project-attachments'[\s\S]*?object\.deleted_at is not null/i,
  );
  assert.match(processorMigration, /list_legacy_gedcom_cleanup_storage_objects/i);
  assert.match(processorMigration, /mark_legacy_gedcom_cleanup_storage_deleted/i);
  assert.match(worker, /client\.storage[\s\S]*?\.from\(bucket\)[\s\S]*?\.remove/i);
  assert.match(worker, /mark_legacy_gedcom_cleanup_storage_deleted/i);
});

test("confirmed targets are replay safe and fail closed on partial counts", () => {
  assert.match(queueMigration, /9ec3889d-3532-48e4-870b-c6d61caec47d/g);
  assert.match(queueMigration, /gedcom-content:b160258f4be37cfbc05b7cf536a2d780/g);
  assert.match(queueMigration, /target_count = 17556/i);
  assert.match(queueMigration, /myheritage-project:a7fxu888-9f56-75ze-8ar2-8ar25f9e16aj/i);
  assert.match(queueMigration, /preserved_source_count <> 2480/i);
  assert.match(
    queueMigration,
    /create_legacy_gedcom_cleanup_job\([\s\S]*?YURII_PRESERVED_SOURCE_COUNT_CHANGED_AFTER_LOCK:expected=2480/i,
  );
  assert.match(queueMigration, /29547cd4-4d68-4328-b0c2-0a42abab1c75/g);
  assert.match(queueMigration, /gedcom-content:1fd05b33e6e557e32c1502947d78c1dd/g);
  assert.match(queueMigration, /target_count = 2760/i);
  assert.equal((queueMigration.match(/elsif target_count = 0/gi) ?? []).length, 2);
  assert.equal((queueMigration.match(/if exists \(\s*select 1 from public\.projects/gi) ?? []).length, 2);
  assert.match(queueMigration, /COUNT_MISMATCH/g);
  assert.doesNotMatch(queueMigration, /delete\s+from/i);
});

test("processing is service-only and scheduled with the existing cron secret", () => {
  assert.match(processorMigration, /create or replace function public\.process_next_legacy_gedcom_cleanup/i);
  assert.match(processorMigration, /SERVICE_ROLE_REQUIRED/i);
  assert.match(
    processorMigration,
    /grant execute on function public\.get_legacy_gedcom_cleanup_status\(uuid\),[\s\S]*?public\.process_next_legacy_gedcom_cleanup\(integer\)[\s\S]*?to service_role/i,
  );
  assert.match(worker, /TASK_REMINDER_CRON_SECRET/);
  assert.match(worker, /constantTimeEqual/);
  assert.match(worker, /process_next_legacy_gedcom_cleanup/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(workflow, /process-legacy-gedcom-cleanups/);
  assert.match(config, /\[functions\.process-legacy-gedcom-cleanups\][\s\S]*?verify_jwt\s*=\s*false/);
});
