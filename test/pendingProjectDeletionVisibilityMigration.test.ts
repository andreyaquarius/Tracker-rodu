import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130013_pending_project_deletion_visibility.sql",
    import.meta.url,
  ),
  "utf8",
);

test("pending deletion jobs are listed without exposing the private job table", () => {
  assert.match(
    migration,
    /create or replace function public\.list_accessible_project_deletions\(\)/i,
  );
  assert.match(migration, /security definer[\s\S]*?set search_path = pg_catalog, public, private, pg_temp/i);
  assert.match(migration, /private\.project_deletion_job_payload\(job\.id\)/i);
  assert.match(migration, /job\.status in \('queued', 'running', 'failed'\)/i);
});

test("only the requester, owner or administrator can discover an active deletion", () => {
  assert.match(migration, /job\.requested_by = actor_id/i);
  assert.match(migration, /project\.owner_id = actor_id/i);
  assert.match(migration, /actor_is_admin := public\.is_app_admin\(actor_id\)/i);
  assert.match(
    migration,
    /revoke execute on function public\.list_accessible_project_deletions\(\)\s+from public, anon/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.list_accessible_project_deletions\(\)\s+to authenticated/i,
  );
});
