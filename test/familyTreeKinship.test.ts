import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../src/types/familyTree.ts";
import { familyTreeKinshipLabel } from "../src/utils/familyTreeKinship.ts";

const graphBase: FamilyTreeGraphDto = {
  projectId: "project",
  treeId: "tree",
  mode: "family",
  rootPersonId: "root",
  tree: null,
  availablePersons: [],
  nodes: [],
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
};

test("labels direct ancestors and descendants relative to the tree center", () => {
  const graph = graphWithEdges([
    parentEdge("father-root", "father", "root"),
    parentEdge("grandmother-father", "grandmother", "father"),
    parentEdge("root-child", "root", "child"),
  ]);

  assert.equal(label(graph, occurrence("root:0", "root", 0, ["root"]), node("root")), "центральна особа");
  assert.equal(label(graph, occurrence("father:0", "father", -1, ["root", "father"]), node("father", "male")), "батько");
  assert.equal(label(graph, occurrence("grandmother:0", "grandmother", -2, ["root", "father", "grandmother"]), node("grandmother", "female")), "бабуся");
  assert.equal(label(graph, occurrence("child:0", "child", 1, ["root", "child"]), node("child", "female")), "донька");
});

test("labels side branches and relatives by marriage", () => {
  const graph = graphWithEdges([
    parentEdge("father-root", "father", "root"),
    parentEdge("father-sibling", "father", "sibling"),
    partnerEdge("sibling-wife", "sibling", "siblingWife"),
    parentEdge("grandfather-father", "grandfather", "father"),
    parentEdge("grandfather-uncle", "grandfather", "uncle"),
  ]);

  assert.equal(label(graph, occurrence("sibling:0", "sibling", 0, ["root", "father", "sibling"]), node("sibling", "male")), "брат");
  assert.equal(label(graph, occurrence("sibling-wife:0", "siblingWife", 0, ["root", "father", "sibling", "siblingWife"]), node("siblingWife", "female")), "дружина брата");
  assert.equal(label(graph, occurrence("uncle:0", "uncle", -1, ["root", "father", "grandfather", "uncle"]), node("uncle", "male")), "дядько");
});

test("labels distant ancestors by generation when exact title becomes too long", () => {
  const path = ["root", "p1", "p2", "p3", "p4", "p5", "p6"];
  const graph = graphWithEdges(path.slice(1).map((parentId, index) => parentEdge(`${parentId}-${path[index]}`, parentId, path[index] ?? "root")));

  assert.equal(label(graph, occurrence("p6:0", "p6", -6, path), node("p6", "male")), "предок 6 покоління");
});

function graphWithEdges(edges: FamilyTreeEdgeDto[]): FamilyTreeGraphDto {
  return {
    ...graphBase,
    edges,
  };
}

function label(graph: FamilyTreeGraphDto, occurrenceValue: FamilyTreeOccurrenceDto, nodeValue: FamilyTreeNodeDto): string {
  return familyTreeKinshipLabel(graph, occurrenceValue, nodeValue);
}

function node(personId: string, gender = "unknown"): FamilyTreeNodeDto {
  return {
    personId,
    displayName: personId,
    primaryName: null,
    names: [],
    events: [],
    gender,
    status: "proven",
    isLiving: false,
    privacyStatus: "private",
    redacted: false,
    occurrenceIds: [`${personId}:0`],
  };
}

function occurrence(id: string, personId: string, generation: number, path: string[]): FamilyTreeOccurrenceDto {
  return {
    id,
    personId,
    mode: "family",
    path,
    generation,
    depth: Math.abs(generation),
    duplicateIndex: 0,
    isRepeated: false,
  };
}

function parentEdge(id: string, parentId: string, childId: string): FamilyTreeEdgeDto {
  return {
    id,
    kind: "parent_child",
    relationshipId: id,
    fromPersonId: parentId,
    toPersonId: childId,
    relationshipType: "biological",
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: true,
    parentSetId: null,
    familyGroupId: null,
    style: { lineStyle: "solid", visibility: "visible" },
    metadata: {},
  };
}

function partnerEdge(id: string, personAId: string, personBId: string): FamilyTreeEdgeDto {
  return {
    id,
    kind: "partner",
    relationshipId: id,
    fromPersonId: personAId,
    toPersonId: personBId,
    relationshipType: "marriage",
    evidenceStatus: "proven",
    confidence: 100,
    familyGroupId: null,
    style: { lineStyle: "solid", visibility: "visible" },
    metadata: {},
  };
}
