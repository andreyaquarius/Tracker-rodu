import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const legacy = read("supabase/migrations/202609100002_zagulyaky_public_stats_cache.sql");
const fix = () => read("supabase/migrations/202609100004_zagulyaky_stats_safeupdate_compatibility.sql");
const withoutComments = (sql: string) => sql.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const cacheDeletes = (sql: string) => withoutComments(sql).match(/\bdelete\s+from\s+security_private\.zagulyaky_stats_invalidations\b[^;]*;/gi) ?? [];

test("regression: the published cache migration contains the DELETE rejected by pg-safeupdate", () => {
  const statements = cacheDeletes(legacy);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /\bwhere\b/i);
});

test("forward cache fix explicitly qualifies DELETE and keeps the before-compute snapshot boundary", () => {
  const sql = withoutComments(fix());
  const statements = cacheDeletes(sql);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /\bwhere\s+transaction_id\s+is\s+not\s+null\s*;/i);
  assert.ok(sql.indexOf(statements[0]) < sql.indexOf("result := security_private.compute_zagulyaky_public_stats_v1()"));
  assert.match(sql, /update\s+security_private\.zagulyaky_public_stats_cache\s+set[^;]*\bwhere\s+singleton\s*;/i);
  assert.match(sql, /pg_advisory_xact_lock\(709100002::bigint\)/);
  assert.match(sql, /transaction_read_only/);
  assert.match(sql, /interval '60 seconds'/);
  assert.doesNotMatch(sql, /\bsafeupdate\.|\btruncate\b|\bdrop\s+(?:function|table)\b|\balter\s+(?:role|database|system)\b/i);
  assert.equal((sql.match(/create\s+or\s+replace\s+function/gi) ?? []).length, 1);
  assert.match(sql, /create\s+or\s+replace\s+function\s+security_private\.get_zagulyaky_public_stats_v1\(\)/i);
  assert.match(sql, /revoke all on function security_private\.get_zagulyaky_public_stats_v1\(\)\s+from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant execute on function security_private\.get_zagulyaky_public_stats_v1\(\)\s+to anon, authenticated, service_role;/i);
});

test("deployment gates the cache regression before touching the linked database", () => {
  const workflow = read(".github/workflows/deploy-supabase-functions.yml");
  const gate = workflow.indexOf("- name: Verify public statistics cache contracts");
  assert.ok(gate >= 0);
  assert.ok(gate < workflow.indexOf("- name: Link Supabase project"));
  const step = workflow.slice(gate, workflow.indexOf("\n      - name:", gate + 1));
  assert.match(step, /test\/zagulyakyPublicStatsSafeupdate\.test\.ts/);
  assert.match(step, /test\/integration\/queryLoadOptimizations\.test\.ts/);
});
