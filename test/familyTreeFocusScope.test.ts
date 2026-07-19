import assert from "node:assert/strict";
import test from "node:test";
import { scopedFamilyTreeFocusPersonId } from "../src/utils/familyTreeFocusHistory.ts";

test("tree-scoped focus is null-safe before an entry point is loaded", () => {
  assert.equal(scopedFamilyTreeFocusPersonId(null, null), "");
  assert.equal(scopedFamilyTreeFocusPersonId(null, "tree-1"), "");
});

test("tree-scoped focus is returned only for the selected tree", () => {
  const focus = { treeId: "tree-1", centralPersonId: "person-1" };
  assert.equal(scopedFamilyTreeFocusPersonId(focus, "tree-2"), "");
  assert.equal(scopedFamilyTreeFocusPersonId(focus, "tree-1"), "person-1");
});
