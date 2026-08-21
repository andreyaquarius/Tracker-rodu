import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608200005_zagulyaky_public_search_fields.sql", import.meta.url),
  "utf8",
);

function privateSearchBody(): string {
  const marker = "create or replace function security_private.search_zagulyaky_v1(";
  const start = migration.indexOf(marker);
  const end = migration.indexOf("$function$;", start);
  assert.ok(start >= 0, "the public catalogue search override must exist");
  assert.ok(end > start, "the public catalogue search override must be complete");
  return migration.slice(start, end);
}

function searchPredicate(body: string): string {
  const start = body.indexOf("nullif(btrim(coalesce(p_query, '')), '') is null");
  const end = body.indexOf("and (not (p_filters ? 'eventType')", start);
  assert.ok(start >= 0, "the text-search predicate must exist");
  assert.ok(end > start, "the text-search predicate must end before filters");
  return body.slice(start, end);
}

test("public catalogue search includes safe published record, participant, source, and discovery fields", () => {
  const body = privateSearchBody();
  const predicate = searchPredicate(body);

  assert.match(body, /r\.status = 'published'/);
  assert.match(body, /r\.privacy_status = 'cleared'/);
  assert.match(
    body,
    /not r\.possible_living_person\s+or security_private\.zagulyaky_has_living_person_clearance_v1\(r\.id\)/s,
  );
  assert.ok(
    body.indexOf("security_private.zagulyaky_has_living_person_clearance_v1(r.id)")
      < body.indexOf("limit safe_limit + 1"),
    "the living-person clearance gate must run before pagination",
  );

  for (const field of [
    "r.title",
    "r.summary",
    "r.original_text",
    "r.normalized_text",
    "r.event_date_text",
    "r.source_location_text",
    "r.found_location_text",
    "r.classification_reason",
  ]) {
    assert.match(predicate, new RegExp(field.replace(".", "\\.")));
  }

  for (const field of [
    "participant.original_full_name",
    "participant.normalized_uk_full_name",
    "participant.origin_text",
    "participant.residence_text",
    "participant.notes",
  ]) {
    assert.match(predicate, new RegExp(field.replace(".", "\\.")));
  }

  for (const field of [
    "source.archive_name",
    "source.fond",
    "source.inventory",
    "source.file_number",
    "source.page_from",
    "source.page_to",
    "source.citation",
  ]) {
    assert.match(predicate, new RegExp(field.replace(".", "\\.")));
  }

  assert.match(predicate, /array_to_string\(discovery\.record_types, ' '\)/);
  for (const field of [
    "discovery.official_location_text",
    "discovery.discovered_location_text",
    "discovery.page_from",
    "discovery.page_to",
    "discovery.notes",
  ]) {
    assert.match(predicate, new RegExp(field.replace(".", "\\.")));
  }
});

test("public catalogue search does not query private ingestion, payloads, or private source links", () => {
  const body = privateSearchBody();
  const predicate = searchPredicate(body);

  for (const forbidden of [
    "zagulyaky_ingestion",
    "candidate_data",
    "raw_payload",
    "r.payload",
    "source.metadata",
    "source.source_url",
    "source.external_id",
  ]) {
    assert.doesNotMatch(predicate, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
  }
  assert.doesNotMatch(body, /source\.source_url/i);
});

test("the replacement retains a non-public helper ACL and reloads the RPC schema", () => {
  assert.match(
    migration,
    /revoke all on function security_private\.search_zagulyaky_v1\(text,text,jsonb,integer,timestamptz,uuid\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.search_zagulyaky_v1\(text,text,jsonb,integer,timestamptz,uuid\)\s+to service_role;/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
});
