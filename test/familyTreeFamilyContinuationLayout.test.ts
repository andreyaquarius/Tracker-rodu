import test from "node:test";
import assert from "node:assert/strict";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { positionFamilyContinuations } from "../src/features/family-tree-view/react/familyContinuationLayout.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function parentRelations(
  parents: readonly string[],
  childId: string,
  unionId: string,
): ParentChildRelation[] {
  return parents.map((parentId, index) => ({
    id: `${unionId}:${parentId}:${childId}`,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role: index === 0 ? "father" : "mother",
  }));
}

function continuation(
  scopeId: string,
  parentIds: readonly string[],
  familyGroupId?: string,
  unionIds: readonly string[] = [],
  input: Partial<FamilyContinuation> = {},
): FamilyContinuation {
  return {
    id: `${scopeId}:${input.expanded ? "open" : "closed"}`,
    scope: {
      id: scopeId,
      parentIds,
      ...(familyGroupId ? { familyGroupId } : {}),
      ...(unionIds.length ? { unionIds } : {}),
    },
    token: `cursor:${scopeId}`,
    hiddenCount: 2,
    ...input,
  };
}

test("an expanded family control stays below the parent card that opened it", () => {
  const graph: FamilyGraphData = {
    persons: [person("father"), person("mother"), person("child")],
    unions: [
      {
        id: "partnership",
        kind: "partnership",
        memberIds: ["father", "mother"],
        familyGroupId: "family",
      },
      {
        id: "parent-set",
        kind: "parent-set",
        memberIds: ["father", "mother"],
        familyGroupId: "family",
      },
    ],
    parentChildRelations: parentRelations(
      ["father", "mother"],
      "child",
      "parent-set",
    ),
    familyContinuations: [
      continuation(
        "family:one",
        ["father", "mother"],
        "family",
        ["partnership", "parent-set"],
      ),
      continuation(
        "family:one",
        ["father", "mother"],
        "family",
        ["partnership", "parent-set"],
        { expanded: true },
      ),
    ],
  };
  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "father",
      ancestorDepth: 0,
      descendantDepth: 1,
      collateralDepth: 0,
      showUnknownParentPlaceholders: false,
    },
  });
  const controls = positionFamilyContinuations(graph, layout, {
    activeOwnerByScope: new Map([["family:one", "mother"]]),
  });

  assert.equal(controls.length, 1);
  assert.equal(controls[0]?.continuation.expanded, true);
  assert.equal(controls[0]?.ownerPersonId, "mother");
  const anchor = layout.nodes.find(node =>
    node.occurrenceId === controls[0]?.anchorOccurrenceId,
  );
  assert.ok(anchor);
  assert.equal(anchor.personId, "mother");
  assert.equal(
    controls[0]?.x! + controls[0]?.width! / 2,
    anchor.x + anchor.width / 2,
  );
});

test("a person shows one family control while each visible partner keeps theirs", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("partner-a"),
      person("partner-b"),
      person("child-a"),
      person("child-b"),
    ],
    unions: [
      {
        id: "family-a",
        kind: "partnership",
        memberIds: ["focus", "partner-a"],
        familyGroupId: "a",
      },
      {
        id: "family-b",
        kind: "partnership",
        memberIds: ["focus", "partner-b"],
        familyGroupId: "b",
      },
    ],
    parentChildRelations: [
      ...parentRelations(["focus", "partner-a"], "child-a", "family-a"),
      ...parentRelations(["focus", "partner-b"], "child-b", "family-b"),
    ],
    familyContinuations: [
      continuation("family:a", ["focus", "partner-a"], "a", ["family-a"]),
      continuation("family:b", ["focus", "partner-b"], "b", ["family-b"]),
    ],
  };
  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "focus",
      ancestorDepth: 0,
      descendantDepth: 1,
      collateralDepth: 1,
      showUnknownParentPlaceholders: false,
    },
  });
  const controls = positionFamilyContinuations(graph, layout);

  assert.deepEqual(
    controls
      .map(
        control =>
          `${control.continuation.scope.id}:${control.ownerPersonId}`,
      )
      .sort(),
    [
      "family:a:focus",
      "family:a:partner-a",
      "family:b:partner-b",
    ],
  );
});

test("a reused family group never moves a control below another partner card", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("partner-a"), person("partner-b")],
    unions: [
      {
        id: "family-a",
        kind: "partnership",
        memberIds: ["focus", "partner-a"],
        familyGroupId: "leaked-group",
      },
      {
        id: "family-b",
        kind: "partnership",
        memberIds: ["focus", "partner-b"],
        familyGroupId: "leaked-group",
      },
    ],
    parentChildRelations: [],
    familyContinuations: [
      continuation(
        "scope-b",
        ["focus", "partner-b"],
        "leaked-group",
      ),
    ],
  };
  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "focus",
      ancestorDepth: 0,
      descendantDepth: 0,
      collateralDepth: 1,
      showUnknownParentPlaceholders: false,
    },
  });
  const controls = positionFamilyContinuations(graph, layout);
  const ownerIds = controls.map(control => control.ownerPersonId).sort();
  const anchoredPeople = controls.map(control =>
    layout.nodes.find(node => node.occurrenceId === control.anchorOccurrenceId)
      ?.personId,
  );

  assert.deepEqual(ownerIds, ["focus", "partner-b"]);
  assert.deepEqual(anchoredPeople.sort(), ["focus", "partner-b"]);
});

test("fallback placement uses at most one occurrence of each visible parent", () => {
  const graph: FamilyGraphData = {
    persons: [person("parent-a"), person("parent-b")],
    unions: [],
    parentChildRelations: [],
    familyContinuations: [
      continuation("scope", ["parent-a", "parent-b"]),
    ],
  };
  const layout = {
    nodes: [
      {
        occurrenceId: "person:parent-a",
        personId: "parent-a",
        kind: "person" as const,
        generation: 0,
        x: 100,
        y: 50,
        width: 100,
        height: 120,
        orderKey: "a",
      },
      {
        occurrenceId: "reference:parent-a",
        personId: "parent-a",
        kind: "reference" as const,
        generation: 1,
        x: 500,
        y: 250,
        width: 100,
        height: 120,
        orderKey: "b",
      },
    ],
    unions: [],
    edges: [],
    bounds: { left: 100, top: 50, right: 600, bottom: 370 },
    generationBands: [],
    warnings: [],
  };
  const control = positionFamilyContinuations(graph, layout)[0];

  assert.equal(control?.anchorOccurrenceId, "person:parent-a");
  assert.equal(control?.x, 135);
});
