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

test("Storage rejects manual uploads and guards a client that skipped rotation", () => {
  assert.match(migration, /drop policy if exists project_backups_insert_owner/i);
  assert.match(migration, /tracker-rodu-automatic-/i);
  assert.doesNotMatch(migration, /tracker-rodu-manual-/i);
  assert.match(migration, /select count\(\*\)[\s\S]*?\) < 7/i);
  assert.match(migration, /drop policy if exists project_backups_update_owner/i);
});
