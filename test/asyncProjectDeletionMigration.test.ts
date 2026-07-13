import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130011_async_project_deletion.sql",
    import.meta.url,
  ),
  "utf8",
);

test("project deletion uses a durable private resumable job", () => {
  assert.match(
    migration,
    /create table if not exists private\.project_deletion_jobs/i,
  );
  assert.match(
    migration,
    /where status in \('queued', 'running', 'failed'\)/i,
  );
  assert.match(migration, /processed_rows bigint not null default 0/i);
});

test("project deletion is exposed only as authenticated owner-admin RPCs", () => {
  assert.match(
    migration,
    /create or replace function public\.start_project_deletion\(target_project_id uuid\)[\s\S]*?PROJECT_DELETE_ACCESS_REQUIRED/i,
  );
  assert.match(
    migration,
    /revoke execute on function public\.start_project_deletion\(uuid\)\s+from public, anon/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.process_project_deletion\(uuid, integer\)\s+to authenticated/i,
  );
  assert.match(
    migration,
    /revoke delete on table public\.projects from public, anon, authenticated/i,
    "direct REST deletion must not bypass the asynchronous worker",
  );
});

test("each deletion step has a hard server-side batch ceiling", () => {
  assert.match(
    migration,
    /safe_batch_size integer := greatest\(1, least\(coalesce\(batch_size, 250\), 500\)\)/i,
  );
  assert.match(
    migration,
    /where project_id = \$1[\s\S]*?limit \$2[\s\S]*?delete from %s target/i,
  );
  assert.match(
    migration,
    /if deleted_count > 0 then\s+return private\.project_deletion_job_payload/i,
  );
});

test("active deletion prevents a completed phase from being repopulated", () => {
  assert.match(
    migration,
    /create or replace function public\.can_edit_project[\s\S]*?not exists \([\s\S]*?private\.project_deletion_jobs[\s\S]*?status in \('queued', 'running', 'failed'\)/i,
  );
  assert.match(
    migration,
    /create policy projects_update_owner[\s\S]*?and not deletion_pending[\s\S]*?with check \([\s\S]*?and not deletion_pending/i,
  );
});

test("a service-only worker resumes jobs and gates finalization on storage cleanup", () => {
  assert.match(
    migration,
    /add column if not exists deletion_pending boolean not null default false/i,
  );
  assert.match(
    migration,
    /when phase_index >= phase_count and storage_cleaned_at is null\s+then 'storage_cleanup'/i,
  );
  assert.match(
    migration,
    /create or replace function public\.process_next_project_deletion[\s\S]*?SERVICE_ROLE_REQUIRED/i,
  );
  assert.match(
    migration,
    /where job\.status in \('queued', 'running', 'failed'\)/i,
  );
  assert.match(
    migration,
    /create or replace function public\.mark_project_deletion_storage_cleaned[\s\S]*?SERVICE_ROLE_REQUIRED/i,
  );
  assert.match(
    migration,
    /revoke execute on function public\.process_next_project_deletion\(integer\)\s+from public, anon, authenticated/i,
  );
});

test("deletion batches use project indexes and suppress redundant graph version bumps", () => {
  assert.match(
    migration,
    /first_key\.attname = 'project_id'[\s\S]*?create index if not exists %I on %s \(project_id\)/i,
  );
  assert.match(
    migration,
    /current_setting\('app\.project_deletion', true\) = 'on'/i,
  );
  assert.match(
    migration,
    /set_config\('app\.project_deletion', 'on', true\)/i,
  );
  assert.doesNotMatch(
    migration,
    /where project_id = \$1\s+order by ctid/i,
  );
});

test("backup uploads cannot race storage cleanup and final project deletion", () => {
  assert.match(
    migration,
    /create policy project_backups_insert_owner[\s\S]*?is_project_owner[\s\S]*?can_edit_project/i,
  );
  assert.match(
    migration,
    /create policy project_backups_update_owner[\s\S]*?using \([\s\S]*?can_edit_project[\s\S]*?with check \([\s\S]*?can_edit_project/i,
  );
});
