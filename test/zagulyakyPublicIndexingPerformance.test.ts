import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608300002_zagulyaky_public_indexing_timeout_fix.sql", import.meta.url),
  "utf8",
);

test("public Zagulyaky indexing limits an index-ordered narrow candidate page before enrichment", () => {
  assert.match(
    migration,
    /create or replace function security_private\.list_public_zagulyaky_indexing_v1\(\s*p_kind text,\s*p_limit integer default 100,\s*p_cursor_slug text default null\s*\)/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.list_public_zagulyaky_indexing_v1/i,
  );
  assert.match(migration, /set statement_timeout = '10s'/i);
  assert.match(
    migration,
    /cursor_floor_slug text := coalesce\(safe_cursor_slug, ''\);/i,
  );

  const candidatesStart = migration.indexOf("with candidates as materialized (");
  const candidatesEnd = migration.indexOf("), page_candidates as materialized", candidatesStart);
  assert.notEqual(candidatesStart, -1);
  assert.notEqual(candidatesEnd, -1);
  const candidates = migration.slice(candidatesStart, candidatesEnd);

  assert.match(candidates, /select\s+record_row\.id,\s+record_row\.public_slug/i);
  assert.match(candidates, /record_row\.status = 'published'/i);
  assert.match(candidates, /record_row\.privacy_status = 'cleared'/i);
  assert.match(candidates, /record_row\.public_slug is not null/i);
  assert.match(candidates, /zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/i);
  assert.match(
    candidates,
    /\(lower\(record_row\.public_slug\), record_row\.public_slug\)\s*>\s*\(lower\(cursor_floor_slug\), cursor_floor_slug\)/i,
  );
  assert.doesNotMatch(candidates, /safe_cursor_slug\s+is\s+null\s+or/i);
  assert.match(candidates, /order by lower\(record_row\.public_slug\), record_row\.public_slug\s+limit safe_limit \+ 1/i);
  assert.doesNotMatch(
    candidates,
    /title|summary|original_text|normalized_text|event_date|zagulyaky_participants|zagulyaky_sources|zagulyaky_document_discoveries/i,
  );

  const limitPosition = migration.indexOf("limit safe_limit + 1", candidatesStart);
  const recordEnrichmentPosition = migration.indexOf(
    "join public.zagulyaky_records record_row on record_row.id = candidate.id",
    candidatesEnd,
  );
  assert.ok(limitPosition > candidatesStart && limitPosition < recordEnrichmentPosition);
  assert.ok(migration.indexOf("left join lateral", recordEnrichmentPosition) > recordEnrichmentPosition);
});

test("optimized Zagulyaky indexing preserves the redacted public payload and ACL", () => {
  for (const publicKey of [
    "originalText",
    "normalizedText",
    "subject",
    "primarySource",
    "documentDiscovery",
    "nextCursor",
  ]) {
    assert.ok(migration.includes(`'${publicKey}'`), `Expected public key ${publicKey}`);
  }
  assert.doesNotMatch(
    migration,
    /'sourceUrl'|'storagePath'|'createdBy'|'contributor'|'attachments'/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.list_public_zagulyaky_indexing_v1\(text, integer, text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.list_public_zagulyaky_indexing_v1\(text, integer, text\)\s+to anon, authenticated, service_role;/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
});
