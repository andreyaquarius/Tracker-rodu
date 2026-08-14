import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve("supabase/migrations/202608150001_product_analytics_foundation.sql"),
  "utf8",
);
const edgeFunction = readFileSync(
  resolve("supabase/functions/collect-product-analytics/index.ts"),
  "utf8",
);
const consentService = readFileSync(
  resolve("src/services/productAnalyticsConsent.ts"),
  "utf8",
);
const supabaseConfig = readFileSync(resolve("supabase/config.toml"), "utf8");

function tableDefinition(name: string): string {
  const match = migration.match(new RegExp(
    `create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`,
    "i",
  ));
  assert.ok(match, `${name} table must exist`);
  return match[1] ?? "";
}

test("analytics fact tables never store a raw user id", () => {
  assert.doesNotMatch(tableDefinition("product_analytics_sessions"), /\buser_id\b/i);
  assert.doesNotMatch(tableDefinition("product_analytics_events"), /\buser_id\b/i);
  assert.match(tableDefinition("product_analytics_sessions"), /actor_key bytea/i);
});

test("database contracts enforce admin-only aggregates, cohort privacy and retention", () => {
  assert.match(migration, /if not public\.is_app_admin\(auth\.uid\(\)\)/i);
  assert.match(migration, /having count\(distinct event\.actor_key\) >= 5/i);
  assert.match(migration, /occurred_at < now\(\) - interval '90 days'/i);
  assert.match(migration, /last_seen_at < now\(\) - interval '13 months'/i);
  assert.match(migration, /request_count > 120/i);
  assert.match(migration, /enable row level security/i);
});

test("admin foundation preserves existing admins and keeps roles plus audit service-controlled", () => {
  assert.match(migration, /create table if not exists public\.admin_roles/i);
  assert.match(migration, /create table if not exists public\.admin_role_assignments/i);
  assert.match(migration, /create table if not exists public\.admin_audit_log/i);
  assert.match(
    migration,
    /select admin\.user_id, 'super_admin', admin\.granted_by[\s\S]*?from public\.app_admins admin/i,
  );
  assert.match(migration, /alter table public\.admin_audit_log enable row level security/i);
  assert.match(migration, /revoke all on table public\.admin_audit_log from public, anon, authenticated/i);
  assert.match(
    migration,
    /grant execute on function security_private\.write_admin_audit_v1\([^;]+\) to service_role/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function security_private\.write_admin_audit_v1\([^;]+\) to authenticated/i,
  );
});

test("collector requires JWT, independent consent and HMAC pseudonymization", () => {
  assert.match(
    supabaseConfig,
    /\[functions\.collect-product-analytics\][\s\S]*?verify_jwt\s*=\s*true/i,
  );
  assert.match(edgeFunction, /get_my_product_analytics_consent/);
  assert.match(edgeFunction, /name: "HMAC", hash: "SHA-256"/);
  assert.match(edgeFunction, /contextRecord\.isAdmin === true/);
  assert.match(edgeFunction, /new TextEncoder\(\)\.encode\(rawBody\)\.byteLength > MAX_REQUEST_BYTES/);
  assert.match(consentService, /product-analytics-consent-v2/);
  assert.doesNotMatch(consentService, /tracker-rodu-analytics-consent-v1/);
});
