import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonDocumentaryGraphV1.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/features/context-graph/PersonDocumentaryGraphV1.css", import.meta.url),
  "utf8",
);

test("documentary graph requests one bounded, project-scoped snapshot and ignores stale responses", () => {
  assert.match(component, /getPersonDocumentaryGraph\([\s\S]*?projectId,[\s\S]*?center\.id,[\s\S]*?toServiceFilters/u);
  assert.match(component, /maxNodes:\s*100/u);
  assert.match(component, /maxEdges:\s*250/u);
  assert.match(component, /const requestSequence = useRef\(0\)/u);
  assert.match(component, /requestContextKey !== activeContextKey\.current/u);
  assert.match(component, /sequence !== requestSequence\.current/u);
  assert.match(component, /setSnapshot\(null\)/u);
  assert.match(component, /interface AppliedFilterState[\s\S]*?contextKey:[\s\S]*?value: FilterState/u);
  assert.match(component, /if \(!activeAppliedFilters\) return undefined;[\s\S]*?loadGraph\(activeAppliedFilters\)/u);
  assert.match(component, /if \(appliedFilterState\.contextKey === contextKey\) return;/u);
  assert.doesNotMatch(component, /useEffect\(\(\) => \{[\s\S]{0,180}setAppliedFilters\(defaultFilters\(\)\)/u);
});

test("documentary graph exposes depth, entity, event, evidence, canonical place and year filters", () => {
  assert.match(component, /value="1"[\s\S]*?прямі згадки/u);
  assert.match(component, /value="2"[\s\S]*?пов’язані особи та місця/u);
  for (const entityType of ["person", "finding", "person_event", "document", "place"]) {
    assert.match(component, new RegExp(`value: "${entityType}"`, "u"));
  }
  assert.match(component, /eventTypes:\s*value\.eventType === "all"/u);
  assert.match(component, /evidenceStatuses:\s*value\.evidenceStatus === "all"/u);
  assert.match(component, /Канонічне місце/u);
  assert.match(component, /Усі підтверджені місця/u);
  assert.match(component, /mergePlaceOptions\(current, graph\.nodes\)/u);
  assert.match(component, /placeId:\s*value\.placeId \|\| undefined/u);
  assert.match(component, /Назви взято з підтверджених місць поточного графа/u);
  assert.match(component, /yearFrom:/u);
  assert.match(component, /yearTo:/u);
  assert.match(component, /Початковий рік не може бути пізнішим/u);
});

test("documentary graph starts with one low toolbar instead of a large intro", () => {
  assert.doesNotMatch(component, /documentary-graph-v1__header|documentary-graph-v1__eyebrow/u);
  assert.match(component, /className="documentary-graph-v1__toolbar"/u);
  assert.match(component, /className="documentary-graph-v1__compact-heading"[\s\S]*?<h2 id=\{headingId\}>Документи<\/h2>[\s\S]*?personDisplayName\(center\)/u);
  const toolbar = sourceBlock(
    component,
    '<div className="documentary-graph-v1__toolbar">',
    '<div className="documentary-graph-v1__disclosures">',
  );
  assert.match(toolbar, /documentary-graph-v1__depth-filter/u);
  assert.match(toolbar, /Застосувати/u);
  assert.match(toolbar, /Скинути/u);
  assert.match(styles, /documentary-graph-v1__toolbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(9rem, 1fr\) auto auto/u);
  assert.match(styles, /documentary-graph-v1__button\s*\{[\s\S]*?min-height:\s*2\.25rem/u);
  assert.doesNotMatch(styles, /documentary-graph-v1__header h2[\s\S]*?font-size:\s*clamp/u);
});

test("documentary graph explains the source chain and progressively discloses complex filters", () => {
  assert.match(component, /Простежте шлях від людини до джерела її згадки/u);
  assert.match(
    component,
    /<ol className="documentary-graph-v1__path"[\s\S]*?<li>Особа<\/li>[\s\S]*?<li>Знахідка або подія<\/li>[\s\S]*?<li>Документ<\/li>[\s\S]*?<li>Місце<\/li>/u,
  );
  assert.match(component, /<details className="documentary-graph-v1__path-guide">[\s\S]*?<summary>Як читати граф<\/summary>/u);
  assert.match(
    component,
    /<details className="documentary-graph-v1__advanced-filters">[\s\S]*?Додаткові фільтри[\s\S]*?Типи вузлів, події, підтвердження, місце й роки[\s\S]*?documentary-graph-v1__entity-filter[\s\S]*?documentary-graph-v1__field-grid[\s\S]*?<\/details>/u,
  );
  const advancedStart = component.indexOf('className="documentary-graph-v1__advanced-filters"');
  const advancedEnd = component.indexOf("</details>", advancedStart);
  const resultStart = component.indexOf('className="documentary-graph-v1__workspace"');
  assert.ok(advancedStart >= 0 && advancedEnd > advancedStart);
  assert.ok(resultStart > advancedEnd, "the documentary graph must remain outside the collapsed filters");
  assert.match(styles, /\.documentary-graph-v1 summary:focus-visible/u);
});

test("documentary graph has distinct node geometries and deterministic SVG paths", () => {
  assert.match(component, /buildDocumentaryGraphLayeredLayout/u);
  assert.match(component, /node\.entityType === "person"[\s\S]*?<circle/u);
  assert.match(component, /node\.entityType === "finding"[\s\S]*?<rect/u);
  assert.match(component, /node\.entityType === "document"[\s\S]*?document-shape[\s\S]*?<path/u);
  assert.match(component, /node\.entityType === "person_event"[\s\S]*?<polygon/u);
  assert.match(component, /documentary-graph-v1__place-shape/u);
  assert.match(component, /d=\{edge\.path\}/u);
  assert.doesNotMatch(component, /forceSimulation|d3-force/u);
});

test("graph interaction is keyboard accessible and mirrored by a DOM node list and detail panel", () => {
  assert.match(component, /role="button"/u);
  assert.match(component, /tabIndex=\{0\}/u);
  assert.match(component, /event\.key !== "Enter" && event\.key !== " "/u);
  assert.match(component, /aria-pressed=\{selected\}/u);
  assert.match(component, /Список вузлів графа/u);
  assert.match(component, /Відомості про вузол/u);
  assert.match(component, /Чому вузол тут/u);
  assert.match(component, /<title>\{title\}<\/title>/u);
});

test("detail actions navigate only by stable entity ids, including an event's owner person", () => {
  assert.match(component, /onFocusPerson\?: \(personId: string\)/u);
  assert.match(component, /onOpenPerson\?: \(personId: string\)/u);
  assert.match(component, /onOpenDocument\?: \(documentId: string\)/u);
  assert.match(component, /onOpenFinding\?: \(findingId: string\)/u);
  assert.match(component, /onOpenPlace\?: \(placeId: string\)/u);
  assert.match(component, /onOpenPerson\(eventOwnerId\)/u);
  assert.match(component, /"ownerPersonId"/u);
  assert.match(component, /node\.masked[\s\S]*?Дані цієї живої або приватної особи приховано/u);
});

test("documentary graph translates event, evidence and participant role codes for display", () => {
  assert.match(component, /nodeDisplayLabel\(node\)/u);
  assert.match(component, /statusDisplayLabel\(status\)/u);
  assert.match(component, /edgeDisplayLabel\(edge\)/u);
  assert.match(component, /witness:\s*"свідок"/u);
  assert.match(component, /godmother:\s*"хрещена мати"/u);
  assert.match(component, /has_participant:\s*"учасник знахідки"/u);
});

test("large and mobile graphs scroll inside their panel and preserve accessible details", () => {
  assert.match(styles, /\.documentary-graph-v1__canvas\s*\{[\s\S]*?overflow-x:\s*auto/u);
  assert.match(styles, /overscroll-behavior-x:\s*contain/u);
  assert.match(styles, /@media \(max-width: 780px\)/u);
  assert.match(styles, /-webkit-overflow-scrolling:\s*touch/u);
  assert.match(styles, /\.documentary-graph-v1__detail[\s\S]*?position:\s*sticky/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("documentary graph remains isolated from the classic family graph", () => {
  assert.doesNotMatch(component, /familyTree|family_trees|FamilyTree/u);
  assert.doesNotMatch(component, /savePersonContextRelation|archivePersonContextRelation/u);
  assert.match(component, /Схема не змінює родинне дерево/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
