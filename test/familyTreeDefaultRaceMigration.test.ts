import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130008_family_tree_default_race.sql",
    import.meta.url,
  ),
  "utf8",
);

test("default family tree creation is atomic for parallel GEDCOM batches", () => {
  assert.match(
    migration,
    /create or replace function public\.family_tree_default_for_project/i,
  );
  assert.match(
    migration,
    /create or replace function public\.ensure_default_family_tree/i,
  );
  assert.equal(
    (migration.match(/on conflict \(project_id\) where is_default do update/gi) ?? []).length,
    2,
  );
  assert.equal(
    (migration.match(/returning existing_tree\.id into target_tree_id/gi) ?? []).length,
    2,
  );
  assert.equal(
    (migration.match(/if target_tree_id is not null then\s+return target_tree_id/gi) ?? []).length,
    2,
  );
  assert.equal(
    (migration.match(/pg_catalog\.pg_advisory_xact_lock/gi) ?? []).length,
    2,
  );
  assert.equal(
    (migration.match(/pg_catalog\.hashtextextended/gi) ?? []).length,
    2,
  );
  assert.equal((migration.match(/set search_path = ''/gi) ?? []).length, 2);
  assert.match(
    migration,
    /revoke execute on function public\.family_tree_default_for_project\(uuid, uuid\)[\s\S]*?from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.ensure_default_family_tree\(uuid\)[\s\S]*?to authenticated/i,
  );
});
