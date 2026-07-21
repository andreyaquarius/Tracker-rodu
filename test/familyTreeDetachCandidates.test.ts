import assert from "node:assert/strict";
import test from "node:test";
import {
  familyTreeDetachCandidates,
  familyTreeDetachCandidatesFromRelationships,
  type FamilyTreeDetachableRelationshipDescriptor,
} from "../src/features/family-tree-view/state/familyTreeDetach.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";

test("detach candidates label every direct relationship and dedupe only an exact edge", () => {
  const relationships: FamilyTreeDetachableRelationshipDescriptor[] = [
    {
      kind: "parent_child",
      direction: "parent",
      relationshipId: "edge-father",
      relatedPersonId: "father",
      parentRoleLabel: "father",
    },
    {
      kind: "parent_child",
      direction: "parent",
      relationshipId: "edge-mother",
      relatedPersonId: "mother",
      parentRoleLabel: "mother",
    },
    {
      kind: "parent_child",
      direction: "parent",
      relationshipId: "edge-guardian",
      relatedPersonId: "guardian",
      parentRoleLabel: "guardian",
    },
    {
      kind: "parent_child",
      direction: "parent",
      relationshipId: "edge-parent",
      relatedPersonId: "unnamed-parent",
      parentRoleLabel: "parent",
    },
    {
      kind: "parent_child",
      direction: "child",
      relationshipId: "edge-child",
      relatedPersonId: "child",
    },
    {
      kind: "partner",
      direction: "partner",
      relationshipId: "edge-partner-1",
      relatedPersonId: "partner",
    },
    // The same person can have more than one persisted relationship. These
    // rows must remain separately removable because their relationship ids
    // are different.
    {
      kind: "partner",
      direction: "partner",
      relationshipId: "edge-partner-2",
      relatedPersonId: "partner",
    },
    // A repeated query/result row must not render a duplicate destructive
    // action for the exact same canonical edge.
    {
      kind: "partner",
      direction: "partner",
      relationshipId: "edge-partner-2",
      relatedPersonId: "partner",
    },
  ];
  const names = new Map([
    ["father", "Іван"],
    ["mother", "Олена"],
    ["guardian", "Марія"],
    ["child", "Петро"],
    ["partner", "Ганна"],
  ]);

  const candidates = familyTreeDetachCandidatesFromRelationships(relationships, names);
  const byRelationshipId = new Map(
    candidates.map((candidate) => [candidate.relationshipId, candidate]),
  );

  assert.equal(candidates.length, 7);
  assert.equal(byRelationshipId.get("edge-father")?.relationLabel, "Батько");
  assert.equal(byRelationshipId.get("edge-mother")?.relationLabel, "Мати");
  assert.equal(
    byRelationshipId.get("edge-guardian")?.relationLabel,
    "Опікун / опікунка",
  );
  assert.equal(byRelationshipId.get("edge-parent")?.relationLabel, "Один з батьків");
  assert.equal(byRelationshipId.get("edge-parent")?.personLabel, "Особа без імені");
  assert.equal(byRelationshipId.get("edge-child")?.relationLabel, "Дитина");
  assert.equal(
    byRelationshipId.get("edge-partner-1")?.relationLabel,
    "Партнер / партнерка",
  );
  assert.equal(
    candidates.filter((candidate) => candidate.relatedPersonId === "partner").length,
    2,
    "parallel persisted relationships must not be collapsed by person id",
  );
  assert.ok(
    candidates
      .slice(0, 5)
      .every((candidate) => candidate.kind === "parent_child"),
    "parent/child actions remain grouped before partnership actions",
  );
});

test("graph detach candidates ignore parent sets and normalize partnership ids", () => {
  const graph: FamilyGraphData = {
    persons: [
      { id: "selected", displayName: "Центральна особа" },
      { id: "father", displayName: "Батько" },
      { id: "child", displayName: "Дитина" },
      { id: "partner", displayName: "Партнерка" },
    ],
    parentChildRelations: [
      {
        id: "parent-edge",
        parentId: "father",
        childId: "selected",
        kind: "biological",
        role: "father",
      },
      {
        id: "child-edge",
        parentId: "selected",
        childId: "child",
        kind: "biological",
      },
    ],
    unions: [
      {
        id: "partnership:partner-edge",
        kind: "partnership",
        memberIds: ["selected", "partner"],
      },
      {
        id: "partnership:partner-edge",
        kind: "partnership",
        memberIds: ["selected", "partner"],
      },
      {
        id: "parent-set-should-not-be-detachable",
        kind: "parent-set",
        memberIds: ["selected", "father"],
      },
    ],
  };

  const candidates = familyTreeDetachCandidates(graph, "selected");

  assert.deepEqual(
    new Set(candidates.map((candidate) => candidate.relationshipId)),
    new Set(["parent-edge", "child-edge", "partner-edge"]),
  );
  assert.equal(
    candidates.filter((candidate) => candidate.relationshipId === "partner-edge").length,
    1,
  );
  assert.equal(
    candidates.some(
      (candidate) => candidate.relationshipId === "parent-set-should-not-be-detachable",
    ),
    false,
  );
});

