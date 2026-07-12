import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyGroup,
  FamilyGroupMember,
  FamilyTreePerson,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  ParentChildRelationship,
  ParentSet,
  PartnerRelationship,
} from "../src/types/familyTree.ts";
import type { FamilyTreePersonProfile } from "../src/services/familyTreeGraphRepository.ts";
import {
  adaptTrackerFamilyTreeSnapshot,
  parentSetUnionId,
  partnershipUnionId,
  type TrackerFamilyTreeSnapshot,
} from "../src/features/family-tree-view/adapters/trackerFamilyTreeAdapter.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";

const now = "2026-07-10T00:00:00.000Z";

function profile(
  id: string,
  overrides: Partial<FamilyTreePersonProfile> = {},
): FamilyTreePersonProfile {
  return {
    id,
    projectId: "project",
    researchId: null,
    gender: "unknown",
    status: "proven",
    surname: id,
    givenName: "",
    patronymic: "",
    fullName: id,
    maidenSurname: "",
    isLiving: false,
    privacyStatus: "private",
    ...overrides,
  };
}

function treePerson(
  personId: string,
  displayOrder = 0,
): FamilyTreePerson {
  return {
    treeId: "tree",
    projectId: "project",
    personId,
    memberRole: "member",
    displayOrder,
    notes: "",
    createdAt: now,
  };
}

function familyGroup(
  id: string,
  overrides: Partial<FamilyGroup> = {},
): FamilyGroup {
  return {
    id,
    projectId: "project",
    treeId: "tree",
    groupType: "couple",
    displayLabel: "",
    primaryPartner1Id: null,
    primaryPartner2Id: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function groupMember(
  familyGroupId: string,
  personId: string,
  memberRole: FamilyGroupMember["memberRole"],
  displayOrder: number,
): FamilyGroupMember {
  return {
    projectId: "project",
    familyGroupId,
    personId,
    memberRole,
    displayOrder,
    notes: "",
    createdAt: now,
  };
}

function partner(
  id: string,
  personAId: string,
  personBId: string,
  overrides: Partial<PartnerRelationship> = {},
): PartnerRelationship {
  return {
    id,
    projectId: "project",
    treeId: "tree",
    familyGroupId: null,
    personAId,
    personBId,
    relationshipType: "unknown",
    status: "unknown",
    startDate: "",
    startPlace: "",
    endDate: "",
    endPlace: "",
    evidenceStatus: "proven",
    confidence: 100,
    isPrimaryForDisplay: false,
    privacyStatus: "private",
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function parentSet(
  id: string,
  childId: string,
  overrides: Partial<ParentSet> = {},
): ParentSet {
  return {
    id,
    projectId: "project",
    treeId: "tree",
    childId,
    familyGroupId: null,
    setType: "biological",
    isPreferredForDisplay: true,
    isDefaultForPedigree: true,
    displayOrder: 0,
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function parentChild(
  id: string,
  parentId: string,
  childId: string,
  parentSetId: string,
  overrides: Partial<ParentChildRelationship> = {},
): ParentChildRelationship {
  return {
    id,
    projectId: "project",
    treeId: "tree",
    parentId,
    childId,
    parentSetId,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function personName(personId: string): FamilyTreePersonName {
  return {
    id: `name-${personId}`,
    projectId: "project",
    personId,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: "Коваль",
    givenName: "Олена",
    patronymic: "Іванівна",
    fullName: "Коваль Олена Іванівна",
    originalText: "",
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "proven",
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function timelineEvent(
  personId: string,
  eventType: FamilyTreePersonTimelineEvent["eventType"],
  eventDate: string,
  dateText = eventDate,
): FamilyTreePersonTimelineEvent {
  return {
    id: `${personId}-${eventType}`,
    projectId: "project",
    personId,
    eventType,
    title: "",
    eventDate,
    dateFrom: "",
    dateTo: "",
    dateText,
    placeName: "",
    geo: null,
    eventRole: "",
    evidenceStatus: "proven",
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function snapshot(
  personIds: readonly string[],
  overrides: Partial<TrackerFamilyTreeSnapshot> = {},
): TrackerFamilyTreeSnapshot {
  return {
    personProfiles: personIds.map(id => profile(id)),
    treePersons: personIds.map((id, index) => treePerson(id, index)),
    groups: [],
    groupMembers: [],
    partnerRelationships: [],
    parentSets: [],
    parentChildRelationships: [],
    personNames: [],
    personTimelineEvents: [],
    ...overrides,
  };
}

test("adapter namespaces union IDs while preserving canonical IDs, union data, and manual ordering", () => {
  const graph = adaptTrackerFamilyTreeSnapshot(snapshot(
    ["root", "partner-a", "partner-b", "child-a", "child-b"],
    {
      treePersons: [
        treePerson("root", 20),
        treePerson("partner-a", 30),
        treePerson("partner-b", 10),
        treePerson("child-a", 50),
        treePerson("child-b", 40),
      ],
      personNames: [personName("root")],
      personTimelineEvents: [
        timelineEvent("root", "birth", "1880-04-03", "3 квітня 1880"),
      ],
      groups: [familyGroup("group-a"), familyGroup("group-b")],
      groupMembers: [
        groupMember("group-a", "partner-a", "partner", 0),
        groupMember("group-a", "root", "partner", 1),
        groupMember("group-a", "child-a", "child", 8),
        groupMember("group-b", "root", "partner", 0),
        groupMember("group-b", "partner-b", "partner", 1),
        groupMember("group-b", "child-b", "child", 3),
      ],
      partnerRelationships: [
        partner("shared-id", "root", "partner-a", {
          familyGroupId: "group-a",
          relationshipType: "marriage",
          status: "active",
          startDate: "03.02.1901",
          endDate: "1910",
          isPrimaryForDisplay: true,
        }),
        partner("partner-relation-b", "root", "partner-b", {
          familyGroupId: "group-b",
          relationshipType: "cohabitation",
          status: "ended",
        }),
      ],
      parentSets: [
        parentSet("shared-id", "child-a", {
          familyGroupId: "group-a",
          displayOrder: 8,
        }),
        parentSet("set-child-b", "child-b", {
          familyGroupId: "group-b",
          displayOrder: 3,
        }),
      ],
      parentChildRelationships: [
        parentChild("root-child-a", "root", "child-a", "shared-id", {
          familyGroupId: "group-a",
          parentRoleLabel: "father",
        }),
        parentChild("partner-a-child-a", "partner-a", "child-a", "shared-id", {
          familyGroupId: "group-a",
          parentRoleLabel: "mother",
        }),
        parentChild("root-child-b", "root", "child-b", "set-child-b", {
          familyGroupId: "group-b",
          parentRoleLabel: "father",
        }),
        parentChild("partner-b-child-b", "partner-b", "child-b", "set-child-b", {
          familyGroupId: "group-b",
          parentRoleLabel: "mother",
        }),
      ],
      graphVersion: 17,
    },
  ));

  assert.deepEqual(
    graph.persons.map(person => person.id).sort(),
    ["child-a", "child-b", "partner-a", "partner-b", "root"],
  );
  assert.deepEqual(
    graph.parentChildRelations.map(relation => relation.id).sort(),
    ["partner-a-child-a", "partner-b-child-b", "root-child-a", "root-child-b"],
  );
  assert.deepEqual(
    graph.unions.map(union => union.id).sort(),
    [
      parentSetUnionId("set-child-b"),
      parentSetUnionId("shared-id"),
      partnershipUnionId("partner-relation-b"),
      partnershipUnionId("shared-id"),
    ].sort(),
  );
  assert.equal(graph.graphVersion, 17);

  const root = graph.persons.find(person => person.id === "root")!;
  const partnerB = graph.persons.find(person => person.id === "partner-b")!;
  assert.equal(root.displayName, "Коваль Олена Іванівна");
  assert.deepEqual(root.birth, { display: "3 квітня 1880", sort: "1880-04-03" });
  assert.ok(partnerB.displayOrder! < root.displayOrder!);

  const marriage = graph.unions.find(
    union => union.id === partnershipUnionId("shared-id"),
  )!;
  assert.equal(marriage.kind, "partnership");
  assert.equal(marriage.familyGroupId, "group-a");
  assert.deepEqual(marriage.memberIds, ["partner-a", "root"]);
  assert.equal(marriage.relationshipType, "marriage");
  assert.equal(marriage.status, "active");
  assert.deepEqual(marriage.startDate, { display: "03.02.1901", sort: "1901-02-03" });
  assert.deepEqual(marriage.endDate, { display: "1910", sort: "1910" });

  const setA = graph.unions.find(
    union => union.id === parentSetUnionId("shared-id"),
  )!;
  assert.equal(setA.kind, "parent-set");
  assert.equal(setA.familyGroupId, "group-a");
  assert.deepEqual(setA.memberIds, ["partner-a", "root"]);

  const childARelation = graph.parentChildRelations.find(
    relation => relation.id === "root-child-a",
  )!;
  const childBRelation = graph.parentChildRelations.find(
    relation => relation.id === "root-child-b",
  )!;
  assert.equal(childARelation.unionId, parentSetUnionId("shared-id"));
  assert.equal(childARelation.kind, "biological");
  assert.equal(childARelation.role, "father");
  assert.ok(childBRelation.displayOrder! < childARelation.displayOrder!);

  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "root",
      ancestorDepth: 1,
      descendantDepth: 1,
      collateralDepth: 1,
      maxVisibleNodes: 50,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
    },
  });
  const cards = layout.nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );
  assert.deepEqual(
    cards.map(node => node.personId).sort(),
    ["child-a", "child-b", "partner-a", "partner-b", "root"],
  );
  assert.equal(cards.some(node => node.kind === "reference"), false);
});

test("multiple donor, surrogate, and guardian parent sets never invent a partnership", () => {
  const graph = adaptTrackerFamilyTreeSnapshot(snapshot(
    ["child", "donor", "surrogate", "guardian"],
    {
      parentSets: [
        parentSet("set-genetic", "child", {
          setType: "genetic",
          isPreferredForDisplay: true,
          isDefaultForPedigree: false,
          displayOrder: 7,
        }),
        parentSet("set-guardian", "child", {
          setType: "guardian",
          isPreferredForDisplay: false,
          isDefaultForPedigree: true,
          displayOrder: 11,
        }),
      ],
      parentChildRelationships: [
        parentChild("donor-child", "donor", "child", "set-genetic", {
          relationshipType: "donor",
          parentRoleLabel: "custom",
          isBloodline: true,
          isLegal: false,
        }),
        parentChild("surrogate-child", "surrogate", "child", "set-genetic", {
          relationshipType: "surrogate",
          parentRoleLabel: "mother",
          isBloodline: false,
          isLegal: false,
        }),
        parentChild("guardian-child", "guardian", "child", "set-guardian", {
          relationshipType: "guardian",
          parentRoleLabel: "guardian",
          isBloodline: false,
          isLegal: true,
        }),
      ],
    },
  ));

  assert.equal(graph.unions.some(union => union.kind === "partnership"), false);
  assert.equal(graph.unions.length, 2);

  const genetic = graph.unions.find(
    union => union.id === parentSetUnionId("set-genetic"),
  )!;
  const guardian = graph.unions.find(
    union => union.id === parentSetUnionId("set-guardian"),
  )!;
  assert.deepEqual(genetic.memberIds, ["donor", "surrogate"]);
  assert.equal(genetic.parentSetType, "genetic");
  assert.equal(genetic.isPreferredForDisplay, true);
  assert.equal(genetic.isDefaultForPedigree, false);
  assert.deepEqual(guardian.memberIds, ["guardian"]);
  assert.equal(guardian.parentSetType, "guardian");
  assert.equal(guardian.isPreferredForDisplay, false);
  assert.equal(guardian.isDefaultForPedigree, true);
  assert.ok(genetic.displayOrder! < guardian.displayOrder!);

  const exactRelations = Object.fromEntries(
    graph.parentChildRelations.map(relation => [relation.id, relation]),
  );
  assert.equal(exactRelations["donor-child"]!.kind, "donor");
  assert.equal(exactRelations["donor-child"]!.role, "custom");
  assert.equal(exactRelations["surrogate-child"]!.kind, "surrogate");
  assert.equal(exactRelations["surrogate-child"]!.role, "mother");
  assert.equal(exactRelations["guardian-child"]!.kind, "guardian");
  assert.equal(exactRelations["guardian-child"]!.role, "guardian");
  assert.equal(exactRelations["donor-child"]!.isPreferred, true);
  assert.equal(exactRelations["guardian-child"]!.isPreferred, true);
});

test("a repeated canonical ancestor stays one person across both parent paths", () => {
  const graph = adaptTrackerFamilyTreeSnapshot(snapshot(
    ["focus", "left-parent", "right-parent", "shared-ancestor"],
    {
      parentSets: [
        parentSet("set-focus", "focus", { displayOrder: 0 }),
        parentSet("set-left", "left-parent", { displayOrder: 0 }),
        parentSet("set-right", "right-parent", { displayOrder: 0 }),
      ],
      parentChildRelationships: [
        parentChild("left-focus", "left-parent", "focus", "set-focus", {
          parentRoleLabel: "father",
        }),
        parentChild("right-focus", "right-parent", "focus", "set-focus", {
          parentRoleLabel: "mother",
        }),
        parentChild("ancestor-left", "shared-ancestor", "left-parent", "set-left", {
          parentRoleLabel: "father",
        }),
        parentChild("ancestor-right", "shared-ancestor", "right-parent", "set-right", {
          parentRoleLabel: "father",
        }),
      ],
    },
  ));

  assert.equal(
    graph.persons.filter(person => person.id === "shared-ancestor").length,
    1,
  );
  assert.deepEqual(
    graph.parentChildRelations
      .filter(relation => relation.parentId === "shared-ancestor")
      .map(relation => relation.id)
      .sort(),
    ["ancestor-left", "ancestor-right"],
  );

  assert.deepEqual(
    graph.parentChildRelations
      .filter(relation => relation.parentId === "shared-ancestor")
      .map(relation => relation.unionId)
      .sort(),
    [parentSetUnionId("set-left"), parentSetUnionId("set-right")].sort(),
  );
});
