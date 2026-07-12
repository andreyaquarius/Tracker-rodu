import assert from "node:assert/strict";
import test from "node:test";
import type { FamilyTreeGraphDto, FamilyTreeNodeDto } from "../src/types/familyTree.ts";
import { availableFamilyTreeActionsForPerson, familyTreeRelationFlagsByPerson } from "../src/utils/familyTreeActions.ts";

function node(personId: string, gender = ""): FamilyTreeNodeDto {
  return {
    personId,
    displayName: personId,
    primaryName: null,
    names: [],
    events: [],
    gender,
    status: "",
    isLiving: false,
    privacyStatus: "private",
    redacted: false,
    occurrenceIds: [],
  };
}

function graph(overrides: Partial<FamilyTreeGraphDto> = {}): FamilyTreeGraphDto {
  return {
    projectId: "project",
    treeId: "tree",
    mode: "family",
    rootPersonId: "child",
    tree: null,
    availablePersons: [],
    nodes: [node("child"), node("father", "чоловік"), node("mother", "жінка")],
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
    ...overrides,
  };
}

test("available family tree actions hide parent buttons that already have matching parents", () => {
  const result = availableFamilyTreeActionsForPerson(graph({
    edges: [
      {
        id: "father-child",
        kind: "parent_child",
        relationshipId: "father-child",
        fromPersonId: "father",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "father",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", color: "bloodline", visibility: "normal" },
        metadata: {},
      },
      {
        id: "mother-child",
        kind: "parent_child",
        relationshipId: "mother-child",
        fromPersonId: "mother",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "mother",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", color: "bloodline", visibility: "normal" },
        metadata: {},
      },
    ],
  }), "child").map((item) => item.action);

  assert.equal(result.includes("add_father"), false);
  assert.equal(result.includes("add_mother"), false);
  assert.equal(result.includes("add_child"), true);
  assert.equal(result.includes("add_sibling"), true);
});

test("family tree relation flags understand genetic father and mother edge types", () => {
  const flags = familyTreeRelationFlagsByPerson(graph({
    edges: [
      {
        id: "genetic-father-child",
        kind: "parent_child",
        relationshipId: "genetic-father-child",
        fromPersonId: "father",
        toPersonId: "child",
        relationshipType: "genetic_father",
        parentRoleLabel: "parent",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", color: "bloodline", visibility: "normal" },
        metadata: {},
      },
    ],
  })).get("child");

  assert.equal(flags?.parents, 1);
  assert.equal(flags?.fathers, 1);
  assert.equal(flags?.mothers, 0);
  assert.deepEqual(
    availableFamilyTreeActionsForPerson(graph({
      edges: [
        {
          id: "genetic-father-child",
          kind: "parent_child",
          relationshipId: "genetic-father-child",
          fromPersonId: "father",
          toPersonId: "child",
          relationshipType: "genetic_father",
          parentRoleLabel: "parent",
          evidenceStatus: "proven",
          confidence: 100,
          style: { lineStyle: "solid", color: "bloodline", visibility: "normal" },
          metadata: {},
        },
      ],
    }), "child").map((item) => item.action).includes("add_mother"),
    true,
  );
});

test("adoptive father does not block adding a biological father", () => {
  const currentGraph = graph({
    edges: [
      {
        id: "adoptive-father-child",
        kind: "parent_child",
        relationshipId: "adoptive-father-child",
        fromPersonId: "father",
        toPersonId: "child",
        relationshipType: "adoptive",
        parentRoleLabel: "adoptive_father",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "dashed", visibility: "visible" },
        metadata: {},
      },
    ],
  });
  const flags = familyTreeRelationFlagsByPerson(currentGraph).get("child");
  const actions = availableFamilyTreeActionsForPerson(currentGraph, "child").map((item) => item.action);

  assert.equal(flags?.fathers, 1);
  assert.equal(flags?.biologicalFathers, 0);
  assert.equal(actions.includes("add_father"), true);
  assert.equal(actions.includes("add_mother"), true);
  assert.equal(actions.includes("add_sibling"), true);
});

test("family tree relation flags infer parent side from Ukrainian gender labels", () => {
  const flags = familyTreeRelationFlagsByPerson(graph({
    edges: [
      {
        id: "father-child",
        kind: "parent_child",
        relationshipId: "father-child",
        fromPersonId: "father",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "parent",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
      {
        id: "mother-child",
        kind: "parent_child",
        relationshipId: "mother-child",
        fromPersonId: "mother",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "parent",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
    ],
  })).get("child");

  assert.equal(flags?.fathers, 1);
  assert.equal(flags?.mothers, 1);
});
