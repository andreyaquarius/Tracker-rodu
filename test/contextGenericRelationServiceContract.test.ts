import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mapContextRelationEvidencePage } from "../src/services/contextRelationEvidenceMapper.ts";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);
const evidenceMapper = readFileSync(
  new URL("../src/services/contextRelationEvidenceMapper.ts", import.meta.url),
  "utf8",
);

test("generic context relation writes use authenticated project-scoped RPCs", () => {
  const saveBlock = sourceBlock(
    service,
    "export async function saveContextRelation",
    "export async function archiveContextRelation",
  );
  assert.match(saveBlock, /runAuthenticatedSupabaseRequest/u);
  assert.match(saveBlock, /client\.rpc\("save_context_relation_v2",\s*\{/u);
  for (const field of [
    "relationTypeId",
    "sourceEntityType",
    "sourceEntityId",
    "targetEntityType",
    "targetEntityId",
    "sourceRoleLabel",
    "targetRoleLabel",
    "validFrom",
    "validTo",
    "periodText",
    "evidenceStatus",
    "confidence",
    "privacyStatus",
    "assertionKind",
    "notes",
    "metadata",
  ]) {
    assert.match(
      saveBlock,
      new RegExp(`${field}(?:\\s*:|\\s*,)`, "u"),
      `Missing generic relation field: ${field}`,
    );
  }
  assert.match(saveBlock, /p_project_id:/u);
  assert.match(saveBlock, /p_payload:/u);
  assert.match(saveBlock, /p_expected_lock_version:\s*expectedLockVersion \?\? null/u);

  const archiveBlock = sourceBlock(
    service,
    "export async function archiveContextRelation",
    "export async function getContextRelationEvidence",
  );
  assert.match(archiveBlock, /runAuthenticatedSupabaseRequest/u);
  assert.match(archiveBlock, /client\.rpc\("archive_context_relation_v2",\s*\{/u);
  assert.match(archiveBlock, /p_project_id:/u);
  assert.match(archiveBlock, /p_relation_id:/u);
  assert.match(archiveBlock, /p_expected_lock_version:/u);

  assert.doesNotMatch(
    `${saveBlock}\n${archiveBlock}`,
    /\.from\(["'](?:context_relations|context_relation_evidence_links)["']\)/u,
  );
});

test("generic evidence read, save and archive use dedicated RPC methods", () => {
  const readBlock = sourceBlock(
    service,
    "export async function getContextRelationEvidence",
    "export async function saveContextRelationEvidence",
  );
  assert.match(readBlock, /runAuthenticatedSupabaseRequest/u);
  assert.match(readBlock, /client\.rpc\("get_context_relation_evidence_v2",\s*\{/u);
  assert.match(readBlock, /p_project_id:/u);
  assert.match(readBlock, /p_relation_id:/u);
  assert.match(readBlock, /mapContextRelationEvidencePage\(data,\s*\{/u);
  assert.match(readBlock, /projectId:\s*requestedProjectId/u);
  assert.match(readBlock, /relationId:\s*requestedRelationId/u);

  const saveBlock = sourceBlock(
    service,
    "export async function saveContextRelationEvidence",
    "export async function archiveContextRelationEvidence",
  );
  assert.match(saveBlock, /runAuthenticatedSupabaseRequest/u);
  assert.match(saveBlock, /client\.rpc\("save_context_relation_evidence_v2",\s*\{/u);
  for (const field of [
    "relationId",
    "evidenceEntityType",
    "evidenceEntityId",
    "citationId",
    "documentFragmentId",
    "sourceLocator",
    "excerpt",
    "notes",
    "metadata",
  ]) {
    assert.match(saveBlock, new RegExp(`${field}:`, "u"), `Missing evidence field: ${field}`);
  }
  assert.match(saveBlock, /p_expected_lock_version:\s*expectedLockVersion \?\? null/u);

  const archiveBlock = sourceBlock(
    service,
    "export async function archiveContextRelationEvidence",
    "export async function savePersonContextRelation",
  );
  assert.match(archiveBlock, /runAuthenticatedSupabaseRequest/u);
  assert.match(archiveBlock, /client\.rpc\("archive_context_relation_evidence_v2",\s*\{/u);
  assert.match(archiveBlock, /p_evidence_id:/u);
  assert.match(archiveBlock, /p_expected_lock_version:/u);
});

test("generic relation and evidence responses accept camelCase and snake_case RPC rows", () => {
  const relationMapper = sourceBlock(
    service,
    "function mapContextRelationV2",
    "function researchNodeId",
  );
  for (const pair of [
    "projectId ?? row.project_id",
    "relationTypeId ?? row.relation_type_id",
    "sourceEntityType ?? row.source_entity_type",
    "sourceEntityId ?? row.source_entity_id",
    "targetEntityType ?? row.target_entity_type",
    "targetEntityId ?? row.target_entity_id",
    "sourceRoleLabel ?? row.source_role_label",
    "targetRoleLabel ?? row.target_role_label",
    "personContextRelationId ?? row.person_context_relation_id",
    "lockVersion ?? row.lock_version",
    "evidenceCount ?? row.evidence_count",
  ]) {
    assert.ok(relationMapper.includes(`row.${pair}`), `Missing generic relation mapping: ${pair}`);
  }

  for (const pair of [
    "projectId ?? row.project_id",
    "relationId ?? row.relation_id",
    "evidenceEntityType ?? row.evidence_entity_type",
    "evidenceEntityId ?? row.evidence_entity_id",
    "citationId ?? row.citation_id",
    "documentFragmentId ?? row.document_fragment_id",
    "sourceLocator ?? row.source_locator",
    "lockVersion ?? row.lock_version",
    "deletedAt ?? row.deleted_at",
  ]) {
    assert.ok(evidenceMapper.includes(`row.${pair}`), `Missing generic evidence mapping: ${pair}`);
  }
});

test("bounded evidence payload fills requested ids and rejects cross-scope rows", () => {
  const context = { projectId: "project-1", relationId: "relation-1" };
  const result = mapContextRelationEvidencePage({
    items: [
      {
        id: "evidence-1",
        evidenceSource: "person_v1",
        evidenceEntityType: "document",
        evidenceEntityId: "document-1",
        sourceLocator: "арк. 7",
        excerpt: "Короткий уривок",
        lockVersion: 3,
      },
      {
        id: "evidence-wrong-project",
        projectId: "another-project",
        relationId: "relation-1",
      },
      {
        id: "evidence-wrong-relation",
        project_id: "project-1",
        relation_id: "another-relation",
      },
    ],
  }, context);

  assert.deepEqual(result, [{
    id: "evidence-1",
    projectId: "project-1",
    relationId: "relation-1",
    evidenceSource: "person_v1",
    evidenceEntityType: "document",
    evidenceEntityId: "document-1",
    citationId: null,
    documentFragmentId: null,
    sourceLocator: "арк. 7",
    excerpt: "Короткий уривок",
    notes: "",
    metadata: {},
    lockVersion: 3,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
  }]);
});

test("research filters and generic writes normalize partial historical dates without inventing display precision", () => {
  const graphBlock = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "export async function saveContextRelation",
  );
  const saveBlock = sourceBlock(
    service,
    "export async function saveContextRelation",
    "export async function archiveContextRelation",
  );
  assert.match(graphBlock, /normalizeHistoricalDate\(filters\.validFrom,\s*"start"/u);
  assert.match(graphBlock, /normalizeHistoricalDate\(filters\.validTo,\s*"end"/u);
  assert.match(saveBlock, /normalizeHistoricalDate\(draft\.validFrom,\s*"start"/u);
  assert.match(saveBlock, /normalizeHistoricalDate\(draft\.validTo,\s*"end"/u);
  assert.match(saveBlock, /historicalPeriodText\(draft\.validFrom,\s*draft\.validTo\)/u);

  const normalizer = sourceBlock(
    service,
    "function normalizeHistoricalDate",
    "function historicalPeriodText",
  );
  assert.match(normalizer, /\\d\{4\}/u, "Year-only historical dates must be supported");
  assert.match(
    normalizer,
    /\(\?:-\(\\d\{2\}\)\(\?:-\(\\d\{2\}\)\)\?\)\?/u,
    "Month and day groups must remain optional",
  );
  assert.match(normalizer, /(?:boundary|side) === "start"/u);
  assert.match(normalizer, /historicalDaysInMonth/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
