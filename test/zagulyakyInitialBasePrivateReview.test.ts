import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608200004_zagulyaky_initial_base_private_review.sql", import.meta.url),
  "utf8",
);

function privateFunctionBody(functionName: string): string {
  const marker = `create or replace function security_private.${functionName}`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `private ${functionName} must exist`);
  const end = migration.indexOf("$function$;", start);
  assert.ok(end > start, `private ${functionName} must have a complete body`);
  return migration.slice(start, end);
}

function assertRevoked(signature: string): void {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    migration,
    new RegExp(`revoke all on function ${escaped}\\s+from public, anon, authenticated, service_role;`, "i"),
  );
}

test("initial-base candidate validation retains only bounded participant provenance fields", () => {
  const validator = privateFunctionBody("zagulyaky_structuring_validate_candidate_v1");

  for (const key of ["originText", "residenceText", "socialEstateText"]) {
    assert.match(validator, new RegExp(`participant_value -> '${key}'`));
    assert.match(validator, new RegExp(`'${key}', [a-z_]+_value`));
  }
  assert.match(validator, /'origin_text', 500, false/);
  assert.match(validator, /'residence_text', 500, false/);
  assert.match(validator, /'social_estate_text', 240, false/);
  assert.match(validator, /'participants', safe_participants/);
  assert.match(validator, /'candidateKey', security_private\.zagulyaky_structuring_sha256_v1/);
  assert.doesNotMatch(validator, /sourceUrl|facebookPostUrl|rawPayload/);
});

test("private Stage 0 source cards find structured fields without leaking them through the list", () => {
  const helper = privateFunctionBody("zagulyaky_structured_candidate_search_text_v1");
  const list = privateFunctionBody("admin_list_zagulyaky_ingestion_items_v1");
  const detail = privateFunctionBody("admin_get_zagulyaky_ingestion_item_v1");

  for (const key of ["originText", "residenceText", "socialEstateText"]) {
    assert.match(helper, new RegExp(`participant\\.value ->> '${key}'`));
  }
  assert.match(helper, /jsonb_array_elements\(/);
  assert.doesNotMatch(helper, /candidate_data::text/i);

  assert.match(list, /has_admin_permission_v1\('zagulyaky\.import'\)/);
  assert.match(list, /zagulyaky_structured_candidate_search_text_v1\(candidate\.candidate_data\)/);
  assert.match(list, /'structuredCandidateCount'/);
  assert.match(list, /'structuredPersonCount'/);
  assert.match(list, /'structuredDocumentCount'/);
  assert.doesNotMatch(list, /'facebookPostUrl'|'sourceUrl'|'rawText'|'rawPayload'|'candidateData'/);

  assert.match(detail, /has_admin_permission_v1\('zagulyaky\.import'\)/);
  assert.match(detail, /'facebookPostUrl'/);
  assert.match(detail, /facebook\[\.\]com/);
  assert.match(detail, /'structuredCandidates'/);
  assert.match(detail, /'participants', candidate_row\.candidate_data -> 'participants'/);
  assert.match(detail, /'structuredCandidateCount'/);
  assert.doesNotMatch(detail, /evidence_spans|input_fingerprint|raw_payload/i);
});

test("initial-base review never auto-writes catalogue provenance and disables materialization", () => {
  assert.match(
    migration,
    /create index if not exists zagulyaky_structured_candidates_item_status_created_idx/i,
  );
  assert.doesNotMatch(migration, /insert\s+into\s+public\.zagulyaky_records/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.zagulyaky_sources/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.zagulyaky_attachments/i);
  assertRevoked("security_private.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)");
  assertRevoked("public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)");
  assert.doesNotMatch(
    migration,
    /grant execute on function (?:security_private|public)\.admin_materialize_zagulyaky_structuring_candidates_v1/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
  assert.ok(existsSync(new URL("../supabase/tests/zagulyaky_initial_base_private_review_test.sql", import.meta.url)));
});
