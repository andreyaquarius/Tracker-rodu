import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendFamilyCorridorTrailItem,
  capturePedigreeReturnSnapshot,
  familyTreePerspectiveKey,
  isSpecialFamilyTreePerspective,
  keepFamilyCorridorTrailThrough,
  specialPerspectiveReturnSnapshot,
  type FamilyCorridorTrailItem,
  type FamilyTreePerspective,
} from "../src/features/family-tree-view/state/familyTreePerspectiveState.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";

const graph: FamilyGraphData = {
  persons: [{ id: "focus", displayName: "focus" }],
  unions: [],
  parentChildRelations: [],
  graphVersion: 7,
  permissionFingerprint: "member",
};

function snapshot() {
  return capturePedigreeReturnSnapshot({
    treeId: "tree",
    graph,
    focusHistory: ["home", "focus"],
    focusIndex: 1,
    branchVisibility: {
      scopeKey: "tree-request",
      branchRevision: 4,
      graphVersion: 7,
      permissionFingerprint: "member",
      layerKeys: ["parents"],
      pendingLayerKeys: ["children"],
      activeLayerKeys: ["parents"],
      restorePersonLayerKeys: [["focus", ["partners"]]],
    },
    camera: { x: 15, y: 25, zoom: 0.8 },
    selectedPersonId: "selected",
    generationSettings: {
      ancestorDepth: 7,
      descendantDepth: 0,
      collateralDepth: 1,
      showAllParentSets: true,
      activeParentSetByChild: { focus: "parent-set" },
    },
    familyContinuationOwners: new Map([["family", "focus"]]),
  });
}

test("pedigree return snapshot owns every required view setting", () => {
  const result = snapshot();

  assert.equal(result.focusPersonId, "focus");
  assert.deepEqual(result.focusHistory, ["home", "focus"]);
  assert.deepEqual(result.camera, { x: 15, y: 25, zoom: 0.8 });
  assert.equal(result.selectedPersonId, "selected");
  assert.deepEqual(result.generationSettings, {
    ancestorDepth: 7,
    descendantDepth: 0,
    collateralDepth: 1,
    showAllParentSets: true,
    activeParentSetByChild: { focus: "parent-set" },
  });
  assert.deepEqual(result.branchVisibility.activeLayerKeys, ["parents"]);
  assert.deepEqual(result.familyContinuationOwners, [["family", "focus"]]);
  assert.equal(result.pedigreeGraph, graph);
});

test("three perspectives have explicit and stable identities", () => {
  const returnTo = snapshot();
  const pedigree: FamilyTreePerspective = { kind: "pedigree" };
  const corridor: FamilyTreePerspective = {
    kind: "family-corridor",
    sessionId: "corridor-1",
    scope: { id: "family", parentIds: ["a", "b"] },
    continuation: {
      id: "family-control",
      scope: { id: "family", parentIds: ["a", "b"] },
      token: "family-cursor",
    },
    trail: [{
      scope: { id: "family", parentIds: ["a", "b"] },
      continuation: {
        id: "family-control",
        scope: { id: "family", parentIds: ["a", "b"] },
        token: "family-cursor",
      },
    }],
    returnTo,
  };
  const descendants: FamilyTreePerspective = {
    kind: "all-descendants",
    sessionId: "descendants-2",
    rootPersonId: "ancestor",
    returnTo,
  };

  assert.equal(familyTreePerspectiveKey(pedigree, "focus"), "pedigree:focus");
  assert.equal(
    familyTreePerspectiveKey(corridor, "focus"),
    "family-corridor:corridor-1:family",
  );
  assert.equal(
    familyTreePerspectiveKey(descendants, "focus"),
    "all-descendants:descendants-2:ancestor",
  );
  assert.equal(isSpecialFamilyTreePerspective(pedigree), false);
  assert.equal(isSpecialFamilyTreePerspective(corridor), true);
  assert.equal(specialPerspectiveReturnSnapshot(descendants), returnTo);
});

function trailItem(
  scopeId: string,
  token = `${scopeId}-cursor`,
  ownerPersonId?: string,
): FamilyCorridorTrailItem {
  return {
    scope: { id: scopeId, parentIds: [`${scopeId}-parent`] },
    continuation: {
      id: `${scopeId}-control`,
      scope: { id: scopeId, parentIds: [`${scopeId}-parent`] },
      token,
    },
    ...(ownerPersonId ? { ownerPersonId } : {}),
    anchorOccurrenceId: `${scopeId}-anchor`,
  };
}

test("family corridor trail appends a newly opened family scope", () => {
  const root = trailItem("root");
  const child = trailItem("child", "child-cursor", "child-owner");
  const original = [root] as const;

  const result = appendFamilyCorridorTrailItem(original, child);

  assert.deepEqual(result, [root, child]);
  assert.deepEqual(original, [root]);
  assert.notEqual(result, original);
});

test("family corridor trail replaces an existing scope and truncates deeper steps", () => {
  const root = trailItem("root");
  const child = trailItem("child", "old-child-cursor");
  const grandchild = trailItem("grandchild");
  const replacement = trailItem("child", "new-child-cursor", "new-owner");
  const original = [root, child, grandchild] as const;

  const result = appendFamilyCorridorTrailItem(original, replacement);

  assert.deepEqual(result, [root, replacement]);
  assert.equal(result[0], root);
  assert.deepEqual(original, [root, child, grandchild]);
});

test("family corridor trail can return to any breadcrumb inclusively", () => {
  const root = trailItem("root");
  const child = trailItem("child");
  const grandchild = trailItem("grandchild");
  const trail = [root, child, grandchild] as const;

  assert.deepEqual(keepFamilyCorridorTrailThrough(trail, 0), [root]);
  assert.deepEqual(keepFamilyCorridorTrailThrough(trail, 1), [root, child]);
  assert.deepEqual(
    keepFamilyCorridorTrailThrough(trail, 20),
    [root, child, grandchild],
  );
  assert.deepEqual(keepFamilyCorridorTrailThrough(trail, -1), []);
  assert.deepEqual(trail, [root, child, grandchild]);
});

test("production uses independent pedigree, corridor and progressive descendant stores", () => {
  const page = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(page, /const pedigreeNeighborhood = useFamilyTreeNeighborhood/);
  assert.match(page, /const specialNeighborhood = useFamilyTreeNeighborhood/);
  assert.match(page, /const progressiveDescendants = useProgressiveDescendantGraph/);
  assert.match(page, /enabled: perspective\.kind === "family-corridor"/);
  assert.match(page, /enabled: perspective\.kind === "all-descendants"/);
  assert.match(
    page,
    /perspective\.kind === "pedigree"[\s\S]*?\? pedigreeGraph[\s\S]*?: perspective\.kind === "family-corridor"/,
  );
  assert.match(page, /kind: "all-descendants"/);
  assert.match(page, /captureCurrentPedigreeSnapshot\(\)/);
  assert.match(page, /restorePedigreeSnapshot\(perspective\.returnTo/);
  assert.match(
    page,
    /return mergeNeighborhood\(snapshotGraph,[\s\S]*?continuations: specialGraph\.continuations \?\? \[\]/,
  );
  assert.match(page, /\n\s*continuation,\n/);
  assert.match(
    page,
    /\) \?\? perspective\.continuation/,
  );
  assert.match(
    page,
    /result !== "expanded"[\s\S]*?corridorExpansionSessionsRef\.current\.delete/,
  );
  assert.match(
    page,
    /current\.sessionId !== requestSessionId/,
  );
  assert.match(page, /allDescendantsTruncated/);
  assert.match(hook, /enabled\?: boolean/);
  assert.match(hook, /sessionKey\?: string/);
  assert.match(hook, /if \(!enabled\) return;/);
});
