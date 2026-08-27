import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202608270004_zagulyaky_search_and_my_records_performance.sql",
  import.meta.url,
);

function migrationSource(): string {
  assert.equal(
    existsSync(migrationUrl),
    true,
    "the catalogue/My records performance migration must be committed",
  );
  return readFileSync(migrationUrl, "utf8");
}

function functionDefinition(source: string, qualifiedName: string): string {
  const start = source.search(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${qualifiedName.replaceAll(".", "\\.")}\\s*\\(`,
    "i",
  ));
  assert.notEqual(start, -1, `${qualifiedName} must be redefined by the performance migration`);
  const end = source.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${qualifiedName} must use a bounded dollar-quoted definition`);
  return source.slice(start, end + "$function$;".length);
}

test("blank public Zagulyaky searches use a dedicated feed-index fast path", () => {
  const definition = functionDefinition(
    migrationSource(),
    "security_private.search_zagulyaky_v1",
  );

  assert.match(definition, /set statement_timeout = '5s'/i);
  assert.match(definition, /normalized_query\s+text\s*:=\s*nullif\(btrim\(coalesce\(p_query,\s*''\)\),\s*''\)/i);
  assert.match(definition, /if normalized_query is null then/i);

  const blankStart = definition.search(/if normalized_query is null then/i);
  const nonBlankStart = definition.search(/\belse\b/i);
  assert.ok(nonBlankStart > blankStart, "the nonblank search path follows the blank feed path");
  const blankPath = definition.slice(blankStart, nonBlankStart);
  const nonBlankPath = definition.slice(nonBlankStart);

  assert.doesNotMatch(blankPath, /\blike\b|websearch_to_tsquery|zagulyaky_participants|zagulyaky_record_sources|zagulyaky_document_discoveries/i);
  assert.match(nonBlankPath, /websearch_to_tsquery/i);
  assert.match(nonBlankPath, /zagulyaky_participants/i);
  assert.match(nonBlankPath, /zagulyaky_record_sources/i);
  assert.match(nonBlankPath, /zagulyaky_document_discoveries/i);
});

test("public search limits narrow record candidates before list-card enrichment", () => {
  const definition = functionDefinition(
    migrationSource(),
    "security_private.search_zagulyaky_v1",
  );

  assert.doesNotMatch(definition, /select\s+r\.\*/i);
  assert.match(definition, /r\.id[\s\S]*?r\.published_at[\s\S]*?order by r\.published_at desc, r\.id desc[\s\S]*?limit safe_limit \+ 1/i);

  const firstLimit = definition.search(/limit safe_limit \+ 1/i);
  const firstEnrichment = definition.search(/jsonb_build_object\(\s*'originalFullName'/i);
  assert.ok(firstLimit >= 0 && firstEnrichment > firstLimit, "participants and source cards are projected only after the bounded candidate page");

  assert.match(definition, /r\.status = 'published'/i);
  assert.match(definition, /r\.privacy_status = 'cleared'/i);
  assert.match(definition, /not r\.possible_living_person[\s\S]*?zagulyaky_has_living_person_clearance_v1\(r\.id\)/i);
  assert.match(definition, /originPlaceKey/i);
  assert.match(definition, /foundPlaceKey/i);
  assert.match(definition, /eventRole/i);
  assert.match(definition, /'items'/i);
  assert.match(definition, /'nextCursor'/i);
});

test("explicit text search never falls back to a full TOAST body substring scan", () => {
  const migration = migrationSource();
  const definition = functionDefinition(
    migration,
    "security_private.search_zagulyaky_v1",
  );

  assert.match(definition, /r\.search_vector\s*@@\s*websearch_to_tsquery/i);
  assert.doesNotMatch(
    definition,
    /lower\([\s\S]{0,500}coalesce\(r\.(?:original_text|normalized_text),[\s\S]{0,500}\)\s+like/i,
  );
  assert.match(migration, /zagulyaky_records_catalog_metadata_trgm_idx/i);
  assert.match(migration, /zagulyaky_participants_catalog_search_trgm_idx/i);
  assert.match(migration, /zagulyaky_sources_catalog_search_trgm_idx/i);
  assert.match(migration, /zagulyaky_document_discoveries_catalog_search_trgm_idx/i);
});

test("My records pagination has matching owner indexes and projects summaries only", () => {
  const migration = migrationSource();
  const definition = functionDefinition(
    migration,
    "security_private.get_my_zagulyaky_page_v1",
  );

  assert.match(
    migration,
    /create index if not exists\s+\w+\s+on public\.zagulyaky_records\s*\(created_by,\s*updated_at desc,\s*id desc\)/i,
  );
  assert.match(
    migration,
    /create index if not exists\s+\w+\s+on public\.zagulyaky_records\s*\(created_by,\s*status,\s*updated_at desc,\s*id desc\)/i,
  );
  assert.match(definition, /set statement_timeout = '5s'/i);
  assert.match(definition, /where r\.created_by = current_user_id/i);
  assert.match(definition, /order by r\.updated_at desc, r\.id desc[\s\S]*?limit safe_limit[\s\S]*?offset safe_offset/i);
  assert.doesNotMatch(definition, /select\s+r\.\*/i);
  assert.doesNotMatch(definition, /to_jsonb\(r\)/i);
  assert.match(definition, /jsonb_build_object\([\s\S]*?'id',\s*r\.id[\s\S]*?'kind',\s*r\.kind[\s\S]*?'title',\s*r\.title/i);
  assert.match(definition, /'total'/i);
  assert.match(definition, /'overallTotal'/i);
  assert.match(definition, /'statusCounts'/i);
});
