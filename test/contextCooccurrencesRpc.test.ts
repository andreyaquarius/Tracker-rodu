import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290017_person_context_cooccurrences.sql",
    import.meta.url,
  ),
  "utf8",
);

const privateRpc = sourceBlock(
  migration,
  "create or replace function security_private.list_person_context_cooccurrences_v1",
  "comment on function security_private.list_person_context_cooccurrences_v1",
);
const findingBlock = sourceBlock(
  privateRpc,
  "shared_finding_candidates as materialized",
  "shared_findings as materialized",
);
const eventBlock = sourceBlock(
  privateRpc,
  "center_event_rows as materialized",
  "center_direct_name_rows as materialized",
);
const directDocumentBlock = sourceBlock(
  privateRpc,
  "center_direct_name_rows as materialized",
  "shared_document_context_candidates as materialized",
);
const scoringBlock = sourceBlock(
  privateRpc,
  "candidate_counts as materialized",
  "visible_candidates as materialized",
);

test("co-occurrence RPC is a bounded, project-scoped, read-only projection", () => {
  assert.match(
    privateRpc,
    /perform security_private\.require_context_project_access_v1\(p_project_id, false\)/iu,
  );
  assert.match(privateRpc, /source_cap constant integer := 500/iu);
  assert.match(privateRpc, /members_per_source_cap constant integer := 500/iu);
  assert.match(privateRpc, /pair_cap constant integer := 10000/iu);
  assert.match(privateRpc, /p_min_shared < 1 or p_min_shared > 1000/iu);
  assert.match(privateRpc, /p_limit < 1 or p_limit > 100/iu);
  assert.match(privateRpc, /p_offset < 0 or p_offset > 100000/iu);
  assert.match(privateRpc, /candidate\.shared_source_count >= p_min_shared/iu);
  assert.match(privateRpc, /candidate_rank > p_offset/iu);
  assert.match(privateRpc, /candidate_rank <= p_offset \+ p_limit/iu);

  for (const projectScopedRead of [
    /participant\.project_id = p_project_id/iu,
    /person_name\.project_id = p_project_id/iu,
    /event_row\.project_id = p_project_id/iu,
    /document\.project_id = p_project_id/iu,
  ]) {
    assert.match(privateRpc, projectScopedRead);
  }
  assert.doesNotMatch(privateRpc, /\binsert\s+into\b/iu);
  assert.doesNotMatch(privateRpc, /\bupdate\s+public\./iu);
  assert.doesNotMatch(privateRpc, /\bdelete\s+from\b/iu);
});

test("Finding co-occurrence de-duplicates people before truncation accounting", () => {
  assert.match(findingBlock, /select distinct member\.person_id/iu);
  assert.match(
    findingBlock,
    /count\(\*\) over \(\) as member_count[\s\S]*?from\s*\(\s*select distinct member\.person_id/iu,
    "Finding membership must be distinct in a nested input before the outer count",
  );
  assert.match(findingBlock, /bounded\.member_count > members_per_source_cap/iu);
  assert.match(findingBlock, /limit \(members_per_source_cap \+ 1\)/iu);
  assert.match(findingBlock, /limit members_per_source_cap/iu);
  assert.match(privateRpc, /limit \(pair_cap \+ 1\)/iu);
  assert.match(privateRpc, /'truncated', \(/iu);
});

test("shared Events require real timeline rows on the exact same Finding", () => {
  assert.match(eventBlock, /from public\.person_timeline_events event_row/iu);
  assert.match(eventBlock, /event_row\.source_finding_id is not null/iu);
  assert.match(
    eventBlock,
    /event_row\.source_finding_id = (?:center_event\.source_finding_id|shared_finding\.source_id)/iu,
  );
  assert.match(eventBlock, /event_row\.event_type = center_event\.event_type/iu);

  // A shared book/document and date is not a canonical event: two separate
  // births on the same day in one register must remain separate contexts.
  assert.doesNotMatch(
    eventBlock,
    /event_row\.source_document_id = center_event\.source_document_id/iu,
  );
  assert.doesNotMatch(
    eventBlock,
    /candidate\.source_document_id = center_event\.source_document_id/iu,
  );
  assert.doesNotMatch(
    eventBlock,
    /center_event\.source_finding_id is not null\s+or\s+center_event\.source_document_id/iu,
  );
});

test("direct Document co-occurrence requires the same canonical citation or fragment", () => {
  assert.match(
    directDocumentBlock,
    /person_name\.source_document_id = center_name\.source_document_id/iu,
  );
  assert.match(
    directDocumentBlock,
    /when 'fragment' then person_name\.document_fragment_id = center_name\.provenance_id/iu,
  );
  assert.match(
    directDocumentBlock,
    /else person_name\.citation_id = center_name\.provenance_id/iu,
  );
  assert.match(
    directDocumentBlock,
    /person_name\.document_fragment_id is not null[\s\S]*?union all[\s\S]*?person_name\.citation_id is not null/iu,
  );

  assert.match(
    directDocumentBlock,
    /count\(\*\) over \(\) as member_count[\s\S]*?from\s*\(\s*select distinct(?:\s+on\s*\([^)]*person_id[^)]*\))?[\s\S]*?person_id/iu,
    "Direct provenance membership must be distinct in a nested input before the outer count",
  );
});

test("scoring counts each evidence context once and does not double-score Events", () => {
  assert.match(scoringBlock, /shared_finding_count, 0\) \* 10/iu);
  assert.match(scoringBlock, /independent_document_count, 0\) \* 4/iu);
  assert.doesNotMatch(scoringBlock, /independent_event_count/iu);
  assert.doesNotMatch(scoringBlock, /shared_event_count, 0\) \*/iu);
  assert.doesNotMatch(scoringBlock, /\* 6/iu);
  assert.match(privateRpc, /'algorithmVersion', 'cooccurrence_v1'/iu);
});

test("representative sources are deterministic and capped at five", () => {
  const rankedSources = sourceBlock(
    privateRpc,
    "ranked_sources as materialized",
    "cap_state as",
  );
  assert.match(rankedSources, /partition by source\.person_id/iu);
  assert.match(
    rankedSources,
    /order by source\.weight desc, source\.source_year desc nulls last,[\s\S]*?source\.source_kind, source\.source_id/iu,
  );
  assert.match(privateRpc, /source\.source_rank <= 5/iu);
  assert.match(
    privateRpc,
    /jsonb_agg\([\s\S]*?order by source\.source_rank/iu,
  );
});

test("privacy and concrete Place filters are enforced before payload assembly", () => {
  assert.match(
    privateRpc,
    /center_row\.is_living[\s\S]*?center_row\.privacy_status in \('private', 'confidential'\)[\s\S]*?not can_edit/iu,
  );
  assert.match(privateRpc, /if center_hidden then[\s\S]*?'items', '\[\]'::jsonb/iu);
  assert.match(
    privateRpc,
    /person\.is_living[\s\S]*?person\.privacy_status in \('private', 'confidential'\)[\s\S]*?not can_edit/iu,
  );
  assert.match(privateRpc, /place_link\.source_finding_id = finding\.id/iu);
  assert.match(privateRpc, /place_link\.resolution_status = 'confirmed'/iu);
  assert.match(privateRpc, /finding_event\.place_resolution_status = 'confirmed'/iu);
  assert.match(privateRpc, /CONTEXT_COOCCURRENCE_PLACE_NOT_FOUND_OR_FORBIDDEN/iu);
});

test("payload is explicitly allowlisted and omits source bodies", () => {
  for (const forbiddenKey of [
    "notes",
    "transcription",
    "url",
    "sourceUrl",
    "fileReference",
    "customFields",
    "custom_fields",
    "excerpt",
  ]) {
    assert.doesNotMatch(
      privateRpc,
      new RegExp(`'${forbiddenKey}'\\s*,`, "iu"),
      `The co-occurrence payload must not expose ${forbiddenKey}`,
    );
  }
  for (const key of [
    "centerPersonId",
    "algorithmVersion",
    "personId",
    "displayName",
    "masked",
    "sharedFindingCount",
    "sharedDocumentCount",
    "sharedEventCount",
    "sharedSourceCount",
    "relationStrength",
    "firstYear",
    "lastYear",
    "topSources",
    "total",
    "truncated",
  ]) {
    assert.match(privateRpc, new RegExp(`'${key}'\\s*,`, "iu"));
  }
  assert.match(privateRpc, /'kind', source\.source_kind/iu);
  assert.match(privateRpc, /'id', source\.source_id/iu);
  assert.match(privateRpc, /'label', source\.source_label/iu);
  assert.match(privateRpc, /'year', source\.source_year/iu);
});

test("public facade is invoker-only with exact authenticated ACL", () => {
  assert.match(privateRpc, /security definer/iu);
  assert.match(
    migration,
    /create or replace function public\.list_person_context_cooccurrences_v1[\s\S]*?security invoker/iu,
  );
  assert.match(
    migration,
    /revoke all on function public\.list_person_context_cooccurrences_v1\([\s\S]*?\) from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.list_person_context_cooccurrences_v1\([\s\S]*?\) to authenticated, service_role;/iu,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function (?:security_private|public)\.list_person_context_cooccurrences_v1\([\s\S]*?\) to (?:public|anon)(?:\s|;)/iu,
  );
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
