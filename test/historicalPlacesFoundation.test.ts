import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608280001_historical_places_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const domainTypes = readFileSync(
  new URL("../src/types/historicalPlaces.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/historicalPlacesService.ts", import.meta.url),
  "utf8",
);

function sqlFunction(schema: string, name: string): string {
  const source = migration.toLowerCase();
  const marker = `create or replace function ${schema}.${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing SQL function ${schema}.${name}`);

  const end = source.indexOf("\ncreate or replace function ", start + marker.length);
  return migration.slice(start, end === -1 ? migration.length : end);
}

function sqlTable(name: string): string {
  const source = migration.toLowerCase();
  const marker = `create table if not exists public.${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing SQL table public.${name}`);

  const end = source.indexOf("\ncreate table if not exists ", start + marker.length);
  return migration.slice(start, end === -1 ? migration.length : end);
}

const searchRpc = sqlFunction("public", "search_places_v1");
const searchImplementation = sqlFunction("security_private", "search_places_v1");
const createRpc = sqlFunction("public", "create_project_place_v1");
const resolveRpc = sqlFunction("public", "resolve_place_hierarchy_v1");
const resolveImplementation = sqlFunction(
  "security_private",
  "resolve_place_hierarchy_v1",
);

test("historical-place foundation is additive and does not rewrite legacy records", () => {
  for (const table of [
    "places",
    "place_names",
    "place_external_identifiers",
    "place_type_assignments",
    "place_hierarchy_relations",
    "place_change_requests",
  ]) {
    assert.match(
      migration,
      new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"),
    );
  }

  const legacyTables =
    "(?:persons|person_names|person_timeline_events|documents|findings|zagulyaky_(?:records|participants|sources))";
  assert.doesNotMatch(
    migration,
    new RegExp(`^\\s*(?:update|delete\\s+from)\\s+public\\.${legacyTables}\\b`, "im"),
  );
  assert.doesNotMatch(
    migration,
    new RegExp(`^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${legacyTables}\\b`, "im"),
  );
  assert.doesNotMatch(
    migration,
    new RegExp(`^\\s*drop\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${legacyTables}\\b`, "im"),
  );
});

test("the place-type vocabulary matches the values emitted by the UI", () => {
  assert.match(migration, /\('settlement',\s*'населений пункт'/u);
  assert.match(migration, /\('small_settlement',\s*'присілок'/u);
  assert.doesNotMatch(migration, /\('prisilok',/u);
});

test("source spellings and uncertain historical date ranges stay lossless", () => {
  const placeNames = sqlTable("place_names");
  assert.match(placeNames, /\bname\s+text\s+not null/i);
  assert.match(placeNames, /\boriginal_text\s+text\s+not null/i);
  assert.match(placeNames, /\bvalid_from\s+date\b/i);
  assert.match(placeNames, /\bvalid_to\s+date\b/i);
  assert.match(placeNames, /\bvalid_from_text\s+text\b/i);
  assert.match(placeNames, /\bvalid_to_text\s+text\b/i);
  assert.match(placeNames, /\bvalid_from_precision\s+text\b/i);
  assert.match(placeNames, /\bvalid_to_precision\s+text\b/i);
  assert.match(
    migration,
    /place_names\.original_text[^;]*exact source wording[^;]*never normalized or overwritten/is,
  );
  assert.match(
    migration,
    /historical_place_search_normalize_v1[^;]*search-only normalization[^;]*never rewrites source text/is,
  );

  // Creating a place must persist all supplied source-name variants instead of
  // silently reducing them to the canonical label.
  assert.match(createRpc, /p_input\s*->\s*'names'/i);
  assert.match(createRpc, /jsonb_array_elements/i);
  assert.match(createRpc, /original_text/i);
  assert.match(createRpc, /valid_from/i);
  assert.match(createRpc, /valid_to/i);
  assert.match(createRpc, /date_precision/i);

  assert.match(domainTypes, /\bdatePrecision:\s*PlaceNameDatePrecision\b/);
  assert.match(domainTypes, /exact spelling supplied by the source or user/i);
});

test("global and project scopes are protected by RLS and explicit ACLs", () => {
  assert.match(
    migration,
    /places\.project_id is null[\s\S]*shared\/global catalogue row/i,
  );
  assert.match(
    migration,
    /places\.project_id is not null[\s\S]*private row owned by one project/i,
  );

  for (const table of [
    "places",
    "place_names",
    "place_external_identifiers",
    "place_type_assignments",
    "place_hierarchy_relations",
    "place_change_requests",
  ]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"),
    );
  }

  assert.match(migration, /is_project_member\(project_id\)/i);
  assert.match(migration, /can_edit_project\(project_id\)/i);
  assert.match(
    migration,
    /grant execute on function public\.search_places_v1\(text,date,uuid,integer\)[\s\S]*?to anon, authenticated, service_role/i,
  );
  const createGrant = migration.match(
    /grant execute on function public\.create_project_place_v1\(uuid,jsonb\)[^;]*;/i,
  )?.[0];
  const resolveGrant = migration.match(
    /grant execute on function public\.resolve_place_hierarchy_v1\(uuid,date,integer\)[^;]*;/i,
  )?.[0];
  assert.ok(createGrant, "Missing create_project_place_v1 grant");
  assert.ok(resolveGrant, "Missing resolve_place_hierarchy_v1 grant");
  assert.doesNotMatch(createGrant, /\banon\b/i);
  assert.doesNotMatch(resolveGrant, /\banon\b/i);
  assert.match(
    migration,
    /grant execute on function public\.create_project_place_v1\(uuid,jsonb\)[\s\S]*?to authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.resolve_place_hierarchy_v1\(uuid,date,integer\)[\s\S]*?to authenticated, service_role/i,
  );
});

test("public place RPCs are invoker wrappers, not exposed definer functions", () => {
  for (const functionName of [
    "search_places_v1",
    "create_project_place_v1",
    "resolve_place_hierarchy_v1",
  ]) {
    const functionBlock = sqlFunction("public", functionName);
    assert.match(functionBlock, /security invoker/iu);
    assert.doesNotMatch(functionBlock, /security definer/iu);
  }

  assert.match(searchImplementation, /security definer/iu);
  assert.match(resolveImplementation, /security definer/iu);
});

test("bounded project deletion safely detaches same-project merge aliases", () => {
  assert.match(
    migration,
    /merged_into_place_id uuid references public\.places\(id\) on delete restrict/iu,
  );
  assert.match(
    migration,
    /prepare_historical_place_project_delete_v1[\s\S]*?current_setting\('app\.project_deletion', true\)[\s\S]*?update public\.places referencing_place[\s\S]*?status = 'archived',[\s\S]*?merged_into_place_id = null[\s\S]*?referencing_place\.project_id = old\.project_id[\s\S]*?referencing_place\.merged_into_place_id = old\.id/iu,
  );
  assert.match(
    migration,
    /create trigger places_05_prepare_project_delete[\s\S]*?before delete on public\.places/iu,
  );
});

test("versioned RPCs bound input and resolve time-aware hierarchies", () => {
  assert.match(searchRpc, /p_limit\s+integer\s+default\s+20/i);
  assert.match(searchRpc, /security_private\.search_places_v1\(\$1,\s*\$2,\s*\$3,\s*\$4\)/i);
  assert.match(
    searchImplementation,
    /least\(greatest\(coalesce\(p_limit,\s*20\),\s*1\),\s*50\)/i,
  );
  assert.match(searchImplementation, /char_length\(raw_query\)\s*>\s*200/i);
  assert.match(searchImplementation, /set statement_timeout\s*=\s*'5s'/i);

  assert.match(createRpc, /p_input\s+jsonb/i);
  assert.match(createRpc, /jsonb_typeof\(p_input\)\s*<>\s*'object'/i);
  assert.match(createRpc, /octet_length\(p_input::text\)/i);
  assert.match(createRpc, /names_input\s*:=\s*coalesce\(p_input\s*->\s*'names'/i);
  assert.match(createRpc, /jsonb_array_length\(names_input\)\s*>\s*50/i);
  assert.match(createRpc, /can_edit_project\(p_project_id\)/i);
  assert.match(createRpc, /between\s+-90\s+and\s+90/i);
  assert.match(createRpc, /between\s+-180\s+and\s+180/i);
  assert.match(createRpc, /set statement_timeout\s*=\s*'5s'/i);

  assert.match(resolveRpc, /p_at_date\s+date\s+default\s+null/i);
  assert.match(resolveRpc, /p_max_depth\s+integer\s+default\s+12/i);
  assert.match(
    resolveRpc,
    /security_private\.resolve_place_hierarchy_v1\(\$1,\s*\$2,\s*\$3\)/i,
  );
  assert.match(
    resolveImplementation,
    /least\(greatest\(coalesce\(p_max_depth,\s*12\),\s*1\),\s*32\)/i,
  );
  assert.match(resolveImplementation, /with recursive\s+hierarchy_walk/i);
  assert.match(
    resolveImplementation,
    /valid_from\s+is null\s+or[\s\S]*?valid_from\s*<=\s*p_at_date/i,
  );
  assert.match(
    resolveImplementation,
    /valid_to\s+is null\s+or[\s\S]*?valid_to\s*>=\s*p_at_date/i,
  );
  assert.match(resolveImplementation, /cycle_detected/i);
  assert.match(resolveImplementation, /ambiguous_detected/i);
  assert.match(resolveImplementation, /truncated_detected/i);
  assert.match(resolveImplementation, /set statement_timeout\s*=\s*'5s'/i);
});

test("the foundation needs no PostGIS and never auto-merges ambiguous matches", () => {
  assert.doesNotMatch(migration, /^\s*create extension[^;]*\bpostgis\b/im);
  assert.doesNotMatch(migration, /::\s*(?:geometry|geography)\b/i);
  assert.doesNotMatch(migration, /\bst_[a-z0-9_]+\s*\(/i);

  assert.match(migration, /merged_into_place_id\s+uuid/i);
  assert.match(migration, /'merge_places'/i);
  assert.match(resolveImplementation, /when ambiguous_detected then 'ambiguous'/i);
  assert.doesNotMatch(migration, /function\s+(?:public\.)?merge_places_v1\b/i);
  assert.doesNotMatch(
    createRpc,
    /(?:similarity\s*\(|merged_into_place_id|status\s*=\s*'merged'|place_change_requests)/i,
  );
});

test("read RPCs and anonymous grants do not expose private people or provenance", () => {
  const readRpcs = `${searchImplementation}\n${resolveImplementation}`;
  assert.doesNotMatch(
    readRpcs,
    /public\.(?:persons|person_names|person_timeline_events|family_tree_persons|zagulyaky_[a-z0-9_]+)\b/i,
  );
  assert.doesNotMatch(
    readRpcs,
    /jsonb_build_object\([\s\S]*?'(?:createdBy|created_by|sourceDocumentId|source_document_id|sourceFindingId|source_finding_id)'/i,
  );

  const anonPlaceGrant = migration.match(
    /grant select \([\s\S]*?\) on public\.places to anon;/i,
  )?.[0];
  const anonNameGrant = migration.match(
    /grant select \([\s\S]*?\) on public\.place_names to anon;/i,
  )?.[0];
  assert.ok(anonPlaceGrant, "Missing column-limited anonymous places grant");
  assert.ok(anonNameGrant, "Missing column-limited anonymous place_names grant");
  assert.doesNotMatch(anonPlaceGrant, /\b(?:project_id|created_by|metadata)\b/i);
  assert.doesNotMatch(
    anonNameGrant,
    /\b(?:project_id|created_by|source_document_id|source_finding_id|citation_id|metadata)\b/i,
  );
});

test("frontend exports the typed historical-place contract", () => {
  for (const typeName of [
    "PlaceScope",
    "PlaceStatus",
    "PlaceVerificationStatus",
    "PlaceNameType",
    "PlaceNameDatePrecision",
    "PlaceSummary",
    "PlaceName",
    "PlaceHierarchyNode",
    "PlaceHierarchyCandidate",
    "PlaceHierarchyResolution",
    "PlaceSearchInput",
    "CreateProjectPlaceInput",
    "ResolvePlaceHierarchyInput",
  ]) {
    assert.match(
      domainTypes,
      new RegExp(`export\\s+(?:type|interface)\\s+${typeName}\\b`),
    );
  }
  assert.match(domainTypes, /export type PlaceScope\s*=\s*"global"\s*\|\s*"project"/);
  assert.match(service, /export class HistoricalPlacesServiceError\s+extends Error/);
  assert.match(service, /export const searchHistoricalPlaces\s*=\s*searchPlaces/);
  assert.match(service, /export async function createProjectPlace\b/);
  assert.match(service, /export async function resolvePlaceHierarchy\b/);
});

test("frontend calls only the bounded versioned RPC contracts", () => {
  assert.match(
    service,
    /rpc\("search_places_v1",\s*\{[\s\S]*?p_query:\s*query,[\s\S]*?p_at_date:[\s\S]*?p_project_id:[\s\S]*?p_limit:\s*limit/s,
  );
  assert.match(
    service,
    /rpc\("create_project_place_v1",\s*\{[\s\S]*?p_project_id:\s*projectId,[\s\S]*?p_input:\s*legacyPayload/s,
  );
  assert.match(
    service,
    /rpc\("resolve_place_hierarchy_v1",\s*\{[\s\S]*?p_place_id:\s*placeId,[\s\S]*?p_at_date:\s*atDate,[\s\S]*?p_max_depth:\s*maxDepth/s,
  );
  assert.match(service, /HISTORICAL_PLACE_SEARCH_MAX_LIMIT\s*=\s*50/);
  assert.match(service, /HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH\s*=\s*32/);
  assert.doesNotMatch(service, /\.from\(\s*["']places["']\s*\)/);
});

test("new place fields never fall back to a lossy legacy write", () => {
  assert.match(service, /if \(createProjectPlaceRequiresV2\(input\)\)\s*\{\s*throw historicalPlacesMigrationRequired\("create"\)/u);
  assert.match(service, /patchKeys\.some\(\(key\) => !legacyKeys\.has\(key\)\)[\s\S]*?historicalPlacesMigrationRequired\("write"\)/u);
  assert.match(service, /"MIGRATION_REQUIRED"/u);
  assert.match(service, /Зміни не збережено, щоб не втратити нові поля/u);
});
