import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRootLineageProjection,
  mergeRootLineageOverlay,
} from "../src/features/family-tree-view/state/rootLineageProjection.ts";
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

function person(id: PersonId): TreePerson {
  return { id, displayName: id, sex: "unknown" };
}

function relation(
  id: string,
  parentId: PersonId,
  childId: PersonId,
  unionId: string,
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role: "parent",
  };
}

function fixture(): FamilyGraphData {
  return {
    persons: [
      "home",
      "father",
      "mother",
      "paternal-grandfather",
      "paternal-grandmother",
      "maternal-grandfather",
      "maternal-grandmother",
      "sibling",
      "sibling-spouse",
      "spouse",
      "side-child",
      "unrelated",
    ].map(person),
    unions: [
      { id: "home-parents", kind: "parent-set", memberIds: ["father", "mother"] },
      { id: "home-parents-partnership", kind: "partnership", memberIds: ["father", "mother"] },
      {
        id: "father-parents",
        kind: "parent-set",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "mother-parents",
        kind: "parent-set",
        memberIds: ["maternal-grandfather", "maternal-grandmother"],
      },
      { id: "home-spouse", kind: "partnership", memberIds: ["home", "spouse"] },
      {
        id: "sibling-spouse",
        kind: "partnership",
        memberIds: ["sibling", "sibling-spouse"],
      },
      { id: "side-family", kind: "parent-set", memberIds: ["unrelated"] },
    ],
    parentChildRelations: [
      relation("father-home", "father", "home", "home-parents"),
      relation("mother-home", "mother", "home", "home-parents"),
      relation("father-sibling", "father", "sibling", "home-parents"),
      relation("mother-sibling", "mother", "sibling", "home-parents"),
      relation(
        "paternal-grandfather-father",
        "paternal-grandfather",
        "father",
        "father-parents",
      ),
      relation(
        "paternal-grandmother-father",
        "paternal-grandmother",
        "father",
        "father-parents",
      ),
      relation(
        "maternal-grandfather-mother",
        "maternal-grandfather",
        "mother",
        "mother-parents",
      ),
      relation(
        "maternal-grandmother-mother",
        "maternal-grandmother",
        "mother",
        "mother-parents",
      ),
      relation("unrelated-side", "unrelated", "side-child", "side-family"),
    ],
    graphVersion: "version-7",
    permissionFingerprint: "project-a",
  };
}

test("keeps the complete bilateral ancestor closure and a sibling bridge", () => {
  const source = fixture();
  const result = buildRootLineageProjection({
    graph: source,
    rootPersonId: "home",
    connectPersonId: "sibling",
  });

  assert.equal(result.hasRoot, true);
  assert.equal(result.hasCompleteBridge, true);
  assert.deepEqual(result.lineagePersonIds, [
    "father",
    "home",
    "maternal-grandfather",
    "maternal-grandmother",
    "mother",
    "paternal-grandfather",
    "paternal-grandmother",
  ]);
  assert.equal(result.bridgePersonIds.includes("sibling"), true);
  assert.equal(result.bridgePersonIds.includes("home"), true);
  assert.deepEqual(
    [
      "home",
      "father",
      "mother",
      "paternal-grandfather",
      "paternal-grandmother",
      "maternal-grandfather",
      "maternal-grandmother",
      "sibling",
    ].filter(personId =>
      !result.graph.persons.some(personValue => personValue.id === personId),
    ),
    [],
  );
  assert.equal(result.graph.persons.some(value => value.id === "side-child"), false);
  assert.equal(result.graph.persons.some(value => value.id === "unrelated"), false);
  assert.equal(
    result.graph.unions.some(value => value.id === "home-parents-partnership"),
    true,
    "the visual partnership companion of a retained parent set survives",
  );
  assert.equal(
    result.graph.parentChildRelations.some(value => value.id === "father-sibling"),
    true,
    "the narrow bridge remains connected to the visual focus",
  );
  assert.equal(source.persons.length, 12, "projection must not mutate its input");
});

test("a spouse bridge uses the partnership without changing the root closure", () => {
  const result = buildRootLineageProjection({
    graph: fixture(),
    rootPersonId: "home",
    connectPersonId: "spouse",
  });

  assert.equal(result.hasCompleteBridge, true);
  assert.deepEqual(result.bridgePersonIds, ["home", "spouse"]);
  assert.equal(result.graph.unions.some(value => value.id === "home-spouse"), true);
  assert.equal(result.lineagePersonIds.includes("maternal-grandmother"), true);

  const layout = layoutFamilyGraph({
    graph: result.graph,
    options: {
      focusPersonId: "spouse",
      lineageTargetPersonId: "home",
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });
  for (const personId of result.lineagePersonIds) {
    assert.equal(
      layout.nodes.some(
        node =>
          node.personId === personId &&
          (node.lineageRole === "focus" || node.lineageRole === "direct-ancestor"),
      ),
      true,
      `${personId} must remain traversable and filled from spouse focus`,
    );
  }
});

test("missing or disconnected focus never replaces the persisted root", () => {
  const result = buildRootLineageProjection({
    graph: fixture(),
    rootPersonId: "home",
    connectPersonId: "unrelated",
  });

  assert.equal(result.hasRoot, true);
  assert.equal(result.hasCompleteBridge, false);
  assert.deepEqual(result.bridgePersonIds, []);
  assert.equal(result.lineagePersonIds.includes("home"), true);
  assert.equal(result.lineagePersonIds.includes("paternal-grandfather"), true);
  assert.equal(result.graph.persons.some(value => value.id === "unrelated"), false);
});

test("a multi-step bridge expands every partnership before reaching the root", () => {
  const projection = buildRootLineageProjection({
    graph: fixture(),
    rootPersonId: "home",
    connectPersonId: "sibling-spouse",
  });
  assert.equal(projection.hasCompleteBridge, true);
  assert.equal(projection.bridgePersonIds.includes("sibling-spouse"), true);
  assert.equal(projection.bridgePersonIds.includes("sibling"), true);
  const layout = layoutFamilyGraph({
    graph: projection.graph,
    options: {
      focusPersonId: "sibling-spouse",
      lineageTargetPersonId: "home",
      lineageBridgePersonIds: projection.bridgePersonIds,
      primaryLineagePersonIds: projection.bridgePersonIds,
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });

  for (const personId of projection.lineagePersonIds) {
    assert.equal(
      layout.nodes.some(
        node =>
          node.personId === personId &&
          (node.lineageRole === "focus" || node.lineageRole === "direct-ancestor"),
      ),
      true,
      `${personId} must remain reachable across the multi-step bridge`,
    );
  }
});

test("structural merge preserves base rows, continuations, and graph identity", () => {
  const source = fixture();
  const overlay = buildRootLineageProjection({
    graph: source,
    rootPersonId: "home",
  }).graph;
  const base: FamilyGraphData = {
    ...source,
    persons: [{ ...person("home"), displayName: "Base home" }, person("spouse")],
    unions: source.unions.filter(value => value.id === "home-spouse"),
    parentChildRelations: [],
    continuations: [
      { id: "base-more", personId: "home", direction: "children", token: "base-token" },
    ],
    familyContinuations: [],
  };
  const merged = mergeRootLineageOverlay(base, overlay);

  assert.equal(
    merged.persons.find(value => value.id === "home")?.displayName,
    "Base home",
  );
  assert.deepEqual(merged.continuations, base.continuations);
  assert.equal(merged.persons.some(value => value.id === "maternal-grandmother"), true);
  assert.equal(merged.graphVersion, base.graphVersion);
  assert.equal(merged.permissionFingerprint, base.permissionFingerprint);

  const incompatible = { ...overlay, graphVersion: "version-8" };
  assert.equal(mergeRootLineageOverlay(base, incompatible), base);
});

test("a sibling visual focus still paints both loaded root ancestor sectors", () => {
  const projection = buildRootLineageProjection({
    graph: fixture(),
    rootPersonId: "home",
    connectPersonId: "sibling",
  });
  const result = layoutFamilyGraph({
    graph: projection.graph,
    options: {
      focusPersonId: "sibling",
      lineageTargetPersonId: "home",
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });
  const filled = (personId: PersonId) => result.nodes.some(
    node =>
      node.personId === personId &&
      (node.lineageRole === "focus" || node.lineageRole === "direct-ancestor"),
  );

  for (const personId of projection.lineagePersonIds) {
    assert.equal(filled(personId), true, `${personId} must retain root fill`);
  }
  assert.equal(filled("sibling"), false);
});

test("root closure is merged after descendants-only projection before layout", () => {
  const source = fixture();
  const descendantsOnly = buildAllDescendantsProjection({
    graph: source,
    rootPersonId: "home",
  }).graph;
  assert.equal(
    descendantsOnly.persons.some(value => value.id === "maternal-grandmother"),
    false,
    "the mode projector must actually remove ancestors in this fixture",
  );
  const rootClosure = buildRootLineageProjection({
    graph: source,
    rootPersonId: "home",
    connectPersonId: "home",
  });
  const displayed = mergeRootLineageOverlay(descendantsOnly, rootClosure.graph);
  const result = layoutDescendantForest({
    graph: displayed,
    options: {
      focusPersonId: "home",
      lineageTargetPersonId: "home",
      layoutMode: "descendant-forest",
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });

  for (const personId of rootClosure.lineagePersonIds) {
    assert.equal(
      result.nodes.some(
        node =>
          node.personId === personId &&
          (node.lineageRole === "focus" || node.lineageRole === "direct-ancestor"),
      ),
      true,
      `${personId} must be painted after the all-descendants projection`,
    );
  }
});
