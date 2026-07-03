import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTree,
  FamilyTreePersonName,
  FamilyTreeGraphQuery,
  ParentChildRelationship,
  ParentSet,
  PartnerRelationship,
} from "../src/types/familyTree.ts";
import type {
  FamilyTreeGraphRepositoryData,
  FamilyTreePersonProfile,
} from "../src/services/familyTreeGraphRepository.ts";
import {
  buildFamilyTreeGraphDto,
  resolveFamilyTreeEdgeStyle,
} from "../src/services/familyTreeGraphService.ts";

const now = "2026-07-03T00:00:00.000Z";

function query(overrides: Partial<FamilyTreeGraphQuery> = {}): FamilyTreeGraphQuery {
  return {
    projectId: "project",
    treeId: "tree",
    rootPersonId: "root",
    mode: "family",
    ...overrides,
  };
}

function tree(overrides: Partial<FamilyTree> = {}): FamilyTree {
  return {
    id: "tree",
    projectId: "project",
    researchId: null,
    title: "Tree",
    description: "",
    rootPersonId: "root",
    isDefault: true,
    privacyStatus: "private",
    settings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function profile(id: string, displayName = id): FamilyTreePersonProfile {
  const parts = displayName.split(" ");
  return {
    id,
    projectId: "project",
    researchId: null,
    gender: "unknown",
    status: "proven",
    surname: parts[0] ?? "",
    givenName: parts[1] ?? "",
    patronymic: parts.slice(2).join(" "),
    fullName: displayName,
    isLiving: false,
    privacyStatus: "private",
  };
}

function name(personId: string, fullName: string): FamilyTreePersonName {
  return {
    id: `name-${personId}`,
    projectId: "project",
    personId,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: fullName.split(" ")[0] ?? "",
    givenName: fullName.split(" ")[1] ?? "",
    patronymic: "",
    fullName,
    originalText: fullName,
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
    relationshipType: "marriage",
    status: "active",
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

function data(overrides: Partial<FamilyTreeGraphRepositoryData> = {}): FamilyTreeGraphRepositoryData {
  const profiles = ["root", "partner-1", "partner-2", "child-1", "child-2", "father", "mother", "ancestor"]
    .map((id) => profile(id, id));
  return {
    tree: tree(),
    treePersons: [],
    personProfiles: profiles,
    groups: [],
    groupMembers: [],
    partnerRelationships: [],
    parentSets: [],
    parentChildRelationships: [],
    associationRelationships: [],
    layoutPositions: [],
    researchIssues: [],
    personNames: profiles.map((item) => name(item.id, item.fullName)),
    personTimelineEvents: [],
    ...overrides,
  };
}

test("family view includes two partners and children from both partner sets", () => {
  const graph = buildFamilyTreeGraphDto(query(), data({
    partnerRelationships: [
      partner("spouse-1", "root", "partner-1"),
      partner("spouse-2", "root", "partner-2"),
    ],
    parentSets: [
      parentSet("set-child-1", "child-1"),
      parentSet("set-child-2", "child-2"),
    ],
    parentChildRelationships: [
      parentChild("root-child-1", "root", "child-1", "set-child-1"),
      parentChild("partner-1-child-1", "partner-1", "child-1", "set-child-1"),
      parentChild("root-child-2", "root", "child-2", "set-child-2"),
      parentChild("partner-2-child-2", "partner-2", "child-2", "set-child-2"),
    ],
  }));

  assert.deepEqual(
    graph.nodes.map((node) => node.personId).sort(),
    ["child-1", "child-2", "partner-1", "partner-2", "root"],
  );
  assert.equal(graph.edges.filter((edge) => edge.kind === "partner").length, 2);
  assert.equal(graph.edges.filter((edge) => edge.kind === "parent_child").length, 4);
});

test("descendants view keeps children from different partners in one graph response", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "descendants" }), data({
    partnerRelationships: [
      partner("spouse-1", "root", "partner-1"),
      partner("spouse-2", "root", "partner-2"),
    ],
    parentSets: [
      parentSet("set-child-1", "child-1"),
      parentSet("set-child-2", "child-2"),
    ],
    parentChildRelationships: [
      parentChild("root-child-1", "root", "child-1", "set-child-1"),
      parentChild("partner-1-child-1", "partner-1", "child-1", "set-child-1"),
      parentChild("root-child-2", "root", "child-2", "set-child-2"),
      parentChild("partner-2-child-2", "partner-2", "child-2", "set-child-2"),
    ],
  }));

  assert.equal(graph.nodes.some((node) => node.personId === "partner-1"), true);
  assert.equal(graph.nodes.some((node) => node.personId === "partner-2"), true);
  assert.equal(graph.nodes.some((node) => node.personId === "child-1"), true);
  assert.equal(graph.nodes.some((node) => node.personId === "child-2"), true);
});

test("ancestors view creates separate occurrences for repeated ancestor", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "ancestors", maxDepth: 2 }), data({
    tree: tree({ rootPersonId: "root" }),
    parentSets: [
      parentSet("set-root", "root"),
      parentSet("set-father", "father"),
      parentSet("set-mother", "mother"),
    ],
    parentChildRelationships: [
      parentChild("father-root", "father", "root", "set-root"),
      parentChild("mother-root", "mother", "root", "set-root"),
      parentChild("ancestor-father", "ancestor", "father", "set-father"),
      parentChild("ancestor-mother", "ancestor", "mother", "set-mother"),
    ],
  }));

  const ancestorOccurrences = graph.occurrences.filter((occurrence) => occurrence.personId === "ancestor");
  assert.equal(ancestorOccurrences.length, 2);
  assert.equal(graph.issues.some((issue) => issue.code === "repeatedAncestor"), true);
});

test("adoptive parent set is represented as dashed parent-child edge", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "ancestors" }), data({
    parentSets: [
      parentSet("adoptive-set", "root", {
        setType: "adoptive",
        isPreferredForDisplay: true,
        isDefaultForPedigree: false,
      }),
    ],
    parentChildRelationships: [
      parentChild("adoptive-root", "father", "root", "adoptive-set", {
        relationshipType: "adoptive",
        parentRoleLabel: "adoptive_father",
        isBloodline: false,
        isLegal: true,
        isSocial: true,
      }),
    ],
  }));

  const edge = graph.edges.find((item) => item.relationshipId === "adoptive-root");
  assert.equal(edge?.style.lineStyle, "dashed");
  assert.equal(graph.groups.some((group) => group.id === "adoptive-set" && group.groupType === "adoptive"), true);
});

test("detects biological cycle in graph bridge issues", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "descendants", rootPersonId: "root" }), data({
    parentSets: [
      parentSet("set-root", "root"),
      parentSet("set-child", "child-1"),
    ],
    parentChildRelationships: [
      parentChild("root-child", "root", "child-1", "set-child"),
      parentChild("child-root", "child-1", "root", "set-root"),
    ],
  }));

  assert.equal(graph.issues.some((issue) => issue.code === "biologicalCycle"), true);
});

test("maps graph edge styles by relationship and evidence status", () => {
  assert.deepEqual(
    resolveFamilyTreeEdgeStyle({
      kind: "parent_child",
      relationshipType: "biological",
      evidenceStatus: "proven",
      isBloodline: true,
    }),
    { lineStyle: "solid", visibility: "visible" },
  );
  assert.deepEqual(
    resolveFamilyTreeEdgeStyle({
      kind: "parent_child",
      relationshipType: "guardian",
      evidenceStatus: "likely",
    }),
    { lineStyle: "dashed", visibility: "visible" },
  );
  assert.deepEqual(
    resolveFamilyTreeEdgeStyle({
      kind: "parent_child",
      relationshipType: "biological",
      evidenceStatus: "unknown",
    }),
    { lineStyle: "dotted", visibility: "visible", marker: "warning" },
  );
  assert.deepEqual(
    resolveFamilyTreeEdgeStyle({
      kind: "parent_child",
      relationshipType: "biological",
      evidenceStatus: "disproven",
    }),
    { lineStyle: "dotted", visibility: "hidden", marker: "disproven" },
  );
});
