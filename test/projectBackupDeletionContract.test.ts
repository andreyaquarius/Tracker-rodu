import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/projectBackups.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130016_project_deletion_schema_contract.sql",
    import.meta.url,
  ),
  "utf8",
);

test("backup restore clears project content through bounded server batches", () => {
  assert.match(service, /rpc\("clear_project_records_for_restore"/);
  assert.match(service, /batch_size:\s*500/);
  assert.match(service, /result\?\.complete === true/);
  assert.match(service, /Number\.isFinite\(deletedRows\)/);
  assert.match(service, /PROJECT_RESTORE_CLEAR_INVALID_PROGRESS/);
  assert.doesNotMatch(
    service,
    /const tables\s*=\s*\[/,
    "the client must not maintain a second incomplete table list",
  );

  assert.match(
    migration,
    /safe_batch_size integer := greatest\(1, least\(coalesce\(batch_size, 500\), 500\)\)/i,
  );
  assert.match(
    migration,
    /where project_id = \$1[\s\S]*?limit \$2[\s\S]*?delete from %s target/i,
  );
});

test("backup restore derives all content phases from the deletion contract", () => {
  assert.match(
    migration,
    /unnest\(private\.project_deletion_phase_names\(\)\)/i,
  );
  assert.match(
    migration,
    /not in \('activity_log', 'project_invitations'\)/i,
    "only audit/access records are retained during restore",
  );
  assert.match(migration, /delete from private\.project_dashboard_stats_cache/i);
  assert.doesNotMatch(
    migration,
    /delete from public\.projects/i,
    "restoring content must never delete the workspace itself",
  );
  assert.doesNotMatch(
    migration,
    /delete from public\.project_members/i,
    "restoring content must preserve collaborators",
  );
});

test("backup restore clear RPC is owner-admin only and rejects deleting projects", () => {
  assert.match(
    migration,
    /not public\.is_project_owner\(target_project_id\)[\s\S]*?not public\.is_app_admin\(actor_id\)/i,
  );
  assert.match(migration, /PROJECT_RESTORE_ACCESS_REQUIRED/i);
  assert.match(migration, /project\.deletion_pending/i);
  assert.match(migration, /PROJECT_DELETION_IN_PROGRESS/i);
  assert.match(
    migration,
    /revoke execute on function public\.clear_project_records_for_restore\(uuid, integer\)\s+from public, anon/i,
  );
});
