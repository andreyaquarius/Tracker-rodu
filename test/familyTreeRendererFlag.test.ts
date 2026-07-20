import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseProductionFamilyTreeRenderer } from "../src/utils/familyTreeRendererFlag.ts";

test("family-tree v2 is a core renderer and no longer depends on a rollout flag", () => {
  assert.equal(shouldUseProductionFamilyTreeRenderer({}), true);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: false }), true);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ unrelated_flag: true }), true);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: true }), true);
});

test("family-tree v2 is always available in the local Vite development server", () => {
  assert.equal(shouldUseProductionFamilyTreeRenderer({}, true), true);
  assert.equal(
    shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: false }, true),
    true,
  );
});
