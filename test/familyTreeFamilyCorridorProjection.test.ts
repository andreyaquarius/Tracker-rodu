import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFamilyCorridorProjection,
  familyCorridorScopeKey,
  projectFamilyCorridorGraph,
  type FamilyCorridorScope,
} from "../src/features/family-tree-view/state/familyCorridorProjection.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

function person(id: string): TreePerson {
  return { id, displayName: id };
}

function partnership(
  id: string,
  familyGroupId: string,
  memberIds: readonly string[],
): TreeUnion {
  return { id, familyGroupId, memberIds, kind: "partnership" };
}

function parentSet(
  id: string,
  familyGroupId: string,
  memberIds: readonly string[],
): TreeUnion {
  return { id, familyGroupId, memberIds, kind: "parent-set" };
}

function relation(
  id: string,
  parentId: string,
  childId: string,
  unionId?: string,
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    ...(unionId ? { unionId } : {}),
    kind: "biological",
  };
}

function familyContinuation(
  id: string,
  familyGroupId: string,
  parentIds: readonly string[],
  unionIds: readonly string[],
): FamilyContinuation {
  return {
    id,
    scope: { id: `family-group:${familyGroupId}`, familyGroupId, parentIds, unionIds },
    token: `cursor:${id}`,
    hiddenCount: 1,
  };
}

function ids(values: readonly { id: string }[]): string[] {
  return values.map(value => value.id).sort();
}

function corridorFixture(): FamilyGraphData {
  const personIds = [
    "grandfather",
    "grandmother",
    "father",
    "mother",
    "aunt",
    "child-line",
    "child-other",
    "line-spouse",
    "focus",
    "focus-sibling",
    "other-partner",
    "side-child",
    "nested-partner",
    "nested-child",
    "deep-partner",
    "deep-child",
    "unrelated-a",
    "unrelated-b",
    "unrelated-child",
  ];
  const unions: TreeUnion[] = [
    partnership("ancestors-partnership", "ancestors", ["grandfather", "grandmother"]),
    parentSet("ancestors-father", "ancestors", ["grandfather", "grandmother"]),
    parentSet("ancestors-aunt", "ancestors", ["grandfather", "grandmother"]),
    partnership("selected-partnership", "selected", ["father", "mother"]),
    parentSet("selected-child-line", "selected", ["father", "mother"]),
    parentSet("selected-child-other", "selected", ["father", "mother"]),
    partnership("side-partnership", "side", ["father", "other-partner"]),
    parentSet("side-parent-set", "side", ["father", "other-partner"]),
    partnership("line-partnership", "line", ["child-line", "line-spouse"]),
    parentSet("line-focus", "line", ["child-line", "line-spouse"]),
    parentSet("line-focus-sibling", "line", ["child-line", "line-spouse"]),
    partnership("nested-partnership", "z-nested", ["child-other", "nested-partner"]),
    parentSet("nested-parent-set", "z-nested", ["child-other", "nested-partner"]),
    partnership("deep-partnership", "a-deep", ["nested-child", "deep-partner"]),
    parentSet("deep-parent-set", "a-deep", ["nested-child", "deep-partner"]),
    partnership("unrelated-partnership", "unrelated", ["unrelated-a", "unrelated-b"]),
    parentSet("unrelated-parent-set", "unrelated", ["unrelated-a", "unrelated-b"]),
  ];
  const parentChildRelations: ParentChildRelation[] = [
    relation("grandfather-father", "grandfather", "father", "ancestors-father"),
    relation("grandmother-father", "grandmother", "father", "ancestors-father"),
    relation("grandfather-aunt", "grandfather", "aunt", "ancestors-aunt"),
    relation("grandmother-aunt", "grandmother", "aunt", "ancestors-aunt"),
    relation("father-child-line", "father", "child-line", "selected-child-line"),
    relation("mother-child-line", "mother", "child-line", "selected-child-line"),
    relation("father-child-other", "father", "child-other", "selected-child-other"),
    relation("mother-child-other", "mother", "child-other", "selected-child-other"),
    relation("father-side-child", "father", "side-child", "side-parent-set"),
    relation("other-side-child", "other-partner", "side-child", "side-parent-set"),
    relation("line-focus", "child-line", "focus", "line-focus"),
    relation("spouse-focus", "line-spouse", "focus", "line-focus"),
    relation("line-focus-sibling", "child-line", "focus-sibling", "line-focus-sibling"),
    relation("spouse-focus-sibling", "line-spouse", "focus-sibling", "line-focus-sibling"),
    relation("other-nested", "child-other", "nested-child", "nested-parent-set"),
    relation("partner-nested", "nested-partner", "nested-child", "nested-parent-set"),
    relation("nested-deep", "nested-child", "deep-child", "deep-parent-set"),
    relation("partner-deep", "deep-partner", "deep-child", "deep-parent-set"),
    relation("unrelated-a-child", "unrelated-a", "unrelated-child", "unrelated-parent-set"),
    relation("unrelated-b-child", "unrelated-b", "unrelated-child", "unrelated-parent-set"),
  ];
  return {
    persons: personIds.map(person),
    unions,
    parentChildRelations,
    continuations: [
      { id: "keep-parents", personId: "grandfather", direction: "parents", token: "parents" },
      { id: "keep-children", personId: "child-other", direction: "children", token: "children" },
      { id: "drop-siblings", personId: "father", direction: "siblings", token: "siblings" },
      { id: "drop-unbound-partners", personId: "father", direction: "partners", token: "partners" },
      {
        id: "keep-bound-partner",
        personId: "father",
        direction: "partners",
        token: "selected-partner",
        unionId: "selected-partnership",
      },
      {
        id: "drop-side-family",
        personId: "father",
        direction: "children",
        token: "side-family",
        unionId: "side-parent-set",
      },
      { id: "drop-hidden-person", personId: "side-child", direction: "children", token: "hidden" },
    ],
    familyContinuations: [
      familyContinuation(
        "selected-family-control",
        "selected",
        ["father", "mother"],
        ["selected-partnership", "selected-child-line", "selected-child-other"],
      ),
      familyContinuation(
        "line-family-control",
        "line",
        ["child-line", "line-spouse"],
        ["line-partnership", "line-focus", "line-focus-sibling"],
      ),
      familyContinuation(
        "nested-family-control",
        "z-nested",
        ["child-other", "nested-partner"],
        ["nested-partnership", "nested-parent-set"],
      ),
      familyContinuation(
        "deep-family-control",
        "a-deep",
        ["nested-child", "deep-partner"],
        ["deep-partnership", "deep-parent-set"],
      ),
      familyContinuation(
        "side-family-control",
        "side",
        ["father", "other-partner"],
        ["side-partnership", "side-parent-set"],
      ),
      familyContinuation(
        "unrelated-family-control",
        "unrelated",
        ["unrelated-a", "unrelated-b"],
        ["unrelated-partnership", "unrelated-parent-set"],
      ),
    ],
    graphVersion: 73,
    permissionFingerprint: "rls-scope",
  };
}

test("isolates one family, its ancestors, direct children and every loaded path to focus", () => {
  const graph = corridorFixture();
  const result = buildFamilyCorridorProjection({
    graph,
    selectedFamily: { familyGroupId: "selected" },
    originalFocusPersonId: "focus",
  });

  assert.equal(result.hasPathToOriginalFocus, true);
  assert.equal(result.perspectiveFocusPersonId, "focus");
  assert.deepEqual(result.directChildIds, ["child-line", "child-other"]);
  assert.deepEqual(result.pathPersonIds, ["child-line", "father", "focus", "mother"]);
  assert.deepEqual(ids(result.graph.persons), [
    "child-line",
    "child-other",
    "father",
    "focus",
    "grandfather",
    "grandmother",
    "line-spouse",
    "mother",
  ]);
  assert.deepEqual(ids(result.graph.unions), [
    "ancestors-father",
    "ancestors-partnership",
    "line-focus",
    "line-partnership",
    "selected-child-line",
    "selected-child-other",
    "selected-partnership",
  ]);
  assert.deepEqual(ids(result.graph.parentChildRelations), [
    "father-child-line",
    "father-child-other",
    "grandfather-father",
    "grandmother-father",
    "line-focus",
    "mother-child-line",
    "mother-child-other",
    "spouse-focus",
  ]);
  assert.deepEqual(ids(result.graph.continuations ?? []), [
    "keep-bound-partner",
    "keep-children",
    "keep-parents",
  ]);
  assert.deepEqual(ids(result.graph.familyContinuations ?? []), [
    "line-family-control",
    "nested-family-control",
    "selected-family-control",
  ]);
  assert.equal(result.graph.graphVersion, 73);
  assert.equal(result.graph.permissionFingerprint, "rls-scope");

  // The source graph remains an immutable cache of every loaded branch.
  assert.equal(graph.persons.length, 19);
  assert.equal(graph.unions.length, 17);
  assert.equal(graph.parentChildRelations.length, 20);
});

test("only active connected nested families add descendants, independent of input order", () => {
  const graph = corridorFixture();
  const result = buildFamilyCorridorProjection({
    graph,
    selectedFamily: { familyGroupId: "selected" },
    originalFocusPersonId: "focus",
    activeNestedFamilies: [
      { familyGroupId: "a-deep" },
      { familyGroupId: "unrelated" },
      { familyGroupId: "z-nested" },
      // An ancestor is visible, but it is not below the selected family.
      { familyGroupId: "ancestors" },
    ],
  });

  assert.deepEqual(result.activeNestedFamilyKeys, [
    "family-group:z-nested",
    "family-group:a-deep",
  ]);
  assert.equal(result.graph.persons.some(value => value.id === "nested-child"), true);
  assert.equal(result.graph.persons.some(value => value.id === "deep-child"), true);
  assert.equal(result.graph.persons.some(value => value.id === "unrelated-child"), false);
  assert.equal(result.graph.persons.some(value => value.id === "aunt"), false);

  const lineExpanded = projectFamilyCorridorGraph({
    graph,
    selectedFamily: { familyGroupId: "selected" },
    originalFocusPersonId: "focus",
    activeNestedFamilies: [{ familyGroupId: "line" }],
  });
  assert.equal(lineExpanded.persons.some(value => value.id === "focus-sibling"), true);
});

test("reports no focus path without retaining a disconnected focus or side branch", () => {
  const graph = corridorFixture();
  const result = buildFamilyCorridorProjection({
    graph,
    selectedFamily: { familyGroupId: "selected" },
    originalFocusPersonId: "unrelated-child",
  });

  assert.equal(result.hasPathToOriginalFocus, false);
  assert.deepEqual(result.pathPersonIds, []);
  assert.equal(result.perspectiveFocusPersonId, "father");
  assert.equal(result.graph.persons.some(value => value.id === "unrelated-child"), false);
  assert.equal(result.graph.persons.some(value => value.id === "side-child"), false);
  assert.equal(result.graph.persons.some(value => value.id === "child-other"), true);
});

test("keeps multiple directed paths and terminates deterministically on cycles", () => {
  const graph: FamilyGraphData = {
    persons: ["a", "b", "left", "right", "focus"].map(person),
    unions: [
      partnership("selected-p", "selected-cycle", ["a", "b"]),
      parentSet("selected-left", "selected-cycle", ["a", "b"]),
      parentSet("selected-right", "selected-cycle", ["a", "b"]),
    ],
    parentChildRelations: [
      relation("a-left", "a", "left", "selected-left"),
      relation("b-left", "b", "left", "selected-left"),
      relation("a-right", "a", "right", "selected-right"),
      relation("b-right", "b", "right", "selected-right"),
      relation("left-focus", "left", "focus"),
      relation("right-focus", "right", "focus"),
      relation("cycle", "focus", "left"),
    ],
  };
  const input = {
    graph,
    selectedFamily: { familyGroupId: "selected-cycle" },
    originalFocusPersonId: "focus",
  } as const;

  const first = buildFamilyCorridorProjection(input);
  const second = buildFamilyCorridorProjection(input);

  assert.deepEqual(first.pathPersonIds, ["a", "b", "focus", "left", "right"]);
  assert.deepEqual(ids(first.graph.parentChildRelations), [
    "a-left",
    "a-right",
    "b-left",
    "b-right",
    "cycle",
    "left-focus",
    "right-focus",
  ]);
  assert.deepEqual(ids(first.graph.persons), ids(second.graph.persons));
  assert.deepEqual(ids(first.graph.parentChildRelations), ids(second.graph.parentChildRelations));
});

test("family keys resolve legacy families by parents and safely encode IDs", () => {
  const parentIds = ["parent,one", "parent/two"];
  const scope: FamilyCorridorScope = { parentIds };
  const key = familyCorridorScopeKey(scope);
  const graph: FamilyGraphData = {
    persons: [...parentIds, "child"].map(person),
    unions: [
      { id: "legacy-partnership", kind: "partnership", memberIds: [...parentIds].reverse() },
      { id: "legacy-parent-set", kind: "parent-set", memberIds: parentIds },
    ],
    parentChildRelations: [
      relation("legacy-one", parentIds[0], "child", "legacy-parent-set"),
      relation("legacy-two", parentIds[1], "child", "legacy-parent-set"),
    ],
  };

  assert.match(key, /^parents:/);
  const result = buildFamilyCorridorProjection({
    graph,
    selectedFamily: { familyKey: key },
    originalFocusPersonId: "child",
  });
  assert.deepEqual(result.selectedParentIds, [...parentIds].sort());
  assert.deepEqual(result.directChildIds, ["child"]);
  assert.deepEqual(ids(result.graph.unions), ["legacy-parent-set", "legacy-partnership"]);
});

test("parent identity splits an accidentally reused family group", () => {
  const graph: FamilyGraphData = {
    persons: ["a", "b", "their-child", "x", "y", "other-child"].map(person),
    unions: [
      partnership("ab-partnership", "leaked-group", ["a", "b"]),
      parentSet("ab-parent-set", "leaked-group", ["a", "b"]),
      partnership("xy-partnership", "leaked-group", ["x", "y"]),
      parentSet("xy-parent-set", "leaked-group", ["x", "y"]),
    ],
    parentChildRelations: [
      relation("a-child", "a", "their-child", "ab-parent-set"),
      relation("b-child", "b", "their-child", "ab-parent-set"),
      relation("x-child", "x", "other-child", "xy-parent-set"),
      relation("y-child", "y", "other-child", "xy-parent-set"),
    ],
  };

  const result = buildFamilyCorridorProjection({
    graph,
    selectedFamily: {
      familyGroupId: "leaked-group",
      parentIds: ["a", "b"],
      unionIds: ["ab-partnership", "ab-parent-set"],
    },
    originalFocusPersonId: "their-child",
  });

  assert.deepEqual(ids(result.graph.persons), ["a", "b", "their-child"]);
  assert.deepEqual(ids(result.graph.unions), ["ab-parent-set", "ab-partnership"]);
  assert.deepEqual(ids(result.graph.parentChildRelations), ["a-child", "b-child"]);
});
