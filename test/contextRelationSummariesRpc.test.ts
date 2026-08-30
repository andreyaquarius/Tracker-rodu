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

const privateSummary = sourceBlock(
  migration,
  "create or replace function security_private.list_person_context_relation_summaries_v1",
  "-- Data API facade remains SECURITY INVOKER",
);
const publicSummary = sourceBlock(
  migration,
  "create or replace function public.list_person_context_relation_summaries_v1",
  "revoke all on function security_private.get_person_context_graph_v1",
);
const foundationList = sourceBlock(
  foundation,
  "create or replace function security_private.list_person_context_relations_v1",
  "create or replace function security_private.save_context_relation_type_v1",
);

test("context relation summaries are project/person scoped and bounded", () => {
  assert.match(
    privateSummary,
    /perform security_private\.require_context_project_access_v1\(p_project_id, false\)/i,
  );
  assert.match(privateSummary, /person\.id = p_person_id[\s\S]*?person\.project_id = p_project_id/i);
  assert.match(privateSummary, /relation\.project_id = p_project_id/i);
  assert.match(
    privateSummary,
    /relation\.source_person_id = p_person_id[\s\S]*?relation\.target_person_id = p_person_id/i,
  );
  assert.match(privateSummary, /p_limit < 1 or p_limit > 500/i);
  assert.match(privateSummary, /p_offset < 0 or p_offset > 100000/i);
  assert.match(privateSummary, /order by visible\.updated_at desc, visible\.id[\s\S]*?limit p_limit offset p_offset/i);
  assert.doesNotMatch(privateSummary, /\bpublic\.family_trees\b/i);
});

test("summary RPC repeats the foundation privacy and living-person filters", () => {
  for (const source of [foundationList, privateSummary]) {
    assert.match(source, /relation\.privacy_status <> 'confidential' or can_edit/i);
    assert.match(
      source,
      /endpoint\.project_id = relation\.project_id[\s\S]*?endpoint\.id in \([\s\S]*?relation\.source_person_id[\s\S]*?relation\.target_person_id[\s\S]*?endpoint\.is_living[\s\S]*?endpoint\.privacy_status in \('private', 'confidential'\)/i,
    );
    assert.doesNotMatch(source, /relation\.created_by\s*=\s*auth\.uid\(\)/i);
  }
});

test("summary items omit evidence arrays and expose only evidenceCount", () => {
  assert.match(
    privateSummary,
    /context_relation_json_v1\(relation_row, false\)[\s\S]*?- 'evidence'[\s\S]*?'evidenceCount'/i,
  );
  assert.match(
    privateSummary,
    /from public\.context_relation_evidence evidence[\s\S]*?evidence\.project_id = p_project_id[\s\S]*?evidence\.relation_id = relation_row\.id[\s\S]*?evidence\.deleted_at is null/i,
  );
  assert.match(privateSummary, /'total', \(select count\(\*\) from visible\)/i);
  assert.match(privateSummary, /'revision'[\s\S]*?public\.context_graph_revisions/i);
  assert.doesNotMatch(
    privateSummary,
    /context_relation_json_v1\(relation_row, true\)/i,
  );
});

test("summary facade is invoker-only with exact authenticated/service ACL", () => {
  assert.match(privateSummary, /security definer/i);
  assert.match(publicSummary, /security invoker/i);
  assert.match(
    publicSummary,
    /select security_private\.list_person_context_relation_summaries_v1\(\s*\$1, \$2, \$3, \$4, \$5\s*\)/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.list_person_context_relation_summaries_v1\([\s\S]*?\) from public, anon, authenticated, service_role;[\s\S]*?grant execute on function security_private\.list_person_context_relation_summaries_v1\([\s\S]*?\) to authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.list_person_context_relation_summaries_v1\([\s\S]*?\) from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.list_person_context_relation_summaries_v1\([\s\S]*?\) to authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function (?:security_private|public)\.list_person_context_relation_summaries_v1\([\s\S]*?\) to (?:public|anon)(?:\s|;)/i,
  );
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
