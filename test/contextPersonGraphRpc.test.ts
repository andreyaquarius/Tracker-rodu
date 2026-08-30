import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290013_person_context_graph_rpc.sql",
    import.meta.url,
  ),
  "utf8",
);
const foundation = readFileSync(
  new URL(
    "../supabase/migrations/202608290009_context_person_relations_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

test("person context graph RPC is project-scoped and isolated from the family graph", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(
    migration,
    /perform security_private\.require_context_project_access_v1\(p_project_id, false\)/i,
  );
  assert.match(migration, /relation\.project_id = p_project_id/i);
  assert.match(migration, /person\.project_id = p_project_id/i);
  assert.doesNotMatch(migration, /\bpublic\.family_trees\b/i);
  assert.doesNotMatch(migration, /\bgraph_version\b/i);
  assert.doesNotMatch(migration, /\bparent_child_relationships\b/i);
  assert.doesNotMatch(migration, /\bpartner_relationships\b/i);
});

test("person context graph is a bounded depth-one read model", () => {
  assert.match(migration, /p_depth is null or p_depth <> 1/i);
  assert.match(migration, /p_max_nodes < 1 or p_max_nodes > 100/i);
  assert.match(migration, /CONTEXT_GRAPH_DEPTH_UNSUPPORTED/i);
  assert.match(migration, /CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE/i);
  assert.match(
    migration,
    /ranked\.neighbor_rank <= greatest\(p_max_nodes - 1, 0\)/i,
  );
  assert.match(
    migration,
    /'truncated'[\s\S]*?count\(\*\) > greatest\(p_max_nodes - 1, 0\)/i,
  );
});

test("person context graph has a hard backward-safe edge budget", () => {
  assert.match(migration, /p_max_edges integer default 250/i);
  assert.match(
    migration,
    /max_edges := least\(greatest\(coalesce\(p_max_edges, 250\), 1\), 500\)/i,
  );
  assert.match(
    migration,
    /row_number\(\) over \([\s\S]*?partition by visible\.neighbor_person_id[\s\S]*?order by visible\.updated_at desc, visible\.id[\s\S]*?\) as neighbor_edge_rank/i,
  );
  assert.match(
    migration,
    /row_number\(\) over \([\s\S]*?candidate\.neighbor_edge_rank[\s\S]*?candidate\.neighbor_rank[\s\S]*?candidate\.updated_at desc[\s\S]*?candidate\.id[\s\S]*?\) as edge_rank/i,
  );
  assert.match(migration, /where ranked\.edge_rank <= max_edges/i);
  assert.match(
    migration,
    /'edgesTruncated'[\s\S]*?count\(\*\) > max_edges[\s\S]*?from ranked_relations/i,
  );
});

test("person context graph filters relation type, evidence status and validity interval", () => {
  assert.match(migration, /relation\.relation_type_id = any\(p_relation_type_ids\)/i);
  assert.match(migration, /relation\.evidence_status = any\(p_evidence_statuses\)/i);
  assert.match(migration, /CONTEXT_GRAPH_EVIDENCE_STATUS_INVALID/i);
  assert.match(migration, /relation\.valid_to >= p_valid_from/i);
  assert.match(migration, /relation\.valid_from <= p_valid_to/i);
  assert.match(migration, /CONTEXT_GRAPH_DATE_RANGE_INVALID/i);
});

test("privacy is enforced before graph nodes and edges are assembled", () => {
  assert.match(migration, /relation\.privacy_status <> 'confidential' or can_edit/i);
  assert.match(
    migration,
    /private_endpoint\.is_living[\s\S]*?private_endpoint\.privacy_status in \('private', 'confidential'\)/i,
  );
  assert.match(migration, /then 'Приватна особа'/i);
  assert.match(migration, /'masked'/i);
  assert.match(migration, /public\.can_edit_project\(p_project_id\)/i);
});

test("private means project-visible and confidential remains editor-only consistently", () => {
  const foundationList = sourceBlock(
    foundation,
    "create or replace function security_private.list_person_context_relations_v1",
    "create or replace function security_private.save_context_relation_type_v1",
  );
  for (const source of [foundationList, migration]) {
    assert.match(source, /privacy_status <> 'confidential' or can_edit/i);
    assert.doesNotMatch(source, /created_by\s*=\s*auth\.uid\(\)/i);
  }
  assert.match(
    migration,
    /`private` is visible inside the[\s\S]*?`confidential` is editor-only/i,
  );
});

test("RPC returns the documented camelCase person graph contract", () => {
  for (const key of [
    "centerPersonId",
    "nodes",
    "edges",
    "revision",
    "truncated",
    "edgesTruncated",
    "entityType",
    "isCenter",
    "displayName",
    "gender",
    "degree",
    "sourcePersonId",
    "targetPersonId",
    "relationTypeLabel",
    "category",
    "directionality",
    "assertionKind",
    "evidenceCount",
  ]) {
    assert.match(migration, new RegExp(`'${key}'`), `Missing response key ${key}`);
  }
});

test("public facade is invoker-only and anonymous callers cannot execute it", () => {
  assert.match(
    migration,
    /create or replace function public\.get_person_context_graph_v1[\s\S]*?security invoker/i,
  );
  assert.match(
    migration,
    /create or replace function security_private\.get_person_context_graph_v1[\s\S]*?security definer/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_person_context_graph_v1[\s\S]*?from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_person_context_graph_v1[\s\S]*?to authenticated, service_role/i,
  );
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
