import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../supabase/migrations/202608290018_church_role_family_network.sql", import.meta.url),
  "utf8",
);

test("church-role service calls the bounded authenticated RPC with every filter", () => {
  assert.match(service, /listPersonChurchRoleNetworkV1/u);
  assert.match(service, /client\.rpc\("list_person_church_role_network_v1"/u);
  for (const argument of [
    "p_project_id", "p_person_id", "p_role_codes", "p_year_from", "p_year_to",
    "p_evidence_statuses", "p_min_occurrences", "p_limit", "p_offset",
  ]) {
    assert.match(service, new RegExp(argument, "u"));
  }
});

test("church-role service rejects a genealogical-fact flag and maps bounded evidence", () => {
  assert.match(service, /groupingIsGenealogicalFact[\s\S]*?throw new Error/u);
  assert.match(service, /rawSamples\.slice\(0, 5\)/u);
  assert.match(service, /evidenceCount/u);
  assert.match(service, /source:\s*mapChurchRoleNetworkSource/u);
});

test("church-role service preserves citation and document-fragment evidence", () => {
  assert.match(service, /kind !== "document_fragment"/u);
  assert.match(service, /kind !== "citation"/u);
  assert.match(service, /Фрагмент документа/u);
  assert.match(service, /Цитата/u);
});

test("church-role migration backfills existing exact sponsors and blocks ambiguous manual sponsor assertions", () => {
  assert.match(migration, /backfill_finding_context_targets_v1\(\)/u);
  assert.match(migration, /backfill_exact_sponsor_findings/u);
  assert.match(migration, /backfill_exact_sponsor_legacy_relations/u);
  assert.match(migration, /'allowNewManualAssertions', false/u);
});
