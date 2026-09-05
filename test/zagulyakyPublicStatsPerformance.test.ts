import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202609050002_zagulyaky_public_stats_timeout_fix.sql",
    import.meta.url,
  ),
  "utf8",
);

test("public Zagulyaky statistics aggregate only a narrow visible projection", () => {
  assert.match(
    migration,
    /create or replace function security_private\.get_zagulyaky_public_stats_v1\(\)/i,
  );
  assert.match(migration, /with visible as materialized\s*\(\s*select\s+record_row\.id,/i);
  assert.doesNotMatch(migration, /select\s+(?:record_row\.)?\*\s+from public\.zagulyaky_records/i);
  assert.match(migration, /record_row\.status = 'published'/i);
  assert.match(migration, /record_row\.privacy_status = 'cleared'/i);
  assert.match(migration, /zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/i);
});

test("location statistics avoid four global UNION sorts without changing exact counts", () => {
  assert.equal((migration.match(/union all/gi) ?? []).length, 1);
  assert.equal((migration.match(/zagulyaky_document_discoveries discovery/gi) ?? []).length, 1);
  assert.match(migration, /cross join lateral \(values/i);
  assert.match(migration, /count\(distinct locations\.location\) as places/i);
  assert.match(migration, /zagulyaky_document_discoveries discovery[\s\S]*?discovery\.record_id/i);
  assert.match(migration, /zagulyaky_record_sources link on link\.record_id = visible\.id/i);
  assert.match(migration, /set statement_timeout = '10s'/i);
});

test("optimized private implementation retains the established RPC boundary", () => {
  assert.match(
    migration,
    /revoke all on function security_private\.get_zagulyaky_public_stats_v1\(\)[\s\S]*?from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.get_zagulyaky_public_stats_v1\(\)[\s\S]*?to anon, authenticated, service_role/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});
