import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608270002_zagulyaky_public_detail_query_optimization.sql",
    import.meta.url,
  ),
  "utf8",
);

test("public Zagulyaka detail materializes its canonical payload exactly once", () => {
  assert.match(
    migration,
    /to_regprocedure\(\s*'security_private\.get_public_zagulyaka_api_v1\(text\)'\s*\)/i,
  );
  assert.match(migration, /ZAGULYAKA_PUBLIC_DETAIL_IMPLEMENTATION_NOT_FOUND/i);
  assert.match(
    migration,
    /create or replace function security_private\.get_public_zagulyaka_api_v1\(p_slug text\)/i,
  );
  assert.match(migration, /language sql[\s\S]*?stable[\s\S]*?security definer/i);
  assert.match(
    migration,
    /set search_path = pg_catalog, public, security_private, pg_temp/i,
  );
  assert.match(
    migration,
    /returns jsonb[\s\S]*?when source\.payload is null then null/i,
  );
  assert.match(
    migration,
    /with source as materialized\s*\(\s*select security_private\.get_public_zagulyaka_v1\(\$1\) as payload\s*\)/i,
  );
  assert.equal(
    migration.match(/security_private\.get_public_zagulyaka_v1\(\$1\)/gi)?.length,
    1,
  );
  assert.doesNotMatch(migration, /create or replace function public\.get_public_zagulyaka_v1/i);
});

test("record lookups preserve the UUID primary-key side of each comparison", () => {
  const indexedUuidLookups = migration.match(
    /record_row\.id\s*=\s*\(source\.payload\s*->>\s*'id'\)::uuid/gi,
  ) ?? [];

  assert.equal(indexedUuidLookups.length, 2);
  assert.doesNotMatch(migration, /record_row\.id::text/i);
});

test("optimized detail keeps privacy, attachment, origin and map projections", () => {
  assert.match(migration, /zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/i);
  assert.match(migration, /'\{publicAttachments\}'/i);
  assert.doesNotMatch(
    migration,
    /'(?:bucket|path|publicBucket|publicPath|public_bucket|public_path)'/i,
  );
  assert.match(migration, /zagulyaky_public_facebook_origin_v1/i);
  assert.match(migration, /'originGeo', record_row\.origin_geo/i);
  assert.match(migration, /'foundGeo', record_row\.found_geo/i);
});

test("optimized private implementation retains the established catalogue ACL", () => {
  assert.match(
    migration,
    /revoke all on function security_private\.get_public_zagulyaka_api_v1\(text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.get_public_zagulyaka_api_v1\(text\)\s+to anon, authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function security_private\.get_public_zagulyaka_api_v1\(text\)\s+to public/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
});
