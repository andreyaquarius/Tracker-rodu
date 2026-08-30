import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonResearchGraphV1.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/features/context-graph/PersonResearchGraphV1.css", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);

test("research graph is a distinct workspace mode and does not write to the family tree", () => {
  assert.match(workspace, /onChangeView\("research"\)/u);
  assert.match(workspace, /Дослідницький граф/u);
  assert.match(component, /getPersonResearchGraph\([\s\S]*?projectId,[\s\S]*?center\.id/u);
  assert.match(component, /не змінює родинні зв’язки/u);
  assert.doesNotMatch(component, /familyTree|family_trees|saveFamily|deleteFamily/u);
});

test("research graph requests one bounded project-scoped snapshot and ignores stale responses", () => {
  assert.match(component, /maxNodes:\s*100/u);
  assert.match(component, /maxEdges:\s*220/u);
  assert.match(component, /const requestSequence = useRef\(0\)/u);
  assert.match(component, /sequence !== requestSequence\.current/u);
  assert.match(component, /requestContextKey !== activeContextKey\.current/u);
  assert.match(component, /setSnapshot\(null\)/u);
  assert.match(component, /if \(!activeFilters\) return undefined/u);
});

test("research graph exposes depth, entity, evidence, confidence, period and provenance filters", () => {
  assert.match(component, /\(\[1, 2, 3\] as const\)/u);
  for (const entityType of [
    "hypothesis", "person", "family", "finding", "event",
    "document", "source", "repository", "place",
  ]) {
    assert.match(component, new RegExp(`value: "${entityType}"`, "u"));
  }
  assert.match(component, /evidenceStatuses:/u);
  assert.match(component, /assertionKinds:/u);
  assert.match(component, /minConfidence:/u);
  assert.match(component, /validFrom:/u);
  assert.match(component, /validTo:/u);
  assert.match(component, /hasEvidence:/u);
  assert.match(component, /relationTypeIds:/u);
  assert.match(component, /Усі типи зв’язків/u);
});

test("research graph exposes an explicit all-time, year and exact-date projection", () => {
  assert.match(component, /\["all", "Весь час"\]/u);
  assert.match(component, /\["year", "Конкретний рік"\]/u);
  assert.match(component, /\["date", "Точна дата"\]/u);
  assert.match(component, /type="range"[\s\S]*?aria-label="Рік часового зрізу"/u);
  assert.match(component, /Показувати зв’язки без дати/u);
  assert.match(component, /filterDraft\.temporalMode !== "all"/u);
  assert.match(component, /focusYear:/u);
  assert.match(component, /focusDate:/u);
  assert.match(component, /includeUndated:/u);
  assert.match(component, /temporalFocusError/u);
  assert.match(component, /весь доступний період/u);
});

test("place filter searches a named catalogue and does not ask a user for UUID", () => {
  assert.match(component, /searchResearchGraphPlaces\(projectId, query/u);
  assert.match(component, /role="combobox"/u);
  assert.match(component, /role="listbox"/u);
  assert.match(component, /Почніть вводити назву з каталогу/u);
  assert.match(component, /Оберіть конкретне місце з результатів історичного каталогу/u);
  assert.match(component, /placeSearchSequence = useRef\(0\)/u);
  assert.match(component, /sequence !== placeSearchSequence\.current/u);
  assert.match(component, /requestContextKey !== activeContextKey\.current/u);
  assert.doesNotMatch(component, />\s*UUID\s*</u);
});

test("changing the temporal focus clears a place label resolved for the previous time", () => {
  assert.match(component, /const updateTemporalFocus = \([\s\S]*?placeId:\s*""[\s\S]*?placeLabel:\s*""/u);
  assert.match(component, /updateTemporalFocus\(\{ temporalMode: value \}\)/u);
  assert.match(component, /updateTemporalFocus\(\{ focusYear: Number\(event\.target\.value\) \}\)/u);
  assert.match(component, /updateTemporalFocus\(\{ focusDate: event\.target\.value \}\)/u);
  assert.match(component, /setPlaceQuery\(""\)/u);
  assert.match(component, /placeSearchSequence\.current \+= 1/u);
});

test("historical labels and place context are rendered only from RPC projection metadata", () => {
  assert.match(component, /node\.metadata\.temporalLabelApplied/u);
  assert.match(component, /temporalPlaceType/u);
  assert.match(component, /temporalHierarchy/u);
  assert.match(component, /temporalAmbiguous/u);
  assert.match(component, /temporalContextAmbiguous/u);
  assert.match(component, /temporalNameAmbiguous/u);
  assert.match(component, /temporalHierarchyAmbiguous/u);
  assert.match(component, /temporalHierarchyTruncated/u);
  assert.match(component, /redirectPlaceId/u);
  assert.match(component, /onOpenPlace\(redirectPlaceId \|\| node\.entityId\)/u);
  assert.match(component, /місце об’єднано з актуальною карткою/u);
  assert.match(component, /metadataNestedLabel/u);
  assert.match(component, /Історична назва для вибраного часового зрізу/u);
  assert.doesNotMatch(component, /place_names|place_relations|person_names/u);
});

test("temporal ambiguity explains names, place types and hierarchies separately", () => {
  assert.match(component, /const temporalNameAmbiguous/u);
  assert.match(component, /const temporalPlaceTypeAmbiguous/u);
  assert.match(component, /const temporalHierarchyAmbiguous/u);
  assert.match(component, /кілька варіантів імені особи/u);
  assert.match(component, /кілька варіантів назви/u);
  assert.match(component, /temporalPlaceTypeAmbiguous \? <span>Для цього часу існує кілька можливих типів місця/u);
  assert.match(component, /temporalHierarchyAmbiguous \? <span>Для цього часу існує кілька можливих адміністративних шляхів/u);
  assert.match(styles, /\.research-graph-v1__temporal-ambiguity-note/u);
});

test("hypotheses and generated, disputed and proven edges have explicit explanations", () => {
  assert.match(component, /Пунктир означає припущення/u);
  assert.match(component, /isResearchHypothesisEdge/u);
  assert.match(component, /Впевненість/u);
  assert.match(component, /Докази/u);
  assert.match(component, /Походження/u);
  assert.match(styles, /\.research-graph-v1__edges path\.is-hypothesis[\s\S]*?stroke-dasharray/u);
  assert.match(styles, /\.research-graph-v1__edges path\.is-generated[\s\S]*?stroke-dasharray/u);
  assert.match(styles, /\.research-graph-v1__edges path\.is-disputed/u);
  assert.match(styles, /\.research-graph-v1__edges path\.is-proven/u);
  assert.match(component, /onOpenHypothesis\?: \(hypothesisId: string\)/u);
  assert.match(component, /Відкрити гіпотезу/u);
  assert.match(workspace, /onOpenHypothesis=\{onOpenHypothesis\}/u);
});

test("research graph remains keyboard accessible and usable on a narrow screen", () => {
  assert.match(component, /role="button"/u);
  assert.match(component, /tabIndex=\{0\}/u);
  assert.match(component, /event\.key !== "Enter" && event\.key !== " "/u);
  assert.match(component, /Список вузлів/u);
  assert.match(component, /Пояснення вибраного вузла/u);
  assert.match(styles, /\.research-graph-v1__canvas\s*\{[\s\S]*?overflow:\s*auto/u);
  assert.match(styles, /overscroll-behavior:\s*contain/u);
  assert.match(styles, /@media \(max-width: 760px\)/u);
  assert.match(styles, /\.research-graph-v1__year-focus[\s\S]*?grid-template-columns:\s*1fr/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("personal saved views are available independently of shared-data edit rights", () => {
  const savedViewsIndex = component.indexOf("research-graph-v1__saved-views");
  const sharedEditorGateIndex = component.indexOf("{canEdit && !readOnly ? (");
  assert.ok(savedViewsIndex > 0 && savedViewsIndex < sharedEditorGateIndex);
  assert.match(component, /Збережені представлення/u);
  assert.match(component, /listResearchGraphSavedViews\(projectId\)/u);
  assert.match(component, /saveResearchGraphSavedView\(projectId/u);
  assert.match(component, /deleteResearchGraphSavedView\(projectId/u);
  assert.match(component, /Оновити представлення/u);
  assert.match(component, /Особисті набори центру, фільтрів, макета, масштабу та положення графа/u);
});

test("saved view stores configuration IDs but never copies node labels or place labels", () => {
  assert.match(component, /function toSavedViewFilters/u);
  assert.match(component, /relationTypeIds:/u);
  assert.match(component, /placeIds:/u);
  assert.match(component, /centerEntityId:\s*center\.id/u);
  assert.match(component, /layoutId,/u);
  assert.match(component, /Імена вузлів, підписи й приватний текст до представлення не копіюються/u);
  const storageBlock = component.slice(
    component.indexOf("function toSavedViewFilters"),
    component.indexOf("function fromSavedViewFilters"),
  );
  assert.doesNotMatch(storageBlock, /placeLabel|nodes|edges/u);
});

test("saved view load is atomic and refuses stale filters, versions and unknown layouts", () => {
  assert.match(component, /getResearchGraphSavedView\(projectId, candidate\.id\)/u);
  assert.match(component, /view\.configVersion !== RESEARCH_GRAPH_SAVED_VIEW_CONFIG_VERSION/u);
  assert.match(component, /!isResearchGraphLayoutId\(view\.viewState\.layoutId\)/u);
  assert.match(component, /researchGraphSavedFiltersSupported\(view\.filters\)/u);
  assert.match(component, /Збережений тип зв’язку більше недоступний/u);
  assert.match(component, /resolveResearchGraphSavedPlace\(projectId, savedPlaceId/u);
  assert.match(component, /фільтр місця видалено, об’єднано або він більше недоступний/u);
  assert.match(component, /const prepared: PreparedSavedView/u);
  assert.match(component, /restorePreparedSavedView\(prepared\)/u);
  const loadBlock = component.slice(
    component.indexOf("const loadSavedView = async"),
    component.indexOf("const deleteSavedView = async"),
  );
  const finalContextGuard = loadBlock.indexOf("requestContextKey !== activeContextKey.current");
  const relationTypeSetter = loadBlock.indexOf("setRelationTypes(refreshedRelationTypes");
  assert.ok(finalContextGuard >= 0 && relationTypeSetter > finalContextGuard);
});

test("loading another saved center refocuses first and restores pending state after prop change", () => {
  assert.match(component, /view\.centerEntityId !== center\.id/u);
  assert.match(component, /pendingSavedView\.current = prepared/u);
  assert.match(component, /onFocusPerson\(view\.centerEntityId\)/u);
  assert.match(component, /prepared\?\.view\.projectId === projectId && prepared\.view\.centerEntityId === center\.id/u);
  assert.match(component, /restorePreparedSavedView\(prepared\)/u);
  assert.match(component, /setSelectedSavedViewId\(""\)/u);
  assert.match(component, /setSavedViewName\(""\)/u);
});

test("all three deterministic layouts are selectable, saved and restored atomically", () => {
  assert.match(component, /buildResearchGraphLayout\(visibleSnapshot\.nodes, visibleSnapshot\.edges, layoutId\)/u);
  assert.match(component, /value:\s*"radial"/u);
  assert.match(component, /value:\s*"hierarchical"/u);
  assert.match(component, /value:\s*"force"/u);
  assert.match(component, /role="radiogroup"/u);
  assert.match(component, /type="radio"/u);
  assert.match(component, /checked=\{layoutId === option\.value\}/u);
  assert.match(component, /setLayoutId\(prepared\.view\.viewState\.layoutId\)/u);
  assert.match(component, /setLayoutId\(nextLayoutId\)/u);
  assert.match(component, /pendingViewport\.current = \{ x: 0, y: 0, width: 0, height: 0 \}/u);
  assert.match(styles, /\.research-graph-v1__layout-picker/u);
});

test("layout zoom and viewport are real, bounded and keyboard accessible", () => {
  assert.match(component, /clampResearchGraphZoom/u);
  assert.match(component, /clampResearchGraphViewport/u);
  assert.match(component, /canvas\.scrollTo/u);
  assert.match(component, /canvas\.scrollLeft/u);
  assert.match(component, /canvas\.scrollTop/u);
  assert.match(component, /aria-label="Зменшити масштаб графа"/u);
  assert.match(component, /aria-label="Збільшити масштаб графа"/u);
  assert.match(component, /event\.key === "\+"/u);
  assert.match(component, /event\.key === "0"/u);
  assert.match(
    component,
    /const resetViewport = \(\) => \{[\s\S]*?pendingViewport\.current = null;[\s\S]*?currentViewport\.current = \{/u,
  );
  assert.match(styles, /\.research-graph-v1__viewport-tools/u);
  assert.match(styles, /\.research-graph-v1__saved-view-form\s*\{[\s\S]*?grid-template-columns:\s*1fr/u);
});
