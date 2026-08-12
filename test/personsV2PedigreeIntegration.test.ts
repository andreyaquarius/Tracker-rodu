import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const productionTree = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const familyTreeShell = readFileSync(
  new URL("../src/pages/FamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const personsModule = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const pedigreeService = readFileSync(
  new URL("../src/services/projectPersonPedigreeOrder.ts", import.meta.url),
  "utf8",
);

test("only the persisted tree root is lifted into the V2 catalogue pedigree context", () => {
  assert.match(productionTree, /onActiveContextChange\?\.\(\{[\s\S]*?treeId: selectedEntry\.id,[\s\S]*?rootPersonId: selectedEntry\.rootPersonId/);
  assert.doesNotMatch(productionTree, /activeCentralPersonId = circularChartFocusPersonId/);
  assert.match(productionTree, /scopedFamilyTreeFocusPersonId\(activeTreeFocus, selectedEntry\?\.id\)/);
  assert.match(familyTreeShell, /persistedRootPersonId = treeAdminSummaries\.find\([\s\S]*?data\?\.tree\?\.rootPersonId/);
  assert.match(familyTreeShell, /onActiveContextChange\?\.\(\{[\s\S]*?treeId: activeTreeId,[\s\S]*?rootPersonId: persistedRootPersonId/);
  assert.match(app, /onActiveContextChange=\{handleFamilyTreeActiveContextChange\}/);
  assert.match(app, /context\.projectId !== projectId/);
  assert.match(app, /pedigreeContext=\{[\s\S]*?familyTreePedigreeContext\.projectId === workspace\?\.projectId/);
});

test("V2 catalogue loads canonical Ahnentafel order and forwards it to sorting", () => {
  assert.match(personsModule, /readCachedProjectPersonPedigreeOrder\(projectId, context, pedigreeCacheScope\)/);
  assert.match(personsModule, /loadProjectPersonPedigreeOrder\(projectId, context, \{[\s\S]*?signal: controller\.signal,[\s\S]*?cacheScope: pedigreeCacheScope/);
  assert.match(personsModule, /\[pedigreeCacheScope, pedigreeRequestKey, pedigreeRootPersonId, pedigreeTreeId, projectId\]/);
  assert.match(personsModule, /familyOrderStatus === "loading"[\s\S]*?Готуємо список осіб/);
  assert.match(personsModule, /directAncestorIds=\{effectiveDirectAncestorIds\}[\s\S]*?familyOrder=\{familyOrder\}/);
  assert.match(personsModule, /familyOrderStatus=\{familyOrderStatus\}/);
  assert.match(personsModule, /status: "unavailable"/);
  assert.match(pedigreeService, /const rootPersonId = entry\.rootPersonId/);
  assert.doesNotMatch(pedigreeService, /requestedContext\?\.rootPersonId\s*\|\|/);
  assert.match(pedigreeService, /pedigreeOrderCache/);
  assert.match(pedigreeService, /cacheScope/);
  assert.match(pedigreeService, /A missing tree\/root is expected[\s\S]*?if \(value\.treeId && value\.rootPersonId\)/);
  assert.match(pedigreeService, /list_family_tree_direct_ancestor_order_v1/);
  assert.match(pedigreeService, /list_family_tree_root_kinship_v1/);
  assert.match(pedigreeService, /kinshipByPersonId/);
  assert.match(pedigreeService, /pedigreeRanksFromAncestorOrderRows/);
  assert.doesNotMatch(pedigreeService, /buildCircularAncestorChartModel/);
  assert.doesNotMatch(pedigreeService, /maxNodes: 600/);
});

test("V2 catalogue renders exact kinship instead of a disappearing ancestor flag", () => {
  const catalogue = readFileSync(
    new URL("../src/features/persons-v2/PersonsCatalogV2.tsx", import.meta.url),
    "utf8",
  );
  assert.match(personsModule, /personKinshipLabel\(kinship/);
  assert.match(personsModule, /kinshipLabels=\{kinshipLabels\}/);
  assert.match(personsModule, /kinshipLabel=\{kinshipLabels\.get\(routePerson\.id\)/);
  assert.match(catalogue, /kinshipLabels\.get\(person\.id\) \?\? "Зв’язок не визначено"/);
  assert.doesNotMatch(catalogue, /directIds\.has\(person\.id\) \? "Прямий предок" : "—"/);
});
