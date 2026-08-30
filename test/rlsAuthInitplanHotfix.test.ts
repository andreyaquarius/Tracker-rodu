import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608300003_rls_auth_initplan_hotfix.sql",
    import.meta.url,
  ),
  "utf8",
);

const policyStatement = (policyName: string) => {
  const statementStart = migration.indexOf(`alter policy ${policyName}`);
  assert.notEqual(statementStart, -1, `missing ALTER POLICY for ${policyName}`);

  const statementEnd = migration.indexOf(";", statementStart);
  assert.notEqual(statementEnd, -1, `unterminated ALTER POLICY for ${policyName}`);

  const nextPolicyStart = migration.indexOf("alter policy ", statementStart + 1);
  assert.ok(
    nextPolicyStart === -1 || statementEnd < nextPolicyStart,
    `ALTER POLICY for ${policyName} crosses into the next policy`,
  );

  return migration.slice(statementStart, statementEnd + 1);
};

test("RLS initplan hotfix wraps every targeted auth.uid call in a scalar select", () => {
  const savedPlaces = policyStatement("zagulyaky_saved_places_owner_only");
  const savedSourcePresets = policyStatement(
    "zagulyaky_saved_source_presets_owner_only",
  );
  const placeChangeRequests = policyStatement(
    "place_change_requests_project_submit",
  );

  assert.match(savedPlaces, /\bon public\.zagulyaky_saved_places\b/u);
  assert.match(savedPlaces, /using \(owner_id = \(select auth\.uid\(\)\)\)/u);
  assert.match(
    savedPlaces,
    /with check \(owner_id = \(select auth\.uid\(\)\)\);$/u,
  );

  assert.match(
    savedSourcePresets,
    /\bon public\.zagulyaky_saved_source_presets\b/u,
  );
  assert.match(
    savedSourcePresets,
    /using \(owner_id = \(select auth\.uid\(\)\)\)/u,
  );
  assert.match(
    savedSourcePresets,
    /with check \(owner_id = \(select auth\.uid\(\)\)\);$/u,
  );

  assert.match(placeChangeRequests, /\bon public\.place_change_requests\b/u);
  assert.match(
    placeChangeRequests,
    /with check \(\s*public\.can_edit_project\(project_id\)\s+and created_by = \(select auth\.uid\(\)\)\s+and status = 'submitted'\s+and reviewed_by is null\s+and reviewed_at is null\s*\);$/u,
  );

  assert.equal((migration.match(/\balter policy\b/gu) ?? []).length, 3);
  assert.doesNotMatch(migration, /=\s*auth\.uid\(\)/u);
});

test("RLS initplan hotfix changes no indexes or unrelated table policies", () => {
  assert.doesNotMatch(migration, /\b(?:create|drop|alter)\s+(?:unique\s+)?index\b/iu);
  assert.doesNotMatch(migration, /\b(?:documents|task_notifications)\b/u);
  assert.doesNotMatch(migration, /\bdrop\s+policy\b/iu);
});
