import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190009_zagulyaky_automated_structuring.sql", import.meta.url),
  "utf8",
);
const dbTest = readFileSync(
  new URL("../supabase/tests/zagulyaky_automated_structuring_test.sql", import.meta.url),
  "utf8",
);

test("automated structuring keeps runs, tasks, and 0..N candidates in private staging", () => {
  for (const table of [
    "zagulyaky_structuring_runs",
    "zagulyaky_structuring_tasks",
    "zagulyaky_ingestion_structured_candidates",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`),
    );
  }
  assert.match(migration, /unique \(run_id, item_id\)/);
  assert.match(migration, /unique \(run_id, item_id, input_fingerprint, candidate_key\)/);
  assert.match(migration, /status text not null default 'proposed' check \(status in \(\s*'proposed', 'materialized', 'rejected', 'superseded'/s);
  assert.match(migration, /privacy_review_required boolean not null default true check \(privacy_review_required\)/);
});

test("the bounded admin and service contracts preserve consent, leases, fingerprints, and provenance", () => {
  assert.match(
    migration,
    /admin_start_zagulyaky_structuring_run_v1\([\s\S]*?p_explicit_consent boolean,[\s\S]*?p_item_limit integer default 50,[\s\S]*?p_max_attempts integer default 3/s,
  );
  assert.match(migration, /if p_explicit_consent is not true then\s+raise exception 'STRUCTURING_CONSENT_REQUIRED'/s);
  assert.match(migration, /if p_item_limit not between 1 and 5000 or p_max_attempts not between 1 and 10/s);
  assert.match(migration, /and not item_row\.requires_ocr and not item_row\.requires_source_refetch[\s\S]*?and char_length\(item_row\.raw_text\) <= 12000/s);
  assert.match(migration, /'excludedOversizedCount', run_row\.excluded_oversized_count/);
  assert.match(migration, /service_claim_zagulyaky_structuring_task_v1\([\s\S]*?p_lease_seconds integer default 120/s);
  assert.match(
    migration,
    /create or replace function public\.admin_start_zagulyaky_structuring_run_v1\([\s\S]*?language sql\s+security invoker\s+set search_path = pg_catalog/s,
  );
  assert.match(
    migration,
    /create or replace function public\.service_complete_zagulyaky_structuring_task_v1\([\s\S]*?language sql security invoker set search_path = pg_catalog/s,
  );
  assert.match(migration, /for update of task skip locked/);
  assert.match(migration, /raise exception 'STRUCTURING_DUPLICATE_CANDIDATE_KEY'/);
  assert.match(migration, /'inputFingerprint', task_row\.input_fingerprint/);
  assert.match(migration, /'claimToken', task_row\.claim_token/);
  assert.match(migration, /'requestedBy', run_row\.requested_by/);
  assert.match(migration, /'provider', run_row\.provider/);
  assert.match(migration, /'model', run_row\.model/);
  assert.match(migration, /values \(candidate_row\.item_id, record_row\.id, 'derived'/);
});

test("candidate and materialization projections cannot turn source text or Facebook/media data into public content", () => {
  const candidateList = migration.slice(
    migration.indexOf("create or replace function security_private.admin_list_zagulyaky_structuring_candidates_v1"),
    migration.indexOf("create or replace function security_private.admin_get_zagulyaky_structuring_candidate_v1"),
  );
  const materialize = migration.slice(
    migration.indexOf("create or replace function security_private.admin_materialize_zagulyaky_structuring_candidates_v1"),
    migration.indexOf("-- Private implementations are deliberately not API surface."),
  );

  assert.match(candidateList, /'classificationReason'/);
  assert.match(candidateList, /'participantCount'/);
  assert.match(candidateList, /'warnings'/);
  assert.doesNotMatch(candidateList, /rawText|rawPayload|sourceUrl|excerpt/i);
  assert.match(migration, /substring\(p_raw_text from start_offset \+ 1 for end_offset - start_offset\) is distinct from excerpt/);
  assert.match(migration, /'scope', p_scope, 'start', start_offset, 'end', end_offset/);
  assert.doesNotMatch(materialize, /insert into public\.zagulyaky_sources/i);
  assert.doesNotMatch(materialize, /insert into public\.zagulyaky_attachments/i);
  assert.match(materialize, /candidate_row\.kind, 'draft', 'unverified'/);
  assert.match(materialize, /'automated_structuring_candidate'/);
  assert.match(materialize, /'attemptedCount', attempted_count/);
  assert.doesNotMatch(materialize, /'recordIds'/);
});

test("the current-batch year repair is provenance-only and has executable database coverage", () => {
  assert.match(migration, /when jsonb_typeof\(p_item -> 'rawPayload' -> 'years'\) = 'array'/);
  assert.match(migration, /'candidateYears', to_jsonb\(item_row\.candidate_years\)/);
  assert.match(migration, /'rawPayload', item_row\.raw_payload/);
  assert.ok(existsSync(new URL("../supabase/tests/zagulyaky_automated_structuring_test.sql", import.meta.url)));
  assert.match(dbTest, /select plan\(36\)/);
  assert.match(dbTest, /one post can complete with a person and a document candidate/);
  assert.match(dbTest, /candidate detail retains checked offsets but discards evidence excerpts and raw post text/);
  assert.match(dbTest, /materialization creates only private unverified drafts/);
  assert.match(dbTest, /candidate-year repair falls back to raw export year strings/);
});
