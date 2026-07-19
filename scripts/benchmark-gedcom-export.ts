import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import type {
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
} from "../src/types/familyTree.ts";
import type {
  FamilyTreeProjection,
  FamilyTreeProjectionEdge,
  FamilyTreeProjectionNode,
} from "../src/utils/familyTreeProjection.ts";
import { exportFamilyTreeProjectionToGedcom } from "../src/utils/gedcom.ts";

const requestedSizes = process.argv.slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0);
const sizes = requestedSizes.length ? requestedSizes : [2_480, 10_000, 20_000, 50_000];

for (const size of sizes) {
  const before = process.memoryUsage().heapUsed;
  const projectionStartedAt = performance.now();
  const projection = syntheticProjection(size);
  const projectionMs = performance.now() - projectionStartedAt;
  const exportStartedAt = performance.now();
  const result = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Treker Rodu scale test",
    createdAt: "2026-07-19",
    rootPersonId: "person-0",
  });
  const exportMs = performance.now() - exportStartedAt;
  const after = process.memoryUsage().heapUsed;

  assert.equal(Object.keys(result.individualXrefs).length, size);
  assert.equal(countOccurrences(result.text, " INDI\r\n"), size);
  assert.ok(result.text.endsWith("0 TRLR\r\n"));

  process.stdout.write(`${JSON.stringify({
    persons: size,
    edges: projection.edges.length,
    families: Object.keys(result.familyXrefs).length,
    bytes: Buffer.byteLength(result.text, "utf8"),
    projectionMs: Math.round(projectionMs),
    exportMs: Math.round(exportMs),
    heapDeltaMb: Math.round(((after - before) / 1024 / 1024) * 10) / 10,
    warnings: result.warnings.length,
  })}\n`);
}

function syntheticProjection(personCount: number): FamilyTreeProjection {
  const projectId = "scale-project";
  const treeId = "scale-tree";
  const nodes = Array.from({ length: personCount }, (_, index) =>
    syntheticNode(projectId, index));
  const edges: FamilyTreeProjectionEdge[] = [];

  for (let index = 0; index + 1 < personCount; index += 2) {
    edges.push({
      id: `partner-${index}`,
      source: "graph_edge",
      kind: "partner",
      fromPersonId: `person-${index}`,
      toPersonId: `person-${index + 1}`,
      relationshipType: "marriage",
      evidenceStatus: "proven",
      confidence: 90,
      lineStyle: "solid",
      familyGroupId: `family-${index / 2}`,
    });
  }

  for (let childIndex = 2; childIndex < personCount; childIndex += 1) {
    const parentIndex = Math.floor((childIndex - 2) / 2);
    const familyIndex = Math.floor(parentIndex / 2);
    edges.push({
      id: `parent-${parentIndex}-${childIndex}`,
      source: "graph_edge",
      kind: "parent_child",
      fromPersonId: `person-${parentIndex}`,
      toPersonId: `person-${childIndex}`,
      relationshipType: "biological",
      parentRoleLabel: parentIndex % 2 === 0 ? "father" : "mother",
      parentSetType: "biological",
      evidenceStatus: "proven",
      confidence: 90,
      isBloodline: true,
      lineStyle: "solid",
      familyGroupId: `family-${familyIndex}`,
      parentSetId: `parent-set-${childIndex}`,
    });
  }

  const parentChildEdges = edges.filter((edge) => edge.kind === "parent_child");
  const partnerEdges = edges.filter((edge) => edge.kind === "partner");
  return {
    projectId,
    treeId,
    nodes,
    edges,
    parentChildEdges,
    partnerEdges,
    associationEdges: [],
    issues: [],
    stats: {
      persons: personCount,
      connectedPersons: personCount,
      isolatedPersons: 0,
      parentChildEdges: parentChildEdges.length,
      partnerEdges: partnerEdges.length,
      associationEdges: 0,
      skippedLegacyRelations: 0,
    },
  };
}

function syntheticNode(projectId: string, index: number): FamilyTreeProjectionNode {
  const personId = `person-${index}`;
  const name: FamilyTreePersonName = {
    id: `name-${index}`,
    projectId,
    personId,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: `Прізвище${index}`,
    givenName: `Ім'я${index}`,
    patronymic: "",
    fullName: `Прізвище${index} Ім'я${index}`,
    originalText: `Прізвище${index} Ім'я${index}`,
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "proven",
    confidence: 90,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
  const birth: FamilyTreePersonTimelineEvent = {
    id: `birth-${index}`,
    projectId,
    personId,
    eventType: "birth",
    title: "",
    eventDate: `${1800 + (index % 200)}`,
    dateFrom: "",
    dateTo: "",
    dateText: "",
    placeName: `Місце ${index % 250}`,
    geo: null,
    eventRole: "subject",
    evidenceStatus: "proven",
    confidence: 90,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
  return {
    personId,
    researchId: "",
    displayName: name.fullName,
    primaryName: name,
    names: [name],
    events: [birth],
    gender: index % 2 === 0 ? "чоловік" : "жінка",
    status: "доведена",
    isLiving: false,
    privacyStatus: "private",
    hasDates: true,
    hasPlaces: true,
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}
