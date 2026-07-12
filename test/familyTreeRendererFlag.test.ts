import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseProductionFamilyTreeRenderer } from "../src/utils/familyTreeRendererFlag.ts";

test("family-tree v2 rollout fails closed until the server explicitly enables it", () => {
  assert.equal(shouldUseProductionFamilyTreeRenderer({}), false);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: false }), false);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ unrelated_flag: true }), false);
  assert.equal(shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: true }), true);
});

test("family-tree v2 is always available in the local Vite development server", () => {
  assert.equal(shouldUseProductionFamilyTreeRenderer({}, true), true);
  assert.equal(
    shouldUseProductionFamilyTreeRenderer({ family_tree_renderer_v2: false }, true),
    true,
  );
});
