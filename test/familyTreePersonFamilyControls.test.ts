import test from "node:test";
import assert from "node:assert/strict";
import {
  composeFamilyTreeBranchLayers,
  familyTreeFamilyBranchKey,
  type FamilyTreeBranchLayer,
} from "../src/features/family-tree-view/data/branchLayers.ts";
import {
  graphWithoutLegacyFamilyChildControls,
  positionFamilyContinuations,
} from "../src/features/family-tree-view/react/familyContinuationLayout.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  LayoutEdge,
  LayoutNode,
  LayoutResult,
  LayoutUnion,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function personNode(
  personId: string,
  x: number,
  occurrenceId = `person:${personId}`,
): LayoutNode {
  return {
    occurrenceId,
    personId,
    kind: "person",
    generation: 0,
    x,
    y: 40,
    width: 100,
    height: 120,
    orderKey: personId,
  };
}

function scope(
  id: string,
  parentIds: readonly string[],
  unionId = `union:${id}`,
): FamilyScope {
  return { id, parentIds, unionIds: [unionId] };
}

function continuation(
  familyScope: FamilyScope,
  expanded = false,
): FamilyContinuation {
  return {
    id: `continuation:${familyScope.id}`,
    scope: familyScope,
    token: expanded
      ? `local:active:${familyScope.id}`
      : `server:${familyScope.id}`,
    ...(expanded ? { expanded: true } : { hiddenCount: 2 }),
  };
}

function union(
  familyScope: FamilyScope,
  memberOccurrenceIds: readonly string[],
): LayoutUnion {
  return {
    occurrenceId: `layout-union:${familyScope.id}`,
    unionId: familyScope.unionIds![0]!,
    kind: "partnership",
    generation: 0,
    x: 200,
    y: 100,
    memberOccurrenceIds,
    childOccurrenceIds: [],
  };
}

function fixture(input: {
  continuations: readonly FamilyContinuation[];
  people?: readonly string[];
  unions?: readonly LayoutUnion[];
  edges?: readonly LayoutEdge[];
  auxiliaryNodes?: readonly LayoutNode[];
}): { graph: FamilyGraphData; layout: LayoutResult } {
  const personIds = input.people ?? ["father", "mother"];
  const nodes = [
    ...personIds.map((personId, index) =>
      personNode(personId, 80 + index * 180),
    ),
    ...(input.auxiliaryNodes ?? []),
  ];
  const graph: FamilyGraphData = {
    persons: personIds.map(person),
    unions: (input.unions ?? []).map(item => ({
      id: item.unionId,
      kind: item.kind,
      memberIds: item.memberOccurrenceIds.map(occurrenceId =>
        occurrenceId.replace(/^person:/, ""),
      ),
    })),
    parentChildRelations: [],
    familyContinuations: input.continuations,
  };
  const layout: LayoutResult = {
    nodes,
    unions: input.unions ?? [],
    edges: input.edges ?? [],
    bounds: { left: 80, top: 40, right: 720, bottom: 240 },
    generationBands: [],
    warnings: [],
  };
  return { graph, layout };
}

function controlKeys(
  controls: ReturnType<typeof positionFamilyContinuations>,
): string[] {
  return controls
    .map(control => `${control.continuation.scope.id}:${control.ownerPersonId}`)
    .sort();
}

function rectanglesIntersect(
  left: Pick<LayoutNode, "x" | "y" | "width" | "height">,
  right: Pick<LayoutNode, "x" | "y" | "width" | "height">,
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

test("a closed family is offered below both parent cards, never at the union junction", () => {
  const shared = scope("shared", ["father", "mother"]);
  const sharedUnion = union(shared, ["person:father", "person:mother"]);
  const { graph, layout } = fixture({
    continuations: [continuation(shared)],
    unions: [sharedUnion],
  });

  const controls = positionFamilyContinuations(graph, layout);

  assert.deepEqual(controlKeys(controls), ["shared:father", "shared:mother"]);
  for (const control of controls) {
    const card = layout.nodes.find(
      node => node.personId === control.ownerPersonId,
    );
    assert.ok(card);
    assert.equal(control.anchorOccurrenceId, card.occurrenceId);
    assert.equal(control.x + control.width / 2, card.x + card.width / 2);
    assert.ok(control.y >= card.y + card.height);
    assert.notEqual(control.anchorOccurrenceId, sharedUnion.occurrenceId);
  }
});

test("technical scopes for the same parents render only one button per card", () => {
  const persisted = {
    ...scope("family-group:shared", ["father", "mother"]),
    familyGroupId: "shared",
  };
  const derived = scope("parents:father,mother", ["mother", "father"]);
  const { graph, layout } = fixture({
    continuations: [
      { ...continuation(persisted), hiddenCount: 2 },
      { ...continuation(derived), hiddenCount: 2 },
    ],
  });

  const controls = positionFamilyContinuations(graph, layout);

  assert.deepEqual(controlKeys(controls), [
    "family-group:shared:father",
    "family-group:shared:mother",
  ]);
  assert.equal(
    controls.length,
    new Set(controls.map(control => control.ownerPersonId)).size,
  );
});

test("an expanded equivalent scope suppresses every closed duplicate", () => {
  const persisted = {
    ...scope("family-group:shared", ["father", "mother"]),
    familyGroupId: "shared",
  };
  const derived = scope("parents:father,mother", ["mother", "father"]);
  const { graph, layout } = fixture({
    continuations: [continuation(persisted), continuation(derived, true)],
  });

  const controls = positionFamilyContinuations(graph, layout, {
    activeOwnerByScope: new Map([[derived.id, "mother"]]),
  });

  assert.deepEqual(controlKeys(controls), [
    "parents:father,mother:mother",
  ]);
  assert.equal(controls[0]?.continuation.expanded, true);
});

test("duplicate single-parent scopes still render one button", () => {
  const first = scope("single:a", ["father"]);
  const second = scope("single:b", ["father"]);
  const { graph, layout } = fixture({
    people: ["father"],
    continuations: [continuation(first), continuation(second)],
  });

  const controls = positionFamilyContinuations(graph, layout);

  assert.equal(controls.length, 1);
  assert.equal(controls[0]?.ownerPersonId, "father");
});

test("authoritative family controls suppress stale per-person child arrows", () => {
  const shared = scope("shared", ["father", "mother"]);
  const { graph } = fixture({ continuations: [continuation(shared)] });
  const withLegacyControls: FamilyGraphData = {
    ...graph,
    continuations: [
      {
        id: "father-children",
        personId: "father",
        direction: "children",
        token: "legacy:father:children",
        hiddenCount: 2,
      },
      {
        id: "mother-children",
        personId: "mother",
        direction: "children",
        token: "legacy:mother:children",
        hiddenCount: 2,
      },
      {
        id: "father-parents",
        personId: "father",
        direction: "parents",
        token: "legacy:father:parents",
        hiddenCount: 1,
      },
      {
        id: "unrelated-children",
        personId: "unrelated",
        direction: "children",
        token: "legacy:unrelated:children",
        hiddenCount: 3,
      },
    ],
  };

  const normalized = graphWithoutLegacyFamilyChildControls(withLegacyControls);

  assert.deepEqual(
    normalized.continuations?.map(item => `${item.personId}:${item.direction}`),
    ["father:parents", "unrelated:children"],
  );
  assert.equal(normalized.familyContinuations?.length, 1);
  const legacyOnly: FamilyGraphData = {
    ...withLegacyControls,
    familyContinuations: undefined,
  };
  assert.equal(graphWithoutLegacyFamilyChildControls(legacyOnly), legacyOnly);
});

test("after expansion only the clicked parent's duplicate remains for that family", () => {
  const shared = scope("shared", ["father", "mother"]);
  const { graph, layout } = fixture({
    continuations: [continuation(shared, true)],
  });

  const controls = positionFamilyContinuations(graph, layout, {
    activeOwnerByScope: new Map([[shared.id, "mother"]]),
  });

  assert.deepEqual(controlKeys(controls), ["shared:mother"]);
  assert.equal(controls[0]?.anchorOccurrenceId, "person:mother");
  assert.equal(controls[0]?.continuation.expanded, true);
  assert.equal(controls[0]?.continuation.hiddenCount, undefined);
});

test("the co-parent keeps a control only for children with another partner", () => {
  const shared = scope("shared", ["father", "mother"]);
  const otherFamily = scope("other-family", ["mother", "other-partner"]);
  const { graph, layout } = fixture({
    people: ["father", "mother", "other-partner"],
    continuations: [
      continuation(shared, true),
      continuation(otherFamily),
    ],
  });

  const controls = positionFamilyContinuations(graph, layout, {
    activeOwnerByScope: new Map([[shared.id, "father"]]),
  });

  assert.deepEqual(controlKeys(controls), [
    "other-family:mother",
    "other-family:other-partner",
    "shared:father",
  ]);
  assert.equal(
    controls.some(
      control =>
        control.continuation.scope.id === shared.id &&
        control.ownerPersonId === "mother",
    ),
    false,
  );
  assert.equal(
    controls.some(
      control =>
        control.continuation.scope.id === otherFamily.id &&
        control.ownerPersonId === "mother",
    ),
    true,
  );
});

test("a family control shares the card-bottom row without covering legacy branch controls", () => {
  const shared = scope("shared", ["father", "mother"]);
  const auxiliaryNodes: LayoutNode[] = [
    {
      occurrenceId: "continuation:father:parents",
      kind: "continuation",
      generation: 0,
      x: 114,
      y: 167,
      width: 28,
      height: 28,
      orderKey: "parents",
      continuation: {
        id: "father-parents",
        personId: "father",
        direction: "parents",
        token: "server:father:parents",
        hiddenCount: 1,
      },
    },
    {
      occurrenceId: "continuation:father:partners",
      kind: "continuation",
      generation: 0,
      x: 146,
      y: 167,
      width: 28,
      height: 28,
      orderKey: "partners",
      continuation: {
        id: "father-partners",
        personId: "father",
        direction: "partners",
        token: "server:father:partners",
        hiddenCount: 1,
      },
    },
  ];
  const { graph, layout } = fixture({
    continuations: [continuation(shared)],
    auxiliaryNodes,
  });

  const fatherControl = positionFamilyContinuations(graph, layout).find(
    control => control.ownerPersonId === "father",
  );

  assert.ok(fatherControl);
  for (const auxiliary of auxiliaryNodes) {
    assert.equal(rectanglesIntersect(fatherControl, auxiliary), false);
  }
  assert.equal(fatherControl.anchorOccurrenceId, "person:father");
});

test("collapse and reopen are idempotent and never duplicate a card-family control", () => {
  const shared = scope("shared", ["father", "mother"]);
  const base = fixture({ continuations: [continuation(shared)] });
  const layerKey = familyTreeFamilyBranchKey(shared.id);
  const layer: FamilyTreeBranchLayer = {
    scopeKind: "family",
    key: layerKey,
    scope: shared,
    consumedToken: `server:${shared.id}`,
    response: {
      persons: [person("father"), person("mother"), person("child")],
      unions: [
        {
          id: shared.unionIds![0]!,
          kind: "parent-set",
          memberIds: shared.parentIds,
        },
      ],
      parentChildRelations: [
        {
          id: "father-child",
          parentId: "father",
          childId: "child",
          unionId: shared.unionIds![0]!,
          kind: "biological",
        },
        {
          id: "mother-child",
          parentId: "mother",
          childId: "child",
          unionId: shared.unionIds![0]!,
          kind: "biological",
        },
      ],
      continuations: [],
      familyContinuations: [],
    },
  };
  const layers = new Map([[layerKey, layer]]);
  const firstOpenGraph = composeFamilyTreeBranchLayers(
    base.graph,
    layers,
    new Set([layerKey]),
  );
  const collapsedGraph = composeFamilyTreeBranchLayers(
    base.graph,
    layers,
    new Set(),
  );
  const reopenedGraph = composeFamilyTreeBranchLayers(
    base.graph,
    layers,
    new Set([layerKey]),
  );
  const options = {
    activeOwnerByScope: new Map([[shared.id, "father"]]),
  };

  const firstOpen = positionFamilyContinuations(
    firstOpenGraph,
    base.layout,
    options,
  );
  const collapsed = positionFamilyContinuations(
    collapsedGraph,
    base.layout,
    options,
  );
  const reopened = positionFamilyContinuations(
    reopenedGraph,
    base.layout,
    options,
  );

  assert.deepEqual(controlKeys(firstOpen), ["shared:father"]);
  assert.deepEqual(controlKeys(collapsed), ["shared:father", "shared:mother"]);
  assert.deepEqual(reopened, firstOpen);
  assert.deepEqual(reopenedGraph, firstOpenGraph);
  assert.equal(firstOpenGraph.persons.some(item => item.id === "child"), true);
  assert.equal(collapsedGraph.persons.some(item => item.id === "child"), false);
  assert.equal(
    firstOpenGraph.persons.length,
    new Set(firstOpenGraph.persons.map(item => item.id)).size,
  );
  for (const controls of [firstOpen, collapsed, reopened]) {
    assert.equal(
      controls.length,
      new Set(
        controls.map(
          control =>
            `${control.continuation.scope.id}:${control.ownerPersonId}`,
        ),
      ).size,
    );
    assert.equal(controls.length, new Set(controls.map(control => control.id)).size);
  }
});

test("positioning card controls never creates or mutates union lines", () => {
  const shared = scope("shared", ["father", "mother"]);
  const sharedUnion = union(shared, ["person:father", "person:mother"]);
  const edges: LayoutEdge[] = [
    {
      id: "partnership-line",
      sourceId: "person:father",
      targetId: "person:mother",
      unionOccurrenceId: sharedUnion.occurrenceId,
      kind: "partnership",
      points: [
        { x: 180, y: 100 },
        { x: 260, y: 100 },
      ],
    },
  ];
  const { graph, layout } = fixture({
    continuations: [continuation(shared)],
    unions: [sharedUnion],
    edges,
  });
  const graphBefore = structuredClone(graph);
  const unionsBefore = structuredClone(layout.unions);
  const edgesBefore = structuredClone(layout.edges);

  const controls = positionFamilyContinuations(graph, layout);

  assert.deepEqual(graph, graphBefore);
  assert.deepEqual(layout.unions, unionsBefore);
  assert.deepEqual(layout.edges, edgesBefore);
  assert.equal(layout.unions.length, 1);
  assert.equal(layout.edges.length, 1);
  assert.equal(
    controls.every(control =>
      layout.nodes.some(node => node.occurrenceId === control.anchorOccurrenceId),
    ),
    true,
  );
});
