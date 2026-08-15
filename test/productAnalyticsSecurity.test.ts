import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve("supabase/migrations/202608150001_product_analytics_foundation.sql"),
  "utf8",
);
const actionsMigration = readFileSync(
  resolve("supabase/migrations/202608150002_product_analytics_actions_reports.sql"),
  "utf8",
);
const ingestHotfixMigration = readFileSync(
  resolve("supabase/migrations/202608150003_product_analytics_ingest_hotfix.sql"),
  "utf8",
);
const edgeFunction = readFileSync(
  resolve("supabase/functions/collect-product-analytics/index.ts"),
  "utf8",
);
const analyticsService = readFileSync(
  resolve("src/services/productAnalytics.ts"),
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

function migrationFunction(source: string, name: string): string {
  const match = source.match(new RegExp(
    `create or replace function ${name.replaceAll(".", "\\.")}\\([\\s\\S]*?\\$function\\$;`,
    "i",
  ));
  assert.ok(match, `${name} function must exist`);
  return match[0] ?? "";
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
  assert.match(actionsMigration, /has_admin_permission_v1\('analytics\.view'\)/i);
  assert.match(
    migrationFunction(actionsMigration, "security_private.admin_get_product_analytics_overview_v1"),
    /has_admin_permission_v1\('analytics\.view'\)/i,
  );
  assert.match(
    migrationFunction(actionsMigration, "security_private.admin_get_product_analytics_pages_v1"),
    /has_admin_permission_v1\('analytics\.view'\)/i,
  );
  assert.match(actionsMigration, /having count\(distinct event\.actor_key\) >= 5/i);
  assert.match(actionsMigration, /having count\(\*\) >= 5/i);
  assert.doesNotMatch(actionsMigration, /select[\s\S]{0,80}\b(session_id|actor_key)\b[\s\S]{0,80}return/i);
});

test("semantic event storage remains a closed allowlist", () => {
  assert.match(ingestHotfixMigration, /select count\(\*\) from jsonb_object_keys\(event_value\)/i);
  assert.doesNotMatch(ingestHotfixMigration, /jsonb_object_length/i);
  assert.match(ingestHotfixMigration, /allowed_actions constant text\[\]/i);
  assert.match(ingestHotfixMigration, /action_code_value = any\(allowed_actions\)/i);
  assert.doesNotMatch(ingestHotfixMigration, /project_id|person_id|search_text|file_name/i);
  assert.match(
    actionsMigration,
    /'gedcom_import',\s*2,\s*'operation_finished',\s*'gedcom_import_complete',\s*'success'/i,
  );
});

test("admin analytics preferences and storage health expose aggregates only", () => {
  assert.match(actionsMigration, /create table if not exists public\.admin_analytics_preferences/i);
  assert.match(actionsMigration, /get_my_admin_analytics_preferences_v1/i);
  assert.match(actionsMigration, /set_my_admin_analytics_preferences_v1/i);
  assert.match(actionsMigration, /count\(\*\)::integer as object_count/i);
  assert.match(actionsMigration, /::bigint as total_bytes/i);
  assert.doesNotMatch(
    migrationFunction(actionsMigration, "security_private.admin_get_system_health_v1"),
    /storage\.objects[\s\S]*?select[\s\S]*?\b(name|owner|path)\b/i,
  );
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
  assert.match(actionsMigration, /create trigger app_admins_sync_super_role/i);
  assert.match(
    actionsMigration,
    /after insert or update of granted_by on public\.app_admins/i,
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
  assert.match(edgeFunction, /target_project_id:\s*null/);
  assert.doesNotMatch(edgeFunction, /p_project_id:\s*null/);
  assert.match(edgeFunction, /if \(contextError\)[\s\S]*?503/i);
  assert.match(edgeFunction, /new TextEncoder\(\)\.encode\(rawBody\)\.byteLength > MAX_REQUEST_BYTES/);
  assert.match(consentService, /product-analytics-consent-v2/);
  assert.doesNotMatch(consentService, /tracker-rodu-analytics-consent-v1/);
});

test("analytics collector backs off after transient failures and discards expired telemetry", () => {
  assert.match(analyticsService, /RETRY_DELAYS_MS/);
  assert.match(analyticsService, /now < nextRetryAt/);
  assert.match(analyticsService, /occurredAt >= now - MAX_EVENT_AGE_MS/);
});
