import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  mapProjectSearchResults,
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MAX_LIMIT,
  projectSearchResultLimit,
} from "../src/utils/projectSearchResults.ts";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130002_server_project_search.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/projectSearch.ts", import.meta.url),
  "utf8",
);

test("project search RPC is membership-scoped and bounded", () => {
  assert.match(
    migration,
    /create or replace function public\.search_project_records\(\s*target_project_id uuid,\s*search_query text,\s*result_limit integer default 40\s*\)/i,
  );
  assert.match(migration, /security invoker/i);
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(migration, /set search_path = pg_catalog, public, pg_temp/i);
  assert.match(migration, /not public\.is_project_member\(target_project_id\)/i);
  assert.match(migration, /char_length\(normalized_query\) < 3/i);
  assert.match(migration, /escaped_query text := replace/i);
  assert.match(migration, /escape '!'/i);
  assert.match(
    migration,
    /least\(greatest\(coalesce\(result_limit, 40\), 1\), 50\)/i,
  );
  assert.match(migration, /set statement_timeout = '5s'/i);
  assert.match(
    migration,
    /revoke execute on function public\.search_project_records\(uuid, text, integer\)\s+from public, anon/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.search_project_records\(uuid, text, integer\)\s+to authenticated/i,
  );
});

test("project search migration covers the key record tables with trigram indexes", () => {
  assert.match(migration, /create extension if not exists pg_trgm with schema extensions/i);
  for (const table of [
    "researches",
    "persons",
    "documents",
    "year_matrix",
    "tasks",
    "findings",
    "hypotheses",
    "archive_requests",
    "custom_records",
  ]) {
    assert.match(
      migration,
      new RegExp(`create index if not exists ${table}_project_search_trgm_idx`, "i"),
    );
  }
  assert.equal(
    [...migration.matchAll(/\.project_id = target_project_id/gi)].length >= 9,
    true,
  );
  assert.doesNotMatch(migration, /execute\s+format/i);
});

test("project search limit is clamped consistently with the RPC", () => {
  assert.equal(projectSearchResultLimit(0), 1);
  assert.equal(projectSearchResultLimit(14.9), 14);
  assert.equal(projectSearchResultLimit(500), PROJECT_SEARCH_MAX_LIMIT);
  assert.equal(projectSearchResultLimit(Number.NaN), PROJECT_SEARCH_DEFAULT_LIMIT);
});

test("project search service calls the bounded RPC and skips short queries", () => {
  assert.match(
    service,
    /normalizedQuery\.length < PROJECT_SEARCH_MIN_QUERY_LENGTH\) return \[\]/,
  );
  assert.match(service, /"search_project_records"/);
  assert.match(service, /target_project_id: projectId/);
  assert.match(service, /search_query: normalizedQuery/);
  assert.match(service, /result_limit: projectSearchResultLimit\(limit\)/);
});

test("project search response mapper keeps compact standard and custom hits", () => {
  assert.deepEqual(mapProjectSearchResults([
    {
      id: "person-1",
      entityId: "person-1",
      module: "persons",
      page: "persons",
      moduleLabel: "Особи",
      title: "Лариса Рачкай",
      description: "1944–2010",
    },
    {
      id: "record-1",
      module: "custom:section-1",
      page: "custom:section-1",
      moduleLabel: "Свідчення",
      title: "Спогад",
      description: "Текст",
    },
    {
      id: "ignored",
      page: "unsupported",
      title: "Unsupported record",
    },
  ]), [
    {
      id: "person-1",
      entityId: "person-1",
      module: "persons",
      page: "persons",
      moduleLabel: "Особи",
      title: "Лариса Рачкай",
      description: "1944–2010",
    },
    {
      id: "record-1",
      entityId: "record-1",
      module: "custom:section-1",
      page: "custom:section-1",
      moduleLabel: "Свідчення",
      title: "Спогад",
      description: "Текст",
    },
  ]);
  assert.deepEqual(mapProjectSearchResults({}), []);
});
