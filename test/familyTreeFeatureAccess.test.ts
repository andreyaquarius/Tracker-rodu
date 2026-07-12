import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  filterFamilyTreeAccessCandidates,
  matchesFamilyTreeAccessSearch,
  resolveFamilyTreeFeatureAccess,
} from "../src/utils/familyTreeFeatureAccess.ts";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607120002_family_tree_feature_access.sql",
    import.meta.url,
  ),
  "utf8",
);

test("app administrator always keeps family-tree access during entitlement rollout", () => {
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

test("non-admin family-tree access is fail-closed", () => {
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

test("family-tree feature migration enforces allow-list on tables and definer RPCs", () => {
  assert.match(migration, /create table if not exists public\.family_tree_feature_access/i);
  assert.match(migration, /public\.is_app_admin\(auth\.uid\(\)\)/i);
  assert.match(migration, /as restrictive for all to authenticated/i);
  assert.match(migration, /legacy_person_relation_graph_edges/i);
  assert.match(migration, /perform public\.assert_family_tree_feature_access\(\)/i);
  assert.match(
    migration,
    /revoke execute on function public\.get_family_tree_neighborhood_v1_feature_impl\(jsonb\)[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(migration, /admin_set_family_tree_feature_access/i);
  assert.match(migration, /FAMILY_TREE_FEATURE_ACCESS_REQUIRED/i);
});
