import test from "node:test";
import assert from "node:assert/strict";
import type { PersonRelation } from "../src/types/index.ts";
import type { FamilyTreeProjectionEdge } from "../src/utils/familyTreeProjection.ts";
import {
  buildLegacyFamilyTreeImportPlan,
  buildLegacyImportMutationBatches,
  LEGACY_IMPORT_PARENT_EDGE_BATCH_SIZE,
  LEGACY_IMPORT_ROW_BATCH_SIZE,
  legacyImportExpectedSyncKeys,
} from "../src/utils/familyTreeLegacyImportBatch.ts";

const projectId = "project";
const treeId = "tree";

test("builds FK-safe GEDCOM family rows and preserves familyXref metadata", () => {
  const relations = [
    relation("spouse", "father", "mother", "подружжя", { familyXref: "@F1@", startDate: "1900", rawNotes: "union" }),
    relation("father-rel", "child", "father", "батько", { familyXref: "@F1@", pedigree: "birth", rawNotes: "parents" }),
    relation("mother-rel", "child", "mother", "мати", { familyXref: "@F1@", pedigree: "birth", rawNotes: "parents" }),
  ];
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations,
    partnerEdges: [partnerEdge("father", "mother", "spouse")],
    parentChildEdges: [
      parentEdge("father", "child", "father-rel", "father"),
      parentEdge("mother", "child", "mother-rel", "mother"),
    ],
    idFactory: sequentialIds(),
  });

  assert.equal(plan.familyGroups.length, 1);
  assert.equal(plan.partnerRelationships.length, 1);
  assert.equal(plan.parentSets.length, 1);
  assert.equal(plan.parentChildRelationships.length, 2);
  const familyGroup = plan.familyGroups[0];
  const parentSet = plan.parentSets[0];
  assert.equal(familyGroup.metadata.familyXref, "@F1@");
  assert.equal(familyGroup.metadata.rawNotes, "union");
  assert.equal(plan.partnerRelationships[0].metadata.familyXref, "@F1@");
  assert.equal(plan.partnerRelationships[0].metadata.legacyRelationId, "spouse");
  assert.equal(plan.partnerRelationships[0].start_date, "1900");
  assert.equal(parentSet.metadata.familyXref, "@F1@");
  assert.equal(parentSet.metadata.pedigree, "birth");
  assert.equal(parentSet.family_group_id, familyGroup.id);
  assert.ok(plan.parentChildRelationships.every((row) => row.parent_set_id === parentSet.id));
  assert.ok(plan.parentChildRelationships.every((row) => row.family_group_id === familyGroup.id));
  assert.ok(plan.parentChildRelationships.every((row) => row.metadata.familyXref === "@F1@"));
  assert.deepEqual(
    plan.parentChildRelationships.map((row) => row.metadata.legacyRelationId),
    ["father-rel", "mother-rel"],
  );

  const memberKeys = new Set(plan.familyGroupMembers.map((row) =>
    `${row.person_id}|${row.member_role}`));
  assert.deepEqual(memberKeys, new Set([
    "father|partner",
    "mother|partner",
    "father|parent",
    "mother|parent",
    "child|child",
  ]));

  const batches = buildLegacyImportMutationBatches(plan);
  assert.deepEqual(batches.map((batch) => batch.table), [
    "family_groups",
    "partner_relationships",
    "parent_sets",
    "parent_child_relationships",
    "family_group_members",
  ]);
  assert.equal(batches.at(-1)?.mode, "upsert");
});

test("orders parent-child rows ancestor-first for the database cycle trigger", () => {
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations: [],
    partnerEdges: [],
    // Intentionally deepest-first to prove that persistence order is derived.
    parentChildEdges: [
      parentEdge("child", "grandchild", "deep"),
      parentEdge("root", "child", "shallow"),
    ],
    idFactory: sequentialIds(),
  });

  assert.deepEqual(plan.parentChildRelationships.map((row) =>
    `${row.parent_id}>${row.child_id}`), [
    "root>child",
    "child>grandchild",
  ]);
  assert.deepEqual(
    plan.parentChildRelationships.map((row) => row.metadata.legacyRelationId),
    ["shallow", "deep"],
    "batch metadata must keep the source relation id even when its full legacy row is unavailable",
  );
});

test("covers every canonical GEDCOM edge with permanent legacy relation metadata", () => {
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations: [],
    partnerEdges: [
      partnerEdge("first", "second", "partner-source"),
    ],
    parentChildEdges: [
      parentEdge("first", "child", "father-source", "father"),
      parentEdge("second", "child", "mother-source", "mother"),
    ],
    idFactory: sequentialIds(),
  });

  assert.deepEqual(
    plan.partnerRelationships.map((row) => row.metadata),
    [{ source: "gedcom_import", legacyRelationId: "partner-source" }],
  );
  assert.deepEqual(
    plan.parentChildRelationships.map((row) => row.metadata),
    [
      { source: "gedcom_import", legacyRelationId: "father-source" },
      { source: "gedcom_import", legacyRelationId: "mother-source" },
    ],
  );
});

test("keeps repeated unions for the same couple separate by GEDCOM FAM xref", () => {
  const relations = [
    relation("union-1", "first", "second", "подружжя", { familyXref: "@F1@", startDate: "1900" }),
    relation("union-2", "first", "second", "подружжя", { familyXref: "@F2@", startDate: "1910" }),
  ];
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations,
    partnerEdges: [
      partnerEdge("first", "second", "union-1"),
      partnerEdge("first", "second", "union-2"),
    ],
    parentChildEdges: [],
    idFactory: sequentialIds(),
  });

  assert.equal(plan.familyGroups.length, 2);
  assert.notEqual(plan.familyGroups[0].id, plan.familyGroups[1].id);
  assert.deepEqual(plan.familyGroups.map((group) => group.metadata.familyXref), ["@F1@", "@F2@"]);
  // The production schema has a unique `couple` index per person pair. A
  // repeated union remains separate and uses the schema-safe general group.
  assert.deepEqual(plan.familyGroups.map((group) => group.group_type), ["couple", "other"]);
  assert.deepEqual(plan.partnerRelationships.map((row) => row.family_group_id),
    plan.familyGroups.map((group) => group.id));
  assert.deepEqual(plan.partnerRelationships.map((row) => row.start_date), ["1900", "1910"]);
});

test("does not merge a child-only FAM into an earlier union of the same parents", () => {
  const relations = [
    relation("union-1", "first", "second", "подружжя", { familyXref: "@F1@" }),
    relation("f1-parent-1", "child-1", "first", "батько", { familyXref: "@F1@" }),
    relation("f1-parent-2", "child-1", "second", "мати", { familyXref: "@F1@" }),
    relation("f2-parent-1", "child-2", "first", "батько", { familyXref: "@F2@" }),
    relation("f2-parent-2", "child-2", "second", "мати", { familyXref: "@F2@" }),
  ];
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations,
    partnerEdges: [partnerEdge("first", "second", "union-1")],
    parentChildEdges: [
      parentEdge("first", "child-1", "f1-parent-1", "father"),
      parentEdge("second", "child-1", "f1-parent-2", "mother"),
      parentEdge("first", "child-2", "f2-parent-1", "father"),
      parentEdge("second", "child-2", "f2-parent-2", "mother"),
    ],
    idFactory: sequentialIds(),
  });

  assert.equal(plan.familyGroups.length, 2);
  const groupByXref = new Map(plan.familyGroups.map((group) =>
    [group.metadata.familyXref, group]));
  assert.notEqual(groupByXref.get("@F1@")?.id, groupByXref.get("@F2@")?.id);
  assert.equal(
    plan.parentSets.find((set) => set.child_id === "child-1")?.family_group_id,
    groupByXref.get("@F1@")?.id,
  );
  assert.equal(
    plan.parentSets.find((set) => set.child_id === "child-2")?.family_group_id,
    groupByXref.get("@F2@")?.id,
  );
});

test("2480-person graph uses O(batches) HTTP mutations instead of O(edges)", () => {
  const edgeCount = 2_479;
  const edges = Array.from({ length: edgeCount }, (_, index) =>
    parentEdge(`person-${index}`, `person-${index + 1}`, `relation-${index}`));
  const plan = buildLegacyFamilyTreeImportPlan({
    projectId,
    treeId,
    relations: [],
    partnerEdges: [],
    parentChildEdges: edges.reverse(),
    idFactory: sequentialIds(),
  });
  const batches = buildLegacyImportMutationBatches(plan);

  const expectedRequests = Math.ceil(edgeCount / LEGACY_IMPORT_ROW_BATCH_SIZE)
    + Math.ceil(edgeCount / LEGACY_IMPORT_PARENT_EDGE_BATCH_SIZE);
  assert.equal(batches.length, expectedRequests);
  assert.ok(batches.length < edgeCount / 50);
  assert.ok(batches.every((batch) => batch.rows.length <= LEGACY_IMPORT_ROW_BATCH_SIZE));
  assert.ok(batches
    .filter((batch) => batch.table === "parent_child_relationships")
    .every((batch) => batch.rows.length <= LEGACY_IMPORT_PARENT_EDGE_BATCH_SIZE));
  assert.equal(plan.parentChildRelationships[0].parent_id, "person-0");
  assert.equal(plan.parentChildRelationships.at(-1)?.child_id, "person-2479");
});

test("sync keys match graph-trigger mapping identities", () => {
  const edges = [
    partnerEdge("a", "b", "partner-relation"),
    parentEdge("a", "child", "parent-relation"),
  ];
  assert.deepEqual(legacyImportExpectedSyncKeys(edges), new Set([
    "partner-relation|partner",
    "parent-relation|parent_child",
  ]));
});

function parentEdge(
  parentId: string,
  childId: string,
  legacyRelationId: string,
  parentRoleLabel: "father" | "mother" | "parent" = "parent",
): FamilyTreeProjectionEdge {
  return {
    id: `edge:${legacyRelationId}`,
    kind: "parent_child",
    fromPersonId: parentId,
    toPersonId: childId,
    relationshipType: "biological",
    parentRoleLabel,
    parentSetType: "biological",
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: true,
    isLegal: false,
    isSocial: true,
    lineStyle: "solid",
    legacyRelationId,
    source: "legacy_relation",
  };
}

function partnerEdge(
  firstId: string,
  secondId: string,
  legacyRelationId: string,
): FamilyTreeProjectionEdge {
  return {
    id: `edge:${legacyRelationId}`,
    kind: "partner",
    fromPersonId: firstId,
    toPersonId: secondId,
    relationshipType: "marriage",
    evidenceStatus: "proven",
    confidence: 100,
    lineStyle: "solid",
    legacyRelationId,
    source: "legacy_relation",
  };
}

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
  relationType: PersonRelation["relationType"],
  gedcomMetadata: NonNullable<PersonRelation["gedcomMetadata"]>,
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType,
    status: "доведено",
    evidenceText: "",
    notes: "",
    gedcomMetadata,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function sequentialIds(): () => string {
  let index = 0;
  return () => `generated-${++index}`;
}
