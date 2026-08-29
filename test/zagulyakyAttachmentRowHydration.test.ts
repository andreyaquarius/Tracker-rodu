import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290004_zagulyaky_attachment_row_assignment_fix.sql",
    import.meta.url,
  ),
  "utf8",
);

const affectedFunctions = [
  "admin_get_zagulyaka_attachment_review_v1",
  "admin_prepare_zagulyaka_attachment_publication_v1",
  "admin_complete_zagulyaka_attachment_publication_v1",
  "admin_revoke_zagulyaka_attachment_publication_v1",
  "admin_prepare_zagulyaka_attachment_publication_v2",
  "admin_complete_zagulyaka_attachment_publication_v2",
  "admin_revoke_zagulyaka_attachment_publication_v2",
] as const;

test("attachment hotfix redefines every affected private workflow", () => {
  for (const functionName of affectedFunctions) {
    assert.match(
      migration,
      new RegExp(`create or replace function security_private\\.${functionName}\\(`, "i"),
      `missing corrected definition for ${functionName}`,
    );
  }
});

test("typed attachment and record rows are hydrated from expanded whole rows", () => {
  assert.equal(
    migration.match(/select a\.\* into attachment/gi)?.length,
    affectedFunctions.length,
    "every attachment row assignment must expand the table alias",
  );
  assert.equal(
    migration.match(/select r\.\* into target_record/gi)?.length,
    affectedFunctions.length,
    "every parent record row assignment must expand the table alias",
  );
  assert.doesNotMatch(migration, /select a\s+into attachment/i);
  assert.doesNotMatch(migration, /select r\s+into target_record/i);
  assert.doesNotMatch(migration, /select a,\s*r\s+into attachment,\s*target_record/i);
});

test("hotfix keeps the hardened private execution contract", () => {
  assert.equal(migration.match(/security definer/gi)?.length, affectedFunctions.length);
  assert.equal(
    migration.match(/set search_path = pg_catalog, public, security_private(?:, storage)?, pg_temp/gi)?.length,
    affectedFunctions.length,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\./i,
    "public wrappers and their ACLs must remain untouched",
  );
});
