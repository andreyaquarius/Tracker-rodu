import test from "node:test";
import assert from "node:assert/strict";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import type {
  FamilyGraphData,
  FamilyTreeLayoutInput,
} from "../src/features/family-tree-view/types.ts";

test("descendant forest recovers a one-parent family from relations when the parent-set members are missing", () => {
  const graph: FamilyGraphData = {
    persons: ["root", "older-child", "middle-child", "younger-child"].map(
      (id, index) => ({
        id,
        displayName: id,
        sex: index === 0 ? "male" : "unknown",
        birth: {
          display: String(1840 + index * 25),
          sort: String(1840 + index * 25),
        },
      }),
    ),
    unions: [
      {
        id: "incomplete-parent-set",
        kind: "parent-set",
        // Legacy/progressively loaded data can omit the materialized members,
        // while the relation rows still identify the known parent exactly.
        memberIds: [],
        expectedParentSlots: 2,
      },
    ],
    parentChildRelations: ["older-child", "middle-child", "younger-child"].map(
      (childId, index) => ({
        id: `root-to-${childId}`,
        parentId: "root",
        childId,
        unionId: "incomplete-parent-set",
        kind: "biological",
        role: "father",
        displayOrder: String(index).padStart(3, "0"),
      }),
    ),
  };
  const before = structuredClone(graph);

  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
  });
  const input: FamilyTreeLayoutInput = {
    graph: projection.graph,
    options: {
      focusPersonId: "root",
      layoutMode: "descendant-forest",
      ancestorDepth: 0,
      descendantDepth: 10,
      collateralDepth: 0,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
      primaryLineagePersonIds: ["root"],
    },
  };
  const result = layoutDescendantForest(input);

  assert.deepEqual(projection.descendantPersonIds, [
    "root",
    "middle-child",
    "older-child",
    "younger-child",
  ]);
  assert.deepEqual(
    result.nodes
      .filter(node => node.kind === "person")
      .map(node => node.personId)
      .sort(),
    ["middle-child", "older-child", "root", "younger-child"],
    "all relation-backed children must be mounted even when parent-set.memberIds is empty",
  );

  const familyOccurrenceIds = new Set(
    result.unions
      .filter(union => union.unionId === "incomplete-parent-set")
      .map(union => union.occurrenceId),
  );
  const familyEdges = result.edges.filter(
    edge =>
      edge.unionOccurrenceId !== undefined &&
      familyOccurrenceIds.has(edge.unionOccurrenceId),
  );
  assert.equal(
    familyEdges.filter(edge => edge.kind === "siblings-bus").length,
    1,
    "the recovered one-parent family must use one shared children bus",
  );
  assert.equal(
    familyEdges.filter(edge => edge.id.endsWith(":family-stem")).length,
    1,
    "the recovered parent must have one stem to that bus",
  );
  assert.equal(
    familyEdges.filter(edge => edge.id.includes(":child:")).length,
    3,
    "the shared bus must have one drop per child",
  );
  assert.deepEqual(
    graph,
    before,
    "relation-backed member recovery must not mutate the transport graph",
  );
});
