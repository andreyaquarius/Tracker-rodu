import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);

test("context relation service uses the authenticated project-scoped RPC contract", () => {
  assert.match(service, /runAuthenticatedSupabaseRequest/u);
  assert.match(service, /client\.rpc\("list_context_relation_types_v1",\s*\{[\s\S]*?p_project_id:/u);
  assert.match(
    service,
    /client\.rpc\("list_person_context_relation_summaries_v1",\s*\{[\s\S]*?p_project_id:[\s\S]*?p_person_id:[\s\S]*?p_include_deleted:[\s\S]*?p_limit:[\s\S]*?p_offset:/u,
  );
  assert.match(
    service,
    /client\.rpc\("get_person_context_graph_v1",\s*\{[\s\S]*?p_max_nodes:[\s\S]*?p_max_edges:/u,
  );
  assert.match(
    service,
    /client\.rpc\("save_person_context_relation_v1",\s*\{[\s\S]*?p_project_id:[\s\S]*?p_payload:[\s\S]*?p_expected_lock_version:/u,
  );
  assert.match(
    service,
    /client\.rpc\("archive_person_context_relation_v1",\s*\{[\s\S]*?p_project_id:[\s\S]*?p_relation_id:[\s\S]*?p_expected_lock_version:/u,
  );
  assert.doesNotMatch(service, /\.from\(["'](?:person_context_relations|context_relation_types)["']\)/u);
});

test("context relation service maps both RPC camelCase and database snake_case payloads", () => {
  const relationMapper = sourceBlock(
    service,
    "function mapPersonContextRelation",
    "function mapContextEvidence",
  );
  const evidenceMapper = sourceBlock(
    service,
    "function mapContextEvidence",
    "function rows",
  );

  for (const pair of [
    "projectId ?? row.project_id",
    "relationTypeId ?? row.relation_type_id",
    "sourcePersonId ?? row.source_person_id",
    "targetPersonId ?? row.target_person_id",
    "evidenceStatus ?? row.evidence_status",
    "privacyStatus ?? row.privacy_status",
    "assertionKind ?? row.assertion_kind",
    "lockVersion ?? row.lock_version",
    "evidenceCount ?? row.evidence_count",
  ]) {
    assert.ok(relationMapper.includes(`row.${pair}`), `Missing relation mapping: ${pair}`);
  }
  for (const pair of [
    "sourceDocumentId ?? row.source_document_id",
    "sourceFindingId ?? row.source_finding_id",
    "sourceEventId ?? row.source_event_id",
    "findingParticipantId ?? row.finding_participant_id",
    "documentFragmentId ?? row.document_fragment_id",
  ]) {
    assert.ok(evidenceMapper.includes(`row.${pair}`), `Missing evidence mapping: ${pair}`);
  }
});

test("context relation writes enforce endpoint and optimistic-lock preconditions", () => {
  assert.match(service, /if \(!draft\.relationTypeId\)/u);
  assert.match(service, /if \(!draft\.sourcePersonId \|\| !draft\.targetPersonId\)/u);
  assert.match(service, /draft\.sourcePersonId === draft\.targetPersonId/u);
  assert.match(service, /p_expected_lock_version:\s*expectedLockVersion \?\? null/u);
  assert.match(service, /archivePersonContextRelation\([\s\S]*?expectedLockVersion:\s*number/u);
  assert.match(service, /draft\.id\s*&&[\s\S]*?draft\.sourceRoleLabel === undefined[\s\S]*?draft\.targetRoleLabel === undefined/u);
  assert.match(service, /draft\.assertionKind === undefined[\s\S]*?draft\.metadata === undefined/u);
  assert.match(service, /validateIsoDate\(draft\.validFrom/u);
  assert.match(service, /validateIsoDate\(draft\.validTo/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
