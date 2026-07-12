import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../src/types/familyTree.ts";
import {
  buildFamilyTreeLayoutFamilyUnits,
  buildFamilyTreeViewerLayout,
  edgeCssClass,
  edgeDashArray,
  type FamilyTreeLayoutEdge,
  type FamilyTreeLayoutNode,
  visibleStandaloneFamilyTreeEdges,
} from "../src/utils/familyTreeViewerLayout.ts";

const baseGraph: FamilyTreeGraphDto = {
  projectId: "project",
  treeId: "tree",
  mode: "family",
  rootPersonId: "root",
  tree: null,
  nodes: [],
  occurrences: [],
  edges: [],
  groups: [],
  issues: [],
  stats: {
    persons: 0,
    occurrences: 0,
    edges: 0,
    groups: 0,
    issues: 0,
    repeatedPersons: 0,
    hiddenDisprovenEdges: 0,
  },
};

function node(personId: string, displayName = personId, overrides: Partial<FamilyTreeNodeDto> = {}): FamilyTreeNodeDto {
  return {
    personId,
    displayName,
    primaryName: null,
    names: [],
    events: [],
    gender: "unknown",
    status: "proven",
    isLiving: false,
    privacyStatus: "private",
    redacted: false,
    occurrenceIds: [`${personId}:0`],
    ...overrides,
  };
}

function occurrence(
  id: string,
  personId: string,
  generation: number,
  overrides: Partial<FamilyTreeOccurrenceDto> = {},
): FamilyTreeOccurrenceDto {
  return {
    id,
    personId,
    mode: "family",
    path: ["root", personId],
    generation,
    depth: Math.abs(generation),
    duplicateIndex: 0,
    isRepeated: false,
    ...overrides,
  };
}

function edge(
  id: string,
  fromPersonId: string,
  toPersonId: string,
  fromOccurrenceId: string,
  toOccurrenceId: string,
  lineStyle: FamilyTreeEdgeDto["style"]["lineStyle"] = "solid",
  overrides: Partial<FamilyTreeEdgeDto> = {},
): FamilyTreeEdgeDto {
  return {
    id,
    kind: "parent_child",
    relationshipId: id,
    fromPersonId,
    toPersonId,
    fromOccurrenceId,
    toOccurrenceId,
    relationshipType: "biological",
    evidenceStatus: lineStyle === "dotted" ? "unknown" : "proven",
    confidence: 100,
    isBloodline: true,
    parentSetId: null,
    familyGroupId: null,
    sourceDocumentId: null,
    sourceFindingId: null,
    style: {
      lineStyle,
      visibility: "visible",
    },
    metadata: {},
    ...overrides,
  };
}

function layoutNode(
  personId: string,
  occurrenceId: string,
  x: number,
  y: number,
  gender = "unknown",
): FamilyTreeLayoutNode {
  return {
    occurrence: occurrence(occurrenceId, personId, Math.round(y / 100)),
    person: node(personId, personId, { gender }),
    x,
    y,
    width: 100,
    height: 50,
    badges: [],
  };
}

function layoutEdge(
  id: string,
  from: FamilyTreeLayoutNode,
  to: FamilyTreeLayoutNode,
  familyGroupId: string,
  role: "father" | "mother",
): FamilyTreeLayoutEdge {
  return {
    edge: edge(id, from.person.personId, to.person.personId, from.occurrence.id, to.occurrence.id, "solid", {
      familyGroupId,
      parentSetId: `${familyGroupId}:parents`,
      parentRoleLabel: role,
    }),
    from,
    to,
    path: "",
    dashArray: "",
    opacity: 1,
  };
}

function sevenGenerationPedigreeGraph(): FamilyTreeGraphDto {
  const nodes: FamilyTreeNodeDto[] = [node("root", "Root Person")];
  const occurrences: FamilyTreeOccurrenceDto[] = [
    occurrence("root:0", "root", 0, { path: ["root"] }),
  ];
  const edges: FamilyTreeEdgeDto[] = [];
  let children = [{ personId: "root", occurrenceId: "root:0", path: ["root"] }];

  for (let generation = 1; generation <= 7; generation += 1) {
    const nextChildren: typeof children = [];
    for (const child of children) {
      for (const role of ["f", "m"] as const) {
        const personId = `${child.personId}-${role}`;
        const occurrenceId = `${personId}:0`;
        const roleLabel = role === "f" ? "father" : "mother";
        nodes.push(node(personId, personId, { gender: role === "f" ? "male" : "female" }));
        occurrences.push(occurrence(occurrenceId, personId, -generation, {
          path: [...child.path, personId],
        }));
        edges.push(edge(`${personId}-${child.personId}`, personId, child.personId, occurrenceId, child.occurrenceId, "solid", {
          familyGroupId: `family:${child.personId}`,
          parentSetId: `parent-set:${child.personId}`,
          parentRoleLabel: roleLabel,
        }));
        nextChildren.push({ personId, occurrenceId, path: [...child.path, personId] });
      }
    }
    children = nextChildren;
  }

  return {
    ...baseGraph,
    nodes,
    occurrences,
    edges,
    stats: {
      ...baseGraph.stats,
      persons: nodes.length,
      occurrences: occurrences.length,
      edges: edges.length,
    },
  };
}

test("viewer layout uses occurrence ids and deterministic generation rows", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person"),
      node("child", "Child Person"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1),
      occurrence("child:0", "child", 1),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0"),
      edge("root-child", "root", "child", "root:0", "child:0"),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 140,
    verticalSpacing: 100,
    padding: 20,
  });

  const father = layout.nodes.find((item) => item.occurrence.id === "father:0");
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");
  const child = layout.nodes.find((item) => item.occurrence.id === "child:0");

  assert.ok(father);
  assert.ok(root);
  assert.ok(child);
  assert.equal(layout.nodes.map((item) => item.occurrence.id).sort().join(","), "child:0,father:0,root:0");
  assert.equal(root.x, 0);
  assert.equal(root.y, 0);
  assert.equal(father.y < root.y, true);
  assert.equal(root.y < child.y, true);
  assert.equal(layout.edges.length, 2);
});

test("viewer layout marks potential duplicate people from graph issues", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("duplicate", "Root Person"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("duplicate:0", "duplicate", 0),
    ],
    issues: [
      {
        code: "potentialDuplicatePerson",
        severity: "needs_review",
        message: "Several people have the same name and matching or missing birth year.",
        personIds: ["root", "duplicate"],
        relationshipIds: [],
        occurrenceIds: [],
        metadata: {},
      },
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph);

  assert.equal(layout.nodes.find((item) => item.person.personId === "root")?.badges.includes("potentialDuplicate"), true);
  assert.equal(layout.nodes.find((item) => item.person.personId === "duplicate")?.badges.includes("potentialDuplicate"), true);
});

test("viewer layout keeps multiple occurrences linked to the same canonical person", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "Root Person"),
      node("ancestor", "Repeated Ancestor", {
        occurrenceIds: ["ancestor:0", "ancestor:1"],
      }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("ancestor:0", "ancestor", -2, {
        path: ["root", "father", "ancestor"],
        duplicateIndex: 0,
        isRepeated: true,
      }),
      occurrence("ancestor:1", "ancestor", -2, {
        path: ["root", "mother", "ancestor"],
        duplicateIndex: 1,
        isRepeated: true,
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph);
  const repeated = layout.nodes.filter((item) => item.person.personId === "ancestor");

  assert.equal(repeated.length, 2);
  assert.equal(repeated.every((item) => item.occurrence.personId === "ancestor"), true);
  assert.equal(repeated.every((item) => item.badges.includes("multipleOccurrences")), true);
});

test("viewer layout preserves the root as coordinate origin even with saved positions", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [node("root", "Root Person")],
    occurrences: [
      occurrence("root:0", "root", 0, {
        layout: { x: 320, y: 180, isCollapsed: false },
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    padding: 20,
  });

  assert.equal(layout.nodes[0]?.x, 0);
  assert.equal(layout.nodes[0]?.y, 0);
  assert.equal(layout.minX < 0, true);
  assert.equal(layout.minY < 0, true);
});

test("viewer layout keeps father on the left and mother on the right regardless of edge order", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
    ],
    edges: [
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        parentRoleLabel: "mother",
      }),
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        parentRoleLabel: "father",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  const father = layout.nodes.find((item) => item.occurrence.id === "father:0");
  const mother = layout.nodes.find((item) => item.occurrence.id === "mother:0");
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");

  assert.ok(father);
  assert.ok(mother);
  assert.ok(root);
  assert.equal(father.x < root.x, true);
  assert.equal(root.x < mother.x, true);
});

test("viewer layout resolves real Ukrainian gender labels for parent sides", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
    ],
    edges: [
      edge("mother-root", "mother", "root", "mother:0", "root:0"),
      edge("father-root", "father", "root", "father:0", "root:0"),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  const father = layout.nodes.find((item) => item.occurrence.id === "father:0");
  const mother = layout.nodes.find((item) => item.occurrence.id === "mother:0");
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");

  assert.ok(father);
  assert.ok(mother);
  assert.ok(root);
  assert.equal(father.x < root.x, true);
  assert.equal(root.x < mother.x, true);
});

test("viewer layout keeps shallow direct ancestor couples compact in side blocks", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "чоловік" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "жінка" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "чоловік" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "жінка" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, { path: ["root", "father", "paternalGrandfather"] }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, { path: ["root", "father", "paternalGrandmother"] }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, { path: ["root", "mother", "maternalGrandfather"] }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, { path: ["root", "mother", "maternalGrandmother"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", { parentRoleLabel: "father" }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", { parentRoleLabel: "mother" }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", { parentRoleLabel: "father" }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", { parentRoleLabel: "mother" }),
      edge("mgf-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", { parentRoleLabel: "father" }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", { parentRoleLabel: "mother" }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  const x = (id: string) => layout.nodes.find((item) => item.occurrence.id === id)?.x ?? 0;
  const width = (id: string) => layout.nodes.find((item) => item.occurrence.id === id)?.width ?? 0;
  const right = (id: string) => x(id) + width(id);

  assert.equal(x("paternalGrandfather:0") < x("paternalGrandmother:0"), true);
  assert.equal(x("maternalGrandfather:0") < x("maternalGrandmother:0"), true);
  assert.equal(right("paternalGrandmother:0") < x("maternalGrandfather:0"), true);
  assert.equal(
    Math.abs(
      x("paternalGrandmother:0") - right("paternalGrandfather:0") -
      (x("maternalGrandmother:0") - right("maternalGrandfather:0")),
    ) <= 0.001,
    true,
  );
});

test("viewer layout keeps seven direct ancestor generations in strict non-mixed rows", () => {
  const graph = sevenGenerationPedigreeGraph();
  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 70,
    nodeHeight: 40,
    horizontalSpacing: 110,
    verticalSpacing: 80,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const father = nodeById.get("root-f:0");
  const mother = nodeById.get("root-m:0");
  assert.ok(root);
  assert.ok(father);
  assert.ok(mother);
  assert.equal(layout.nodes.length, 255);
  assert.equal(father.x < root.x, true);
  assert.equal(root.x < mother.x, true);

  const rows = new Map<number, typeof layout.nodes>();
  for (const item of layout.nodes) {
    const row = rows.get(item.occurrence.generation) ?? [];
    row.push(item);
    rows.set(item.occurrence.generation, row);
    assert.equal(item.y, item.occurrence.generation * 80);
  }
  for (const row of rows.values()) {
    const sorted = [...row].sort((left, right) => left.x - right.x);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.equal(sorted[index].x >= sorted[index - 1].x + sorted[index - 1].width, true);
    }
  }

  for (let generation = -1; generation >= -7; generation -= 1) {
    const paternal = layout.nodes.filter((item) =>
      item.occurrence.generation === generation && item.occurrence.id.startsWith("root-f"),
    );
    const maternal = layout.nodes.filter((item) =>
      item.occurrence.generation === generation && item.occurrence.id.startsWith("root-m"),
    );
    assert.equal(paternal.length > 0, true);
    assert.equal(maternal.length > 0, true);
    const paternalRight = Math.max(...paternal.map((item) => item.x + item.width));
    const maternalLeft = Math.min(...maternal.map((item) => item.x));
    assert.equal(paternalRight < root.x + root.width / 2, true);
    assert.equal(root.x + root.width / 2 <= maternalLeft, true);
    assert.equal(paternalRight < maternalLeft, true);
  }
  const familyUnitsByChild = new Map(layout.familyUnits.flatMap((unit) =>
    unit.childOccurrenceIds.map((childId) => [childId, unit] as const),
  ));
  for (const item of layout.nodes.filter((node) => node.occurrence.generation > -7)) {
    const unit = familyUnitsByChild.get(item.occurrence.id);
    if (item.occurrence.id === "root:0") {
      assert.ok(unit);
    }
    if (!unit || unit.parents.length !== 2) continue;
    assert.equal(unit.parents[0].x + unit.parents[0].width / 2 < unit.parents[1].x + unit.parents[1].width / 2, true);
  }
});

test("viewer layout uses the biological parent union as the direct pedigree backbone", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Biological Father", { gender: "male" }),
      node("mother", "Biological Mother", { gender: "female" }),
      node("adoptiveFather", "Adoptive Father", { gender: "male" }),
      node("grandfather", "Biological Grandfather", { gender: "male" }),
      node("grandmother", "Biological Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("adoptiveFather:0", "adoptiveFather", -1, { path: ["root", "adoptiveFather"] }),
      occurrence("grandfather:0", "grandfather", -2, { path: ["root", "father", "grandfather"] }),
      occurrence("grandmother:0", "grandmother", -2, { path: ["root", "father", "grandmother"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "bio-family",
        parentSetId: "bio-parent-set",
        parentRoleLabel: "father",
        relationshipType: "biological",
        isBloodline: true,
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "bio-family",
        parentSetId: "bio-parent-set",
        parentRoleLabel: "mother",
        relationshipType: "biological",
        isBloodline: true,
      }),
      edge("adoptive-root", "adoptiveFather", "root", "adoptiveFather:0", "root:0", "dashed", {
        familyGroupId: "adoptive-family",
        parentSetId: "adoptive-parent-set",
        parentRoleLabel: "adoptive_father",
        relationshipType: "adoptive",
        isBloodline: false,
      }),
      edge("grandfather-father", "grandfather", "father", "grandfather:0", "father:0", "solid", {
        familyGroupId: "father-bio-family",
        parentSetId: "father-bio-parent-set",
        parentRoleLabel: "father",
        relationshipType: "biological",
        isBloodline: true,
      }),
      edge("grandmother-father", "grandmother", "father", "grandmother:0", "father:0", "solid", {
        familyGroupId: "father-bio-family",
        parentSetId: "father-bio-parent-set",
        parentRoleLabel: "mother",
        relationshipType: "biological",
        isBloodline: true,
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item);
    return item.x + item.width / 2;
  };

  const rootCenter = center("root:0");
  const fatherCenter = center("father:0");
  const motherCenter = center("mother:0");

  assert.equal(fatherCenter < rootCenter, true);
  assert.equal(rootCenter < motherCenter, true);
  assert.equal(Math.max(center("father:0"), center("grandfather:0"), center("grandmother:0")) < rootCenter, true);
  assert.equal(center("grandfather:0") < fatherCenter, true);
  assert.equal(fatherCenter < center("grandmother:0"), true);

  const biologicalRootUnit = layout.familyUnits.find((unit) =>
    unit.childOccurrenceIds.includes("root:0") &&
    unit.parentOccurrenceIds.includes("father:0") &&
    unit.parentOccurrenceIds.includes("mother:0"),
  );
  assert.ok(biologicalRootUnit);
  assert.equal(Math.abs(biologicalRootUnit.unitX - rootCenter) < 0.001, true);
  assert.equal(biologicalRootUnit.parentOccurrenceIds.includes("adoptiveFather:0"), false);
});

test("viewer layout keeps expanded father-side branches on the paternal side", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "male" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
      node("uncle", "Father Brother", { gender: "male" }),
      node("unclePartner", "Father Brother Partner", { gender: "female" }),
      node("cousin", "Father Side Cousin"),
      node("cousinChild", "Father Side Cousin Child"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, { path: ["root", "father", "paternalGrandfather"] }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, { path: ["root", "father", "paternalGrandmother"] }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, { path: ["root", "mother", "maternalGrandfather"] }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, { path: ["root", "mother", "maternalGrandmother"] }),
      occurrence("uncle:0", "uncle", -1, { path: ["root", "father", "uncle"] }),
      occurrence("unclePartner:0", "unclePartner", -1, { path: ["root", "father", "uncle", "unclePartner"] }),
      occurrence("cousin:0", "cousin", 0, { path: ["root", "father", "uncle", "cousin"] }),
      occurrence("cousinChild:0", "cousinChild", 1, { path: ["root", "father", "uncle", "cousin", "cousinChild"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "father",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("paternal-grandfather-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "father",
      }),
      edge("paternal-grandmother-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("paternal-grandfather-uncle", "paternalGrandfather", "uncle", "paternalGrandfather:0", "uncle:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "father",
      }),
      edge("paternal-grandmother-uncle", "paternalGrandmother", "uncle", "paternalGrandmother:0", "uncle:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("maternal-grandfather-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "mother-parent-set",
        parentRoleLabel: "father",
      }),
      edge("maternal-grandmother-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "mother-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-cousin", "uncle", "cousin", "uncle:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "father",
      }),
      edge("uncle-partner-cousin", "unclePartner", "cousin", "unclePartner:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-partner", "uncle", "unclePartner", "uncle:0", "unclePartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "uncle-family",
      }),
      edge("cousin-cousin-child", "cousin", "cousinChild", "cousin:0", "cousinChild:0", "solid", {
        familyGroupId: "cousin-family",
        parentSetId: "cousin-child-parent-set",
        parentRoleLabel: "parent",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const required = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item);
    return item;
  };
  const root = required("root:0");
  const mother = required("mother:0");
  const paternalIds = [
    "father:0",
    "paternalGrandfather:0",
    "paternalGrandmother:0",
    "uncle:0",
    "unclePartner:0",
    "cousin:0",
    "cousinChild:0",
  ];

  for (const id of paternalIds) {
    const item = required(id);
    assert.equal(item.x + item.width / 2 < root.x + root.width / 2, true, `${id} stayed left of the root`);
    assert.equal(item.x + item.width < mother.x, true, `${id} stayed left of the maternal branch`);
  }
});

test("viewer layout packs dense father-side branch components without card overlap", () => {
  const nodes: FamilyTreeNodeDto[] = [
    node("root", "Root Person"),
    node("father", "Father Person", { gender: "male" }),
    node("mother", "Mother Person", { gender: "female" }),
    node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
    node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
  ];
  const occurrences: FamilyTreeOccurrenceDto[] = [
    occurrence("root:0", "root", 0, { path: ["root"] }),
    occurrence("father:0", "father", -1, { path: ["root", "father"] }),
    occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
    occurrence("paternalGrandfather:0", "paternalGrandfather", -2, { path: ["root", "father", "paternalGrandfather"] }),
    occurrence("paternalGrandmother:0", "paternalGrandmother", -2, { path: ["root", "father", "paternalGrandmother"] }),
  ];
  const edges: FamilyTreeEdgeDto[] = [
    edge("father-root", "father", "root", "father:0", "root:0", "solid", {
      familyGroupId: "root-parents",
      parentSetId: "root-parent-set",
      parentRoleLabel: "father",
    }),
    edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
      familyGroupId: "root-parents",
      parentSetId: "root-parent-set",
      parentRoleLabel: "mother",
    }),
    edge("paternal-grandfather-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
      familyGroupId: "paternal-grandparents",
      parentSetId: "father-parent-set",
      parentRoleLabel: "father",
    }),
    edge("paternal-grandmother-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
      familyGroupId: "paternal-grandparents",
      parentSetId: "father-parent-set",
      parentRoleLabel: "mother",
    }),
  ];

  for (let index = 0; index < 8; index += 1) {
    const siblingId = `fatherSibling${index}`;
    const partnerId = `fatherSiblingPartner${index}`;
    const childId = `fatherSideCousin${index}`;
    nodes.push(
      node(siblingId, `Father Sibling ${index}`, { gender: index % 2 === 0 ? "male" : "female" }),
      node(partnerId, `Sibling Partner ${index}`, { gender: index % 2 === 0 ? "female" : "male" }),
      node(childId, `Father Side Cousin ${index}`),
    );
    occurrences.push(
      occurrence(`${siblingId}:0`, siblingId, -1, { path: ["root", "father", siblingId] }),
      occurrence(`${partnerId}:0`, partnerId, -1, { path: ["root", "father", siblingId, partnerId] }),
      occurrence(`${childId}:0`, childId, 0, { path: ["root", "father", siblingId, childId] }),
    );
    edges.push(
      edge(`paternal-grandfather-${siblingId}`, "paternalGrandfather", siblingId, "paternalGrandfather:0", `${siblingId}:0`, "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: `${siblingId}-parent-set`,
        parentRoleLabel: "father",
      }),
      edge(`paternal-grandmother-${siblingId}`, "paternalGrandmother", siblingId, "paternalGrandmother:0", `${siblingId}:0`, "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: `${siblingId}-parent-set`,
        parentRoleLabel: "mother",
      }),
      edge(`${siblingId}-${childId}`, siblingId, childId, `${siblingId}:0`, `${childId}:0`, "solid", {
        familyGroupId: `${siblingId}-family`,
        parentSetId: `${childId}-parent-set`,
        parentRoleLabel: index % 2 === 0 ? "father" : "mother",
      }),
      edge(`${partnerId}-${childId}`, partnerId, childId, `${partnerId}:0`, `${childId}:0`, "solid", {
        familyGroupId: `${siblingId}-family`,
        parentSetId: `${childId}-parent-set`,
        parentRoleLabel: index % 2 === 0 ? "mother" : "father",
      }),
      edge(`${siblingId}-${partnerId}`, siblingId, partnerId, `${siblingId}:0`, `${partnerId}:0`, "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: `${siblingId}-family`,
      }),
    );
  }

  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes,
    occurrences,
    edges,
  };
  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");
  const mother = layout.nodes.find((item) => item.occurrence.id === "mother:0");
  assert.ok(root);
  assert.ok(mother);

  const fatherSideNodes = layout.nodes.filter((item) =>
    item.occurrence.id.startsWith("fatherSibling") ||
    item.occurrence.id.startsWith("fatherSideCousin"),
  );
  assert.equal(fatherSideNodes.length, 24);
  for (const item of fatherSideNodes) {
    assert.equal(item.x + item.width / 2 < root.x + root.width / 2, true, `${item.occurrence.id} stayed on father side`);
    assert.equal(item.x + item.width < mother.x, true, `${item.occurrence.id} stayed before mother branch`);
  }

  const rows = new Map<number, typeof layout.nodes>();
  for (const item of layout.nodes) {
    const row = rows.get(item.occurrence.generation) ?? [];
    row.push(item);
    rows.set(item.occurrence.generation, row);
  }
  for (const row of rows.values()) {
    const sorted = [...row].sort((left, right) => left.x - right.x);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.equal(
        sorted[index].x >= sorted[index - 1].x + sorted[index - 1].width,
        true,
        `${sorted[index - 1].occurrence.id} overlaps ${sorted[index].occurrence.id}`,
      );
    }
  }
});

test("viewer layout reserves width for single known parents on separate branches", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, {
        path: ["root", "father", "paternalGrandmother"],
      }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, {
        path: ["root", "mother", "maternalGrandmother"],
      }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", { parentRoleLabel: "father" }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", { parentRoleLabel: "mother" }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        parentRoleLabel: "mother",
      }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        parentRoleLabel: "mother",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");
  const root = nodeById.get("root:0");
  const paternalGrandmother = nodeById.get("paternalGrandmother:0");
  const maternalGrandmother = nodeById.get("maternalGrandmother:0");

  assert.ok(father);
  assert.ok(mother);
  assert.ok(root);
  assert.ok(paternalGrandmother);
  assert.ok(maternalGrandmother);

  const paternalBranchRight = Math.max(father.x + father.width, paternalGrandmother.x + paternalGrandmother.width);
  const maternalBranchLeft = Math.min(mother.x, maternalGrandmother.x);

  assert.equal(father.x < root.x, true);
  assert.equal(root.x < mother.x, true);
  assert.equal(paternalGrandmother.x < root.x, true);
  assert.equal(root.x < maternalGrandmother.x, true);
  assert.equal(paternalBranchRight < maternalBranchLeft, true);
});

test("viewer layout keeps partner ancestor branches separate when the focus person changes", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "father",
    nodes: [
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("child", "Child Person", { gender: "male" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "male" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("father:0", "father", 0, { path: ["father"] }),
      occurrence("mother:0", "mother", 0, { path: ["father", "child", "mother"] }),
      occurrence("child:0", "child", 1, { path: ["father", "child"] }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -1, {
        path: ["father", "paternalGrandfather"],
      }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -1, {
        path: ["father", "paternalGrandmother"],
      }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -1, {
        path: ["father", "child", "mother", "maternalGrandfather"],
      }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -1, {
        path: ["father", "child", "mother", "maternalGrandmother"],
      }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "family-parents",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "family-parents",
        parentRoleLabel: "mother",
      }),
      edge("father-mother", "father", "mother", "father:0", "mother:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "family-parents",
      }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        parentRoleLabel: "father",
      }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        parentRoleLabel: "mother",
      }),
      edge("mgf-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", {
        parentRoleLabel: "father",
      }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        parentRoleLabel: "mother",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");
  const child = nodeById.get("child:0");
  const paternalGrandfather = nodeById.get("paternalGrandfather:0");
  const paternalGrandmother = nodeById.get("paternalGrandmother:0");
  const maternalGrandfather = nodeById.get("maternalGrandfather:0");
  const maternalGrandmother = nodeById.get("maternalGrandmother:0");

  assert.ok(father);
  assert.ok(mother);
  assert.ok(child);
  assert.ok(paternalGrandfather);
  assert.ok(paternalGrandmother);
  assert.ok(maternalGrandfather);
  assert.ok(maternalGrandmother);

  const paternalBranchRight = Math.max(
    father.x + father.width,
    paternalGrandfather.x + paternalGrandfather.width,
    paternalGrandmother.x + paternalGrandmother.width,
  );
  const maternalBranchLeft = Math.min(mother.x, maternalGrandfather.x, maternalGrandmother.x);

  assert.equal(father.x < mother.x, true);
  assert.equal(paternalGrandfather.x < father.x, true);
  assert.equal(father.x < paternalGrandmother.x, true);
  assert.equal(maternalGrandfather.x < mother.x, true);
  assert.equal(mother.x < maternalGrandmother.x, true);
  assert.equal(paternalBranchRight < maternalBranchLeft, true);
  assert.equal(father.y < child.y, true);
});

test("viewer layout expands descendant partner ancestors around their own child branch", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "maternalGrandmother",
    nodes: [
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("father", "Father Person", { gender: "male" }),
      node("child", "Child Person", { gender: "male" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("paternalGreatGrandfather", "Paternal Great Grandfather", { gender: "male" }),
      node("paternalSecondGreatGrandfather", "Paternal Second Great Grandfather", { gender: "male" }),
    ],
    occurrences: [
      occurrence("maternalGrandmother:0", "maternalGrandmother", 0, { path: ["maternalGrandmother"] }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", 0, {
        path: ["maternalGrandmother", "maternalGrandfather"],
      }),
      occurrence("mother:0", "mother", 1, { path: ["maternalGrandmother", "mother"] }),
      occurrence("father:0", "father", 1, { path: ["maternalGrandmother", "mother", "father"] }),
      occurrence("child:0", "child", 2, { path: ["maternalGrandmother", "mother", "child"] }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", 0, {
        path: ["maternalGrandmother", "mother", "father", "paternalGrandfather"],
      }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", 0, {
        path: ["maternalGrandmother", "mother", "father", "paternalGrandmother"],
      }),
      occurrence("paternalGreatGrandfather:0", "paternalGreatGrandfather", -1, {
        path: ["maternalGrandmother", "mother", "father", "paternalGrandfather", "paternalGreatGrandfather"],
      }),
      occurrence("paternalSecondGreatGrandfather:0", "paternalSecondGreatGrandfather", -2, {
        path: [
          "maternalGrandmother",
          "mother",
          "father",
          "paternalGrandfather",
          "paternalGreatGrandfather",
          "paternalSecondGreatGrandfather",
        ],
      }),
    ],
    edges: [
      edge("mgf-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", {
        familyGroupId: "maternal-family",
        parentRoleLabel: "father",
      }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        familyGroupId: "maternal-family",
        parentRoleLabel: "mother",
      }),
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "parents-family",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "parents-family",
        parentRoleLabel: "mother",
      }),
      edge("mother-father", "mother", "father", "mother:0", "father:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "parents-family",
      }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-family",
        parentRoleLabel: "father",
      }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-family",
        parentRoleLabel: "mother",
      }),
      edge(
        "pggf-pgf",
        "paternalGreatGrandfather",
        "paternalGrandfather",
        "paternalGreatGrandfather:0",
        "paternalGrandfather:0",
        "solid",
        { parentRoleLabel: "father" },
      ),
      edge(
        "p2ggf-pggf",
        "paternalSecondGreatGrandfather",
        "paternalGreatGrandfather",
        "paternalSecondGreatGrandfather:0",
        "paternalGreatGrandfather:0",
        "solid",
        { parentRoleLabel: "father" },
      ),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const father = nodeById.get("father:0");
  const paternalGrandfather = nodeById.get("paternalGrandfather:0");
  const paternalGrandmother = nodeById.get("paternalGrandmother:0");
  const paternalGreatGrandfather = nodeById.get("paternalGreatGrandfather:0");
  const paternalSecondGreatGrandfather = nodeById.get("paternalSecondGreatGrandfather:0");

  assert.ok(father);
  assert.ok(paternalGrandfather);
  assert.ok(paternalGrandmother);
  assert.ok(paternalGreatGrandfather);
  assert.ok(paternalSecondGreatGrandfather);

  assert.equal(paternalGrandfather.x < father.x, true);
  assert.equal(father.x < paternalGrandmother.x, true);
  assert.equal(paternalGreatGrandfather.x < paternalGrandfather.x, true);
  assert.equal(paternalSecondGreatGrandfather.x < paternalGreatGrandfather.x, true);
  assert.equal(paternalGrandfather.y < father.y, true);
  assert.equal(paternalGreatGrandfather.y < paternalGrandfather.y, true);
  assert.equal(paternalSecondGreatGrandfather.y < paternalGreatGrandfather.y, true);
});

test("viewer layout keeps cards in the same generation from overlapping", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person", { gender: "чоловік" }),
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
      node("sibling", "Sibling Person", { gender: "чоловік" }),
      node("wife", "Wife Person", { gender: "жінка" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("sibling:0", "sibling", 0, { path: ["root", "father", "sibling"] }),
      occurrence("wife:0", "wife", 0, { path: ["root", "wife"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        parentRoleLabel: "father",
        parentSetId: "set-root",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        parentRoleLabel: "mother",
        parentSetId: "set-root",
      }),
      edge("father-sibling", "father", "sibling", "father:0", "sibling:0", "solid", {
        parentRoleLabel: "father",
        parentSetId: "set-sibling",
      }),
      edge("mother-sibling", "mother", "sibling", "mother:0", "sibling:0", "solid", {
        parentRoleLabel: "mother",
        parentSetId: "set-sibling",
      }),
      edge("root-wife", "root", "wife", "root:0", "wife:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph);
  const rows = new Map<number, typeof layout.nodes>();
  for (const item of layout.nodes) {
    const row = rows.get(item.occurrence.generation) ?? [];
    row.push(item);
    rows.set(item.occurrence.generation, row);
  }

  for (const row of rows.values()) {
    const sorted = [...row].sort((left, right) => left.x - right.x);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      assert.equal(
        current.x >= previous.x + previous.width,
        true,
        `${previous.occurrence.id} overlaps ${current.occurrence.id}`,
      );
    }
  }
});

test("viewer layout exposes family units for shared parents and children", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("child", "Child Person"),
      node("sibling", "Sibling Person"),
    ],
    occurrences: [
      occurrence("father:0", "father", -1, { path: ["child", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["child", "mother"] }),
      occurrence("child:0", "child", 0, { path: ["child"] }),
      occurrence("sibling:0", "sibling", 0, { path: ["child", "sibling"] }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "set-child",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "set-child",
        parentRoleLabel: "mother",
      }),
      edge("father-sibling", "father", "sibling", "father:0", "sibling:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "set-sibling",
        parentRoleLabel: "father",
      }),
      edge("mother-sibling", "mother", "sibling", "mother:0", "sibling:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "set-sibling",
        parentRoleLabel: "mother",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  assert.equal(layout.familyUnits.length, 1);
  assert.deepEqual(layout.familyUnits[0].parentOccurrenceIds, ["father:0", "mother:0"]);
  assert.deepEqual(layout.familyUnits[0].childOccurrenceIds.sort(), ["child:0", "sibling:0"]);
  assert.equal(layout.familyUnits[0].edges.length, 4);
  assert.equal(layout.familyUnits[0].path.includes(" H "), true);
  assert.equal(layout.familyUnits[0].path.includes(" V "), true);
});

test("viewer layout does not merge separate parent sets into one long family unit", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("parent", "Parent Person"),
      node("childOne", "Child One"),
      node("childTwo", "Child Two"),
    ],
    occurrences: [
      occurrence("parent:0", "parent", 0, { path: ["parent"] }),
      occurrence("childOne:0", "childOne", 1, { path: ["parent", "childOne"] }),
      occurrence("childTwo:0", "childTwo", 1, { path: ["parent", "childTwo"] }),
    ],
    edges: [
      edge("parent-child-one", "parent", "childOne", "parent:0", "childOne:0", "solid", {
        parentSetId: "set-child-one",
      }),
      edge("parent-child-two", "parent", "childTwo", "parent:0", "childTwo:0", "solid", {
        parentSetId: "set-child-two",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  assert.equal(layout.familyUnits.length, 2);
  assert.equal(layout.familyUnits.every((unit) => unit.childOccurrenceIds.length === 1), true);
});

test("viewer layout merges siblings with the same two parents even across separate parent sets", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("childOne", "Child One"),
      node("childTwo", "Child Two"),
    ],
    occurrences: [
      occurrence("father:0", "father", 0, { path: ["father"] }),
      occurrence("mother:0", "mother", 0, { path: ["father", "mother"] }),
      occurrence("childOne:0", "childOne", 1, { path: ["father", "childOne"] }),
      occurrence("childTwo:0", "childTwo", 1, { path: ["father", "childTwo"] }),
    ],
    edges: [
      edge("father-child-one", "father", "childOne", "father:0", "childOne:0", "solid", {
        parentRoleLabel: "father",
        parentSetId: "set-child-one",
      }),
      edge("mother-child-one", "mother", "childOne", "mother:0", "childOne:0", "solid", {
        parentRoleLabel: "mother",
        parentSetId: "set-child-one",
      }),
      edge("father-child-two", "father", "childTwo", "father:0", "childTwo:0", "solid", {
        parentRoleLabel: "father",
        parentSetId: "set-child-two",
      }),
      edge("mother-child-two", "mother", "childTwo", "mother:0", "childTwo:0", "solid", {
        parentRoleLabel: "mother",
        parentSetId: "set-child-two",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  assert.equal(layout.familyUnits.length, 1);
  assert.deepEqual(layout.familyUnits[0].parentOccurrenceIds, ["father:0", "mother:0"]);
  assert.deepEqual(layout.familyUnits[0].childOccurrenceIds.sort(), ["childOne:0", "childTwo:0"]);
});

test("viewer family unit routing assigns separate lanes for overlapping trunk intervals", () => {
  const fatherOne = layoutNode("fatherOne", "fatherOne:0", 0, -100, "male");
  const motherOne = layoutNode("motherOne", "motherOne:0", 200, -100, "female");
  const childOne = layoutNode("childOne", "childOne:0", 100, 0);
  const childOneSibling = layoutNode("childOneSibling", "childOneSibling:0", 160, 0);
  const fatherTwo = layoutNode("fatherTwo", "fatherTwo:0", 40, -100, "male");
  const motherTwo = layoutNode("motherTwo", "motherTwo:0", 240, -100, "female");
  const childTwo = layoutNode("childTwo", "childTwo:0", 140, 0);
  const childTwoSibling = layoutNode("childTwoSibling", "childTwoSibling:0", 200, 0);
  const units = buildFamilyTreeLayoutFamilyUnits([
    layoutEdge("father-one-child", fatherOne, childOne, "family-one", "father"),
    layoutEdge("mother-one-child", motherOne, childOne, "family-one", "mother"),
    layoutEdge("father-one-child-sibling", fatherOne, childOneSibling, "family-one", "father"),
    layoutEdge("mother-one-child-sibling", motherOne, childOneSibling, "family-one", "mother"),
    layoutEdge("father-two-child", fatherTwo, childTwo, "family-two", "father"),
    layoutEdge("mother-two-child", motherTwo, childTwo, "family-two", "mother"),
    layoutEdge("father-two-child-sibling", fatherTwo, childTwoSibling, "family-two", "father"),
    layoutEdge("mother-two-child-sibling", motherTwo, childTwoSibling, "family-two", "mother"),
  ]);

  assert.equal(units.length, 2);
  assert.notEqual(units[0].childBusY, units[1].childBusY);
  for (const unit of units) {
    const parentCenters = unit.parents.map((parent) => parent.y + parent.height / 2);
    const expectedPartnerLineY = parentCenters.reduce((total, value) => total + value, 0) / parentCenters.length;
    const childTop = Math.min(...unit.children.map((child) => child.y));
    assert.equal(unit.parentBusY, expectedPartnerLineY);
    assert.equal(unit.childBusY < childTop, true);
    assert.equal(unit.path.includes(`${unit.childBusY}`), true);
  }
});

test("viewer family unit routing draws a straight drop for a single child under the parent bus", () => {
  const father = layoutNode("father", "father:0", 0, -100, "male");
  const mother = layoutNode("mother", "mother:0", 200, -100, "female");
  const child = layoutNode("child", "child:0", 100, 0);
  const units = buildFamilyTreeLayoutFamilyUnits([
    layoutEdge("father-child", father, child, "family-one", "father"),
    layoutEdge("mother-child", mother, child, "family-one", "mother"),
  ]);

  assert.equal(units.length, 1);
  const childCenterX = child.x + child.width / 2;
  assert.equal(units[0].path.includes(`M ${childCenterX} ${units[0].parentBusY} V ${child.y}`), true);
  assert.doesNotMatch(units[0].path, /V\s+0\s+H/);
});

test("viewer layout keeps duplicate relationship types in one family unit", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("child", "Child Person"),
    ],
    occurrences: [
      occurrence("father:0", "father", 0),
      occurrence("mother:0", "mother", 0),
      occurrence("child:0", "child", 1),
    ],
    edges: [
      edge("father-child-biological", "father", "child", "father:0", "child:0", "solid", {
        parentSetId: "set-child",
        relationshipType: "biological",
        parentRoleLabel: "father",
      }),
      edge("father-child-generic", "father", "child", "father:0", "child:0", "dotted", {
        parentSetId: "set-child",
        relationshipType: "unknown",
        parentRoleLabel: "parent",
      }),
      edge("mother-child-biological", "mother", "child", "mother:0", "child:0", "solid", {
        parentSetId: "set-child",
        relationshipType: "biological",
        parentRoleLabel: "mother",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 170,
    verticalSpacing: 110,
    padding: 20,
  });

  assert.equal(layout.familyUnits.length, 1);
  assert.deepEqual(layout.familyUnits[0].parentOccurrenceIds.sort(), ["father:0", "mother:0"]);
  assert.deepEqual(layout.familyUnits[0].childOccurrenceIds, ["child:0"]);
});

test("viewer layout keeps a child's parent union centered when each parent has siblings", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "child",
    nodes: [
      node("child", "Child Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("fatherBrother", "Father Brother", { gender: "male" }),
      node("motherSister", "Mother Sister", { gender: "female" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "male" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("child:0", "child", 0, { path: ["child"] }),
      occurrence("father:0", "father", -1, { path: ["child", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["child", "mother"] }),
      occurrence("fatherBrother:0", "fatherBrother", -1, {
        path: ["child", "father", "fatherBrother"],
      }),
      occurrence("motherSister:0", "motherSister", -1, {
        path: ["child", "mother", "motherSister"],
      }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, {
        path: ["child", "father", "paternalGrandfather"],
      }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, {
        path: ["child", "father", "paternalGrandmother"],
      }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, {
        path: ["child", "mother", "maternalGrandfather"],
      }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, {
        path: ["child", "mother", "maternalGrandmother"],
      }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "mother",
      }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "father",
      }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "mother",
      }),
      edge(
        "pgf-father-brother",
        "paternalGrandfather",
        "fatherBrother",
        "paternalGrandfather:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "father",
        },
      ),
      edge(
        "pgm-father-brother",
        "paternalGrandmother",
        "fatherBrother",
        "paternalGrandmother:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "mother",
        },
      ),
      edge("mgf-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "maternal-mother",
        parentRoleLabel: "father",
      }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "maternal-mother",
        parentRoleLabel: "mother",
      }),
      edge(
        "mgf-mother-sister",
        "maternalGrandfather",
        "motherSister",
        "maternalGrandfather:0",
        "motherSister:0",
        "solid",
        {
          familyGroupId: "maternal-grandparents",
          parentSetId: "maternal-sister",
          parentRoleLabel: "father",
        },
      ),
      edge(
        "mgm-mother-sister",
        "maternalGrandmother",
        "motherSister",
        "maternalGrandmother:0",
        "motherSister:0",
        "solid",
        {
          familyGroupId: "maternal-grandparents",
          parentSetId: "maternal-sister",
          parentRoleLabel: "mother",
        },
      ),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");
  const fatherBrother = nodeById.get("fatherBrother:0");
  const motherSister = nodeById.get("motherSister:0");
  const childFamily = layout.familyUnits.find((unit) => unit.childOccurrenceIds.includes("child:0"));
  const child = nodeById.get("child:0");

  assert.ok(father);
  assert.ok(mother);
  assert.ok(fatherBrother);
  assert.ok(motherSister);
  assert.ok(childFamily);
  assert.ok(child);
  assert.equal(father.x < mother.x, true);
  assert.equal(fatherBrother.x < father.x, true);
  assert.equal(mother.x < motherSister.x, true);
  const childCenterX = child.x + child.width / 2;
  const parentUnionCenterX = ((father.x + father.width / 2) + (mother.x + mother.width / 2)) / 2;
  assert.equal(Math.abs(childCenterX - parentUnionCenterX) < 0.001, true);
  assert.deepEqual(childFamily.parents.map((parent) => parent.occurrence.id), ["father:0", "mother:0"]);
});

test("viewer layout keeps one-sided parent sibling groups close to the root parent", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "child",
    nodes: [
      node("child", "Child Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("fatherBrother", "Father Brother", { gender: "male" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
      node("maternalGrandfather", "Maternal Grandfather", { gender: "male" }),
      node("maternalGrandmother", "Maternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("child:0", "child", 0, { path: ["child"] }),
      occurrence("father:0", "father", -1, { path: ["child", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["child", "mother"] }),
      occurrence("fatherBrother:0", "fatherBrother", -1, {
        path: ["child", "father", "fatherBrother"],
      }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, {
        path: ["child", "father", "paternalGrandfather"],
      }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, {
        path: ["child", "father", "paternalGrandmother"],
      }),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, {
        path: ["child", "mother", "maternalGrandfather"],
      }),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, {
        path: ["child", "mother", "maternalGrandmother"],
      }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "mother",
      }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "father",
      }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "mother",
      }),
      edge(
        "pgf-father-brother",
        "paternalGrandfather",
        "fatherBrother",
        "paternalGrandfather:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "father",
        },
      ),
      edge(
        "pgm-father-brother",
        "paternalGrandmother",
        "fatherBrother",
        "paternalGrandmother:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "mother",
        },
      ),
      edge("mgf-mother", "maternalGrandfather", "mother", "maternalGrandfather:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "maternal-mother",
        parentRoleLabel: "father",
      }),
      edge("mgm-mother", "maternalGrandmother", "mother", "maternalGrandmother:0", "mother:0", "solid", {
        familyGroupId: "maternal-grandparents",
        parentSetId: "maternal-mother",
        parentRoleLabel: "mother",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph);
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");
  const fatherBrother = nodeById.get("fatherBrother:0");
  const siblingFamily = layout.familyUnits.find((unit) =>
    unit.childOccurrenceIds.includes("father:0") &&
    unit.childOccurrenceIds.includes("fatherBrother:0"),
  );

  assert.ok(father);
  assert.ok(mother);
  assert.ok(fatherBrother);
  assert.ok(siblingFamily);
  assert.equal(fatherBrother.x < father.x, true);
  assert.equal(father.x < mother.x, true);
  assert.equal(father.x - fatherBrother.x <= 330, true);
  assert.equal(siblingFamily.children.every((child) => child.occurrence.id === "father:0" || child.occurrence.id === "fatherBrother:0"), true);
  const childCenters = siblingFamily.children.map((child) => child.x + child.width / 2);
  const childBusStartX = Math.min(siblingFamily.unitX, ...childCenters);
  const childBusEndX = Math.max(siblingFamily.unitX, ...childCenters);
  assert.equal(
    siblingFamily.path.includes(`M ${childBusStartX} ${siblingFamily.childBusY} H ${childBusEndX}`),
    true,
  );
});

test("viewer layout keeps multiple partners on ancestor rows from overlapping", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "male" }),
      node("firstPartner", "First Partner", { gender: "female" }),
      node("secondPartner", "Second Partner", { gender: "female" }),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("firstPartner:0", "firstPartner", -1, { path: ["root", "father", "firstPartner"] }),
      occurrence("secondPartner:0", "secondPartner", -1, { path: ["root", "father", "secondPartner"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        parentRoleLabel: "father",
      }),
      edge("father-first-partner", "father", "firstPartner", "father:0", "firstPartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
      }),
      edge("father-second-partner", "father", "secondPartner", "father:0", "secondPartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const ancestorRow = layout.nodes
    .filter((item) => item.occurrence.generation === -1)
    .sort((left, right) => left.x - right.x);

  assert.equal(ancestorRow.length, 3);
  for (let index = 1; index < ancestorRow.length; index += 1) {
    assert.equal(
      ancestorRow[index].x >= ancestorRow[index - 1].x + ancestorRow[index - 1].width,
      true,
      `${ancestorRow[index - 1].occurrence.id} overlaps ${ancestorRow[index].occurrence.id}`,
    );
  }
});

test("viewer layout keeps parent-sibling partners attached before shifting the root parent pair", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "child",
    nodes: [
      node("child", "Child Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("fatherSister", "Father Sister", { gender: "female" }),
      node("fatherBrother", "Father Brother", { gender: "male" }),
      node("fatherBrotherPartner", "Father Brother Partner", { gender: "female" }),
      node("paternalGrandfather", "Paternal Grandfather", { gender: "male" }),
      node("paternalGrandmother", "Paternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("child:0", "child", 0, { path: ["child"] }),
      occurrence("father:0", "father", -1, { path: ["child", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["child", "mother"] }),
      occurrence("fatherSister:0", "fatherSister", -1, {
        path: ["child", "father", "fatherSister"],
      }),
      occurrence("fatherBrother:0", "fatherBrother", -1, {
        path: ["child", "father", "fatherBrother"],
      }),
      occurrence("fatherBrotherPartner:0", "fatherBrotherPartner", -1, {
        path: ["child", "father", "fatherBrother", "fatherBrotherPartner"],
      }),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, {
        path: ["child", "father", "paternalGrandfather"],
      }),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, {
        path: ["child", "father", "paternalGrandmother"],
      }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "parents",
        parentSetId: "parents-child",
        parentRoleLabel: "mother",
      }),
      edge("pgf-father", "paternalGrandfather", "father", "paternalGrandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "father",
      }),
      edge("pgm-father", "paternalGrandmother", "father", "paternalGrandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "paternal-father",
        parentRoleLabel: "mother",
      }),
      edge(
        "pgf-father-sister",
        "paternalGrandfather",
        "fatherSister",
        "paternalGrandfather:0",
        "fatherSister:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-sister",
          parentRoleLabel: "father",
        },
      ),
      edge(
        "pgm-father-sister",
        "paternalGrandmother",
        "fatherSister",
        "paternalGrandmother:0",
        "fatherSister:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-sister",
          parentRoleLabel: "mother",
        },
      ),
      edge(
        "pgf-father-brother",
        "paternalGrandfather",
        "fatherBrother",
        "paternalGrandfather:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "father",
        },
      ),
      edge(
        "pgm-father-brother",
        "paternalGrandmother",
        "fatherBrother",
        "paternalGrandmother:0",
        "fatherBrother:0",
        "solid",
        {
          familyGroupId: "paternal-grandparents",
          parentSetId: "paternal-brother",
          parentRoleLabel: "mother",
        },
      ),
      edge(
        "father-brother-partner",
        "fatherBrother",
        "fatherBrotherPartner",
        "fatherBrother:0",
        "fatherBrotherPartner:0",
        "solid",
        {
          kind: "partner",
          relationshipType: "marriage",
        },
      ),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const child = nodeById.get("child:0");
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");
  const fatherSister = nodeById.get("fatherSister:0");
  const fatherBrother = nodeById.get("fatherBrother:0");
  const fatherBrotherPartner = nodeById.get("fatherBrotherPartner:0");

  assert.ok(child);
  assert.ok(father);
  assert.ok(mother);
  assert.ok(fatherSister);
  assert.ok(fatherBrother);
  assert.ok(fatherBrotherPartner);
  assert.equal(fatherBrotherPartner.y, fatherBrother.y);
  const ancestorRow = layout.nodes
    .filter((item) => item.y === fatherBrother.y)
    .sort((left, right) => left.x - right.x);
  const brotherIndex = ancestorRow.findIndex((item) => item.occurrence.id === "fatherBrother:0");
  const partnerIndex = ancestorRow.findIndex((item) => item.occurrence.id === "fatherBrotherPartner:0");
  assert.equal(Math.abs(brotherIndex - partnerIndex), 1);
  assert.equal(fatherBrother.x < fatherBrotherPartner.x, true);
  assert.equal(fatherBrotherPartner.x < father.x, true);
  assert.equal(fatherBrother.x < father.x, true);
  assert.equal(father.x < mother.x, true);
  assert.equal(fatherBrotherPartner.x >= fatherBrother.x + fatherBrother.width, true);
  const paternalSideBranchRight = Math.max(
    fatherSister.x + fatherSister.width,
    fatherBrother.x + fatherBrother.width,
    fatherBrotherPartner.x + fatherBrotherPartner.width,
  );
  assert.equal(paternalSideBranchRight < mother.x, true);
  const rootCenterX = child.x + child.width / 2;
  const rootParentUnit = layout.familyUnits.find((unit) =>
    unit.childOccurrenceIds.includes("child:0") &&
    unit.parentOccurrenceIds.includes("father:0") &&
    unit.parentOccurrenceIds.includes("mother:0"),
  );
  assert.ok(rootParentUnit);
  assert.equal(Math.abs(rootCenterX - rootParentUnit.unitX) < 0.001, true);
});

test("viewer layout places disconnected occurrences beside the tree instead of on top of it", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "Root Person"),
      node("stray", "Stray Person"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("stray:0", "stray", 0, { path: ["root", "stray"] }),
    ],
    edges: [],
  };

  const layout = buildFamilyTreeViewerLayout(graph);
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");
  const stray = layout.nodes.find((item) => item.occurrence.id === "stray:0");

  assert.ok(root);
  assert.ok(stray);
  assert.equal(stray.x >= root.x + root.width, true);
});

test("viewer layout keeps partners on the same visual generation as their linked spouse", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "stepan",
    nodes: [
      node("stepan", "Stepan Person", { gender: "male" }),
      node("son", "Son Person", { gender: "male" }),
      node("grandchild", "Grandchild Person", { gender: "male" }),
      node("grandchildWife", "Grandchild Wife", { gender: "female" }),
    ],
    occurrences: [
      occurrence("stepan:0", "stepan", 0, { path: ["stepan"] }),
      occurrence("son:0", "son", 1, { path: ["stepan", "son"] }),
      occurrence("grandchild:0", "grandchild", 2, { path: ["stepan", "son", "grandchild"] }),
      occurrence("grandchildWife:0", "grandchildWife", 0, {
        path: ["stepan", "son", "grandchild", "grandchildWife"],
      }),
    ],
    edges: [
      edge("stepan-son", "stepan", "son", "stepan:0", "son:0", "solid", {
        parentRoleLabel: "father",
      }),
      edge("son-grandchild", "son", "grandchild", "son:0", "grandchild:0", "solid", {
        parentRoleLabel: "father",
      }),
      edge("grandchild-wife", "grandchild", "grandchildWife", "grandchild:0", "grandchildWife:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("stepan:0");
  const grandchild = nodeById.get("grandchild:0");
  const wife = nodeById.get("grandchildWife:0");

  assert.ok(root);
  assert.ok(grandchild);
  assert.ok(wife);
  assert.equal(wife.y, grandchild.y);
  assert.notEqual(wife.y, root.y);
});

test("viewer edge helpers map line style to svg dash and css classes", () => {
  const solid = edge("solid", "a", "b", "a:0", "b:0", "solid");
  const dashed = edge("dashed", "a", "b", "a:0", "b:0", "dashed", {
    relationshipType: "adoptive",
  });
  const dotted = edge("dotted", "a", "b", "a:0", "b:0", "dotted", {
    style: {
      lineStyle: "dotted",
      visibility: "visible",
      marker: "warning",
    },
  });

  assert.equal(edgeDashArray(solid), "");
  assert.equal(edgeDashArray(dashed), "10 8");
  assert.equal(edgeDashArray(dotted), "2 8");
  assert.equal(edgeCssClass(dotted).includes("family-tree-edge-warning"), true);
});

test("viewer hides standalone partner line when the same parents are connected through children", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "child",
    nodes: [
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
      node("child", "Child Person"),
    ],
    occurrences: [
      occurrence("father:0", "father", -1, { path: ["child", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["child", "mother"] }),
      occurrence("child:0", "child", 0, { path: ["child"] }),
    ],
    edges: [
      edge("father-child", "father", "child", "father:0", "child:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "parent-set-1",
        parentRoleLabel: "father",
      }),
      edge("mother-child", "mother", "child", "mother:0", "child:0", "solid", {
        familyGroupId: "family-1",
        parentSetId: "parent-set-1",
        parentRoleLabel: "mother",
      }),
      edge("father-mother", "father", "mother", "father:0", "mother:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "family-1",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph);
  assert.equal(layout.edges.some((item) => item.edge.kind === "partner"), true);
  assert.equal(visibleStandaloneFamilyTreeEdges(layout.edges).some((item) => item.edge.kind === "partner"), false);
});

test("viewer keeps cousin branch parent bus separate even when family group ids leak across branches", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "чоловік" }),
      node("mother", "Mother Person", { gender: "жінка" }),
      node("uncle", "Uncle Person", { gender: "чоловік" }),
      node("cousin", "Cousin Person"),
    ],
    occurrences: [
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("uncle:0", "uncle", -1, { path: ["root", "father", "uncle"] }),
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("cousin:0", "cousin", 0, { path: ["root", "father", "uncle", "cousin"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "leaked-family",
        parentSetId: "root-parent-set",
        parentRoleLabel: "father",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "leaked-family",
        parentSetId: "root-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-cousin", "uncle", "cousin", "uncle:0", "cousin:0", "solid", {
        familyGroupId: "leaked-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "father",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 120,
    nodeHeight: 64,
    horizontalSpacing: 180,
    verticalSpacing: 130,
    padding: 20,
  });

  const rootFamily = layout.familyUnits.find((unit) => unit.childOccurrenceIds.includes("root:0"));
  const cousinFamily = layout.familyUnits.find((unit) => unit.childOccurrenceIds.includes("cousin:0"));

  assert.ok(rootFamily);
  assert.ok(cousinFamily);
  assert.notEqual(rootFamily.key, cousinFamily.key);
  assert.deepEqual(rootFamily.parentOccurrenceIds.sort(), ["father:0", "mother:0"]);
  assert.deepEqual(cousinFamily.parentOccurrenceIds, ["uncle:0"]);
  assert.equal(rootFamily.parentOccurrenceIds.includes("uncle:0"), false);
  assert.equal(cousinFamily.childOccurrenceIds.includes("root:0"), false);
});

test("viewer keeps cousin parents adjacent so root parent sibling does not split the couple", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "Root Person"),
      node("father", "Leonid Kalenskyi", { gender: "чоловік" }),
      node("mother", "Olena Kalenska", { gender: "жінка" }),
      node("uncle", "Mykhailo Kalenskyi", { gender: "чоловік" }),
      node("unclePartner", "Liudmyla Kalenska", { gender: "жінка" }),
      node("cousin", "Dmytro Kalenskyi", { gender: "чоловік" }),
      node("grandfather", "Grandfather", { gender: "чоловік" }),
      node("grandmother", "Grandmother", { gender: "жінка" }),
    ],
    occurrences: [
      occurrence("grandfather:0", "grandfather", -2, { path: ["root", "father", "grandfather"] }),
      occurrence("grandmother:0", "grandmother", -2, { path: ["root", "father", "grandmother"] }),
      occurrence("uncle:0", "uncle", -1, { path: ["root", "father", "uncle"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("unclePartner:0", "unclePartner", -1, { path: ["root", "father", "uncle", "unclePartner"] }),
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("cousin:0", "cousin", 0, { path: ["root", "father", "uncle", "cousin"] }),
    ],
    edges: [
      edge("grandfather-father", "grandfather", "father", "grandfather:0", "father:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-father", "grandmother", "father", "grandmother:0", "father:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("grandfather-uncle", "grandfather", "uncle", "grandfather:0", "uncle:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-uncle", "grandmother", "uncle", "grandmother:0", "uncle:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "father",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-cousin", "uncle", "cousin", "uncle:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "father",
      }),
      edge("uncle-partner-cousin", "unclePartner", "cousin", "unclePartner:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-partner", "uncle", "unclePartner", "uncle:0", "unclePartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "uncle-family",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 120,
    nodeHeight: 64,
    horizontalSpacing: 180,
    verticalSpacing: 130,
    padding: 20,
  });
  const ancestorRow = layout.nodes
    .filter((item) => item.occurrence.generation === -1)
    .sort((left, right) => left.x - right.x);
  const rowIds = ancestorRow.map((item) => item.occurrence.id);
  const uncleIndex = rowIds.indexOf("uncle:0");
  const partnerIndex = rowIds.indexOf("unclePartner:0");

  assert.notEqual(uncleIndex, -1);
  assert.notEqual(partnerIndex, -1);
  assert.equal(Math.abs(uncleIndex - partnerIndex), 1);
  assert.equal(rowIds.includes("father:0"), true);
  assert.equal(
    rowIds.slice(Math.min(uncleIndex, partnerIndex) + 1, Math.max(uncleIndex, partnerIndex)).includes("father:0"),
    false,
  );
});

test("viewer keeps paternal side components together inside the paternal corridor", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("uncle", "Father Brother", { gender: "male" }),
      node("unclePartner", "Father Brother Partner", { gender: "female" }),
      node("cousin", "Cousin Person"),
      node("grandfather", "Paternal Grandfather", { gender: "male" }),
      node("grandmother", "Paternal Grandmother", { gender: "female" }),
    ],
    occurrences: [
      occurrence("grandfather:0", "grandfather", -2, { path: ["root", "father", "grandfather"] }),
      occurrence("grandmother:0", "grandmother", -2, { path: ["root", "father", "grandmother"] }),
      occurrence("uncle:0", "uncle", -1, { path: ["root", "father", "uncle"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("unclePartner:0", "unclePartner", -1, { path: ["root", "father", "uncle", "unclePartner"] }),
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("cousin:0", "cousin", 0, { path: ["root", "father", "uncle", "cousin"] }),
    ],
    edges: [
      edge("grandfather-father", "grandfather", "father", "grandfather:0", "father:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-father", "grandmother", "father", "grandmother:0", "father:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("grandfather-uncle", "grandfather", "uncle", "grandfather:0", "uncle:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-uncle", "grandmother", "uncle", "grandmother:0", "uncle:0", "solid", {
        familyGroupId: "grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "father",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-cousin", "uncle", "cousin", "uncle:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "father",
      }),
      edge("uncle-partner-cousin", "unclePartner", "cousin", "unclePartner:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-partner", "uncle", "unclePartner", "uncle:0", "unclePartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "uncle-family",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 120,
    nodeHeight: 64,
    horizontalSpacing: 180,
    verticalSpacing: 130,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const mother = nodeById.get("mother:0");
  const uncle = nodeById.get("uncle:0");
  const unclePartner = nodeById.get("unclePartner:0");
  const cousin = nodeById.get("cousin:0");

  assert.ok(root);
  assert.ok(mother);
  assert.ok(uncle);
  assert.ok(unclePartner);
  assert.ok(cousin);
  assert.equal(uncle.y, unclePartner.y);
  assert.equal(uncle.x < unclePartner.x, true);
  assert.equal(unclePartner.x >= uncle.x + uncle.width, true);
  assert.equal(unclePartner.x + unclePartner.width < root.x, true);
  assert.equal(cousin.x + cousin.width < root.x, true);
  assert.equal(unclePartner.x + unclePartner.width < mother.x, true);
});

test("viewer layout keeps direct paternal ancestry anchored above the father branch", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "Root Person"),
      node("father", "Father Person", { gender: "male" }),
      node("mother", "Mother Person", { gender: "female" }),
      node("grandfather", "Paternal Grandfather", { gender: "male" }),
      node("grandmother", "Paternal Grandmother", { gender: "female" }),
      node("greatGrandfather", "Great Grandfather", { gender: "male" }),
      node("greatGrandmother", "Great Grandmother", { gender: "female" }),
      node("uncle", "Father Brother", { gender: "male" }),
      node("unclePartner", "Father Brother Partner", { gender: "female" }),
      node("cousin", "Cousin Person"),
    ],
    occurrences: [
      occurrence("greatGrandfather:0", "greatGrandfather", -3, { path: ["root", "father", "grandfather", "greatGrandfather"] }),
      occurrence("greatGrandmother:0", "greatGrandmother", -3, { path: ["root", "father", "grandfather", "greatGrandmother"] }),
      occurrence("grandfather:0", "grandfather", -2, { path: ["root", "father", "grandfather"] }),
      occurrence("grandmother:0", "grandmother", -2, { path: ["root", "father", "grandmother"] }),
      occurrence("father:0", "father", -1, { path: ["root", "father"] }),
      occurrence("mother:0", "mother", -1, { path: ["root", "mother"] }),
      occurrence("uncle:0", "uncle", -1, { path: ["root", "father", "uncle"] }),
      occurrence("unclePartner:0", "unclePartner", -1, { path: ["root", "father", "uncle", "unclePartner"] }),
      occurrence("root:0", "root", 0, { path: ["root"] }),
      occurrence("cousin:0", "cousin", 0, { path: ["root", "father", "uncle", "cousin"] }),
    ],
    edges: [
      edge("father-root", "father", "root", "father:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "father",
      }),
      edge("mother-root", "mother", "root", "mother:0", "root:0", "solid", {
        familyGroupId: "root-parents",
        parentSetId: "root-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("grandfather-father", "grandfather", "father", "grandfather:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-father", "grandmother", "father", "grandmother:0", "father:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "father-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("great-grandfather-grandfather", "greatGrandfather", "grandfather", "greatGrandfather:0", "grandfather:0", "solid", {
        familyGroupId: "great-grandparents",
        parentSetId: "grandfather-parent-set",
        parentRoleLabel: "father",
      }),
      edge("great-grandmother-grandfather", "greatGrandmother", "grandfather", "greatGrandmother:0", "grandfather:0", "solid", {
        familyGroupId: "great-grandparents",
        parentSetId: "grandfather-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("grandfather-uncle", "grandfather", "uncle", "grandfather:0", "uncle:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "father",
      }),
      edge("grandmother-uncle", "grandmother", "uncle", "grandmother:0", "uncle:0", "solid", {
        familyGroupId: "paternal-grandparents",
        parentSetId: "uncle-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-cousin", "uncle", "cousin", "uncle:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "father",
      }),
      edge("uncle-partner-cousin", "unclePartner", "cousin", "unclePartner:0", "cousin:0", "solid", {
        familyGroupId: "uncle-family",
        parentSetId: "cousin-parent-set",
        parentRoleLabel: "mother",
      }),
      edge("uncle-partner", "uncle", "unclePartner", "uncle:0", "unclePartner:0", "solid", {
        kind: "partner",
        relationshipType: "marriage",
        familyGroupId: "uncle-family",
      }),
    ],
  };

  const layout = buildFamilyTreeViewerLayout(graph, {
    nodeWidth: 120,
    nodeHeight: 64,
    horizontalSpacing: 190,
    verticalSpacing: 130,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item);
    return item.x + item.width / 2;
  };

  const fatherCenter = center("father:0");
  const motherCenter = center("mother:0");
  const grandfatherCenter = center("grandfather:0");
  const grandmotherCenter = center("grandmother:0");
  const greatGrandfatherCenter = center("greatGrandfather:0");
  const greatGrandmotherCenter = center("greatGrandmother:0");
  const paternalDirectRight = Math.max(
    center("father:0"),
    center("grandfather:0"),
    center("grandmother:0"),
    center("greatGrandfather:0"),
    center("greatGrandmother:0"),
  );

  assert.equal(grandfatherCenter < fatherCenter, true);
  assert.equal(fatherCenter < grandmotherCenter, true);
  assert.equal(greatGrandfatherCenter < grandfatherCenter, true);
  assert.equal(grandfatherCenter < greatGrandmotherCenter, true);
  assert.equal(paternalDirectRight < motherCenter, true);
});
