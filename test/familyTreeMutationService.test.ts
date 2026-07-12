import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanCreateParentChild,
  assertParentChildGraphAcyclic,
  canAutoCreatePartnerRelationshipForParentType,
  confidenceForEvidence,
  legacyChildRelationType,
  legacyParentRelationType,
  legacySiblingRelationType,
  legacySpouseRelationType,
  legacyStatusForEvidence,
  parentRelationshipTraits,
  parentSetTypeForRelationship,
  roleLabelForParentIntent,
  selectReusableParentSet,
  statusForPartnerType,
  wouldCreateParentChildCycle,
  type ParentSetSelectionRow,
} from "../src/utils/familyTreeMutationRules.ts";
import { PARENT_CHILD_DEFINITIONS } from "../src/utils/familyTreeGraph.ts";
import type { ParentChildRelationshipType } from "../src/types/familyTree.ts";

const parentSets: ParentSetSelectionRow[] = [
  {
    id: "set-biological-grouped",
    family_group_id: "family-1",
    set_type: "biological",
  },
  {
    id: "set-biological",
    family_group_id: null,
    set_type: "biological",
  },
  {
    id: "set-adoptive",
    family_group_id: "family-1",
    set_type: "adoptive",
  },
];

test("maps parent-child relationship types to parent set types", () => {
  assert.equal(parentSetTypeForRelationship("biological"), "biological");
  assert.equal(parentSetTypeForRelationship("adoptive"), "adoptive");
  assert.equal(parentSetTypeForRelationship("foster"), "foster");
  assert.equal(parentSetTypeForRelationship("guardian"), "guardian");
  assert.equal(parentSetTypeForRelationship("social_parent"), "social");
  assert.equal(parentSetTypeForRelationship("legal_parent"), "legal");
  assert.equal(parentSetTypeForRelationship("unknown"), "unknown");
});

test("keeps parent-set and relationship traits aligned with graph definitions", () => {
  for (const relationshipType of Object.keys(PARENT_CHILD_DEFINITIONS) as ParentChildRelationshipType[]) {
    const definition = PARENT_CHILD_DEFINITIONS[relationshipType];
    assert.equal(parentSetTypeForRelationship(relationshipType), definition.parentSetType);
    assert.deepEqual(parentRelationshipTraits(relationshipType), {
      isBloodline: definition.isBloodline,
      isLegal: definition.isLegal,
      isSocial: definition.isSocial,
    });
  }
});

test("maps parent action intent to role labels", () => {
  assert.equal(roleLabelForParentIntent("father", "biological"), "father");
  assert.equal(roleLabelForParentIntent("mother", "biological"), "mother");
  assert.equal(roleLabelForParentIntent("father", "adoptive"), "adoptive_father");
  assert.equal(roleLabelForParentIntent("mother", "adoptive"), "adoptive_mother");
  assert.equal(roleLabelForParentIntent("father", "step"), "stepfather");
  assert.equal(roleLabelForParentIntent("mother", "step"), "stepmother");
  assert.equal(roleLabelForParentIntent("parent", "guardian"), "guardian");
});

test("marks biological, legal and social parent traits", () => {
  assert.deepEqual(parentRelationshipTraits("biological"), {
    isBloodline: true,
    isLegal: false,
    isSocial: true,
  });
  assert.deepEqual(parentRelationshipTraits("adoptive"), {
    isBloodline: false,
    isLegal: true,
    isSocial: true,
  });
  assert.deepEqual(parentRelationshipTraits("foster"), {
    isBloodline: false,
    isLegal: false,
    isSocial: true,
  });
});

test("reuses a matching parent set before creating a new one", () => {
  assert.equal(selectReusableParentSet(parentSets, "biological", null)?.id, "set-biological");
  assert.equal(selectReusableParentSet(parentSets, "biological", "family-1")?.id, "set-biological-grouped");
  assert.equal(selectReusableParentSet(parentSets, "adoptive", "family-1")?.id, "set-adoptive");
  assert.equal(selectReusableParentSet(parentSets, "adoptive", "family-2"), null);
});

test("blocks self parent-child relationships", () => {
  assert.doesNotThrow(() => assertCanCreateParentChild("parent", "child"));
  assert.throws(() => assertCanCreateParentChild("same-person", "same-person"));
});

test("blocks two-node and three-node parent-child cycles", () => {
  assert.throws(() => assertCanCreateParentChild("child", "parent", [
    { parentId: "parent", childId: "child" },
  ]));
  assert.throws(() => assertCanCreateParentChild("grandchild", "grandparent", [
    { parentId: "grandparent", childId: "parent" },
    { parentId: "parent", childId: "grandchild" },
  ]));
});

test("cycle guard ignores disproven edges but still rejects disproven self-links", () => {
  assert.doesNotThrow(() => assertCanCreateParentChild("child", "parent", [
    { parentId: "parent", childId: "child", evidenceStatus: "disproven" },
  ]));
  assert.doesNotThrow(() => assertCanCreateParentChild(
    "child",
    "parent",
    [{ parentId: "parent", childId: "child", evidenceStatus: "proven" }],
    "disproven",
  ));
  assert.throws(() => assertCanCreateParentChild("same", "same", [], "disproven"));
});

test("cycle guard has no generation cap", () => {
  const relationships = Array.from({ length: 60 }, (_, index) => ({
    parentId: `person-${index}`,
    childId: `person-${index + 1}`,
  }));

  assert.equal(wouldCreateParentChildCycle("person-60", "person-0", relationships), true);
  assert.throws(() => assertCanCreateParentChild("person-60", "person-0", relationships));
  assert.throws(() => assertParentChildGraphAcyclic([
    ...relationships,
    { parentId: "person-60", childId: "person-0" },
  ]));
});

test("parent-only cycle guard does not flag a cousin partnership", () => {
  const cousinPedigree = [
    { parentId: "grandparent-1", childId: "parent-1" },
    { parentId: "grandparent-2", childId: "parent-1" },
    { parentId: "grandparent-1", childId: "parent-2" },
    { parentId: "grandparent-2", childId: "parent-2" },
    { parentId: "parent-1", childId: "cousin-1" },
    { parentId: "parent-2", childId: "cousin-2" },
  ];

  assert.doesNotThrow(() => assertParentChildGraphAcyclic(cousinPedigree));
  assert.equal(wouldCreateParentChildCycle("cousin-1", "cousin-2", cousinPedigree), false);
});

test("only biological parent flows can auto-create a partnership", () => {
  const allowed = new Set<ParentChildRelationshipType>(["biological", "birth_parent"]);
  for (const relationshipType of Object.keys(PARENT_CHILD_DEFINITIONS) as ParentChildRelationshipType[]) {
    assert.equal(
      canAutoCreatePartnerRelationshipForParentType(relationshipType),
      allowed.has(relationshipType),
      relationshipType,
    );
  }
});

test("maps evidence and partner statuses for builder defaults", () => {
  assert.equal(confidenceForEvidence("proven"), 100);
  assert.equal(confidenceForEvidence("likely"), 75);
  assert.equal(confidenceForEvidence("unknown"), 50);
  assert.equal(confidenceForEvidence("disputed"), 35);
  assert.equal(confidenceForEvidence("disproven"), 0);
  assert.equal(statusForPartnerType("marriage"), "active");
  assert.equal(statusForPartnerType("divorced"), "ended");
  assert.equal(statusForPartnerType("unknown"), "unknown");
});

test("maps graph builder actions to legacy person relation labels", () => {
  assert.equal(legacyParentRelationType("father"), "батько");
  assert.equal(legacyParentRelationType("mother"), "мати");
  assert.equal(legacyParentRelationType("parent"), "батько або мати");
  assert.equal(legacyChildRelationType("чоловік"), "син");
  assert.equal(legacyChildRelationType("жінка"), "донька");
  assert.equal(legacyChildRelationType("невідомо"), "дитина");
  assert.equal(legacySiblingRelationType("чоловік"), "брат");
  assert.equal(legacySiblingRelationType("жінка"), "сестра");
  assert.equal(legacySpouseRelationType("чоловік"), "чоловік");
  assert.equal(legacySpouseRelationType("жінка"), "дружина");
  assert.equal(legacySpouseRelationType("невідомо"), "подружжя");
  assert.equal(legacyStatusForEvidence("proven"), "доведено");
  assert.equal(legacyStatusForEvidence("disputed"), "сумнівно");
});
