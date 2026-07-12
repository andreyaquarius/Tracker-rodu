import { readFileSync } from "node:fs";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import { calculateTreeLayoutWithCache } from "../src/utils/familyTreeVisualLayout.ts";
import type { FamilyTreeLayoutNode } from "../src/utils/familyTreeViewerLayout";
import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
  GedcomImportDraft,
  GedcomImportEventDraft,
} from "../src/types/familyTree";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run qa:family-tree -- path/to/tree.ged [--fail-on-overlap]");
  process.exit(1);
}

const failOnOverlap = process.argv.includes("--fail-on-overlap");
const draft = buildGedcomImportDraft(readFileSync(filePath, "utf8"));
const graph = graphFromGedcomDraft(draft);
const layout = calculateTreeLayoutWithCache(graph, {}, { storage: null });
const overlaps = rowOverlaps(layout.nodes);
const generations = layout.nodes.map((node) => node.occurrence.generation);
const report = {
  file: filePath,
  people: graph.nodes.length,
  occurrences: graph.occurrences.length,
  edges: graph.edges.length,
  familyUnits: layout.familyUnits.length,
  generationMin: Math.min(...generations),
  generationMax: Math.max(...generations),
  bounds: {
    minX: layout.minX,
    minY: layout.minY,
    maxX: layout.maxX,
    maxY: layout.maxY,
    width: layout.maxX - layout.minX,
    height: layout.maxY - layout.minY,
  },
  rowOverlaps: overlaps.length,
  sampleOverlaps: overlaps.slice(0, 10),
  warnings: draft.warnings.length,
};

console.log(JSON.stringify(report, null, 2));
if (failOnOverlap && overlaps.length) process.exit(2);

function graphFromGedcomDraft(draft: GedcomImportDraft): FamilyTreeGraphDto {
  const peopleByXref = new Map(draft.people.map((person) => [person.xref, person]));
  const rootPersonId = draft.rootPersonXref && peopleByXref.has(draft.rootPersonXref)
    ? draft.rootPersonXref
    : draft.people[0]?.xref ?? "";
  const generationByXref = resolveGenerations(draft, rootPersonId);
  const nodes: FamilyTreeNodeDto[] = draft.people.map((person) => ({
    personId: person.xref,
    displayName: person.names[0]?.fullName || person.xref,
    primaryName: null,
    names: person.names,
    events: person.events.map((event, index) => graphEvent(person.xref, event, index)),
    gender: person.gender,
    status: "proven",
    isLiving: person.isLiving,
    privacyStatus: person.privacyStatus,
    redacted: false,
    occurrenceIds: [`${person.xref}:0`],
  }));
  const occurrences: FamilyTreeOccurrenceDto[] = draft.people.map((person) => {
    const generation = generationByXref.get(person.xref) ?? 0;
    return {
      id: `${person.xref}:0`,
      personId: person.xref,
      mode: "family",
      path: [rootPersonId, person.xref],
      generation,
      depth: Math.abs(generation),
      duplicateIndex: 0,
      isRepeated: false,
    };
  });
  const edges: FamilyTreeEdgeDto[] = [
    ...draft.parentChildRelationships.map((relationship, index): FamilyTreeEdgeDto => ({
      id: `pc:${index}:${relationship.parentXref}:${relationship.childXref}`,
      kind: "parent_child",
      relationshipId: `pc:${relationship.familyXref}:${relationship.parentXref}:${relationship.childXref}`,
      fromPersonId: relationship.parentXref,
      toPersonId: relationship.childXref,
      fromOccurrenceId: `${relationship.parentXref}:0`,
      toOccurrenceId: `${relationship.childXref}:0`,
      relationshipType: relationship.relationshipType,
      parentRoleLabel: relationship.parentRoleLabel,
      evidenceStatus: "proven",
      confidence: 100,
      isBloodline: relationship.relationshipType === "biological",
      parentSetId: `${relationship.familyXref}:parents`,
      familyGroupId: relationship.familyXref,
      sourceDocumentId: null,
      sourceFindingId: null,
      style: {
        lineStyle: relationship.relationshipType === "biological" ? "solid" : "dashed",
        visibility: "visible",
      },
      metadata: {},
    })),
    ...draft.partnerRelationships.map((relationship, index): FamilyTreeEdgeDto => ({
      id: `partner:${index}:${relationship.personAXref}:${relationship.personBXref}`,
      kind: "partner",
      relationshipId: `partner:${relationship.familyXref}`,
      fromPersonId: relationship.personAXref,
      toPersonId: relationship.personBXref,
      fromOccurrenceId: `${relationship.personAXref}:0`,
      toOccurrenceId: `${relationship.personBXref}:0`,
      relationshipType: relationship.relationshipType,
      evidenceStatus: "proven",
      confidence: 100,
      parentSetId: null,
      familyGroupId: relationship.familyXref,
      sourceDocumentId: null,
      sourceFindingId: null,
      style: {
        lineStyle: "solid",
        visibility: "visible",
      },
      metadata: {},
    })),
  ];

  return {
    projectId: "visual-qa",
    treeId: "gedcom-visual-qa",
    mode: "family",
    rootPersonId,
    tree: null,
    availablePersons: [],
    nodes,
    occurrences,
    edges,
    groups: [],
    issues: draft.warnings,
    stats: {
      persons: nodes.length,
      occurrences: occurrences.length,
      edges: edges.length,
      groups: 0,
      issues: draft.warnings.length,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };
}

function resolveGenerations(draft: GedcomImportDraft, rootPersonId: string): Map<string, number> {
  const result = new Map<string, number>([[rootPersonId, 0]]);
  const queue = [rootPersonId];
  while (queue.length) {
    const personId = queue.shift();
    if (!personId) continue;
    const generation = result.get(personId) ?? 0;
    for (const relationship of draft.parentChildRelationships) {
      if (relationship.childXref === personId && !result.has(relationship.parentXref)) {
        result.set(relationship.parentXref, generation - 1);
        queue.push(relationship.parentXref);
      }
      if (relationship.parentXref === personId && !result.has(relationship.childXref)) {
        result.set(relationship.childXref, generation + 1);
        queue.push(relationship.childXref);
      }
    }
    for (const relationship of draft.partnerRelationships) {
      const partner = relationship.personAXref === personId
        ? relationship.personBXref
        : relationship.personBXref === personId
          ? relationship.personAXref
          : "";
      if (partner && !result.has(partner)) {
        result.set(partner, generation);
        queue.push(partner);
      }
    }
  }
  return result;
}

function graphEvent(personId: string, event: GedcomImportEventDraft, index: number): FamilyTreeNodeDto["events"][number] {
  return {
    id: `${personId}:event:${index}`,
    projectId: "visual-qa",
    personId,
    eventType: event.eventType,
    title: event.eventType,
    eventDate: event.eventDate,
    dateFrom: "",
    dateTo: "",
    dateText: event.dateText,
    placeName: event.placeName,
    geo: event.geo,
    eventRole: "primary",
    evidenceStatus: "proven",
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: event.notes,
    metadata: {},
    createdAt: "",
    updatedAt: "",
  };
}

function rowOverlaps(nodes: FamilyTreeLayoutNode[]): string[] {
  const overlaps: string[] = [];
  const sorted = [...nodes].sort((left, right) => left.y - right.y || left.x - right.x);
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const left = sorted[leftIndex];
      const right = sorted[rightIndex];
      if (Math.abs(left.y - right.y) >= Math.max(left.height, right.height)) break;
      if (left.x < right.x + right.width && left.x + left.width > right.x) {
        overlaps.push(`${left.occurrence.id} overlaps ${right.occurrence.id}`);
      }
    }
  }
  return overlaps;
}
