import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../src/pages/BackupPage.tsx", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/projectBackups.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608060001_disable_manual_project_backups.sql",
    import.meta.url,
  ),
  "utf8",
);
const recursionFixMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608230001_fix_project_backup_storage_rls_recursion.sql",
    import.meta.url,
  ),
  "utf8",
);

test("users cannot create an unbounded manual internal backup from the UI", () => {
  assert.doesNotMatch(page, /createInternalBackup/);
  assert.doesNotMatch(page, />\s*Внутрішня копія\s*</);
  assert.doesNotMatch(page, />\s*Створити резервну копію\s*</);
  assert.doesNotMatch(page, /createProjectBackup\([^)]*,\s*["']manual["']\)/);
});

test("all application snapshots use one bounded automatic rotation", () => {
  assert.match(service, /MAX_AUTOMATIC_BACKUPS_PER_PROJECT\s*=\s*7/);
  assert.match(service, /tracker-rodu-automatic-/);
  assert.match(
    service,
    /pruneAutomaticProjectBackups\(\s*projectId,\s*MAX_AUTOMATIC_BACKUPS_PER_PROJECT - 1/,
  );
  assert.match(
    service,
    /pruneAutomaticProjectBackups\(projectId, MAX_AUTOMATIC_BACKUPS_PER_PROJECT\)/,
  );

  const makeRoom = service.indexOf(
    "MAX_AUTOMATIC_BACKUPS_PER_PROJECT - 1",
  );
  const upload = service.indexOf(".upload(path, blob");
  assert.ok(makeRoom >= 0 && upload > makeRoom, "oldest backup must be deleted before upload");
  assert.match(service, /sortBy:\s*\{\s*column:\s*["']created_at["'],\s*order:\s*["']desc["']/);
  assert.match(service, /\.slice\(Math\.max\(0, keep\)\)/);
});

test("Storage keeps the automatic-backup cap without re-reading its own RLS relation", () => {
  assert.match(migration, /drop policy if exists project_backups_insert_owner/i);
  assert.match(migration, /tracker-rodu-automatic-/i);
  assert.doesNotMatch(migration, /tracker-rodu-manual-/i);
  assert.match(migration, /drop policy if exists project_backups_update_owner/i);

  const policyStart = recursionFixMigration.indexOf(
    "create policy project_backups_insert_owner",
  );
  const policyEnd = recursionFixMigration.indexOf(
    ");\n\ncommit;",
    policyStart,
  );
  assert.ok(policyStart >= 0 && policyEnd > policyStart);
  const policy = recursionFixMigration.slice(policyStart, policyEnd);
  assert.match(policy, /tracker-rodu-automatic-/i);
  assert.match(policy, /public\.is_project_owner/i);
  assert.match(policy, /public\.can_edit_project/i);
  assert.match(policy, /security_private\.project_backup_slot_available_v1/i);
  assert.doesNotMatch(
    policy,
    /from\s+storage\.objects/i,
    "a policy on storage.objects must not query storage.objects again",
  );
  assert.match(
    recursionFixMigration,
    /create or replace function security_private\.project_backup_slot_available_v1\(\s*p_project_id uuid\s*\)[\s\S]*?security definer/i,
  );
  assert.match(
    recursionFixMigration,
    /count\(\*\) < 7[\s\S]*?from\s+storage\.objects existing/i,
  );
  assert.match(
    recursionFixMigration,
    /revoke all on function security_private\.project_backup_slot_available_v1\(uuid\)[\s\S]*?grant execute on function security_private\.project_backup_slot_available_v1\(uuid\)\s+to authenticated/i,
  );
});
