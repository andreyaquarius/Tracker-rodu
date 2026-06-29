import test from "node:test";
import assert from "node:assert/strict";
import {
  findBloodlineCycles,
  legacyRelationToGraphIntent,
  validateFamilyGraph,
} from "../src/utils/familyTreeGraph.ts";
import type { PersonRelation } from "../src/types/index.ts";
import type { ParentChildRelationship } from "../src/types/familyTree.ts";

function legacyRelation(
  relationType: PersonRelation["relationType"],
  personId = "child",
  relatedPersonId = "related",
  status: PersonRelation["status"] = "доведено",
): PersonRelation {
  return {
    id: `legacy-${relationType}`,
    personId,
    relatedPersonId,
    relationType,
    status,
    evidenceText: "",
    notes: "",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
  };
}

function parentChild(
  id: string,
  parentId: string,
  childId: string,
  overrides: Partial<ParentChildRelationship> = {},
): ParentChildRelationship {
  return {
    id,
    projectId: "project",
    treeId: "tree",
    parentId,
    childId,
    parentSetId: `set-${childId}`,
    familyGroupId: null,
    relationshipType: "biological",
    parentRoleLabel: "parent",
    startDate: "",
    endDate: "",
    evidenceStatus: "proven",
    confidence: 100,
    isPrimaryForDisplay: false,
    isBloodline: true,
    isLegal: false,
    isSocial: true,
    privacyStatus: "private",
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides,
  };
}

test("maps legacy father relation to biological parent edge", () => {
  const intent = legacyRelationToGraphIntent(legacyRelation("батько", "child-1", "father-1"));

  assert.equal(intent?.kind, "parent_child");
  assert.equal(intent?.fromPersonId, "father-1");
  assert.equal(intent?.toPersonId, "child-1");
  assert.equal(intent?.relationshipType, "biological");
  assert.equal(intent?.parentRoleLabel, "father");
  assert.equal(intent?.parentSetType, "biological");
  assert.equal(intent?.isBloodline, true);
  assert.equal(intent?.lineStyle, "solid");
});

test("maps legacy spouse relation to partner edge", () => {
  const intent = legacyRelationToGraphIntent(legacyRelation("дружина", "person-a", "person-b", "імовірно"));

  assert.equal(intent?.kind, "partner");
  assert.equal(intent?.fromPersonId, "person-a");
  assert.equal(intent?.toPersonId, "person-b");
  assert.equal(intent?.relationshipType, "marriage");
  assert.equal(intent?.evidenceStatus, "likely");
});

test("maps legacy godparent relation to association edge", () => {
  const intent = legacyRelationToGraphIntent(legacyRelation("хрещений", "child-1", "godfather-1"));

  assert.equal(intent?.kind, "association");
  assert.equal(intent?.fromPersonId, "godfather-1");
  assert.equal(intent?.toPersonId, "child-1");
  assert.equal(intent?.relationshipType, "godparent");
});

test("detects biological parent-child cycles", () => {
  const relationships = [
    parentChild("one", "a", "b"),
    parentChild("two", "b", "c"),
    parentChild("three", "c", "a"),
  ];

  assert.deepEqual(findBloodlineCycles(relationships), [["a", "b", "c", "a"]]);
  assert.equal(
    validateFamilyGraph({ parentChildRelationships: relationships })
      .some((issue) => issue.code === "bloodline_cycle" && issue.severity === "critical"),
    true,
  );
});

test("does not treat disproven or non-bloodline links as bloodline cycles", () => {
  const relationships = [
    parentChild("one", "a", "b"),
    parentChild("two", "b", "c", { isBloodline: false, relationshipType: "adoptive" }),
    parentChild("three", "c", "a", { evidenceStatus: "disproven" }),
  ];

  assert.deepEqual(findBloodlineCycles(relationships), []);
});
