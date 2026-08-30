import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);

test("research graph service prefers the authenticated bounded v2 projection", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "export async function savePersonContextRelation",
  );
  assert.match(block, /runAuthenticatedSupabaseRequest/u);
  assert.match(block, /client\.rpc\("get_person_research_context_graph_v2"/u);
  for (const parameter of [
    "p_project_id",
    "p_center_person_id",
    "p_depth",
    "p_entity_types",
    "p_relation_type_ids",
    "p_evidence_statuses",
    "p_assertion_kinds",
    "p_valid_from",
    "p_valid_to",
    "p_min_confidence",
    "p_has_evidence",
    "p_focus_date",
    "p_focus_year",
    "p_place_ids",
    "p_include_undated",
    "p_max_nodes",
    "p_max_edges",
  ]) {
    assert.match(block, new RegExp(`${parameter}:`, "u"), `Missing RPC parameter: ${parameter}`);
  }
  assert.match(block, /boundedInteger\(filters\.maxNodes,\s*1,\s*100,\s*100\)/u);
  assert.match(block, /boundedInteger\(filters\.maxEdges,\s*1,\s*250,\s*250\)/u);
  assert.doesNotMatch(block, /\.from\(/u);
});

test("research graph only falls back to v1 for a missing v2 function and never drops new filters", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "/** Searches the named historical-place catalogue",
  );
  assert.match(block, /isMissingResearchGraphV2Error\(modern\.error\)/u);
  assert.match(block, /client\.rpc\("get_person_research_context_graph_v1"/u);
  assert.match(
    block,
    /validFrom\s*\|\|\s*validTo\s*\|\|\s*focusDate\s*\|\|\s*focusYear !== null\s*\|\|\s*placeIds\.length\s*\|\|\s*filters\.includeUndated === true/u,
  );
  assert.match(block, /Фільтри дат, часового зрізу й місця стануть доступними/u);
  assert.doesNotMatch(block, /if \(modern\.error\) \{[\s\S]*?get_person_research_context_graph_v1/u);
});

test("research date bounds fail closed instead of falling back to v1 undated semantics", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "/** Searches the named historical-place catalogue",
  );
  const guardedDateBounds = block.match(/validFrom\s*\|\|\s*validTo/g) ?? [];
  assert.ok(guardedDateBounds.length >= 2, "date bounds must guard both fallback and migration error paths");
  assert.match(
    block,
    /if \(\s*validFrom[\s\S]*?validTo[\s\S]*?\) \{[\s\S]*?return \{ data: modern\.data, error: modern\.error \};[\s\S]*?get_person_research_context_graph_v1/u,
  );
});

test("research graph response is scoped to the requested project and exact center", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "export async function savePersonContextRelation",
  );
  assert.match(block, /returnedProjectId !== normalizedProjectId/u);
  assert.match(block, /returnedCenterType !== "person" \|\| returnedCenterId !== normalizedPersonId/u);
  assert.match(block, /!centerNode \|\| !centerNode\.isCenter \|\| centerNode\.depth !== 0/u);
  assert.doesNotMatch(block, /uniqueNodes\.unshift/u);
});

test("research graph mapper rejects malformed namespaces and mismatched endpoint copies", () => {
  const block = sourceBlock(service, "function mapResearchGraphNode", "function rows");
  assert.match(block, /id !== `\$\{entityType\}:\$\{entityId\}`/u);
  assert.match(
    block,
    /\^\(person\|family\|place\|event\|document\|finding\|source\|repository\|hypothesis\):/u,
  );
  assert.match(block, /sourceEntityType !== sourceParts\.entityType/u);
  assert.match(block, /targetEntityId !== targetParts\.entityId/u);
  assert.match(service, /nodeIds\.has\(edge\.source\) && nodeIds\.has\(edge\.target\)/u);
  assert.match(service, /deduplicateResearchNodes/u);
  assert.match(service, /deduplicateResearchEdges/u);
});

test("research graph filters validate dates, confidence, evidence and assertion kinds", () => {
  const block = sourceBlock(
    service,
    "export async function getPersonResearchGraph",
    "export async function savePersonContextRelation",
  );
  assert.match(block, /normalizeHistoricalDate\(filters\.validFrom,\s*"start"/u);
  assert.match(block, /normalizeHistoricalDate\(filters\.validTo,\s*"end"/u);
  assert.match(block, /p_valid_from:\s*validFrom\s*\|\|\s*null/u);
  assert.match(block, /p_valid_to:\s*validTo\s*\|\|\s*null/u);
  assert.match(block, /validFrom && validTo && validFrom > validTo/u);
  assert.match(block, /optionalBoundedInteger\(filters\.minConfidence,\s*0,\s*100\)/u);
  assert.match(block, /typeof filters\.hasEvidence === "boolean"/u);
  assert.match(service, /value === "research_hypothesis"/u);
  assert.match(block, /normalizeExactHistoricalDate\(filters\.focusDate/u);
  assert.match(block, /optionalHistoricalYear\(filters\.focusYear/u);
  assert.match(block, /focusDate && focusYear !== null/u);
  assert.match(block, /sameTextSet\(returnedPlaceIds, placeIds\)/u);
  assert.match(block, /returnedIncludeUndated !== \(filters\.includeUndated === true\)/u);
});

test("place autocomplete uses named catalogue results and a year interval without inventing a day", () => {
  const block = sourceBlock(
    service,
    "export async function searchResearchGraphPlaces",
    "/** Saves a polymorphic contextual assertion",
  );
  assert.match(block, /searchPlaces\(\{/u);
  assert.match(block, /periodFrom:\s*`\$\{focusYearText\}-01-01`/u);
  assert.match(block, /periodTo:\s*`\$\{focusYearText\}-12-31`/u);
  assert.match(block, /precision:\s*"year"/u);
  assert.match(block, /label:\s*place\.displayName \|\| place\.canonicalName/u);
  assert.doesNotMatch(block, /-07-01/u);
});

test("saved graph views use owner-scoped RPCs and never fall back to browser storage", () => {
  const block = sourceBlock(
    service,
    "/** Lists only the signed-in member's personal views",
    "/** Saves a polymorphic contextual assertion",
  );
  for (const rpc of [
    "list_context_graph_saved_views_v1",
    "get_context_graph_saved_view_v1",
    "save_context_graph_saved_view_v1",
    "delete_context_graph_saved_view_v1",
  ]) {
    assert.match(block, new RegExp(`client\\.rpc\\("${rpc}"`, "u"));
  }
  assert.match(block, /runAuthenticatedSupabaseRequest/u);
  assert.match(block, /p_expected_lock_version/u);
  assert.match(block, /researchGraphSavedViewError/u);
  assert.doesNotMatch(block, /localStorage|sessionStorage|indexedDB/u);
});

test("saved graph view mapper accepts section 26 layouts and fails closed on unknown schema and layout", () => {
  const block = sourceBlock(
    service,
    "function mapResearchGraphSavedView",
    "function rows",
  );
  assert.match(block, /configVersion \?\? row\.config_version\) !== 1/u);
  assert.match(block, /Непідтримуваний макет збереженого представлення/u);
  assert.match(block, /value === "radial" \|\| value === "hierarchical" \|\| value === "force"/u);
  assert.match(block, /optionalResearchGraphLayoutId/u);
  assert.match(block, /Непідтримувана версія конфігурації/u);
  assert.match(block, /centerEntityType !== "person"/u);
  assert.match(block, /projectId !== expectedProjectId/u);
  assert.match(block, /normalizeHistoricalDate\([\s\S]*?"start"[\s\S]*?"початкову дату"/u);
  assert.match(block, /normalizeHistoricalDate\([\s\S]*?"end"[\s\S]*?"кінцеву дату"/u);
});

test("saved place IDs are re-resolved and merged or inaccessible places are rejected", () => {
  const block = sourceBlock(
    service,
    "export async function resolveResearchGraphSavedPlace",
    "/** Lists only the signed-in member's personal views",
  );
  assert.match(block, /getHistoricalPlaceProfile/u);
  assert.match(block, /place\.status === "merged"/u);
  assert.match(block, /place\.status === "archived"/u);
  assert.match(block, /place\.isRedirect/u);
  assert.match(block, /place\.projectId !== normalizedProjectId/u);
  assert.doesNotMatch(block, /placeLabel/u);
});

test("empty optional saved-view dates cross the RPC boundary as JSON null", () => {
  const block = sourceBlock(
    service,
    "function normalizeResearchGraphSavedViewDraft",
    "function normalizeResearchGraphSavedViewFilters",
  );
  assert.match(block, /validFrom:\s*filters\.validFrom \|\| null/u);
  assert.match(block, /validTo:\s*filters\.validTo \|\| null/u);
  assert.match(block, /focusDate:\s*filters\.focusDate \|\| null/u);
  assert.doesNotMatch(block, /validFrom:\s*filters\.validFrom\s*,/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
