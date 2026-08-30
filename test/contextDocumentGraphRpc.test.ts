import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290014_documentary_context_graph.sql",
    import.meta.url,
  ),
  "utf8",
);

const privateRpc = sourceBlock(
  migration,
  "create or replace function security_private.get_person_documentary_context_graph_v1",
  "create or replace function public.get_person_documentary_context_graph_v1",
);

test("documentary graph migration is transactional and adds project-consistent evidence guards", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /FINDING_DOCUMENT_PROJECT_MISMATCH/i);
  assert.match(migration, /PERSON_EVENT_DOCUMENT_PROJECT_MISMATCH/i);
  assert.match(migration, /PERSON_EVENT_FINDING_PROJECT_MISMATCH/i);
  assert.match(
    migration,
    /foreign key \(document_id, project_id\)[\s\S]*?references public\.documents\(id, project_id\)/i,
  );
  assert.match(
    migration,
    /foreign key \(source_document_id, project_id\)[\s\S]*?references public\.documents\(id, project_id\)/i,
  );
  assert.match(
    migration,
    /foreign key \(source_finding_id, project_id\)[\s\S]*?references public\.findings\(id, project_id\)/i,
  );
});

test("documentary graph is a bounded project-scoped read model", () => {
  assert.match(
    privateRpc,
    /perform security_private\.require_context_project_access_v1\(p_project_id, false\)/i,
  );
  assert.match(privateRpc, /p_depth not in \(1, 2\)/i);
  assert.match(privateRpc, /p_max_nodes < 1 or p_max_nodes > 100/i);
  assert.match(privateRpc, /p_max_edges < 1 or p_max_edges > 500/i);
  assert.match(privateRpc, /node\.node_rank <= p_max_nodes/i);
  assert.match(privateRpc, /edge\.edge_rank <= p_max_edges/i);
  assert.match(privateRpc, /limit \(p_max_nodes \+ 1\)/i);
  assert.match(privateRpc, /limit \(p_max_edges \+ 1\)/i);
  assert.match(privateRpc, /'truncated'[\s\S]*?count\(\*\) > p_max_nodes/i);
  assert.match(privateRpc, /'edgesTruncated'[\s\S]*?count\(\*\) > p_max_edges/i);
  assert.doesNotMatch(privateRpc, /\bpublic\.family_trees\b/i);
  assert.doesNotMatch(privateRpc, /\bgraph_version\b/i);
  assert.doesNotMatch(privateRpc, /\bparent_child_relationships\b/i);
  assert.doesNotMatch(privateRpc, /\bpartner_relationships\b/i);
});

test("documentary graph validates all public filters before reading the projection", () => {
  assert.match(privateRpc, /DOCUMENTARY_GRAPH_ENTITY_TYPE_INVALID/i);
  assert.match(privateRpc, /DOCUMENTARY_GRAPH_EVENT_TYPE_INVALID/i);
  assert.match(privateRpc, /DOCUMENTARY_GRAPH_EVIDENCE_STATUS_INVALID/i);
  assert.match(privateRpc, /DOCUMENTARY_GRAPH_YEAR_RANGE_INVALID/i);
  assert.match(privateRpc, /DOCUMENTARY_GRAPH_PLACE_NOT_FOUND_OR_FORBIDDEN/i);
  assert.match(privateRpc, /event_row\.event_type = any\(p_event_types\)/i);
  assert.match(privateRpc, /event_row\.evidence_status = any\(p_evidence_statuses\)/i);
  assert.match(privateRpc, /link_row\.place_id = p_place_id/i);
  assert.match(privateRpc, /link_row\.resolution_status = 'confirmed'/i);
  assert.match(
    privateRpc,
    /event_row\.place_id = p_place_id[\s\S]*?event_row\.place_resolution_status = 'confirmed'/i,
  );
});

test("privacy is enforced before nodes and edges are assembled", () => {
  assert.match(
    privateRpc,
    /center_row\.is_living[\s\S]*?center_row\.privacy_status in \('private', 'confidential'\)[\s\S]*?not can_edit/i,
  );
  assert.match(privateRpc, /if center_hidden then[\s\S]*?'Приватна особа'/i);
  assert.match(privateRpc, /if center_hidden then[\s\S]*?'edges', '\[\]'::jsonb/i);
  assert.match(
    privateRpc,
    /person\.is_living[\s\S]*?person\.privacy_status in \('private', 'confidential'\)[\s\S]*?not can_edit/i,
  );
  assert.match(privateRpc, /public\.can_edit_project\(p_project_id\)/i);
});

test("projection exposes allowlisted summaries instead of source bodies or URLs", () => {
  for (const forbiddenKey of [
    "notes",
    "transcription",
    "customFields",
    "custom_fields",
    "url",
    "sourceUrl",
    "fileReference",
    "excerpt",
  ]) {
    assert.doesNotMatch(
      privateRpc,
      new RegExp(`'${forbiddenKey}'\\s*,`, "i"),
      `The graph payload must not expose ${forbiddenKey}`,
    );
  }
  assert.doesNotMatch(privateRpc, /finding\.place\b/i);
  assert.doesNotMatch(privateRpc, /event_row\.place_name\b/i);
  assert.match(privateRpc, /link_row\.resolution_status = 'confirmed'/i);
  assert.match(
    privateRpc,
    /'relationType', 'occurred_at'[\s\S]*?event_row\.place_resolution_status = 'confirmed'/i,
  );
});

test("nodes are namespaced, de-duplicated and every selected edge has two selected endpoints", () => {
  for (const prefix of ["person", "finding", "person_event", "document", "place"]) {
    assert.match(privateRpc, new RegExp(`'${prefix}:' \\|\\|`, "i"));
  }
  assert.match(
    privateRpc,
    /finding_people_rollup as materialized[\s\S]*?group by linked\.person_id/i,
  );
  assert.match(
    privateRpc,
    /finding_document_pairs as materialized[\s\S]*?group by source\.finding_id, source\.document_id/i,
  );
  assert.match(
    privateRpc,
    /join selected_nodes source_node on source_node\.node_key = edge\.source_key[\s\S]*?join selected_nodes target_node on target_node\.node_key = edge\.target_key/i,
  );
  assert.match(
    privateRpc,
    /connected_node_keys as \([\s\S]*?edge\.source_key[\s\S]*?edge\.target_key/i,
  );
});

test("public documentary graph facade is invoker-only with exact authenticated ACL", () => {
  assert.match(privateRpc, /security definer/i);
  assert.match(privateRpc, /set search_path = pg_catalog, security_private, pg_temp/i);
  assert.match(
    migration,
    /create or replace function public\.get_person_documentary_context_graph_v1[\s\S]*?security invoker/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_person_documentary_context_graph_v1\([\s\S]*?\) from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.get_person_documentary_context_graph_v1\([\s\S]*?\) to authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function (?:security_private|public)\.get_person_documentary_context_graph_v1\([\s\S]*?\) to (?:public|anon)(?:\s|;)/i,
  );
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
