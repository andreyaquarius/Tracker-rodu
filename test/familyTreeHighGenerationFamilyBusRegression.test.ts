import test from "node:test";
import assert from "node:assert/strict";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import type {
  FamilyGraphData,
  LayoutEdge,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

const EPSILON = 0.001;

function person(id: string, sex: TreePerson["sex"] = "unknown"): TreePerson {
  return { id, displayName: id, sex };
}

function relation(
  id: string,
  parentId: string,
  childId: string,
  unionId: string,
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role: "father",
  };
}

function parentSet(
  id: string,
  parentId: string,
  familyGroupId: string,
): TreeUnion {
  return {
    id,
    kind: "parent-set",
    memberIds: [parentId],
    familyGroupId,
    expectedParentSlots: 2,
  };
}

function highGenerationSingleParentFixture(): FamilyGraphData {
  const directLine = [
    "focus",
    "ancestor-1",
    "ancestor-2",
    "ancestor-3",
    "line-child",
  ] as const;
  const highParentId = "high-generation-father";
  const highChildren = [
    "line-child",
    "high-sibling-older",
    "high-sibling-younger",
  ] as const;

  const chainUnions = directLine.slice(0, -1).map((childId, index) =>
    parentSet(
      `chain-parent-set-${index + 1}`,
      directLine[index + 1]!,
      `chain-family-${index + 1}`,
    ),
  );
  const chainRelations = directLine.slice(0, -1).map((childId, index) =>
    relation(
      `chain-relation-${index + 1}`,
      directLine[index + 1]!,
      childId,
      `chain-parent-set-${index + 1}`,
    ),
  );
  const highUnions = highChildren.map((childId, index) =>
    parentSet(
      `high-child-parent-set-${index + 1}`,
      highParentId,
      `persisted-family-row-${index + 1}`,
    ),
  );
  const highRelations = highChildren.map((childId, index) =>
    relation(
      `high-child-relation-${index + 1}`,
      highParentId,
      childId,
      `high-child-parent-set-${index + 1}`,
    ),
  );

  return {
    persons: [
      ...directLine.map((id, index) => person(id, index % 2 ? "female" : "male")),
      person(highParentId, "male"),
      person("high-sibling-older", "female"),
      person("high-sibling-younger", "male"),
    ],
    unions: [...chainUnions, ...highUnions],
    parentChildRelations: [...chainRelations, ...highRelations],
  };
}

function isVertical(edge: LayoutEdge): boolean {
  return edge.points.every(
    point => Math.abs(point.x - edge.points[0]!.x) <= EPSILON,
  );
}

test("one known ancestor at a high generation uses one bus for per-child family rows", () => {
  const graph = highGenerationSingleParentFixture();
  const highUnionIds = new Set([
    "high-child-parent-set-1",
    "high-child-parent-set-2",
    "high-child-parent-set-3",
  ]);
  const result = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "focus",
      layoutMode: "family-graph",
      ancestorDepth: 5,
      descendantDepth: 0,
      collateralDepth: 1,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });
  const highUnionOccurrenceIds = new Set(
    result.unions
      .filter(union => highUnionIds.has(union.unionId))
      .map(union => union.occurrenceId),
  );
  const highFamilyEdges = result.edges.filter(
    edge =>
      edge.unionOccurrenceId !== undefined &&
      highUnionOccurrenceIds.has(edge.unionOccurrenceId),
  );
  const buses = highFamilyEdges.filter(edge => edge.kind === "siblings-bus");
  const familyStems = highFamilyEdges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );
  const childDrops = highFamilyEdges.filter(edge => edge.id.includes(":child:"));

  assert.equal(
    result.nodes.filter(node =>
      ["line-child", "high-sibling-older", "high-sibling-younger"].includes(
        node.personId ?? "",
      ),
    ).length,
    3,
    "the fixture must display the direct-line child and both collateral siblings",
  );
  assert.equal(
    buses.length,
    1,
    `the one visible parent must own one siblings bus; got ${buses.map(edge => edge.id).join(", ")}`,
  );
  assert.equal(
    familyStems.length,
    1,
    `the parent must have one route to the shared bus; got ${familyStems.map(edge => edge.id).join(", ")}`,
  );
  assert.equal(childDrops.length, 3, "the shared bus needs one drop per child");
  assert.ok(
    childDrops.every(isVertical),
    `every child route must be a vertical drop: ${childDrops
      .filter(edge => !isVertical(edge))
      .map(edge => edge.id)
      .join(", ")}`,
  );
  assert.ok(
    buses[0]!.points.every(
      point => Math.abs(point.y - buses[0]!.points[0]!.y) <= EPSILON,
    ),
    "the shared siblings bus must be horizontal",
  );
  assert.ok(
    childDrops.every(
      edge => Math.abs(edge.points[0]!.y - buses[0]!.points[0]!.y) <= EPSILON,
    ),
    "every child drop must start on the one shared bus",
  );
});
