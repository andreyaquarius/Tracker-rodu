import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608180003_zagulyaky_staging_import.sql", import.meta.url),
  "utf8",
);
const filenameFixMigration = readFileSync(
  new URL("../supabase/migrations/202608190006_zagulyaky_stage0_begin_filename_fix.sql", import.meta.url),
  "utf8",
);
const recoveryMigration = readFileSync(
  new URL("../supabase/migrations/202608190007_zagulyaky_stage0_commit_recovery.sql", import.meta.url),
  "utf8",
);
const edgeFunction = readFileSync(
  new URL("../supabase/functions/zagulyaky-stage0-import/index.ts", import.meta.url),
  "utf8",
);
const localSeed = readFileSync(
  new URL("../supabase/seed/zagulyaky-local-demo.sql", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");

test("Stage 0 creates private Facebook staging tables and never exposes them through browser table grants", () => {
  for (const table of [
    "zagulyaky_ingestion_batches",
    "zagulyaky_ingestion_items",
    "zagulyaky_ingestion_batch_items",
    "zagulyaky_ingestion_chunks",
    "zagulyaky_ingestion_item_errors",
    "zagulyaky_ingestion_media_assets",
    "zagulyaky_ingestion_attachments",
    "zagulyaky_ingestion_links",
    "zagulyaky_ingestion_item_records",
    "zagulyaky_extraction_jobs",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(migration, /grant all on table public\.zagulyaky_ingestion_items to service_role/);
  assert.doesNotMatch(migration, /grant (?:select|insert|update|delete)[^;]*zagulyaky_ingestion[^;]*to authenticated/i);
});

test("Stage 0 requires a dry run and confines mutation RPCs to the server role", () => {
  assert.match(migration, /if p_import_mode <> 'dry_run' then\s+raise exception 'DRY_RUN_REQUIRED'/s);
  assert.match(migration, /DRY_RUN_REMEDIATION_REQUIRED/);
  assert.match(migration, /if not security_private\.zagulyaky_import_server_request_v1\(\) then\s+raise exception 'SERVER_IMPORT_REQUIRED'/s);
  assert.match(migration, /zagulyaky_import_summary_count_v1/);
  assert.match(migration, /sanitized_profile_summary := jsonb_build_object/);
  assert.match(migration, /case when value ~ '\^\[0-9\]\{1,4\}\$' then value::integer else null end/);
  assert.match(migration, /for item_json, current_source_item_index in/);
  assert.match(migration, /current_source_item_index \+ \(p_chunk_index \* 250\)/);
  assert.match(migration, /current_item_id uuid;/);
  assert.match(migration, /values \(p_batch_id, current_item_id, current_source_item_index/);
  assert.match(migration, /item_error_code := case upper\(SQLERRM\)/);
  assert.match(migration, /else 'INGESTION_ITEM_REJECTED'/);
  assert.match(migration, /or security_private\.zagulyaky_import_flag_v1\(item_json, 'sourceIncomplete', false\) then\s+quarantined_count := quarantined_count \+ 1/s);
  assert.match(migration, /grant execute on function public\.service_ingest_zagulyaky_facebook_chunk_v1\([^)]*\) to service_role/);
  assert.match(migration, /revoke all on function public\.service_ingest_zagulyaky_facebook_chunk_v1\([^)]*\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.service_finalize_zagulyaky_facebook_import_v1\([^)]*\) to service_role/);
  assert.match(migration, /create or replace function public\.admin_begin_zagulyaky_facebook_import_v1[\s\S]*?security invoker/s);
});

test("the Stage 0 admin-begin repair preserves its private definer boundary without constructing a PostgreSQL NUL", () => {
  const functionBody = filenameFixMigration.slice(filenameFixMigration.indexOf("as $function$"));
  assert.match(
    filenameFixMigration,
    /create or replace function security_private\.admin_begin_zagulyaky_facebook_import_v1\([\s\S]*?p_profile_summary jsonb default '\{\}'::jsonb[\s\S]*?\)\s+returns jsonb/s,
  );
  assert.match(filenameFixMigration, /language plpgsql\s+security definer\s+set search_path = pg_catalog, public, security_private, pg_temp/s);
  assert.match(filenameFixMigration, /normalized_file_name ~ '\[\\\\\/\]'/);
  assert.match(filenameFixMigration, /raise exception 'INVALID_SOURCE_FILE_NAME' using errcode = '22023'/);
  assert.doesNotMatch(functionBody, /\bchr\s*\(\s*0\s*\)/);
  assert.doesNotMatch(functionBody, /position\s*\([^)]*normalized_file_name/i);
});

test("Stage 0 recovery retains successful private provenance and fixes attached commit items", () => {
  assert.match(recoveryMigration, /commit_recovery_started/);
  assert.match(recoveryMigration, /zagulyaky_commit_recovery_eligible_v1/);
  assert.match(recoveryMigration, /'recoveryAvailable', security_private\.zagulyaky_commit_recovery_eligible_v1\(p_batch\)/);
  assert.match(recoveryMigration, /'recoveryAttemptCount'/);
  assert.match(recoveryMigration, /delete from public\.zagulyaky_ingestion_chunks\s+where batch_id = batch\.id and import_mode = 'commit'/s);
  assert.match(recoveryMigration, /delete from public\.zagulyaky_ingestion_item_errors\s+where batch_id = batch\.id and import_mode = 'commit'/s);
  assert.doesNotMatch(recoveryMigration, /delete from public\.zagulyaky_ingestion_(?:items|batch_items|attachments|media_assets|links|extraction_jobs)/);
  assert.match(recoveryMigration, /media_source_asset_key text;/);
  assert.doesNotMatch(recoveryMigration, /\n\s+source_asset_key text;/);
  assert.match(recoveryMigration, /media_source_asset_key := case when photo_id is not null/);
  assert.match(recoveryMigration, /membership\.source_item_index = current_source_item_index \+ \(p_chunk_index \* 250\)/);
  assert.match(recoveryMigration, /if item_already_in_batch then\s+continue;/s);
  const finalCountGuard = recoveryMigration.indexOf("if batch.processed_item_count + processed_count > batch.expected_item_count then");
  const loopEnd = recoveryMigration.indexOf("end loop;", recoveryMigration.indexOf("for item_json, current_source_item_index in"));
  assert.ok(finalCountGuard > loopEnd, "recovery checks the actual processed count after same-batch skips");
});

test("Edge ingestion verifies raw-byte SHA-256, caller authority, and uses matching 250-item chunks", () => {
  assert.match(edgeFunction, /const MAX_REQUEST_BYTES = 20 \* 1024 \* 1024/);
  assert.match(edgeFunction, /const CHUNK_SIZE = 250/);
  assert.match(edgeFunction, /const actualChecksum = await sha256Bytes\(bytes\)/);
  assert.match(edgeFunction, /if \(actualChecksum !== expectedChecksum\) throw new RequestProblem\("SOURCE_CHECKSUM_MISMATCH", 422\)/);
  assert.match(edgeFunction, /callerClient\.auth\.getUser\(accessToken\)/);
  assert.match(edgeFunction, /admin_begin_zagulyaky_facebook_import_v1/);
  assert.match(edgeFunction, /service_ingest_zagulyaky_facebook_chunk_v1/);
  assert.match(edgeFunction, /service_finalize_zagulyaky_facebook_import_v1/);
  assert.match(edgeFunction, /Never log raw payloads, post text, author labels, CDN URLs, or access tokens/);
  assert.match(
    edgeFunction,
    /host === "facebook\.com" \|\| host\.endsWith\("\.facebook\.com"\) \|\| host === "fb\.com"/,
  );
  assert.doesNotMatch(edgeFunction, /host\.endsWith\("facebook\.com"\)/);
});

test("Stage 0 rejects an embedded NUL anywhere in a post without passing the raw object to the jsonb RPC", () => {
  // JSON.stringify escapes a real U+0000 as the printable sequence \\u0000,
  // so a serialized-string search cannot guard rawPayload. The importer must
  // instead walk nested values and keys, then send only a safe placeholder for
  // the rejected item's provenance slot.
  assert.doesNotMatch(edgeFunction, /JSON\.stringify\(value\)\.includes\("\\u0000"\)/);
  assert.match(edgeFunction, /const pending: unknown\[\] = \[value\]/);
  assert.match(edgeFunction, /if \(typeof current === "string"\) \{\s+if \(current\.includes\("\\u0000"\)\) return true;/s);
  assert.match(edgeFunction, /for \(const \[key, entry\] of Object\.entries\(current\)\) \{\s+if \(key\.includes\("\\u0000"\)\) return true;/s);
  assert.match(edgeFunction, /const embeddedNul = hasNul\(post\)/);
  assert.match(edgeFunction, /rawPayload: embeddedNul \? \{\} : post/);
  assert.match(edgeFunction, /validationError = embeddedNul\s+\? "EMBEDDED_NUL_NOT_ALLOWED"/s);
});

test("the preflight exception is explicitly paired with in-function authentication", () => {
  assert.match(config, /\[functions\.zagulyaky-stage0-import\][\s\S]*?verify_jwt = false/);
  assert.match(edgeFunction, /authorizationToken\(request\)/);
  assert.match(edgeFunction, /IMPORT_PERMISSION_REQUIRED/);
});

test("Stage 0 reduces begin-RPC failures to safe public error codes", () => {
  assert.match(edgeFunction, /function safeRpcErrorCode\(error: unknown\): string/);
  assert.match(edgeFunction, /function safeDatabaseDiagnosticCode\(code: string\): string \| null/);
  assert.match(edgeFunction, /\^\[0-9A-Z\]\{5\}\$/);
  assert.match(edgeFunction, /\^PGRST\[0-9\]\{3\}\$/);
  assert.match(edgeFunction, /function hasAdminPermissionMarker\(error: unknown\): boolean/);
  assert.match(edgeFunction, /code === "42501" \|\| code === "ADMIN_PERMISSION_REQUIRED" \|\| hasAdminPermissionMarker\(error\)/);
  assert.match(edgeFunction, /new RequestProblem\("IMPORT_BEGIN_RPC_UNAVAILABLE", 503\)/);
  assert.match(edgeFunction, /code === "PGRST202" \|\| code === "42883" \|\| code === "42P01"/);
  assert.match(edgeFunction, /new RequestProblem\("IMPORT_BEGIN_VALIDATION_FAILED", 422\)/);
  assert.match(edgeFunction, /code === "22007" \|\| code === "22023" \|\| code === "23514"/);
  assert.match(edgeFunction, /new RequestProblem\("IMPORT_BEGIN_REQUESTER_PROFILE_REQUIRED", 409\)/);
  assert.match(edgeFunction, /new RequestProblem\("IMPORT_BEGIN_CONFLICT", 409\)/);
  assert.match(edgeFunction, /code === "23505"/);
  assert.match(edgeFunction, /new RequestProblem\(`IMPORT_BEGIN_DATABASE_ERROR_\$\{databaseCode\}`, 422\)/);
  assert.match(edgeFunction, /new RequestProblem\("IMPORT_BEGIN_DATABASE_ERROR_UNKNOWN", 422\)/);
  assert.doesNotMatch(edgeFunction, /return new RequestProblem\("IMPORT_BATCH_REJECTED", 422\)/);
  assert.match(edgeFunction, /throw beginImportProblem\(beginError\)/);
  assert.match(edgeFunction, /return json\(request, \{ error: problem\.code \}, problem\.status\)/);
  assert.doesNotMatch(edgeFunction, /json\(request, \{[^}]*beginError\.(?:message|details|hint)/);
  assert.doesNotMatch(edgeFunction, /console\.error\([^\n]*beginError\./);
});

test("the local-only demo seed gives the public catalogue one person and one document", () => {
  assert.ok(existsSync(new URL("../supabase/seed/zagulyaky-local-demo.sql", import.meta.url)));
  assert.match(localSeed, /'person', 'published', 'corroborated', 'cleared'/);
  assert.match(localSeed, /'document', 'published', 'verified', 'cleared'/);
  assert.match(localSeed, /demo-mariia-testova-1891/);
  assert.match(localSeed, /demo-metrychnyi-vytiah-1891/);
  assert.match(localSeed, /example\.test/);
});
