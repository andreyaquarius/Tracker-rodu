import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608120001_large_direct_ancestor_lineage.sql",
    import.meta.url,
  ),
  "utf8",
);
const productionTree = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);

test("large structural ancestry has a separate rendering and catalogue contract", () => {
  assert.match(migration, /old_limit constant text[\s\S]*?600\), 600/);
  assert.match(migration, /new_limit constant text[\s\S]*?2400\), 2400/);
  assert.match(migration, /ROOT_LINEAGE_LIMIT_CONTRACT_CHANGED/);
  assert.match(migration, /list_family_tree_direct_ancestor_order_v1/);
  assert.match(migration, /select count\(\*\)::integer[\s\S]*?into max_unique_people[\s\S]*?family_tree_persons/);
  assert.match(migration, /perform public\.assert_family_tree_feature_access\(\)/);
  assert.match(migration, /public\.is_project_member\(current_project_id\)/);
  assert.match(migration, /member_role <> 'hidden'/);
  assert.match(migration, /evidence_status <> 'disproven'/);
  assert.match(migration, /privacy_status <> 'confidential'/);
  assert.match(migration, /is_default_for_pedigree desc/);
  assert.match(migration, /is_primary_for_display/);
  assert.match(migration, /is_preferred_for_display desc/);
  assert.match(migration, /security_private\.list_family_tree_direct_ancestor_order_v1/);
  assert.match(migration, /security invoker/);
});

test("direct-pedigree mode lays out the loaded structural graph without mounting it all", () => {
  assert.match(
    productionTree,
    /const STRUCTURAL_ANCESTOR_MAX_NODES = MAX_CIRCULAR_ANCESTOR_OCCURRENCES/,
  );
  assert.match(
    productionTree,
    /const maxNodes = directAncestorMode \? STRUCTURAL_ANCESTOR_MAX_NODES : 400/,
  );
  assert.match(
    productionTree,
    /maxNodes,[\s\S]*?structuralOnly: directAncestorMode,[\s\S]*?sessionKey: directAncestorMode/,
  );
  assert.match(
    productionTree,
    /perspective\.kind === "all-descendants" \|\| directAncestorMode[\s\S]*?displayedGraph\.persons\.length/,
  );
  assert.match(productionTree, /maxVisibleNodes: logicalSceneNodeBudget/);
});
