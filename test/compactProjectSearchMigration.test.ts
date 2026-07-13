import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130014_compact_project_search.sql",
    import.meta.url,
  ),
  "utf8",
);

const compactHelper = migration.match(
  /create or replace function public\.project_search_custom_field_text\(fields jsonb\)([\s\S]*?)\$function\$;/i,
)?.[1] ?? "";

test("compact project search excludes bulky technical GEDCOM and attachment payloads", () => {
  assert.match(compactHelper, /immutable/i);
  assert.match(compactHelper, /parallel safe/i);
  assert.match(compactHelper, /set search_path = pg_catalog, pg_temp/i);
  assert.match(compactHelper, /jsonb_each_text/i);
  assert.match(compactHelper, /left\(entry\.field_key, 2\) <> '__'/i);

  for (const usefulInternalField of [
    "__trackerRoduMaidenSurname",
    "__trackerRoduPersonEvents",
    "__gedcomXref",
    "__gedcomNationality",
    "__gedcomEducation",
    "__gedcomEventRawType",
    "__gedcomArchiveActRecord",
  ]) {
    assert.match(compactHelper, new RegExp(usefulInternalField));
  }

  for (const bulkyTechnicalField of [
    "__gedcomRawRecord",
    "__gedcomCitation",
    "__gedcomCitations",
    "__gedcomMedia",
    "__gedcomSource",
    "__trackerRoduPersonScans",
    "__trackerRoduFindingMeta",
    "__trackerRoduDocumentScans",
  ]) {
    assert.doesNotMatch(compactHelper, new RegExp(`'${bulkyTechnicalField}'`));
  }
});

test("all structured project-search indexes are rebuilt from the compact expression", () => {
  for (const table of [
    "researches",
    "persons",
    "documents",
    "year_matrix",
    "tasks",
    "findings",
    "hypotheses",
    "archive_requests",
  ]) {
    assert.match(
      migration,
      new RegExp(`drop index if exists public\\.${table}_project_search_trgm_idx`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`create index ${table}_project_search_trgm_idx[\\s\\S]*?project_search_custom_field_text\\(custom_fields\\)`, "i"),
    );
  }

  assert.match(
    migration,
    /create index custom_records_project_search_trgm_idx[\s\S]*?title \|\| ' ' \|\| values::text/i,
  );
});

test("the deployed search RPC is migrated to the same compact expressions", () => {
  for (const alias of [
    "research",
    "person",
    "document",
    "matrix",
    "task",
    "finding",
    "hypothesis",
    "request",
  ]) {
    assert.match(migration, new RegExp(`'${alias}'`));
  }
  assert.match(
    migration,
    /new_fragment := 'public\.project_search_custom_field_text\('/i,
  );
  assert.match(
    migration,
    /raise exception 'Unconverted custom_fields expression remains in search RPC'/i,
  );
  assert.doesNotMatch(migration, /execute\s+format/i);
});

test("compact index replacement fails quickly and rolls back atomically on contention", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /set local lock_timeout = '10s'/i);
  assert.match(migration, /set local statement_timeout = '15min'/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(
    migration,
    /revoke execute on function public\.project_search_custom_field_text\(jsonb\)[\s\S]*?from public, anon/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.project_search_custom_field_text\(jsonb\)[\s\S]*?to authenticated, service_role/i,
  );
});
