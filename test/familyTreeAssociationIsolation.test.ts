import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const typesSource = readFileSync(new URL("../src/types/familyTree.ts", import.meta.url), "utf8");
const repositorySource = readFileSync(
  new URL("../src/services/familyTreeGraphRepository.ts", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../src/services/familyTreeGraphService.ts", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(new URL("../src/pages/FamilyTreePage.tsx", import.meta.url), "utf8");
const adminServiceSource = readFileSync(
  new URL("../src/services/familyTreeAdminService.ts", import.meta.url),
  "utf8",
);

test("classic family graph query has no association opt-in and repository never reads association rows", () => {
  const queryContract = sourceBlock(
    typesSource,
    "export interface FamilyTreeGraphQuery",
    "export interface FamilyTreeEdgeStyleDto",
  );

  assert.doesNotMatch(queryContract, /includeAssociations/);
  assert.doesNotMatch(
    repositorySource,
    /association_relationships|person_context_relations|context_relation_types|context_relation_evidence/,
  );
  assert.doesNotMatch(serviceSource, /data\.associationRelationships|input\.associationRelationships/);
  assert.doesNotMatch(pageSource, /includeAssociations/);
  assert.match(pageSource, /if \(edge\.kind === "association"\) return false/);
});

test("family-tree administration does not count or explicitly delete social associations", () => {
  const summaryContract = sourceBlock(
    adminServiceSource,
    "export interface FamilyTreeAdminSummary",
    "export interface FamilyTreeMergeHistorySummary",
  );
  const deleteTables = sourceBlock(
    adminServiceSource,
    "const FAMILY_TREE_SCOPED_DELETE_TABLES",
    "export async function readFamilyTreeAdminSummaries",
  );

  assert.doesNotMatch(summaryContract, /associationRelationships/);
  assert.doesNotMatch(deleteTables, /association_relationships/);
});

test("GEDCOM export keeps its independent association option", () => {
  const exportContract = sourceBlock(
    typesSource,
    "export interface GedcomExportOptions",
    "export interface GedcomExportResult",
  );

  assert.match(exportContract, /includeAssociations\?: boolean/);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
