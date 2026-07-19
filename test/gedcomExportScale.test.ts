import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type {
  FamilyTreeProjection,
  FamilyTreeProjectionEdge,
  FamilyTreeProjectionNode,
} from "../src/utils/familyTreeProjection.ts";
import { exportFamilyTreeProjectionToGedcom } from "../src/utils/gedcom.ts";

const enabled = process.env.RUN_GEDCOM_SCALE_TESTS === "1";
const budgets = new Map([
  [2_480, { timeMs: 2_500, heapMiB: 100 }],
  [10_000, { timeMs: 5_000, heapMiB: 180 }],
  [20_000, { timeMs: 10_000, heapMiB: 300 }],
  [50_000, { timeMs: 30_000, heapMiB: 600 }],
]);

for (const personCount of [2_480, 10_000, 20_000, 50_000]) {
  test(`exports ${personCount.toLocaleString("en-US")} people with deterministic family counts`, {
    skip: !enabled,
  }, () => {
    forceGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const projection = nuclearFamilies(personCount);
    const startedAt = performance.now();
    const result = exportFamilyTreeProjectionToGedcom(projection, { createdAt: "2026-07-19" });
    const elapsedMs = performance.now() - startedAt;
    const heapMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    const expectedFamilies = Math.floor(personCount / 3);
    const budget = budgets.get(personCount)!;

    assert.equal(Object.keys(result.individualXrefs).length, personCount);
    assert.equal(Object.keys(result.familyXrefs).length, expectedFamilies);
    assert.equal(result.text.endsWith("0 TRLR\r\n"), true);
    assert.ok(Buffer.byteLength(result.text, "utf8") < 25 * 1024 * 1024);
    assert.ok(elapsedMs < budget.timeMs, `GEDCOM export took ${elapsedMs.toFixed(0)} ms`);
    if (typeof (globalThis as { gc?: () => void }).gc === "function") {
      assert.ok(heapMiB < budget.heapMiB, `GEDCOM export used ${heapMiB.toFixed(0)} MiB of heap`);
    }
  });
}

test("a 50k-generation-deep chain is iterative and does not overflow the call stack", {
  skip: !enabled,
}, () => {
  const personCount = 50_000;
  const nodes = Array.from({ length: personCount }, (_, index) => projectionNode(index));
  const parentChildEdges = Array.from({ length: personCount - 1 }, (_, index) =>
    parentEdge(index, index + 1, `chain-set-${index}`));
  const projection = projectionOf(nodes, parentChildEdges, [], []);
  const startedAt = performance.now();
  const result = exportFamilyTreeProjectionToGedcom(projection, { createdAt: "2026-07-19" });

  assert.equal(Object.keys(result.individualXrefs).length, personCount);
  assert.equal(Object.keys(result.familyXrefs).length, personCount - 1);
  assert.ok(performance.now() - startedAt < 30_000);
});

function nuclearFamilies(personCount: number): FamilyTreeProjection {
  const nodes = Array.from({ length: personCount }, (_, index) => projectionNode(index));
  const partnerEdges: FamilyTreeProjectionEdge[] = [];
  const parentChildEdges: FamilyTreeProjectionEdge[] = [];
  for (let index = 0, family = 0; index + 2 < personCount; index += 3, family += 1) {
    const familyGroupId = `family-${family}`;
    const parentSetId = `parent-set-${family}`;
    partnerEdges.push(partnerEdge(index, index + 1, familyGroupId));
    parentChildEdges.push(
      parentEdge(index, index + 2, parentSetId, familyGroupId),
      parentEdge(index + 1, index + 2, parentSetId, familyGroupId),
    );
  }
  return projectionOf(nodes, parentChildEdges, partnerEdges, []);
}

function projectionNode(index: number): FamilyTreeProjectionNode {
  const personId = `person-${String(index).padStart(6, "0")}`;
  const fullName = `Прізвище${index} Ім’я${index}`;
  const primaryName = {
    id: `name-${index}`,
    projectId: "project",
    personId,
    nameType: "primary" as const,
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: `Прізвище${index}`,
    givenName: `Ім’я${index}`,
    patronymic: "",
    fullName,
    originalText: fullName,
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "proven" as const,
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "",
    updatedAt: "",
  };
  return {
    personId,
    researchId: "",
    displayName: fullName,
    primaryName,
    names: [primaryName],
    events: [],
    gender: index % 2 ? "male" : "female",
    status: "proven",
    isLiving: false,
    privacyStatus: "private",
    hasDates: false,
    hasPlaces: false,
    metadata: {},
  };
}

function partnerEdge(left: number, right: number, familyGroupId: string): FamilyTreeProjectionEdge {
  return {
    id: `partner-${left}-${right}`,
    source: "graph_edge",
    kind: "partner",
    fromPersonId: personId(left),
    toPersonId: personId(right),
    relationshipType: "marriage",
    familyGroupId,
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: false,
    lineStyle: "solid",
    metadata: {},
  };
}

function parentEdge(
  parent: number,
  child: number,
  parentSetId: string,
  familyGroupId: string | null = null,
): FamilyTreeProjectionEdge {
  return {
    id: `parent-${parent}-${child}`,
    source: "graph_edge",
    kind: "parent_child",
    fromPersonId: personId(parent),
    toPersonId: personId(child),
    relationshipType: "biological",
    parentRoleLabel: "parent",
    parentSetId,
    parentSetType: "biological",
    familyGroupId,
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: true,
    lineStyle: "solid",
    metadata: {},
  };
}

function projectionOf(
  nodes: FamilyTreeProjectionNode[],
  parentChildEdges: FamilyTreeProjectionEdge[],
  partnerEdges: FamilyTreeProjectionEdge[],
  associationEdges: FamilyTreeProjectionEdge[],
): FamilyTreeProjection {
  const edges = [...parentChildEdges, ...partnerEdges, ...associationEdges];
  return {
    projectId: "project",
    treeId: "tree",
    nodes,
    edges,
    parentChildEdges,
    partnerEdges,
    associationEdges,
    issues: [],
    stats: {
      persons: nodes.length,
      connectedPersons: nodes.length,
      isolatedPersons: 0,
      parentChildEdges: parentChildEdges.length,
      partnerEdges: partnerEdges.length,
      associationEdges: associationEdges.length,
      skippedLegacyRelations: 0,
    },
  };
}

function personId(index: number): string {
  return `person-${String(index).padStart(6, "0")}`;
}

function forceGc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}
