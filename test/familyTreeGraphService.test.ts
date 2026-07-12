import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTree,
  FamilyTreePerson,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
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

function treePerson(personId: string, overrides: Partial<FamilyTreePerson> = {}): FamilyTreePerson {
  return {
    treeId: "tree",
    projectId: "project",
    personId,
    memberRole: "member",
    displayOrder: 0,
    notes: "",
    createdAt: now,
    ...overrides,
  };
}

function profile(
  id: string,
  displayName = id,
  overrides: Partial<FamilyTreePersonProfile> = {},
): FamilyTreePersonProfile {
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
    maidenSurname: "",
    isLiving: false,
    privacyStatus: "private",
    ...overrides,
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

function event(
  personId: string,
  eventType: FamilyTreePersonTimelineEvent["eventType"],
  eventDate: string,
): FamilyTreePersonTimelineEvent {
  return {
    id: `${personId}-${eventType}-${eventDate}`,
    projectId: "project",
    personId,
    eventType,
    title: "",
    eventDate,
    dateFrom: "",
    dateTo: "",
    dateText: eventDate,
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
  const profiles = ["root", "partner-1", "partner-2", "child-1", "child-2", "father", "mother", "ancestor", "isolated"]
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

test("available persons include project people outside the currently rendered graph", () => {
  const graph = buildFamilyTreeGraphDto(query(), data());

  assert.equal(graph.nodes.some((node) => node.personId === "isolated"), false);
  assert.equal(graph.availablePersons.some((node) => node.personId === "isolated"), true);
});

test("does not warn when the owner views private living people", () => {
  const graph = buildFamilyTreeGraphDto(
    query({ includePrivateLiving: true }),
    data({
      personProfiles: [
        profile("root", "Жива Особа", { isLiving: true, privacyStatus: "private" }),
      ],
      personNames: [name("root", "Жива Особа")],
    }),
  );

  assert.equal(graph.nodes[0]?.redacted, false);
  assert.equal(graph.issues.some((issue) => issue.code === "privateLivingPersonVisible"), false);
});

test("derives maiden surname name from person profile when graph names do not include it", () => {
  const graph = buildFamilyTreeGraphDto(
    query({ rootPersonId: "mother" }),
    data({
      tree: tree({ rootPersonId: "mother" }),
      personProfiles: [
        profile("mother", "Каленська Олена", { surname: "Каленська", givenName: "Олена", maidenSurname: "Завальнюк" }),
      ],
      personNames: [
        name("mother", "Каленська Олена"),
      ],
    }),
  );

  const mother = graph.nodes.find((node) => node.personId === "mother");

  assert.equal(mother?.names.some((item) => item.nameType === "birth" && item.surname === "Завальнюк"), true);
});

test("can focus a project person even when they do not have tree relationships yet", () => {
  const graph = buildFamilyTreeGraphDto(query({ rootPersonId: "isolated" }), data());

  assert.deepEqual(graph.nodes.map((node) => node.personId), ["isolated"]);
  assert.equal(graph.occurrences.length, 1);
  assert.equal(graph.edges.length, 0);
});

test("does not silently choose the first person when a tree has no root", () => {
  const graph = buildFamilyTreeGraphDto(query({ rootPersonId: undefined }), data({
    tree: tree({ rootPersonId: null }),
  }));

  assert.equal(graph.rootPersonId, null);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.issues.some((issue) => issue.code === "missingRootPerson"), true);
});

test("falls back to the saved tree root when query root person id is stale", () => {
  const graph = buildFamilyTreeGraphDto(query({ rootPersonId: "missing-person" }), data());

  assert.equal(graph.rootPersonId, "root");
  assert.equal(graph.nodes.some((node) => node.personId === "root"), true);
  assert.equal(graph.issues.some((issue) => issue.code === "missingRootPerson"), false);
});

test("uses the original root tree member by default when the saved root was overwritten", () => {
  const graph = buildFamilyTreeGraphDto(
    query({ rootPersonId: undefined }),
    data({
      tree: tree({ rootPersonId: "father" }),
      treePersons: [
        treePerson("root", { memberRole: "root", createdAt: "2026-07-01T00:00:00.000Z" }),
        treePerson("father", { memberRole: "root", createdAt: "2026-07-04T00:00:00.000Z" }),
      ],
    }),
  );

  assert.equal(graph.rootPersonId, "root");
});

test("allows a valid query root to temporarily override the default tree root", () => {
  const graph = buildFamilyTreeGraphDto(
    query({ rootPersonId: "father" }),
    data({
      treePersons: [
        treePerson("root", { memberRole: "root", createdAt: "2026-07-01T00:00:00.000Z" }),
      ],
    }),
  );

  assert.equal(graph.rootPersonId, "father");
});

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

test("family view limits generations up and down independently", () => {
  const graph = buildFamilyTreeGraphDto(query({ maxDepthUp: 1, maxDepthDown: 2 }), data({
    parentSets: [
      parentSet("set-root", "root"),
      parentSet("set-father", "father"),
      parentSet("set-child-1", "child-1"),
      parentSet("set-child-2", "child-2"),
    ],
    parentChildRelationships: [
      parentChild("father-root", "father", "root", "set-root"),
      parentChild("ancestor-father", "ancestor", "father", "set-father"),
      parentChild("root-child-1", "root", "child-1", "set-child-1"),
      parentChild("child1-child2", "child-1", "child-2", "set-child-2"),
    ],
  }));

  const persons = graph.nodes.map((node) => node.personId);
  assert.equal(persons.includes("father"), true);
  assert.equal(persons.includes("ancestor"), false);
  assert.equal(persons.includes("child-1"), true);
  assert.equal(persons.includes("child-2"), true);
});

test("unlimited depth traverses ancestors beyond the default generation limit", () => {
  const chain = ["root", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const relationships = chain.slice(1).map((parentId, index) => {
    const childId = chain[index] ?? "root";
    return parentChild(`${parentId}-${childId}`, parentId, childId, `set-${childId}`);
  });
  const graph = buildFamilyTreeGraphDto(query({ mode: "ancestors", unlimitedDepth: true }), data({
    personProfiles: chain.map((id) => profile(id, id)),
    personNames: chain.map((id) => name(id, id)),
    parentSets: chain.slice(0, -1).map((childId) => parentSet(`set-${childId}`, childId)),
    parentChildRelationships: relationships,
  }));

  const persons = graph.nodes.map((node) => node.personId);
  assert.equal(persons.includes("p7"), true);
});

test("graph display collapses duplicate parent-child relationships for the same parent and child", () => {
  const graph = buildFamilyTreeGraphDto(query(), data({
    parentSets: [
      parentSet("set-root", "root"),
    ],
    parentChildRelationships: [
      parentChild("father-root-generic", "father", "root", "set-root", {
        relationshipType: "unknown",
        parentRoleLabel: "parent",
        confidence: 50,
      }),
      parentChild("father-root-biological", "father", "root", "set-root", {
        relationshipType: "biological",
        parentRoleLabel: "father",
        confidence: 100,
      }),
    ],
  }));

  const parentEdges = graph.edges.filter((edge) =>
    edge.kind === "parent_child" &&
    edge.fromPersonId === "father" &&
    edge.toPersonId === "root"
  );

  assert.equal(parentEdges.length, 1);
  assert.equal(parentEdges[0]?.relationshipId, "father-root-biological");
  assert.equal(parentEdges[0]?.relationshipType, "biological");
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

test("descendants view keeps a descendant partner on the descendant generation", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "descendants", maxDepthDown: 2 }), data({
    parentSets: [
      parentSet("set-child-1", "child-1"),
    ],
    parentChildRelationships: [
      parentChild("root-child-1", "root", "child-1", "set-child-1"),
    ],
    partnerRelationships: [
      partner("child-spouse", "child-1", "partner-1"),
    ],
  }));

  const child = graph.occurrences.find((occurrence) => occurrence.personId === "child-1");
  const spouse = graph.occurrences.find((occurrence) => occurrence.personId === "partner-1");

  assert.equal(child?.generation, 1);
  assert.equal(spouse?.generation, 1);
});

test("descendants view marks boundary people with hidden children beyond the selected depth", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "descendants", maxDepthDown: 1 }), data({
    parentSets: [
      parentSet("set-child-1", "child-1"),
      parentSet("set-child-2", "child-2"),
    ],
    parentChildRelationships: [
      parentChild("root-child-1", "root", "child-1", "set-child-1"),
      parentChild("child1-child2", "child-1", "child-2", "set-child-2"),
    ],
  }));

  const child = graph.occurrences.find((occurrence) => occurrence.personId === "child-1");

  assert.equal(graph.nodes.some((node) => node.personId === "child-2"), false);
  assert.equal(child?.hiddenChildrenCount, 1);
});

test("ancestors view marks boundary people with hidden parents beyond the selected depth", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "ancestors", maxDepthUp: 1 }), data({
    parentSets: [
      parentSet("set-root", "root"),
      parentSet("set-father", "father"),
    ],
    parentChildRelationships: [
      parentChild("father-root", "father", "root", "set-root"),
      parentChild("ancestor-father", "ancestor", "father", "set-father"),
    ],
  }));

  const father = graph.occurrences.find((occurrence) => occurrence.personId === "father");

  assert.equal(graph.nodes.some((node) => node.personId === "ancestor"), false);
  assert.equal(father?.hiddenParentsCount, 1);
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

test("family view keeps repeated ancestors as local branch occurrences", () => {
  const graph = buildFamilyTreeGraphDto(query({ mode: "family", maxDepthUp: 2 }), data({
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
  assert.equal(ancestorOccurrences.every((occurrence) => occurrence.isRepeated), true);
  assert.equal(graph.nodes.find((node) => node.personId === "ancestor")?.occurrenceIds.length, 2);

  const fatherEdge = graph.edges.find((edge) => edge.relationshipId === "ancestor-father");
  const motherEdge = graph.edges.find((edge) => edge.relationshipId === "ancestor-mother");
  assert.equal(fatherEdge?.fromOccurrenceId?.includes("root>father>ancestor"), true);
  assert.equal(fatherEdge?.toOccurrenceId?.includes("root>father"), true);
  assert.equal(motherEdge?.fromOccurrenceId?.includes("root>mother>ancestor"), true);
  assert.equal(motherEdge?.toOccurrenceId?.includes("root>mother"), true);
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

test("detects people without usable names in the rendered graph", () => {
  const unnamed = profile("unnamed", "");
  const graph = buildFamilyTreeGraphDto(query({ rootPersonId: "unnamed" }), data({
    tree: tree({ rootPersonId: "unnamed" }),
    personProfiles: [unnamed],
    personNames: [],
  }));

  const issue = graph.issues.find((item) => item.code === "personWithoutName");

  assert.ok(issue);
  assert.deepEqual(issue.personIds, ["unnamed"]);
});

test("detects multiple biological fathers for one child", () => {
  const graph = buildFamilyTreeGraphDto(query(), data({
    parentSets: [
      parentSet("set-root", "root"),
    ],
    parentChildRelationships: [
      parentChild("father-root", "father", "root", "set-root", {
        parentRoleLabel: "father",
      }),
      parentChild("ancestor-root", "ancestor", "root", "set-root", {
        parentRoleLabel: "father",
      }),
    ],
  }));

  const issue = graph.issues.find((item) => item.code === "multipleBiologicalFathers");

  assert.ok(issue);
  assert.deepEqual(issue.relationshipIds.sort(), ["ancestor-root", "father-root"]);
  assert.equal(issue.personIds.includes("root"), true);
  assert.equal(issue.personIds.includes("father"), true);
  assert.equal(issue.personIds.includes("ancestor"), true);
});

test("detects date conflicts in visible tree people and relationships", () => {
  const graph = buildFamilyTreeGraphDto(query(), data({
    parentSets: [
      parentSet("set-root", "root"),
    ],
    parentChildRelationships: [
      parentChild("father-root", "father", "root", "set-root", {
        parentRoleLabel: "father",
      }),
    ],
    partnerRelationships: [
      partner("root-partner", "root", "partner-1", { startDate: "1980-01-01" }),
    ],
    personTimelineEvents: [
      event("root", "birth", "1991-02-09"),
      event("root", "death", "1981-01-01"),
      event("father", "birth", "2000"),
      event("partner-1", "birth", "1990"),
    ],
  }));

  assert.equal(graph.issues.some((issue) => issue.code === "dateConflict" && issue.personIds.includes("root")), true);
  assert.equal(graph.issues.some((issue) => issue.code === "parentAgeConflict"), true);
  assert.equal(graph.issues.some((issue) =>
    issue.code === "dateConflict" &&
    issue.relationshipIds.includes("root-partner")
  ), true);
});

test("detects potential duplicate people by normalized name and birth year", () => {
  const graph = buildFamilyTreeGraphDto(query(), data({
    personProfiles: [
      profile("root", "Р†РІР°РЅ РџРµС‚СЂРµРЅРєРѕ"),
      profile("duplicate", "Р†РІР°РЅ РџРµС‚СЂРµРЅРєРѕ"),
    ],
    personNames: [
      name("root", "Р†РІР°РЅ РџРµС‚СЂРµРЅРєРѕ"),
      name("duplicate", "Р†РІР°РЅ РџРµС‚СЂРµРЅРєРѕ"),
    ],
    partnerRelationships: [
      partner("root-duplicate", "root", "duplicate"),
    ],
    personTimelineEvents: [
      event("root", "birth", "1901"),
      event("duplicate", "birth", "1901-05-12"),
    ],
  }));

  const issue = graph.issues.find((item) => item.code === "potentialDuplicatePerson");

  assert.ok(issue);
  assert.deepEqual(issue.personIds.sort(), ["duplicate", "root"]);
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
