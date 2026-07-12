import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130005_dashboard_stats_cache.sql",
    import.meta.url,
  ),
  "utf8",
);

test("dashboard stats cache is membership-scoped and hidden from API roles", () => {
  assert.match(migration, /create schema if not exists private/i);
  assert.match(migration, /revoke all on schema private from public, anon, authenticated/i);
  assert.match(migration, /not public\.is_project_member\(target_project_id\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = pg_catalog, public, private, pg_temp/i);
  assert.match(migration, /set statement_timeout = '5s'/i);
});

test("dashboard stats cache serializes cold bursts and rechecks after locking", () => {
  assert.match(migration, /interval '20 seconds'/i);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.equal(
    [...migration.matchAll(/from private\.project_dashboard_stats_cache cache/gi)].length,
    2,
  );
  assert.match(migration, /on conflict \(project_id\) do update/i);
});
