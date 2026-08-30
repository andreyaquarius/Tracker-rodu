import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonSocialCircleV1.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/features/context-graph/PersonSocialCircleV1.css", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);
const panel = sourceBlock(
  component,
  "function PersonCooccurrencePanel(",
  "interface RelationEditorProps",
);

test("social circle exposes the bounded calculated co-occurrence panel without asserting kinship", () => {
  assert.match(component, /<PersonCooccurrencePanel/u);
  assert.match(panel, /Хто часто зустрічається поруч/u);
  assert.match(panel, /спільних знахідок, документів і реальних структурованих подій/u);
  assert.match(panel, /не доказ споріднення і не новий родинний зв’язок/u);
  assert.match(panel, /listPersonContextCooccurrencesV1/u);
  assert.doesNotMatch(panel, /savePersonContextRelation|archivePersonContextRelation/u);
});

test("social circle keeps people and exact roles primary while advanced tools stay disclosed", () => {
  assert.match(component, /Люди поруч/u);
  assert.match(component, /Люди та їхні ролі/u);
  assert.match(component, /Більшість зв’язків додаються автоматично зі знахідок/u);
  assert.match(component, /не створюють споріднення та не змінюють родове дерево/u);
  assert.doesNotMatch(component, /Контекстний граф · глибина 1/u);
  assert.match(component, /<ContextRelationshipGraphV1/u);
  assert.match(component, /initialMode="3d"/u);
  assert.match(component, /<details className="context-social-v1__source-note">/u);
  assert.match(component, /<details className="context-social-v1__relations">/u);
  assert.match(component, /<details className="context-social-v1__disclosure context-social-v1__filter-disclosure">/u);
  assert.match(styles, /\.context-social-v1__relations\s*\{[\s\S]*?order:\s*1/u);
  assert.match(styles, /\.context-social-v1__source-note\s*>\s*summary/u);
});

test("co-occurrence analytics is an optional researcher disclosure", () => {
  assert.match(panel, /<details className="context-social-v1__cooccurrences context-social-v1__disclosure">/u);
  assert.match(panel, /Повторювані згадки/u);
  assert.match(panel, /Дослідницька аналітика людей/u);
  assert.match(panel, /Інструмент для дослідників/u);
  assert.doesNotMatch(panel, /<details[^>]*\sopen(?:=|\s|>)/u);
  assert.match(styles, /\.context-social-v1__disclosure\[open\]\s*>\s*summary/u);
});

test("co-occurrence filters have explicit apply and reset semantics", () => {
  assert.match(panel, /Рік від/u);
  assert.match(panel, /Рік до/u);
  assert.match(panel, /Мінімум спільних джерел/u);
  assert.match(panel, /onSubmit=\{applyFilters\}/u);
  assert.match(panel, />\s*Застосувати\s*</u);
  assert.match(panel, /onClick=\{resetFilters\}/u);
  assert.match(panel, />\s*Скинути\s*</u);
  assert.match(component, /interface AppliedCooccurrenceFilters[\s\S]*?contextKey:[\s\S]*?PersonContextCooccurrenceFilters/u);
});

test("stale co-occurrence responses cannot overwrite another center or filter request", () => {
  assert.match(panel, /const requestSequence = useRef\(0\)/u);
  assert.match(panel, /const requestContextKey = contextKey/u);
  assert.match(panel, /sequence !== requestSequence\.current/u);
  assert.match(panel, /requestContextKey !== activeContextKey\.current/u);
  assert.match(panel, /requestSequence\.current \+= 1/u);
  assert.match(panel, /appliedFilters\.contextKey === contextKey/u);
  assert.match(panel, /if \(!activeFilters\) return undefined/u);
});

test("co-occurrence rows expose strength, source counts, period and safe person actions", () => {
  assert.match(panel, /cooccurrenceStrengthLabel\(item\.relationStrength\)/u);
  assert.match(panel, /item\.sharedFindingCount/u);
  assert.match(panel, /item\.sharedDocumentCount/u);
  assert.match(panel, /item\.sharedEventCount/u);
  assert.match(panel, /cooccurrencePeriodLabel\(item\)/u);
  assert.match(panel, /item\.displayName/u);
  assert.match(panel, /onOpenPersonById\(item\.personId\)/u);
  assert.match(panel, /onFocusPersonById\(item\.personId\)/u);
  assert.match(panel, /if \(item\.masked\) return/u);
  assert.match(workspace, /onOpenPersonById=\{onOpenPerson\}/u);
  assert.match(workspace, /onFocusPersonById=\{onFocusPerson\}/u);
  assert.match(panel, />\s*Відкрити особу\s*</u);
  assert.match(panel, />\s*Зробити центром\s*</u);
  assert.match(panel, /Рейтинг повторюваності, не ймовірність споріднення/u);
});

test("shared sources are the primary candidate action and preserve finding/document semantics", () => {
  assert.match(panel, /Показати спільні джерела/u);
  assert.match(panel, /source\.kind === "finding"[\s\S]*?onOpenFinding/u);
  assert.match(panel, /source\.kind === "document"[\s\S]*?onOpenDocument/u);
  assert.match(panel, /onClick=\{\(\) => openSource\(source\.id\)\}/u);
  assert.match(workspace, /onOpenDocument=\{onOpenDocument\}/u);
  assert.match(workspace, /onOpenFinding=\{onOpenFinding\}/u);
  assert.doesNotMatch(panel, /source\.kind === "event"[\s\S]{0,120}?onOpenFinding/u);
});

test("co-occurrence panel handles loading, error, empty, retry and truncated results", () => {
  assert.match(panel, /Обчислення спільних згадок/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, />\s*Повторити\s*</u);
  assert.match(panel, /Повторюваних спільних згадок не знайдено/u);
  assert.match(panel, /page\?\.truncated && page\.items\.length < page\.total/u);
  assert.match(panel, /page\?\.truncated && page\.items\.length >= page\.total/u);
  assert.match(panel, /Показано \{page\.items\.length\} результатів/u);
  assert.match(panel, /Показати ще/u);
  assert.match(panel, /Розрахунок обмежено, уточніть фільтри/u);
  assert.match(panel, /offset: nextOffset/u);
  assert.match(panel, /mergeCooccurrencePages\(current, result\)/u);
  assert.match(panel, /current \+ result\.items\.length/u);
});

test("co-occurrence panel is bounded and responsive", () => {
  assert.match(styles, /\.context-social-v1__cooccurrence-list\s*\{[\s\S]*?max-height:\s*42rem;[\s\S]*?overflow:\s*auto/u);
  assert.match(styles, /\.context-social-v1__cooccurrence-filters\s*\{[\s\S]*?grid-template-columns:/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.context-social-v1__cooccurrence-list,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.context-social-v1__cooccurrence-list\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?cooccurrence-actions button[\s\S]*?min-height:\s*44px/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?cooccurrence-skeleton/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
