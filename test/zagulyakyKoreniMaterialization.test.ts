import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608270001_zagulyaky_koreni_materialization.sql", import.meta.url),
  "utf8",
);

test("keeps the Koreni receipt and provenance ledger private", () => {
  for (const table of [
    "zagulyaky_koreni_batches",
    "zagulyaky_koreni_source_rows",
    "zagulyaky_koreni_record_map",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists security_private\\.${table}`, "i"));
    assert.match(migration, new RegExp(`alter table security_private\\.${table} enable row level security`, "i"));
  }

  assert.doesNotMatch(migration, /create table[^;]*public\.zagulyaky_(?:ingestion|staging|tabular_import)/i);
  assert.match(migration, /revoke all on table[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(migration, /grant select on table[\s\S]*?to service_role;/i);
});

test("exposes materialization only to the service role and requires an explicit dry-run flag", () => {
  assert.match(
    migration,
    /create or replace function security_private\.materialize_koreni_zagulyaky_v1\([\s\S]*?security definer/i,
  );
  assert.match(migration, /if p_dry_run is null then[\s\S]*?KORENI_DRY_RUN_REQUIRED/i);
  assert.match(migration, /exists \(select 1 from public\.app_admins where user_id = p_actor_id\)/i);
  assert.doesNotMatch(migration, /not public\.is_app_admin\(p_actor_id\)/i);
  assert.match(migration, /if not p_dry_run then[\s\S]*?pg_advisory_xact_lock/i);
  assert.match(
    migration,
    /revoke all on function security_private\.materialize_koreni_zagulyaky_v1\([\s\S]*?from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.materialize_koreni_zagulyaky_v1\([\s\S]*?to service_role;/i,
  );
  assert.doesNotMatch(migration, /grant execute on function security_private\.materialize_koreni_zagulyaky_v1\([\s\S]*?to (?:anon|authenticated);/i);
});

test("validates every chunk before writing and makes retries idempotent", () => {
  assert.match(migration, /if item_count not between 1 and 250 then[\s\S]*?KORENI_CHUNK_SIZE_INVALID/i);
  assert.match(migration, /if octet_length\(p_items::text\) > 8388608 then[\s\S]*?KORENI_CHUNK_TOO_LARGE/i);
  assert.match(migration, /KORENI_DUPLICATE_KEY_IN_CHUNK/i);
  assert.match(migration, /KORENI_EVENT_YEAR_RANGE_INVALID/i);
  assert.match(migration, /KORENI_IDEMPOTENCY_CONFLICT/i);
  assert.match(migration, /existing_map\.candidate_payload_sha256 is distinct from payload_sha256/i);
  assert.match(migration, /unchanged_count := unchanged_count \+ 1;/i);
});

test("materializes one public person, source and subject with durable provenance", () => {
  assert.match(migration, /insert into public\.zagulyaky_records\([\s\S]*?'person', 'pending_review', 'unverified', 'pending'/i);
  assert.match(migration, /insert into public\.zagulyaky_sources\([\s\S]*?'database'/i);
  assert.match(migration, /'koreni'[\s\S]*?'permission_granted'/i);
  assert.match(migration, /Koreni\.org\.ua — ODbL 1\.0/i);
  assert.match(migration, /insert into public\.zagulyaky_participants\([\s\S]*?'subject'/i);
  assert.match(migration, /insert into public\.zagulyaky_record_sources\(record_id, source_id, is_primary\)[\s\S]*?true/i);
  assert.match(migration, /set status = 'published',[\s\S]*?privacy_status = 'cleared'/i);
  assert.match(migration, /possible_living_person[\s\S]*?false,/i);
  assert.match(migration, /insert into security_private\.zagulyaky_koreni_record_map/i);
  assert.match(migration, /'sourceEventDateText'/i);
  assert.match(migration, /'sourceEventYearFrom'/i);
  assert.match(migration, /'sourceEventYearTo'/i);
});
