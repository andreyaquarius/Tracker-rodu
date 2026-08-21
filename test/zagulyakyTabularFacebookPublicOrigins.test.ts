import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608200009_zagulyaky_tabular_facebook_public_origins.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(marker: string): string {
  const start = migration.indexOf(marker);
  const end = migration.indexOf("$function$;", start);
  assert.ok(start >= 0, `${marker} must be present`);
  assert.ok(end > start, `${marker} must have a complete body`);
  return migration.slice(start, end + "$function$;".length);
}

test("tabular Facebook provenance is private by default and explicitly approved in bounded batches", () => {
  assert.match(migration, /create table if not exists public\.zagulyaky_tabular_import_record_origins/i);
  assert.match(migration, /public_link_status text not null default 'private'/i);
  assert.match(migration, /check \(public_link_status in \('private', 'approved', 'revoked'\)\)/i);
  assert.match(
    migration,
    /and security_private\.zagulyaky_is_facebook_post_url_v1\(facebook_post_url_private\)/i,
  );
  assert.match(migration, /alter table public\.zagulyaky_tabular_import_record_origins enable row level security/i);
  assert.match(migration, /revoke all on table public\.zagulyaky_tabular_import_record_origins from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.zagulyaky_tabular_import_record_origins to service_role/i);

  const capture = functionBody(
    "create or replace function security_private.capture_zagulyaky_tabular_record_origin_v1()",
  );
  assert.match(capture, /on conflict \(record_id\) do nothing/i);
  assert.match(capture, /zagulyaky_is_facebook_post_url_v1\(post_row\.facebook_post_url_private\)/i);
  assert.doesNotMatch(capture, /zagulyaky_sources/i);
  assert.doesNotMatch(capture, /zagulyaky_record_sources/i);

  const visibility = functionBody(
    "create or replace function security_private.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(",
  );
  assert.match(visibility, /requested_count not between 1 and 250/i);
  assert.match(visibility, /has_admin_permission_v1\('zagulyaky\.moderate'\)/i);
  assert.match(visibility, /if not security_private\.zagulyaky_is_facebook_post_url_v1\(origin_row\.facebook_post_url_private\)/i);
  assert.ok(
    visibility.indexOf("from public.zagulyaky_records record_row")
      < visibility.indexOf("from public.zagulyaky_tabular_import_record_origins origin"),
    "the visibility switch must lock catalogue records before private origin maps",
  );
  assert.match(visibility, /'social_post'/i);
  assert.match(visibility, /'link_only'/i);
  assert.match(visibility, /missingOriginCount/i);
  assert.match(visibility, /nonFacebookOriginCount/i);
  assert.doesNotMatch(visibility, /return .*facebook_post_url_private/is);
});

test("public detail receives a single named Facebook URL projection, while public search remains untouched", () => {
  const publicDetail = functionBody(
    "create or replace function public.get_public_zagulyaka_v1(p_slug text)",
  );
  assert.match(publicDetail, /security_private\.zagulyaky_public_facebook_origin_v1/i);
  assert.match(publicDetail, /zagulyaky_has_living_person_clearance_v1/i);

  const projection = functionBody(
    "create or replace function security_private.zagulyaky_public_facebook_origin_v1(",
  );
  assert.match(projection, /jsonb_build_object\('originalPostUrl', origin_row\.facebook_post_url_private\)/i);
  assert.match(projection, /origin_row\.public_link_status = 'approved'/i);
  assert.match(projection, /record_row\.status = 'published'/i);
  assert.match(projection, /record_row\.privacy_status = 'cleared'/i);
  assert.match(projection, /source_row\.source_url = origin_row\.facebook_post_url_private/i);
  assert.match(projection, /zagulyaky_is_facebook_post_url_v1\(origin_row\.facebook_post_url_private\)/i);

  assert.doesNotMatch(migration, /create or replace function security_private\.search_zagulyaky_v1/i);
  assert.doesNotMatch(migration, /create or replace function public\.search_zagulyaky_(?:people|documents)_v1/i);
});
