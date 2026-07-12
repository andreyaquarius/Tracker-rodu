import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composeFamilyTreeBranchLayers,
  familyTreeFamilyBranchKey,
  type FamilyTreeBranchLayer,
} from "../src/features/family-tree-view/data/branchLayers.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { positionFamilyContinuations } from "../src/features/family-tree-view/react/familyContinuationLayout.ts";
import { familyTreeLayoutAnchorPoint } from "../src/features/family-tree-view/react/useFamilyTreeLayout.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

const neighborhoodHook = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
    import.meta.url,
  ),
  "utf8",
);
const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const viewport = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/FamilyTreeViewport.tsx",
    import.meta.url,
  ),
  "utf8",
);

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function continuation(
  id: string,
  scope: FamilyScope,
  input: Partial<FamilyContinuation> = {},
): FamilyContinuation {
  return {
    id,
    scope,
    token: `cursor:${id}`,
    hiddenCount: 2,
    ...input,
  };
}

test("one family token is mirrored below parents and keeps its clicked owner while open", () => {
  const scope: FamilyScope = {
    id: "family:parents",
    parentIds: ["father", "mother"],
    familyGroupId: "parents",
    unionIds: ["partnership", "parent-set"],
  };
  const key = familyTreeFamilyBranchKey(scope.id);
  const base: FamilyGraphData = {
    persons: [person("father"), person("mother")],
    unions: [
      {
        id: "partnership",
        kind: "partnership",
        memberIds: ["father", "mother"],
        familyGroupId: "parents",
      },
    ],
    parentChildRelations: [],
    // The server may expose duplicate records for one scope. The client keeps
    // one token and mirrors its presentation under the two parent cards.
    familyContinuations: [
      continuation("father-control", scope),
      continuation("mother-control", scope),
    ],
  };
  const familyLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key,
    scope,
    consumedToken: "cursor:father-control",
    response: {
      persons: [person("father"), person("mother"), person("child")],
      unions: [
        {
          id: "parent-set",
          kind: "parent-set",
          memberIds: ["father", "mother"],
          familyGroupId: "parents",
        },
      ],
      parentChildRelations: [
        {
          id: "father-child",
          parentId: "father",
          childId: "child",
          unionId: "parent-set",
          kind: "biological",
        },
        {
          id: "mother-child",
          parentId: "mother",
          childId: "child",
          unionId: "parent-set",
          kind: "biological",
        },
      ],
      continuations: [],
      familyContinuations: [],
    },
  };
  const layers = new Map([[key, familyLayer]]);
  const closed = composeFamilyTreeBranchLayers(base, layers, new Set());
  const open = composeFamilyTreeBranchLayers(base, layers, new Set([key]));
  const reopened = composeFamilyTreeBranchLayers(base, layers, new Set([key]));

  assert.equal(closed.familyContinuations?.length, 1);
  assert.equal(open.familyContinuations?.length, 1);
  assert.equal(open.familyContinuations?.[0]?.scope.id, scope.id);
  assert.equal(open.familyContinuations?.[0]?.expanded, true);
  assert.equal(open.familyContinuations?.[0]?.hiddenCount, undefined);
  assert.deepEqual(reopened, open);

  for (const currentGraph of [closed, open, reopened]) {
    const layout = layoutFamilyGraph({
      graph: currentGraph,
      options: {
        focusPersonId: "father",
        ancestorDepth: 0,
        descendantDepth: 2,
        collateralDepth: 1,
        showUnknownParentPlaceholders: false,
      },
    });
    const expanded = Boolean(currentGraph.familyContinuations?.[0]?.expanded);
    const controls = positionFamilyContinuations(currentGraph, layout, {
      activeOwnerByScope: new Map([[scope.id, "mother"]]),
    });
    assert.equal(controls.length, expanded ? 1 : 2);
    assert.equal(
      controls.every(control => control.continuation.scope.id === scope.id),
      true,
    );
    assert.deepEqual(
      controls.map(control => control.ownerPersonId).sort(),
      expanded ? ["mother"] : ["father", "mother"],
    );
  }
});

test("family continuation reopens a cached layer before any network request", () => {
  const start = neighborhoodHook.indexOf("const expandFamilyContinuation");
  const end = neighborhoodHook.indexOf("const togglePersonBranches", start);
  assert.ok(start >= 0 && end > start, "family continuation callback must exist");
  const callback = neighborhoodHook.slice(start, end);

  const cachedLayer = callback.indexOf("branchLayersRef.current.has(layerKey)");
  const dedicatedRpc = callback.indexOf("client.loadFamilyBranch");
  const fallbackRpc = callback.indexOf("client.load(");
  assert.ok(cachedLayer >= 0, "cached family layer must be checked");
  assert.ok(dedicatedRpc > cachedLayer, "dedicated RPC must follow the cache check");
  assert.ok(fallbackRpc > cachedLayer, "fallback RPC must follow the cache check");
  assert.match(
    callback.slice(cachedLayer, dedicatedRpc),
    /activeBranchLayerKeysRef\.current\.add\(layerKey\)[\s\S]*commitComposedGraph\(\)[\s\S]*return/,
  );
});

test("a parent card occurrence is a valid family-control camera anchor", () => {
  const graph: FamilyGraphData = {
    persons: [person("father"), person("mother")],
    unions: [{
      id: "partnership",
      kind: "partnership",
      memberIds: ["father", "mother"],
    }],
    parentChildRelations: [],
  };
  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "father",
      ancestorDepth: 0,
      descendantDepth: 0,
      collateralDepth: 0,
      showUnknownParentPlaceholders: false,
    },
  });
  const father = layout.nodes.find(node => node.personId === "father");
  assert.ok(father);
  assert.deepEqual(
    familyTreeLayoutAnchorPoint(layout, father.occurrenceId),
    { x: father.x, y: father.y },
  );
});

test("leaving a special perspective restores the complete pedigree snapshot", () => {
  assert.match(
    productionPage,
    /function captureCurrentPedigreeSnapshot\(\): FamilyTreePedigreeReturnSnapshot/,
  );
  assert.match(
    productionPage,
    /branchVisibility:\s*pedigreeNeighborhood\.captureBranchVisibility\(\)/,
  );

  const start = productionPage.indexOf("function restorePedigreeSnapshot");
  const end = productionPage.indexOf("function enterAllDescendants", start);
  assert.ok(start >= 0 && end > start, "pedigree snapshot restore callback must exist");
  const restore = productionPage.slice(start, end);

  assert.match(
    restore,
    /pedigreeNeighborhood\.restoreBranchVisibility\(snapshot\.branchVisibility\)/,
  );
  assert.match(restore, /setFocusHistory\(\[\.\.\.snapshot\.focusHistory\]\)/);
  assert.match(restore, /setFocusIndex\(snapshot\.focusIndex\)/);
  assert.match(restore, /setAncestorDepth\(snapshot\.generationSettings\.ancestorDepth\)/);
  assert.match(restore, /setDescendantDepth\(snapshot\.generationSettings\.descendantDepth\)/);
  assert.match(restore, /setCollateralDepth\(snapshot\.generationSettings\.collateralDepth\)/);
  assert.match(restore, /setSelectedPersonId\(/);
  assert.match(restore, /cameraSnapshotsRef\.current\.set\(/);
  assert.match(restore, /setPerspective\(\{ kind: "pedigree" \}\)/);

  const captureStart = neighborhoodHook.indexOf("const captureBranchVisibility");
  const restoreStart = neighborhoodHook.indexOf("const restoreBranchVisibility");
  const restoreEnd = neighborhoodHook.indexOf("const reload", restoreStart);
  assert.ok(captureStart >= 0 && restoreStart > captureStart && restoreEnd > restoreStart);
  const capture = neighborhoodHook.slice(captureStart, restoreStart);
  const atomicRestore = neighborhoodHook.slice(restoreStart, restoreEnd);
  assert.match(capture, /branchRevision:\s*branchRevisionRef\.current/);
  assert.match(capture, /graphVersion:\s*graphRef\.current\.graphVersion/);
  assert.match(capture, /permissionFingerprint:\s*graphRef\.current\.permissionFingerprint/);
  assert.match(capture, /\.\.\.branchLayersRef\.current\.keys\(\)/);
  assert.match(capture, /request => request\.layerKey/);
  assert.match(capture, /\.\.\.activeBranchLayerKeysRef\.current/);
  assert.match(atomicRestore, /request\.revision <= snapshot\.branchRevision/);
  assert.match(atomicRestore, /request\.controller\.abort\(\)/);
  assert.match(atomicRestore, /branchLayersRef\.current\.delete\(key\)/);
  assert.match(atomicRestore, /activeBranchLayerKeysRef\.current\.clear\(\)/);
});

test("all three perspectives persist independent camera snapshots", () => {
  assert.match(
    productionPage,
    /useRef\(new Map<string, CameraState>\(\)\)/,
  );
  assert.match(
    productionPage,
    /familyTreePerspectiveKey\(perspective, focusPersonId\)/,
  );
  assert.match(
    productionPage,
    /cameraSnapshotsRef\.current\.set\(perspectiveKey, camera\)/,
  );
  assert.match(productionPage, /key=\{perspectiveKey\}/);
  assert.match(
    productionPage,
    /initialCamera=\{cameraSnapshotsRef\.current\.get\(perspectiveKey\)\}/,
  );
  assert.match(productionPage, /onCameraChange=\{rememberCamera\}/);

  // A restored viewport must not immediately replace its saved camera by
  // auto-centering the focus node on the first layout effect.
  assert.match(
    viewport,
    /useRef<string \| undefined>\(\s*initialCamera \? options\.focusPersonId : undefined,?\s*\)/,
  );
});
