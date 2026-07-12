import test from "node:test";
import assert from "node:assert/strict";
import type { FamilyTreeEdgeDto, FamilyTreeGraphDto, FamilyTreeNodeDto, FamilyTreeOccurrenceDto } from "../src/types/familyTree.ts";
import { graphForDisplayMode } from "../src/utils/familyTreeVisibility.ts";

test("family display mode keeps the focused tree compact by hiding side branches", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "family");
  const personIds = visiblePersonIds(visible);

  assert.equal(personIds.has("root"), true);
  assert.equal(personIds.has("father"), true);
  assert.equal(personIds.has("mother"), true);
  assert.equal(personIds.has("grandfather"), true);
  assert.equal(personIds.has("grandmother"), true);
  assert.equal(personIds.has("spouse"), false);
  assert.equal(personIds.has("child"), false);
  assert.equal(personIds.has("sibling"), false);
  assert.equal(personIds.has("uncle"), false);
  assert.equal(personIds.has("unclePartner"), false);
  assert.equal(personIds.has("cousin"), false);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "root")?.hiddenSideBranchesCount, 1);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.hiddenSideBranchesCount, 3);
});

test("family display mode expands a requested side branch around a visible person", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["father"] });
  const personIds = visiblePersonIds(visible);

  assert.equal(personIds.has("father"), true);
  assert.equal(personIds.has("uncle"), true);
  assert.equal(personIds.has("unclePartner"), true);
  assert.equal(personIds.has("cousin"), true);
  assert.equal(personIds.has("cousinChild"), false);
  assert.equal(personIds.has("sibling"), false);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.hiddenSideBranchesCount, 0);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.sideBranchesExpanded, true);
});

test("family display mode does not show phantom side markers for an opened focus line", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["father"] });

  assert.equal(visible.nodes.some((node) => node.personId === "uncle"), true);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "uncle")?.hiddenSideBranchesCount ?? 0, 0);
});

test("family display mode opens a focused person's local block without expanding the whole tree", () => {
  const graph = {
    ...graphFixture(),
    rootPersonId: "father",
  };

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["father"] });
  const personIds = visiblePersonIds(visible);

  assert.equal(personIds.has("father"), true);
  assert.equal(personIds.has("grandfather"), true);
  assert.equal(personIds.has("grandmother"), true);
  assert.equal(personIds.has("mother"), true);
  assert.equal(personIds.has("root"), true);
  assert.equal(personIds.has("sibling"), true);
  assert.equal(personIds.has("spouse"), true);
  assert.equal(personIds.has("child"), true);
  assert.equal(personIds.has("uncle"), true);
  assert.equal(personIds.has("unclePartner"), true);
  assert.equal(personIds.has("cousin"), true);
  assert.equal(personIds.has("cousinChild"), true);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.sideBranchesExpanded, true);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "uncle")?.sideBranchesExpanded, false);
});

test("family display mode opens a MyHeritage-like grandparent block with sibling descendants and parent-side families", () => {
  const graph = {
    ...grandparentFocusGraphFixture(),
    rootPersonId: "grandmother",
  };

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["grandmother"] });
  const personIds = visiblePersonIds(visible);

  for (const id of [
    "grandmother",
    "greatGrandfather",
    "greatGrandmother",
    "grandfather",
    "father",
    "aunt",
    "root",
    "cousin",
    "rootChild",
    "cousinChild",
    "grandmotherSibling",
    "grandmotherSiblingPartner",
    "siblingChild",
    "siblingGrandchild",
    "greatGrandfatherSibling",
    "greatGrandfatherSiblingPartner",
    "greatGrandfatherSiblingChild",
    "greatGrandfatherSiblingGrandchild",
  ]) {
    assert.equal(personIds.has(id), true, `${id} is visible`);
  }
  assert.equal(personIds.has("unrelated"), false);
});

test("family display mode expands a deep ancestor through a narrow path to the root", () => {
  const graph = deepAncestorGraphFixture();

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["ancestor6"] });
  const personIds = visiblePersonIds(visible);

  for (const id of [
    "ancestor6",
    "ancestor6Spouse",
    "line5",
    "line5Sibling",
    "line5Spouse",
    "line4",
    "line4Sibling",
    "line4Spouse",
    "line3",
    "line3Sibling",
    "father",
    "fatherSibling",
    "mother",
    "root",
  ]) {
    assert.equal(personIds.has(id), true, `${id} is visible`);
  }

  assert.equal(personIds.has("line5SiblingPartner"), false);
  assert.equal(personIds.has("line5SiblingChild"), false);
  assert.equal(personIds.has("line4SiblingPartner"), false);
  assert.equal(personIds.has("line4SiblingChild"), false);
  assert.equal(personIds.has("fatherSiblingPartner"), false);
  assert.equal(personIds.has("fatherSiblingChild"), false);
  assert.equal(
    visible.occurrences.find((occurrence) => occurrence.personId === "line5Sibling")?.hiddenSideBranchesCount,
    1,
  );
});

test("family display mode expands all corridors from a repeated ancestor to the root", () => {
  const ids = [
    "root",
    "father",
    "mother",
    "paternalHalfSibling",
    "maternalHalfSibling",
    "repeatedAncestor",
  ];
  const graph: FamilyTreeGraphDto = {
    ...graphFixture(),
    nodes: ids.map((id) => node(id)),
    occurrences: ids.map((id) => occurrence(id)),
    edges: [
      parent("father", "root"),
      parent("mother", "root"),
      parent("father", "paternalHalfSibling"),
      parent("mother", "maternalHalfSibling"),
      parent("repeatedAncestor", "father"),
      parent("repeatedAncestor", "mother"),
    ],
    stats: {
      persons: ids.length,
      occurrences: ids.length,
      edges: 6,
      groups: 0,
      issues: 0,
      repeatedPersons: 1,
      hiddenDisprovenEdges: 0,
    },
  };

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["repeatedAncestor"] });
  const personIds = visiblePersonIds(visible);

  assert.equal(personIds.has("paternalHalfSibling"), true);
  assert.equal(personIds.has("maternalHalfSibling"), true);
});

test("family display mode keeps a new focus compact until its block is explicitly opened", () => {
  const graph = {
    ...graphFixture(),
    rootPersonId: "father",
  };

  const visible = graphForDisplayMode(graph, "family");
  const personIds = visiblePersonIds(visible);

  assert.deepEqual([...personIds].sort(), [
    "father",
    "grandfather",
    "grandmother",
  ]);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.hiddenSideBranchesCount, 3);
});

test("family display mode marks only requested visible people as expanded", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "family", { expandedPersonIds: ["uncle", "root"] });

  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "root")?.sideBranchesExpanded, true);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "father")?.sideBranchesExpanded, false);
  assert.equal(visible.nodes.some((node) => node.personId === "uncle"), true);
  assert.equal(visible.occurrences.find((occurrence) => occurrence.personId === "uncle")?.sideBranchesExpanded, true);
});

test("direct-line display mode shows only the root and direct ancestors", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "direct-line");
  const personIds = visiblePersonIds(visible);

  assert.deepEqual([...personIds].sort(), [
    "father",
    "grandfather",
    "grandmother",
    "mother",
    "root",
  ]);
});

test("descendants display mode keeps descendants and their partners without pulling ancestors", () => {
  const graph = graphFixture();

  const visible = graphForDisplayMode(graph, "descendants");
  const personIds = visiblePersonIds(visible);

  assert.equal(personIds.has("root"), true);
  assert.equal(personIds.has("spouse"), true);
  assert.equal(personIds.has("child"), true);
  assert.equal(personIds.has("father"), false);
  assert.equal(personIds.has("grandfather"), false);
});

function visiblePersonIds(graph: FamilyTreeGraphDto): Set<string> {
  return new Set(graph.nodes.map((node) => node.personId));
}

function graphFixture(): FamilyTreeGraphDto {
  const ids = [
    "root",
    "father",
    "mother",
    "grandfather",
    "grandmother",
    "sibling",
    "uncle",
    "unclePartner",
    "cousin",
    "cousinChild",
    "spouse",
    "child",
  ];
  return {
    projectId: "project",
    treeId: "tree",
    mode: "family",
    rootPersonId: "root",
    tree: null,
    availablePersons: [],
    nodes: ids.map((id) => node(id)),
    occurrences: ids.map((id) => occurrence(id)),
    edges: [
      parent("grandfather", "father"),
      parent("grandmother", "father"),
      parent("grandfather", "uncle"),
      parent("grandmother", "uncle"),
      partner("grandfather", "grandmother"),
      parent("father", "root"),
      parent("mother", "root"),
      partner("father", "mother"),
      parent("father", "sibling"),
      parent("mother", "sibling"),
      partner("root", "spouse"),
      parent("root", "child"),
      parent("spouse", "child"),
      parent("uncle", "cousin"),
      parent("cousin", "cousinChild"),
      partner("uncle", "unclePartner"),
    ],
    groups: [],
    issues: [],
    stats: {
      persons: ids.length,
      occurrences: ids.length,
      edges: 16,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };
}

function deepAncestorGraphFixture(): FamilyTreeGraphDto {
  const ids = [
    "root",
    "mother",
    "father",
    "fatherSibling",
    "fatherSiblingPartner",
    "fatherSiblingChild",
    "line3",
    "line3Sibling",
    "line4",
    "line4Spouse",
    "line4Sibling",
    "line4SiblingPartner",
    "line4SiblingChild",
    "line5",
    "line5Spouse",
    "line5Sibling",
    "line5SiblingPartner",
    "line5SiblingChild",
    "ancestor6",
    "ancestor6Spouse",
    "unrelated",
  ];
  return {
    ...graphFixture(),
    nodes: ids.map((id) => node(id)),
    occurrences: ids.map((id) => occurrence(id)),
    edges: [
      parent("father", "root"),
      parent("mother", "root"),
      partner("father", "mother"),
      parent("line3", "father"),
      parent("line3", "fatherSibling"),
      parent("fatherSibling", "fatherSiblingChild"),
      parent("fatherSiblingPartner", "fatherSiblingChild"),
      partner("fatherSibling", "fatherSiblingPartner"),
      parent("line4", "line3"),
      parent("line4Spouse", "line3"),
      parent("line4", "line3Sibling"),
      parent("line4Sibling", "line4SiblingChild"),
      parent("line4SiblingPartner", "line4SiblingChild"),
      partner("line4", "line4Spouse"),
      partner("line4Sibling", "line4SiblingPartner"),
      parent("line5", "line4"),
      parent("line5Spouse", "line4"),
      parent("line5", "line4Sibling"),
      parent("line5Sibling", "line5SiblingChild"),
      parent("line5SiblingPartner", "line5SiblingChild"),
      partner("line5", "line5Spouse"),
      partner("line5Sibling", "line5SiblingPartner"),
      parent("ancestor6", "line5"),
      parent("ancestor6Spouse", "line5"),
      parent("ancestor6", "line5Sibling"),
      partner("ancestor6", "ancestor6Spouse"),
    ],
    stats: {
      persons: ids.length,
      occurrences: ids.length,
      edges: 26,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };
}

function grandparentFocusGraphFixture(): FamilyTreeGraphDto {
  const ids = [
    "grandmother",
    "greatGrandfather",
    "greatGrandmother",
    "grandfather",
    "father",
    "aunt",
    "root",
    "cousin",
    "rootChild",
    "cousinChild",
    "grandmotherSibling",
    "grandmotherSiblingPartner",
    "siblingChild",
    "siblingGrandchild",
    "greatGrandfatherSibling",
    "greatGrandfatherSiblingPartner",
    "greatGrandfatherSiblingChild",
    "greatGrandfatherSiblingGrandchild",
    "unrelated",
  ];
  return {
    ...graphFixture(),
    rootPersonId: "grandmother",
    nodes: ids.map((id) => node(id)),
    occurrences: ids.map((id) => occurrence(id)),
    edges: [
      parent("greatGrandfather", "grandmother"),
      parent("greatGrandmother", "grandmother"),
      parent("greatGrandfather", "grandmotherSibling"),
      parent("greatGrandmother", "grandmotherSibling"),
      parent("greatGrandfather", "greatGrandfatherSibling"),
      partner("greatGrandfather", "greatGrandmother"),
      partner("grandmother", "grandfather"),
      partner("grandmotherSibling", "grandmotherSiblingPartner"),
      partner("greatGrandfatherSibling", "greatGrandfatherSiblingPartner"),
      parent("grandmother", "father"),
      parent("grandfather", "father"),
      parent("grandmother", "aunt"),
      parent("grandfather", "aunt"),
      parent("father", "root"),
      parent("aunt", "cousin"),
      parent("root", "rootChild"),
      parent("cousin", "cousinChild"),
      parent("grandmotherSibling", "siblingChild"),
      parent("grandmotherSiblingPartner", "siblingChild"),
      parent("siblingChild", "siblingGrandchild"),
      parent("greatGrandfatherSibling", "greatGrandfatherSiblingChild"),
      parent("greatGrandfatherSiblingPartner", "greatGrandfatherSiblingChild"),
      parent("greatGrandfatherSiblingChild", "greatGrandfatherSiblingGrandchild"),
    ],
    stats: {
      persons: ids.length,
      occurrences: ids.length,
      edges: 23,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };
}

function node(personId: string): FamilyTreeNodeDto {
  return {
    personId,
    displayName: personId,
    primaryName: null,
    names: [],
    events: [],
    gender: "unknown",
    status: "proven",
    isLiving: false,
    privacyStatus: "private",
    redacted: false,
    occurrenceIds: [`occ:${personId}`],
  };
}

function occurrence(personId: string): FamilyTreeOccurrenceDto {
  return {
    id: `occ:${personId}`,
    personId,
    mode: "family",
    path: ["root", personId],
    generation: personId === "root" ? 0 : 1,
    depth: personId === "root" ? 0 : 1,
    duplicateIndex: 0,
    isRepeated: false,
  };
}

function parent(fromPersonId: string, toPersonId: string): FamilyTreeEdgeDto {
  return {
    id: `${fromPersonId}-${toPersonId}`,
    kind: "parent_child",
    relationshipId: `${fromPersonId}-${toPersonId}`,
    fromPersonId,
    toPersonId,
    fromOccurrenceId: `occ:${fromPersonId}`,
    toOccurrenceId: `occ:${toPersonId}`,
    relationshipType: "biological",
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: true,
    style: { lineStyle: "solid", visibility: "visible" },
    metadata: {},
  };
}

function partner(fromPersonId: string, toPersonId: string): FamilyTreeEdgeDto {
  return {
    id: `${fromPersonId}-${toPersonId}`,
    kind: "partner",
    relationshipId: `${fromPersonId}-${toPersonId}`,
    fromPersonId,
    toPersonId,
    fromOccurrenceId: `occ:${fromPersonId}`,
    toOccurrenceId: `occ:${toPersonId}`,
    relationshipType: "marriage",
    evidenceStatus: "proven",
    confidence: 100,
    style: { lineStyle: "solid", visibility: "visible" },
    metadata: {},
  };
}
