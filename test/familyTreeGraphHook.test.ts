import test from "node:test";
import assert from "node:assert/strict";
import { familyTreeGraphQueryKey } from "../src/hooks/useFamilyTreeGraph.ts";
import type { FamilyTreeGraphQuery } from "../src/types/familyTree.ts";

test("family tree graph cache key is stable for the same tree view", () => {
  const query: FamilyTreeGraphQuery = {
    projectId: "project",
    treeId: "tree",
    rootPersonId: "root",
    mode: "family",
    maxDepth: 4,
    maxDepthUp: 4,
    maxDepthDown: 4,
    includeAssociations: false,
    includeDisproven: true,
    includePrivateLiving: true,
    problemsMode: true,
  };

  assert.equal(familyTreeGraphQueryKey(query), familyTreeGraphQueryKey({ ...query }));
});

test("family tree graph cache key separates root person and mode", () => {
  const base: FamilyTreeGraphQuery = {
    projectId: "project",
    treeId: "tree",
    rootPersonId: "root",
    mode: "family",
  };

  assert.notEqual(familyTreeGraphQueryKey(base), familyTreeGraphQueryKey({ ...base, rootPersonId: "other" }));
  assert.notEqual(familyTreeGraphQueryKey(base), familyTreeGraphQueryKey({ ...base, mode: "ancestors" }));
});
