import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  filterFamilyTreeAccessCandidates,
  matchesFamilyTreeAccessSearch,
  resolveFamilyTreeFeatureAccess,
} from "../src/utils/familyTreeFeatureAccess.ts";

const rolloutMigration = readFileSync(
  new URL(
    "../supabase/migrations/202607120002_family_tree_feature_access.sql",
    import.meta.url,
  ),
  "utf8",
);
const planMigration = readFileSync(
  new URL(
    "../supabase/migrations/202607200001_tree_centered_subscription_limits.sql",
    import.meta.url,
  ),
  "utf8",
);

test("app administrator keeps family-tree access while the server result loads", () => {
  assert.equal(resolveFamilyTreeFeatureAccess({
    isAppAdmin: true,
    serverAllowed: false,
    serverLoading: true,
  }), true);
  assert.equal(resolveFamilyTreeFeatureAccess({
    isAppAdmin: true,
    serverAllowed: false,
    serverLoading: false,
  }), true);
});

test("non-admin family-tree access waits for the authenticated server result", () => {
  assert.equal(resolveFamilyTreeFeatureAccess({
    isAppAdmin: false,
    serverAllowed: true,
    serverLoading: true,
  }), false);
  assert.equal(resolveFamilyTreeFeatureAccess({
    isAppAdmin: false,
    serverAllowed: false,
    serverLoading: false,
  }), false);
  assert.equal(resolveFamilyTreeFeatureAccess({
    isAppAdmin: false,
    serverAllowed: true,
    serverLoading: false,
  }), true);
});

test("family-tree tester search matches Ukrainian names and email tokens", () => {
  const user = {
    displayName: "Олена Каленська",
    email: "Olena.Kalenska@example.com",
  };

  assert.equal(matchesFamilyTreeAccessSearch(user, "  оЛЕНа кален  "), true);
  assert.equal(matchesFamilyTreeAccessSearch(user, "kalenska@EXAMPLE"), true);
  assert.equal(matchesFamilyTreeAccessSearch(user, "Андрій"), false);
});

test("family-tree tester search returns only users who can be granted access", () => {
  const candidates = filterFamilyTreeAccessCandidates([
    {
      userId: "available",
      displayName: "Марія Коваль",
      email: "maria@example.com",
      isAdmin: false,
      isEnabled: false,
    },
    {
      userId: "enabled",
      displayName: "Марія Іваненко",
      email: "enabled@example.com",
      isAdmin: false,
      isEnabled: true,
    },
    {
      userId: "admin",
      displayName: "Марія Адміністратор",
      email: "admin@example.com",
      isAdmin: true,
      isEnabled: true,
    },
  ], "марія");

  assert.deepEqual(candidates.map((candidate) => candidate.userId), ["available"]);
  assert.deepEqual(filterFamilyTreeAccessCandidates(candidates, "   "), []);
});

test("tree-centred plans retain RPC isolation but replace beta entitlement with authenticated access", () => {
  assert.match(rolloutMigration, /create table if not exists public\.family_tree_feature_access/i);
  assert.match(rolloutMigration, /as restrictive for all to authenticated/i);
  assert.match(rolloutMigration, /legacy_person_relation_graph_edges/i);
  assert.match(rolloutMigration, /perform public\.assert_family_tree_feature_access\(\)/i);
  assert.match(
    rolloutMigration,
    /revoke execute on function public\.get_family_tree_neighborhood_v1_feature_impl\(jsonb\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    planMigration,
    /create or replace function security_private\.can_use_family_tree_feature\(\)[\s\S]*select auth\.uid\(\) is not null/i,
  );
  assert.match(planMigration, /Family tree and Persons V2 are core plan features/i);
});
