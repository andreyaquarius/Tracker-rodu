import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);

test("co-occurrence service uses the authenticated bounded read-only RPC", () => {
  const block = sourceBlock(
    service,
    "export async function listPersonContextCooccurrencesV1",
    "export async function getPersonDocumentaryGraph",
  );
  assert.match(block, /runAuthenticatedSupabaseRequest/u);
  assert.match(
    block,
    /client\.rpc\("list_person_context_cooccurrences_v1",\s*\{[\s\S]*?p_project_id:[\s\S]*?p_person_id:/u,
  );
  for (const parameter of [
    "p_year_from",
    "p_year_to",
    "p_place_id",
    "p_min_shared",
    "p_limit",
    "p_offset",
  ]) {
    assert.match(block, new RegExp(`${parameter}:`, "u"), `Missing RPC parameter ${parameter}`);
  }
  assert.match(block, /boundedInteger\(filters\.minShared,\s*1,\s*1000,\s*1\)/u);
  assert.match(block, /boundedInteger\(filters\.limit,\s*1,\s*100,\s*20\)/u);
  assert.match(block, /boundedInteger\(filters\.offset,\s*0,\s*100_000,\s*0\)/u);
  assert.doesNotMatch(block, /savePersonContextRelation|\.from\(/u);
});

test("co-occurrence service validates year range, center identity and algorithm version", () => {
  const block = sourceBlock(
    service,
    "export async function listPersonContextCooccurrencesV1",
    "export async function getPersonDocumentaryGraph",
  );
  assert.match(block, /optionalBoundedInteger\(filters\.yearFrom,\s*1,\s*9999\)/u);
  assert.match(block, /optionalBoundedInteger\(filters\.yearTo,\s*1,\s*9999\)/u);
  assert.match(block, /yearFrom > yearTo/u);
  assert.match(block, /returnedCenterId !== normalizedPersonId/u);
  assert.match(block, /returnedAlgorithm !== "cooccurrence_v1"/u);
});

test("co-occurrence service maps and bounds the exact safe response contract", () => {
  const mapper = sourceBlock(
    service,
    "function mapPersonContextCooccurrence(",
    "function mapDocumentaryGraphNode",
  );
  for (const mapping of [
    "personId ?? row.person_id",
    "displayName ?? row.display_name",
    "sharedFindingCount ?? row.shared_finding_count",
    "sharedDocumentCount ?? row.shared_document_count",
    "sharedEventCount ?? row.shared_event_count",
    "sharedSourceCount ?? row.shared_source_count",
    "relationStrength ?? row.relation_strength",
    "firstYear ?? row.first_year",
    "lastYear ?? row.last_year",
    "topSources ?? row.top_sources",
  ]) {
    assert.ok(mapper.includes(`row.${mapping}`), `Missing mapping ${mapping}`);
  }
  assert.match(mapper, /personId === centerPersonId/u);
  assert.match(mapper, /\.slice\(0, 5\)/u);
  assert.match(mapper, /kind !== "finding" && kind !== "document" && kind !== "event"/u);
  assert.match(mapper, /displayName:[\s\S]*?"Приватна особа"/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
