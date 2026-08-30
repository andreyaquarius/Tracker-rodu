import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonResearchGraphV1.tsx", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);

test("research editor selects project entities from catalog options instead of asking for raw UUIDs", () => {
  assert.match(component, /ResearchGraphTargetOption/u);
  assert.match(component, /targetOptions\?:\s*readonly ResearchGraphTargetOption\[\]/u);
  assert.match(component, /targetOptions\.map\(/u);
  assert.match(component, /<select[\s\S]*?value=\{editorDraft\.targetEntityId\}[\s\S]*?availableTargets\.map\(/u);
  assert.match(component, /sourceEntityType:\s*centerIsSource \? "person" : editorDraft\.targetEntityType/u);
  assert.match(component, /sourceEntityId:\s*centerIsSource \? center\.id : editorDraft\.targetEntityId/u);
  assert.match(component, /targetEntityType:\s*centerIsSource \? editorDraft\.targetEntityType : "person"/u);
  assert.match(component, /targetEntityId:\s*centerIsSource \? editorDraft\.targetEntityId : center\.id/u);
  assert.match(workspace, /targetOptions=\{[A-Za-z][A-Za-z0-9]*\}/u);
  assert.match(component, /new Map\(targetOptions\.map/u);
  assert.doesNotMatch(component, /placeholder=["'][^"']*(?:UUID|ідентифікатор|ID)[^"']*["']/iu);
  assert.doesNotMatch(component, /<input[^>]+(?:name|id)=["']targetEntityId["']/iu);
});

test("research editor uses the relation-type catalog and preserves directed endpoint roles", () => {
  assert.match(component, /listContextRelationTypes/u);
  assert.match(component, /relationTypes\.map\(/u);
  assert.match(component, /relationTypeEditorLabel\(type\)/u);
  assert.match(component, /contextRelationTypeSupportsTarget/u);
  assert.match(component, /isLegacyAmbiguousSocialRelationTypeCode\(relationType\.code\)/u);
  assert.match(component, /relationTypeRequiresCenterAsSource/u);
  assert.match(component, /relationType\?\.sourceRoleUk/u);
  assert.match(component, /relationType\?\.targetRoleUk/u);
  assert.match(component, /sourceRoleLabel:/u);
  assert.match(component, /targetRoleLabel:/u);
  assert.match(component, /inverseLabelUk/u);
  assert.match(component, /directionality === "directed"/u);
  assert.match(component, /centerEndpoint:\s*"source" \| "target"/u);
  assert.match(component, /editorDraft\.centerEndpoint === "source"/u);
  assert.match(component, /Роль центральної особи/u);
  assert.match(component, /markerEnd=/u);
  assert.match(component, /<marker/u);
});

test("selected research assertions load evidence details and open catalog-backed sources", () => {
  assert.match(component, /getContextRelationEvidence\(projectId,\s*selectedEdge\.id\)/u);
  assert.match(component, /evidence\.excerpt/u);
  assert.match(component, /evidence\.sourceLocator/u);
  assert.match(component, /evidence\.evidenceEntityType === "document"/u);
  assert.match(component, /onOpenDocument\(evidence\.evidenceEntityId/u);
  assert.match(component, /evidence\.evidenceEntityType === "finding"/u);
  assert.match(component, /onOpenFinding\(evidence\.evidenceEntityId/u);
  assert.match(component, /Відкрити (?:документ|знахідку|доказ)/u);
});

test("research editor supports evidence save and archive with optimistic locking", () => {
  assert.match(component, /saveContextRelationEvidence/u);
  assert.match(component, /archiveContextRelationEvidence/u);
  assert.match(component, /isManuallyManagedResearchEdge\(selectedEdge\)/u);
  assert.match(component, /Автоматичне або імпортоване твердження/u);
  assert.match(component, /archiveContextRelationEvidence\(projectId,\s*item\.id,\s*item\.lockVersion\)/u);
  assert.match(component, /const relationId = selectedEdge\.id/u);
  assert.match(component, /relationId,/u);
  assert.match(component, /evidence\.map\(/u);
  assert.match(component, /onAddEvidence=\{\(\) => void addEvidence\(\)\}/u);
  assert.match(component, /onArchiveEvidence=\{\(item\) => void archiveEvidence\(item\)\}/u);
  assert.match(component, /canEdit/u);
});

test("research service dynamic import can recover after a rejected chunk load", () => {
  const loader = sourceBlock(
    component,
    "async function loadResearchGraphService",
    "type AssertionFilter",
  );
  assert.match(loader, /\.catch\(\(error\)\s*=>\s*\{/u);
  assert.match(loader, /servicePromise = undefined/u);
  assert.match(loader, /throw error/u);
});

test("research mutations cannot overwrite another focused person context", () => {
  assert.match(component, /const mutationSequence = useRef\(0\)/u);
  assert.match(component, /requestContextKey !== activeContextKey\.current/u);
  assert.match(component, /sequence !== mutationSequence\.current/u);
  assert.match(component, /mutationSequence\.current \+= 1/u);
});

test("research period fields explicitly accept partial historical precision", () => {
  assert.match(component, /placeholder="[^"]*РРРР[^"]*РРРР-ММ[^"]*РРРР-ММ-ДД[^"]*"/u);
  assert.match(component, /pattern="\\d\{4\}\(-\\d\{2\}\(-\\d\{2\}\)\?\)\?"/u);
  assert.doesNotMatch(component, /type="date"[\s\S]{0,160}validFrom/u);
  assert.doesNotMatch(component, /type="date"[\s\S]{0,160}validTo/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
