import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202607300004_external_pdf_observability.sql",
  import.meta.url,
);

test("external PDF telemetry rate bucket is private, atomic, and service-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/iu);
  assert.match(sql, /private\.external_pdf_telemetry_rate_limits/iu);
  assert.match(sql, /primary key \(user_id, project_id\)/iu);
  assert.match(sql, /on conflict \(user_id, project_id\) do update/iu);
  assert.match(sql, /security definer[\s\S]*set search_path = ''/iu);
  assert.match(sql, /revoke all on private\.external_pdf_telemetry_rate_limits\s+from public, anon, authenticated/iu);
  assert.match(sql, /revoke all on function public\.reserve_external_pdf_telemetry_event[\s\S]*from public, anon, authenticated/iu);
  assert.match(sql, /grant execute on function public\.reserve_external_pdf_telemetry_event[\s\S]*to service_role/iu);
  for (const forbiddenColumn of ["url", "document_id", "source_id", "file_name", "event_payload", "message", "token", "headers"]) {
    const tableDefinition = /create table if not exists private\.external_pdf_telemetry_rate_limits \(([\s\S]*?)\);/iu.exec(sql)?.[1] ?? "";
    assert.equal(new RegExp(`\\b${forbiddenColumn}\\b`, "iu").test(tableDefinition), false);
  }
});
