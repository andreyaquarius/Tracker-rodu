import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608200011_zagulyaky_historical_submission_without_acknowledgements.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(schema: "security_private" | "public", functionName: string): string {
  const marker = `create or replace function ${schema}.${functionName}`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `${schema}.${functionName} must exist`);
  const end = migration.indexOf("$function$;", start);
  assert.ok(end > start, `${schema}.${functionName} must have a complete body`);
  return migration.slice(start, end + "$function$;".length);
}

test("historical manual submissions no longer require a rights acknowledgement", () => {
  const submit = functionBody("public", "submit_zagulyaka_v1");

  assert.match(submit, /security definer[\s\S]*set search_path = pg_catalog, public, security_private, pg_temp/i);
  assert.match(submit, /existing\.created_by is distinct from current_user_id/i);
  assert.match(submit, /ZAGULYAKA_SOURCE_REQUIRED/i);
  assert.doesNotMatch(submit, /ZAGULYAKA_RIGHTS_CONFIRMATION_REQUIRED/i);
  assert.doesNotMatch(submit, /submission_terms_version is null|rights_confirmed_at is null/i);
  assert.match(submit, /status = 'pending_review'/i);
  assert.match(submit, /when possible_living_person then 'requires_consent'/i);
  assert.doesNotMatch(submit, /status = 'published'/i);
});
