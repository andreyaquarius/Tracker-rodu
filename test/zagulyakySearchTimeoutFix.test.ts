import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/202609070001_zagulyaky_search_timeout_fix.sql", import.meta.url,
), "utf8");

test("search facades evaluate one materialized payload and retain indexed privacy rechecks", () => {
  for (const kind of ["people", "documents"]) {
    const start = migration.indexOf("create or replace function security_private.search_zagulyaky_" + kind + "_v1(");
    assert.ok(start >= 0);
    const definition = migration.slice(start, migration.indexOf("$function$;", start));
    assert.match(definition, /with source as materialized/i);
    assert.equal((definition.match(/select security_private\.search_zagulyaky_v1/g) ?? []).length, 1);
    assert.match(definition, /record_row\.id = \(item\.value ->> 'id'\)::uuid/);
    assert.match(definition, /zagulyaky_has_living_person_clearance_v1/);
    assert.doesNotMatch(definition, /record_row\.id::text/);
  }
});

test("search permits predicate pushdown instead of materializing the entire eligible catalogue", () => {
  assert.match(migration, /eligible_rows as not materialized/i);
  assert.doesNotMatch(migration, /eligible_rows as materialized|join public\.zagulyaky_records r on r\.id = eligible\.id/i);
  assert.match(migration, /matching_rows as materialized/i);
  assert.equal((migration.match(/limit safe_limit \+ 1/g) ?? []).length, 9);
  assert.equal((migration.match(/r\.status = 'published'/g) ?? []).length, 2);
  assert.equal((migration.match(/r\.privacy_status = 'cleared'/g) ?? []).length, 2);
  assert.equal((migration.match(/zagulyaky_has_living_person_clearance_v1\(r\.id\)/g) ?? []).length, 2);
  assert.match(migration, /where r\.id = any\(page_ids\)/);
  assert.match(migration, /set statement_timeout = '5s'/);
  assert.doesNotMatch(migration, /set statement_timeout = '(?:0|[1-9]\d+s)'/);
  assert.doesNotMatch(migration, /select r\.\*|r\.payload|r\.original_text/);
});

test("optional filters and deep cursor pages are indexable", () => {
  assert.match(migration, /on public\.zagulyaky_participants \(event_role_code, record_id\)/);
  assert.match(migration, /zagulyaky_sources_archive_filter_trgm_idx/);
  assert.doesNotMatch(migration, /zagulyaky_matches_catalog_related_filters_v1\(r\.id/);
  assert.equal((migration.match(/\(r\.published_at, r\.id\) < \(p_cursor_published_at, p_cursor_id\)/g) ?? []).length, 2);
  assert.match(migration, /r\.origin_geo is not null\s+and security_private\.zagulyaky_public_place_key_v1/);
  assert.match(migration, /r\.found_geo is not null\s+and security_private\.zagulyaky_public_place_key_v1/);
});

test("hotfix preserves the established RPC ACL and does not modify catalogue data", () => {
  assert.match(migration, /revoke all on function security_private\.search_zagulyaky_v1[\s\S]*?from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function security_private\.search_zagulyaky_v1[\s\S]*?to service_role;/);
  assert.match(migration, /grant execute on function security_private\.search_zagulyaky_people_v1[\s\S]*?to anon, authenticated, service_role;/);
  assert.doesNotMatch(migration, /create or replace function public\.|grant .* on (?:table|all tables)|delete from|truncate |update public\.|insert into public\./i);
  assert.match(migration, /set local lock_timeout = '5s'/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});
