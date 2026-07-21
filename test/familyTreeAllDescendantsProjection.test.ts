import test from "node:test";
import assert from "node:assert/strict";
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

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

function union(
  id: string,
  kind: TreeUnion["kind"],
  memberIds: readonly string[],
): TreeUnion {
  return { id, kind, memberIds };
}

function ids(values: readonly { id: string }[]): string[] {
  return values.map(value => value.id).sort();
}

test("all-descendants keeps descendants and co-parents but excludes spouse-side families", () => {
  const personIds = [
    "ancestor",
    "root",
    "sibling",
    "partner",
    "partner-other",
    "child",
    "partner-unrelated-child",
    "child-partner",
    "grandchild",
    "child-partner-unrelated-child",
  ];
  const graph: FamilyGraphData = {
    persons: personIds.map(id => ({ id, displayName: id })),
    unions: [
      union("ancestor-family", "parent-set", ["ancestor"]),
      union("root-partnership", "partnership", ["root", "partner"]),
      union("root-family", "parent-set", ["root", "partner"]),
      union("partner-other-family", "parent-set", ["partner", "partner-other"]),
      union("child-partnership", "partnership", ["child", "child-partner"]),
      union("child-family", "parent-set", ["child", "child-partner"]),
      union("child-partner-other", "parent-set", ["child-partner"]),
    ],
    parentChildRelations: [
      relation("ancestor-root", "ancestor", "root", "ancestor-family"),
      relation("ancestor-sibling", "ancestor", "sibling", "ancestor-family"),
      relation("root-child", "root", "child", "root-family"),
      relation("partner-child", "partner", "child", "root-family"),
      relation(
        "partner-unrelated",
        "partner",
        "partner-unrelated-child",
        "partner-other-family",
      ),
      relation(
        "partner-other-unrelated",
        "partner-other",
        "partner-unrelated-child",
        "partner-other-family",
      ),
      relation("child-grandchild", "child", "grandchild", "child-family"),
      relation(
        "child-partner-grandchild",
        "child-partner",
        "grandchild",
        "child-family",
      ),
      relation(
        "child-partner-unrelated",
        "child-partner",
        "child-partner-unrelated-child",
        "child-partner-other",
      ),
    ],
    continuations: [
      {
        id: "root-children",
        personId: "root",
        direction: "children",
        token: "root:children",
      },
      {
        id: "root-parents",
        personId: "root",
        direction: "parents",
        token: "root:parents",
      },
      {
        id: "partner-children",
        personId: "partner",
        direction: "children",
        token: "partner:children",
      },
    ],
    familyContinuations: [
      {
        id: "root-family-control",
        scope: { id: "root-family", parentIds: ["root", "partner"] },
        token: "root-family-control",
      },
      {
        id: "partner-other-control",
        scope: {
          id: "partner-other-family",
          parentIds: ["partner", "partner-other"],
        },
        token: "partner-other-control",
      },
      {
        id: "child-family-control",
        scope: {
          id: "child-family",
          parentIds: ["child", "child-partner"],
        },
        token: "child-family-control",
      },
    ],
  };
  const before = structuredClone(graph);

  const result = buildAllDescendantsProjection({ graph, rootPersonId: "root" });

  assert.deepEqual(ids(result.graph.persons), [
    "child",
    "child-partner",
    "grandchild",
    "partner",
    "root",
  ]);
  assert.deepEqual(result.descendantPersonIds, ["root", "child", "grandchild"]);
  assert.deepEqual(result.connectorPersonIds, ["child-partner", "partner"]);
  assert.deepEqual(ids(result.graph.unions), [
    "child-family",
    "child-partnership",
    "root-family",
    "root-partnership",
  ]);
  assert.deepEqual(ids(result.graph.parentChildRelations), [
    "child-grandchild",
    "child-partner-grandchild",
    "partner-child",
    "root-child",
  ]);
  assert.deepEqual(
    result.graph.continuations?.map(item => `${item.personId}:${item.direction}`),
    ["root:children"],
  );
  assert.deepEqual(
    result.graph.familyContinuations?.map(item => item.scope.id),
    ["root-family", "child-family"],
  );
  assert.deepEqual(graph, before);
});

test("all-descendants keeps every selected-person partnership and descendant branch while excluding the ancestor side", () => {
  const personIds = [
    "ancestor",
    "ancestor-partner",
    "ancestor-side-child",
    "root",
    "root-sibling",
    "partner-a",
    "partner-b",
    "childless-partner",
    "partner-a-other-partner",
    "partner-a-other-child",
    "child-a",
    "child-b",
    "child-a-partner",
    "grandchild-a",
  ];
  const graph: FamilyGraphData = {
    persons: personIds.map(id => ({ id, displayName: id })),
    unions: [
      union("ancestor-partnership", "partnership", ["ancestor", "ancestor-partner"]),
      union("ancestor-family", "parent-set", ["ancestor", "ancestor-partner"]),
      union("root-partner-a", "partnership", ["root", "partner-a"]),
      union("root-partner-b", "partnership", ["root", "partner-b"]),
      union("root-childless-partner", "partnership", ["root", "childless-partner"]),
      union("root-family-a", "parent-set", ["root", "partner-a"]),
      union("root-family-b", "parent-set", ["root", "partner-b"]),
      union("partner-a-side-partnership", "partnership", [
        "partner-a",
        "partner-a-other-partner",
      ]),
      union("partner-a-side-family", "parent-set", [
        "partner-a",
        "partner-a-other-partner",
      ]),
      union("child-a-partnership", "partnership", ["child-a", "child-a-partner"]),
      union("child-a-family", "parent-set", ["child-a", "child-a-partner"]),
    ],
    parentChildRelations: [
      relation("ancestor-root", "ancestor", "root", "ancestor-family"),
      relation(
        "ancestor-partner-root",
        "ancestor-partner",
        "root",
        "ancestor-family",
      ),
      relation(
        "ancestor-side-child",
        "ancestor",
        "ancestor-side-child",
        "ancestor-family",
      ),
      relation("ancestor-sibling", "ancestor", "root-sibling", "ancestor-family"),
      relation("root-child-a", "root", "child-a", "root-family-a"),
      relation("partner-a-child-a", "partner-a", "child-a", "root-family-a"),
      relation("root-child-b", "root", "child-b", "root-family-b"),
      relation("partner-b-child-b", "partner-b", "child-b", "root-family-b"),
      relation(
        "partner-a-other-child",
        "partner-a",
        "partner-a-other-child",
        "partner-a-side-family",
      ),
      relation(
        "partner-a-other-partner-child",
        "partner-a-other-partner",
        "partner-a-other-child",
        "partner-a-side-family",
      ),
      relation(
        "child-a-grandchild",
        "child-a",
        "grandchild-a",
        "child-a-family",
      ),
      relation(
        "child-a-partner-grandchild",
        "child-a-partner",
        "grandchild-a",
        "child-a-family",
      ),
    ],
  };

  const result = buildAllDescendantsProjection({ graph, rootPersonId: "root" });

  assert.deepEqual(result.descendantPersonIds, [
    "root",
    "child-a",
    "child-b",
    "grandchild-a",
  ]);
  assert.deepEqual(result.connectorPersonIds, [
    "child-a-partner",
    "childless-partner",
    "partner-a",
    "partner-b",
  ]);
  assert.deepEqual(ids(result.graph.persons), [
    "child-a",
    "child-a-partner",
    "child-b",
    "childless-partner",
    "grandchild-a",
    "partner-a",
    "partner-b",
    "root",
  ]);
  assert.deepEqual(ids(result.graph.unions), [
    "child-a-family",
    "child-a-partnership",
    "root-childless-partner",
    "root-family-a",
    "root-family-b",
    "root-partner-a",
    "root-partner-b",
  ]);
  assert.deepEqual(ids(result.graph.parentChildRelations), [
    "child-a-grandchild",
    "child-a-partner-grandchild",
    "partner-a-child-a",
    "partner-b-child-b",
    "root-child-a",
    "root-child-b",
  ]);
  for (const excludedId of [
    "ancestor",
    "ancestor-partner",
    "ancestor-side-child",
    "root-sibling",
    "partner-a-other-partner",
    "partner-a-other-child",
  ]) {
    assert.equal(
      result.graph.persons.some(person => person.id === excludedId),
      false,
      `${excludedId} belongs outside the selected person's descendant closure`,
    );
  }
});

test("all-descendants traversal is finite and deterministic for a cycle", () => {
  const graph: FamilyGraphData = {
    persons: ["a", "b", "c"].map(id => ({ id, displayName: id })),
    unions: [],
    parentChildRelations: [
      relation("a-b", "a", "b"),
      relation("b-c", "b", "c"),
      relation("c-a", "c", "a"),
    ],
  };

  const first = buildAllDescendantsProjection({ graph, rootPersonId: "a" });
  const second = buildAllDescendantsProjection({ graph, rootPersonId: "a" });

  assert.deepEqual(first.descendantPersonIds, ["a", "b", "c"]);
  assert.deepEqual(second.graph, first.graph);
});

test("focus lineage keeps the loaded path from the descendant root to the original focus", () => {
  const graph: FamilyGraphData = {
    persons: ["root", "line-child", "focus", "side-child"].map(id => ({
      id,
      displayName: id,
    })),
    unions: [],
    parentChildRelations: [
      relation("root-line", "root", "line-child"),
      relation("line-focus", "line-child", "focus"),
      relation("root-side", "root", "side-child"),
    ],
  };

  const result = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "focus",
  });

  assert.deepEqual(result.focusLineagePersonIds, [
    "focus",
    "line-child",
    "root",
  ]);
});

test("focus lineage falls back to the selected root when the original focus is outside its descendant closure", () => {
  const graph: FamilyGraphData = {
    persons: ["root", "child", "outside-parent", "outside-focus"].map(id => ({
      id,
      displayName: id,
    })),
    unions: [],
    parentChildRelations: [
      relation("root-child", "root", "child"),
      relation("outside-line", "outside-parent", "outside-focus"),
    ],
  };

  const result = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "outside-focus",
  });

  assert.deepEqual(result.focusLineagePersonIds, ["root"]);
});

test("focus lineage traversal remains finite and deterministic when the loaded relations contain a cycle", () => {
  const graph: FamilyGraphData = {
    persons: ["root", "cycle-a", "focus"].map(id => ({
      id,
      displayName: id,
    })),
    unions: [],
    parentChildRelations: [
      relation("root-a", "root", "cycle-a"),
      relation("a-focus", "cycle-a", "focus"),
      relation("focus-root", "focus", "root"),
    ],
  };

  const first = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "focus",
  });
  const second = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "focus",
  });

  assert.deepEqual(first.focusLineagePersonIds, ["cycle-a", "focus", "root"]);
  assert.deepEqual(second.focusLineagePersonIds, first.focusLineagePersonIds);
});

test("focus lineage excludes side children and connector partners that do not lead to the original focus", () => {
  const graph: FamilyGraphData = {
    persons: [
      "root",
      "line-partner",
      "side-partner",
      "line-child",
      "side-child",
      "focus",
    ].map(id => ({ id, displayName: id })),
    unions: [
      union("line-family", "parent-set", ["root", "line-partner"]),
      union("side-family", "parent-set", ["root", "side-partner"]),
    ],
    parentChildRelations: [
      relation("root-line", "root", "line-child", "line-family"),
      relation(
        "line-partner-line",
        "line-partner",
        "line-child",
        "line-family",
      ),
      relation("line-focus", "line-child", "focus"),
      relation("root-side", "root", "side-child", "side-family"),
      relation(
        "side-partner-side",
        "side-partner",
        "side-child",
        "side-family",
      ),
    ],
  };

  const result = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "focus",
  });

  assert.deepEqual(result.connectorPersonIds, ["line-partner", "side-partner"]);
  assert.deepEqual(result.focusLineagePersonIds, [
    "focus",
    "line-child",
    "line-partner",
    "root",
  ]);
  assert.equal(result.focusLineagePersonIds.includes("side-child"), false);
  assert.equal(result.focusLineagePersonIds.includes("side-partner"), false);
});

test("a missing descendant root yields an isolated empty graph", () => {
  const graph: FamilyGraphData = {
    persons: [{ id: "someone", displayName: "someone" }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: [],
  };

  const result = buildAllDescendantsProjection({
    graph,
    rootPersonId: "missing",
  });

  assert.equal(result.graph.persons.length, 0);
  assert.equal(result.graph.unions.length, 0);
  assert.equal(result.graph.parentChildRelations.length, 0);
});
