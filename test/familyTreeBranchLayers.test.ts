import test from "node:test";
import assert from "node:assert/strict";
import {
  composeFamilyTreeBranchLayers,
  familyTreeFamilyBranchKey,
  familyTreeBranchKey,
  type FamilyTreeBranchLayer,
} from "../src/features/family-tree-view/data/branchLayers.ts";
import type { NeighborhoodResponse } from "../src/features/family-tree-view/data/neighborhoodClient.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { branchControlPresentation } from "../src/features/family-tree-view/react/branchControlPresentation.ts";
import type {
  FamilyGraphData,
  FamilyContinuation,
  FamilyScope,
  TreeContinuation,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function continuation(
  personId: string,
  direction: TreeContinuation["direction"],
  hiddenCount = 1,
): TreeContinuation {
  return {
    id: `${personId}-${direction}`,
    personId,
    direction,
    token: `server:${personId}:${direction}`,
    hiddenCount,
  };
}

function familyScope(id = "family:parents"): FamilyScope {
  return {
    id,
    parentIds: ["father", "mother"],
    unionIds: ["parents-union"],
  };
}

function familyContinuation(
  id: string,
  scope = familyScope(),
  hiddenCount = 2,
): FamilyContinuation {
  return {
    id,
    scope,
    token: `server:${scope.id}`,
    hiddenCount,
  };
}

function layer(
  personId: string,
  direction: TreeContinuation["direction"],
  response: NeighborhoodResponse,
  parentKey?: string,
): FamilyTreeBranchLayer {
  const key = familyTreeBranchKey(personId, direction);
  return {
    key,
    personId,
    direction,
    consumedToken: `server:${personId}:${direction}`,
    response,
    ...(parentKey ? { parentKey } : {}),
  };
}

function personIds(graph: FamilyGraphData): string[] {
  return graph.persons.map(item => item.id).sort();
}

function assertUniqueEntityIds(graph: FamilyGraphData): void {
  assert.equal(
    graph.persons.length,
    new Set(graph.persons.map(item => item.id)).size,
    "person entity IDs must stay canonical and unique",
  );
  assert.equal(
    graph.unions.length,
    new Set(graph.unions.map(item => item.id)).size,
    "union entity IDs must stay canonical and unique",
  );
  assert.equal(
    graph.parentChildRelations.length,
    new Set(graph.parentChildRelations.map(item => item.id)).size,
    "relationship entity IDs must stay canonical and unique",
  );
}

function independentBranchFixture(): {
  base: FamilyGraphData;
  layers: Map<string, FamilyTreeBranchLayer>;
  partnerKey: string;
  childrenKey: string;
} {
  const partnerControl = continuation("focus", "partners", 2);
  const childrenControl = continuation("focus", "children", 3);
  const base: FamilyGraphData = {
    persons: [person("focus")],
    unions: [],
    parentChildRelations: [],
    continuations: [partnerControl, childrenControl],
  };
  const partnerLayer = layer("focus", "partners", {
    persons: [person("focus"), person("partner")],
    unions: [
      {
        id: "focus-partnership",
        kind: "partnership",
        memberIds: ["focus", "partner"],
      },
    ],
    parentChildRelations: [],
    continuations: [],
  });
  const childrenLayer = layer("focus", "children", {
    persons: [person("focus"), person("child")],
    unions: [
      {
        id: "focus-children",
        kind: "parent-set",
        memberIds: ["focus"],
      },
    ],
    parentChildRelations: [
      {
        id: "focus-child",
        parentId: "focus",
        childId: "child",
        unionId: "focus-children",
        kind: "biological",
      },
    ],
    continuations: [],
  });
  return {
    base,
    layers: new Map([
      [partnerLayer.key, partnerLayer],
      [childrenLayer.key, childrenLayer],
    ]),
    partnerKey: partnerLayer.key,
    childrenKey: childrenLayer.key,
  };
}

test("an active branch control is marked expanded and no longer exposes a hidden count", () => {
  const presentation = branchControlPresentation({
    ...continuation("focus", "partners", 7),
    expanded: true,
  });

  assert.equal(presentation.expanded, true);
  assert.equal("count" in presentation, false);
  assert.equal(presentation.title, "Згорнути партнерів");
  assert.equal(presentation.ariaLabel, "Згорнути партнерів");
  assert.doesNotMatch(presentation.ariaLabel, /приховано|7/);
});

test("partner and children layers collapse independently", () => {
  const { base, layers, partnerKey, childrenKey } = independentBranchFixture();

  const allOpen = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([partnerKey, childrenKey]),
  );
  const partnerClosed = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([childrenKey]),
  );
  const childrenClosed = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([partnerKey]),
  );

  assert.deepEqual(personIds(allOpen), ["child", "focus", "partner"]);
  assert.deepEqual(personIds(partnerClosed), ["child", "focus"]);
  assert.deepEqual(personIds(childrenClosed), ["focus", "partner"]);
  assert.equal(
    partnerClosed.continuations?.find(item => item.direction === "children")
      ?.expanded,
    true,
  );
  assert.equal(
    partnerClosed.continuations?.find(item => item.direction === "partners")
      ?.expanded,
    undefined,
  );
});

test("closing and reopening a cached layer is idempotent and keeps canonical entity IDs unique", () => {
  const { base, layers, partnerKey, childrenKey } = independentBranchFixture();
  const openKeys = new Set([partnerKey, childrenKey]);
  const firstOpen = composeFamilyTreeBranchLayers(base, layers, openKeys);

  composeFamilyTreeBranchLayers(base, layers, new Set([childrenKey]));
  const reopened = composeFamilyTreeBranchLayers(base, layers, openKeys);
  const recomposed = composeFamilyTreeBranchLayers(base, layers, openKeys);

  assert.deepEqual(reopened, firstOpen);
  assert.deepEqual(recomposed, firstOpen);
  assertUniqueEntityIds(reopened);

  const layout = layoutFamilyGraph({
    graph: reopened,
    options: {
      focusPersonId: "focus",
      ancestorDepth: 2,
      descendantDepth: 2,
      collateralDepth: 2,
      maxVisibleNodes: 20,
      showUnknownParentPlaceholders: false,
    },
  });
  const cards = layout.nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );
  assert.equal(cards.length, new Set(cards.map(node => node.personId)).size);
  assert.equal(cards.some(node => node.kind === "reference"), false);
});

test("a nested layer is hidden with its inactive owner and restored without refetching", () => {
  const baseControl = continuation("focus", "children");
  const base: FamilyGraphData = {
    persons: [person("focus")],
    unions: [],
    parentChildRelations: [],
    continuations: [baseControl],
  };
  const owner = layer("focus", "children", {
    persons: [person("focus"), person("child")],
    unions: [
      { id: "focus-family", kind: "parent-set", memberIds: ["focus"] },
    ],
    parentChildRelations: [
      {
        id: "focus-child",
        parentId: "focus",
        childId: "child",
        unionId: "focus-family",
        kind: "biological",
      },
    ],
    continuations: [continuation("child", "children")],
  });
  const nested = layer(
    "child",
    "children",
    {
      persons: [person("child"), person("grandchild")],
      unions: [
        { id: "child-family", kind: "parent-set", memberIds: ["child"] },
      ],
      parentChildRelations: [
        {
          id: "child-grandchild",
          parentId: "child",
          childId: "grandchild",
          unionId: "child-family",
          kind: "biological",
        },
      ],
      continuations: [],
    },
    owner.key,
  );
  const layers = new Map([
    [owner.key, owner],
    [nested.key, nested],
  ]);
  const activeKeys = new Set([owner.key, nested.key]);

  const open = composeFamilyTreeBranchLayers(base, layers, activeKeys);
  activeKeys.delete(owner.key);
  const ownerClosed = composeFamilyTreeBranchLayers(base, layers, activeKeys);
  activeKeys.add(owner.key);
  const restored = composeFamilyTreeBranchLayers(base, layers, activeKeys);

  assert.deepEqual(personIds(open), ["child", "focus", "grandchild"]);
  assert.deepEqual(personIds(ownerClosed), ["focus"]);
  assert.deepEqual(restored, open);
  assert.equal(activeKeys.has(nested.key), true);
  assertUniqueEntityIds(restored);
});

test("an expansion-owned same-generation parent relation reuses the canonical card", () => {
  const siblingControl = continuation("focus", "siblings");
  const base: FamilyGraphData = {
    persons: [person("focus"), person("father")],
    unions: [
      { id: "focus-parents", kind: "parent-set", memberIds: ["father"] },
    ],
    parentChildRelations: [
      {
        id: "father-focus",
        parentId: "father",
        childId: "focus",
        unionId: "focus-parents",
        kind: "biological",
        role: "father",
      },
    ],
    continuations: [siblingControl],
  };
  const siblingLayer = layer("focus", "siblings", {
    persons: [person("focus"), person("father"), person("sibling")],
    unions: [
      { id: "focus-parents", kind: "parent-set", memberIds: ["father"] },
    ],
    parentChildRelations: [
      ...base.parentChildRelations,
      {
        id: "father-sibling",
        parentId: "father",
        childId: "sibling",
        unionId: "focus-parents",
        kind: "biological",
        role: "father",
      },
    ],
    continuations: [],
  });
  const graph = composeFamilyTreeBranchLayers(
    base,
    new Map([[siblingLayer.key, siblingLayer]]),
    new Set([siblingLayer.key]),
  );
  const ownedRelation = graph.parentChildRelations.find(
    relation => relation.id === "father-sibling",
  );
  assert.equal(ownedRelation?.ownerBranchKey, siblingLayer.key);

  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "focus",
      ancestorDepth: 2,
      descendantDepth: 1,
      collateralDepth: 1,
      maxVisibleNodes: 20,
      showUnknownParentPlaceholders: false,
    },
  });
  const fatherCards = layout.nodes.filter(node => node.personId === "father");

  assert.equal(layout.nodes.some(node => node.personId === "sibling"), true);
  assert.equal(fatherCards.length, 1);
  assert.equal(fatherCards[0]?.kind, "person");
  assert.equal(fatherCards.some(node => node.kind === "reference"), false);
});

test("duplicate parent-side child controls reconcile to one canonical family scope", () => {
  const scope = familyScope("shared-family");
  const base: FamilyGraphData = {
    persons: [person("father"), person("mother")],
    unions: [
      {
        id: "parents-union",
        kind: "partnership",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: [],
    familyContinuations: [
      familyContinuation("beside-father", scope, 2),
      familyContinuation("beside-mother", scope, 2),
    ],
  };

  const composed = composeFamilyTreeBranchLayers(base, new Map(), new Set());

  assert.equal(composed.familyContinuations?.length, 1);
  assert.equal(composed.familyContinuations?.[0]?.scope.id, "shared-family");
});

test("family child layer is keyed by scope, closes and reopens from cache", () => {
  const scope = familyScope("shared-family");
  const key = familyTreeFamilyBranchKey(scope.id);
  const base: FamilyGraphData = {
    persons: [person("father"), person("mother")],
    unions: [],
    parentChildRelations: [],
    familyContinuations: [familyContinuation("children", scope, 2)],
  };
  const familyLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key,
    scope,
    consumedToken: `server:${scope.id}`,
    response: {
      persons: [person("father"), person("mother"), person("child")],
      unions: [
        {
          id: "parents-union",
          kind: "parent-set",
          memberIds: ["father", "mother"],
        },
      ],
      parentChildRelations: [
        {
          id: "father-child",
          parentId: "father",
          childId: "child",
          unionId: "parents-union",
          kind: "biological",
        },
        {
          id: "mother-child",
          parentId: "mother",
          childId: "child",
          unionId: "parents-union",
          kind: "biological",
        },
      ],
      continuations: [],
      // An empty authoritative result must still remove the stale closed badge.
      familyContinuations: [],
    },
  };
  const layers = new Map([[key, familyLayer]]);

  const firstOpen = composeFamilyTreeBranchLayers(base, layers, new Set([key]));
  const closed = composeFamilyTreeBranchLayers(base, layers, new Set());
  const reopened = composeFamilyTreeBranchLayers(base, layers, new Set([key]));

  assert.deepEqual(personIds(firstOpen), ["child", "father", "mother"]);
  assert.equal(firstOpen.familyContinuations?.length, 1);
  assert.equal(firstOpen.familyContinuations?.[0]?.expanded, true);
  assert.equal(firstOpen.familyContinuations?.[0]?.hiddenCount, undefined);
  assert.deepEqual(closed.familyContinuations, [familyContinuation("children", scope, 2)]);
  assert.deepEqual(reopened, firstOpen);
});

test("a nested family scope follows its cached parent layer visibility", () => {
  const parentScope = familyScope("parent-family");
  const nestedScope: FamilyScope = {
    id: "child-family",
    parentIds: ["child", "partner"],
  };
  const parentKey = familyTreeFamilyBranchKey(parentScope.id);
  const nestedKey = familyTreeFamilyBranchKey(nestedScope.id);
  const base: FamilyGraphData = {
    persons: [person("father"), person("mother")],
    unions: [],
    parentChildRelations: [],
    familyContinuations: [familyContinuation("parent-control", parentScope)],
  };
  const parentLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key: parentKey,
    scope: parentScope,
    consumedToken: `server:${parentScope.id}`,
    response: {
      persons: [person("father"), person("mother"), person("child"), person("partner")],
      unions: [],
      parentChildRelations: [],
      continuations: [],
      familyContinuations: [
        {
          ...familyContinuation("nested-control", nestedScope),
          ownerBranchKey: parentKey,
        },
      ],
    },
  };
  const nestedLayer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key: nestedKey,
    scope: nestedScope,
    consumedToken: `server:${nestedScope.id}`,
    parentKey,
    response: {
      persons: [person("child"), person("partner"), person("grandchild")],
      unions: [],
      parentChildRelations: [],
      continuations: [],
      familyContinuations: [],
    },
  };
  const layers = new Map([
    [parentKey, parentLayer],
    [nestedKey, nestedLayer],
  ]);

  const open = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([parentKey, nestedKey]),
  );
  const hiddenWithParent = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([nestedKey]),
  );
  const reopened = composeFamilyTreeBranchLayers(
    base,
    layers,
    new Set([parentKey, nestedKey]),
  );

  assert.equal(open.persons.some(item => item.id === "grandchild"), true);
  assert.deepEqual(personIds(hiddenWithParent), ["father", "mother"]);
  assert.deepEqual(reopened, open);
});
