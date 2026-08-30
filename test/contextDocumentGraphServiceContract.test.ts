import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);

test("documentary graph service uses one authenticated, project-scoped bounded RPC", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonDocumentaryGraph",
    "export async function savePersonContextRelation",
  );
  assert.match(block, /runAuthenticatedSupabaseRequest/u);
  assert.match(
    block,
    /client\.rpc\("get_person_documentary_context_graph_v1",\s*\{[\s\S]*?p_project_id:[\s\S]*?p_center_person_id:/u,
  );
  for (const parameter of [
    "p_depth",
    "p_entity_types",
    "p_event_types",
    "p_evidence_statuses",
    "p_year_from",
    "p_year_to",
    "p_place_id",
    "p_max_nodes",
    "p_max_edges",
  ]) {
    assert.match(block, new RegExp(`${parameter}:`, "u"), `Missing RPC parameter: ${parameter}`);
  }
  assert.match(block, /boundedInteger\(filters\.maxNodes,\s*1,\s*100,\s*100\)/u);
  assert.match(block, /boundedInteger\(filters\.maxEdges,\s*1,\s*500,\s*250\)/u);
  assert.doesNotMatch(block, /\.from\(/u);
});

test("documentary graph service validates years and only sends allowlisted filters", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonDocumentaryGraph",
    "export async function savePersonContextRelation",
  );
  assert.match(block, /optionalBoundedInteger\(filters\.yearFrom,\s*1,\s*9999\)/u);
  assert.match(block, /optionalBoundedInteger\(filters\.yearTo,\s*1,\s*9999\)/u);
  assert.match(block, /yearFrom > yearTo/u);
  assert.match(service, /value === "person" \|\| value === "finding" \|\| value === "person_event"/u);
  assert.match(service, /value === "document" \|\| value === "place"/u);
  assert.match(service, /value === "proven" \|\| value === "likely" \|\| value === "disputed"/u);
});

test("documentary graph service rejects malformed records and dangling edges", () => {
  const block = sourceBlock(
    service,
    "function mapDocumentaryGraphNode",
    "function rows",
  );
  assert.match(block, /id !== `\$\{entityType\}:\$\{entityId\}`/u);
  assert.match(block, /\^\(person\|finding\|person_event\|document\|place\):/u);
  assert.match(block, /if \(!id \|\| !source \|\| !target \|\| source === target\) return null/u);
  assert.match(service, /nodeIds\.has\(edge\.source\) && nodeIds\.has\(edge\.target\)/u);
  assert.match(service, /deduplicateDocumentaryNodes/u);
  assert.match(service, /deduplicateDocumentaryEdges/u);
});

test("documentary graph service maps camelCase and snake_case response fields", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonDocumentaryGraph",
    "export async function savePersonContextRelation",
  );
  for (const mapping of [
    "centerNodeId ?? payload.center_node_id",
    "generatedAt ?? payload.generated_at",
    "snapshotUpdatedAt ?? payload.snapshot_updated_at",
    "edgesTruncated ?? payload.edges_truncated",
  ]) {
    assert.ok(block.includes(`payload.${mapping}`), `Missing response mapping: ${mapping}`);
  }
  assert.match(service, /row\.entityType \?\? row\.entity_type/u);
  assert.match(service, /row\.entityId \?\? row\.entity_id/u);
  assert.match(service, /row\.sourceCount \?\? row\.source_count/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
