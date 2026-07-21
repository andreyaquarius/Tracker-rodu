import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  composeFamilyTreeBranchLayers,
  familyTreeFamilyBranchKey,
  type FamilyTreeBranchLayer,
} from "../src/features/family-tree-view/data/branchLayers.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function scope(id: string, parentIds: readonly string[]): FamilyScope {
  return { id, parentIds, unionIds: [`union:${id}`] };
}

function continuation(familyScope: FamilyScope): FamilyContinuation {
  return {
    id: `continuation:${familyScope.id}`,
    scope: familyScope,
    token: `server:${familyScope.id}`,
    hiddenCount: 1,
  };
}

test("the children button stays in the current pedigree and expands locally", () => {
  const handlerStart = productionPage.indexOf(
    "async function toggleFamilyContinuation(",
  );
  const handlerEnd = productionPage.indexOf(
    "function togglePersonBranches(",
    handlerStart,
  );

  assert.notEqual(handlerStart, -1, "children toggle handler must exist");
  assert.notEqual(handlerEnd, -1, "children toggle handler must have a boundary");

  const handler = productionPage.slice(handlerStart, handlerEnd);
  const expansionStart = handler.indexOf(
    "const result = await neighborhood.expandFamilyContinuation(",
  );
  assert.notEqual(
    expansionStart,
    -1,
    "the clicked family must expand in the neighborhood of the current view",
  );

  const beforeExpansion = handler.slice(0, expansionStart);
  const expansionCall = handler.slice(expansionStart, expansionStart + 180);
  assert.match(
    productionPage,
    /const neighborhood = perspective\.kind === "pedigree"\s*\? pedigreeNeighborhood\s*:\s*specialNeighborhood/,
    "a pedigree click must use the long-lived pedigree neighborhood",
  );
  assert.match(
    expansionCall,
    /neighborhood\.expandFamilyContinuation\(\s*continuation,\s*visiblePersonIds/,
    "the clicked family is the only requested expansion",
  );
  assert.match(
    beforeExpansion,
    /setAnchorOccurrenceId\(anchorOccurrenceId\)/,
    "the clicked card remains the viewport anchor during layout reflow",
  );
  assert.doesNotMatch(
    beforeExpansion,
    /kind:\s*["']family-corridor["']|captureCurrentPedigreeSnapshot|setPerspective\(|setSelectedPersonId\(|specialNeighborhood|progressiveDescendants|enterAllDescendants/,
    "showing direct children must not reroot, change perspective, or start a deep-descendant session",
  );
  assert.match(
    productionPage,
    /function visiblePersonIdsForFamily\([\s\S]*?return new Set\(displayedGraphWithoutPhotos\.persons\.map\(person => person\.id\)\);[\s\S]*?\n\s*\}/,
    "the request must preserve the people already visible in the current tree",
  );
});

test("opening one family layer reveals its direct child but keeps deeper generations closed", () => {
  const targetFamily = scope("target-family", ["target", "partner"]);
  const childFamily = scope("child-family", ["child", "child-partner"]);
  const targetKey = familyTreeFamilyBranchKey(targetFamily.id);
  const childKey = familyTreeFamilyBranchKey(childFamily.id);
  const targetContinuation = continuation(targetFamily);

  const base: FamilyGraphData = {
    persons: [person("home"), person("target")],
    unions: [],
    parentChildRelations: [],
    familyContinuations: [targetContinuation],
  };
  const targetLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key: targetKey,
    scope: targetFamily,
    consumedToken: targetContinuation.token,
    response: {
      persons: [person("target"), person("partner"), person("child")],
      unions: [
        {
          id: "union:target-family",
          kind: "parent-set",
          memberIds: ["target", "partner"],
        },
      ],
      parentChildRelations: [
        {
          id: "target-child",
          parentId: "target",
          childId: "child",
          unionId: "union:target-family",
          kind: "biological",
        },
        {
          id: "partner-child",
          parentId: "partner",
          childId: "child",
          unionId: "union:target-family",
          kind: "biological",
        },
      ],
      continuations: [],
      familyContinuations: [
        {
          ...continuation(childFamily),
          ownerBranchKey: targetKey,
        },
      ],
    },
  };
  const childLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key: childKey,
    scope: childFamily,
    parentKey: targetKey,
    consumedToken: `server:${childFamily.id}`,
    response: {
      persons: [
        person("child"),
        person("child-partner"),
        person("grandchild"),
      ],
      unions: [],
      parentChildRelations: [
        {
          id: "child-grandchild",
          parentId: "child",
          childId: "grandchild",
          kind: "biological",
        },
      ],
      continuations: [],
      familyContinuations: [],
    },
  };

  const layers = new Map([
    [targetKey, targetLayer],
    [childKey, childLayer],
  ]);
  const directChildrenOnly = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([targetKey]),
  );
  const ids = directChildrenOnly.persons.map(item => item.id).sort();

  assert.deepEqual(ids, ["child", "home", "partner", "target"]);
  assert.equal(ids.includes("grandchild"), false);
  assert.equal(ids.includes("child-partner"), false);
  assert.equal(
    directChildrenOnly.familyContinuations?.some(
      item => item.scope.id === childFamily.id && !item.expanded,
    ),
    true,
    "the child generation can expose its own closed control without opening grandchildren",
  );
  assert.deepEqual(base.persons.map(item => item.id), ["home", "target"]);
});
