import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PlaceSummary } from "../src/types/historicalPlaces.ts";
import {
  historicalPlacePath,
  parseAppRoute,
} from "../src/utils/appRoutes.ts";
import {
  changeHistoricalPlaceOriginalText,
  historicalPlaceAdministrativeLabel,
  historicalPlaceProfileMatchesDate,
  historicalPlaceOptionLabel,
  isCurrentHistoricalPlaceRequest,
  selectHistoricalPlace,
} from "../src/utils/historicalPlaceField.ts";

const serviceSource = readFileSync(
  new URL("../src/services/historicalPlacesService.ts", import.meta.url),
  "utf8",
);
const fieldSource = readFileSync(
  new URL("../src/components/HistoricalPlaceField.tsx", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../src/pages/HistoricalPlacesPage.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);

test("parses historical-place catalogue, create, profile and edit routes", () => {
  assert.deepEqual(parseAppRoute("/projects/kalenski/places"), {
    kind: "project",
    projectRef: "kalenski",
    page: "places",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/places/new"), {
    kind: "project",
    projectRef: "kalenski",
    page: "places",
    placeMode: "new",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/places/place-1"), {
    kind: "project",
    projectRef: "kalenski",
    page: "places",
    placeId: "place-1",
    placeMode: "profile",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/places/place-1/edit"), {
    kind: "project",
    projectRef: "kalenski",
    page: "places",
    placeId: "place-1",
    placeMode: "edit",
  });
});

test("builds encoded historical-place routes", () => {
  assert.equal(historicalPlacePath("Рід Каленських"), "/projects/%D0%A0%D1%96%D0%B4%20%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D1%81%D1%8C%D0%BA%D0%B8%D1%85/places");
  assert.equal(historicalPlacePath("kalenski", "place/1"), "/projects/kalenski/places/place%2F1");
  assert.equal(historicalPlacePath("kalenski", "place/1", "edit"), "/projects/kalenski/places/place%2F1/edit");
  assert.equal(historicalPlacePath("kalenski", undefined, "new"), "/projects/kalenski/places/new");
});

test("historical place field preserves source wording beside canonical selection", () => {
  const place = {
    id: "place-1",
    displayName: "Трубіївка",
    canonicalName: "Трубіївка",
    placeType: "село",
    currentAdmin: "Київська губернія",
    hierarchy: [],
  } as PlaceSummary;
  const initial = { placeId: null, originalText: "села Трубіевки", place: null };
  const selected = selectHistoricalPlace(initial, place);
  assert.equal(selected.placeId, "place-1");
  assert.equal(selected.originalText, "села Трубіевки");
  assert.equal(selected.place, place);
  assert.equal(
    historicalPlaceOptionLabel(place),
    "Трубіївка — село · Київська губернія",
  );
  assert.equal(historicalPlaceAdministrativeLabel(place), "Київська губернія");

  const datedPlace = {
    ...place,
    hierarchy: [{
      place: { ...place, id: "admin-1", canonicalName: "Брацлавський повіт", displayName: "Брацлавський повіт", hierarchy: [] },
      relationId: "relation-1",
      relationType: "administrative_parent",
      depth: 0,
      validFrom: null,
      validTo: null,
      validFromText: null,
      validToText: null,
      sourceId: null,
      confidence: 100,
      cycleDetected: false,
      path: [],
    }],
  } satisfies PlaceSummary;
  assert.equal(historicalPlaceAdministrativeLabel(datedPlace), "Брацлавський повіт");
  assert.equal(
    historicalPlaceOptionLabel(datedPlace),
    "Трубіївка — село · Брацлавський повіт",
  );

  const changed = changeHistoricalPlaceOriginalText(selected, "с. Трубіевки");
  assert.equal(changed.originalText, "с. Трубіевки");
  assert.equal(changed.placeId, null);
  assert.equal(changed.place, null);
});

test("frontend profile service uses the agreed versioned read RPCs", () => {
  assert.match(serviceSource, /rpc\("get_place_profile_v1",\s*\{[\s\S]*?p_place_id:\s*id,[\s\S]*?p_at_date:/s);
  assert.match(serviceSource, /rpc\("list_place_names_v1",\s*\{\s*p_place_id:\s*id\s*\}\)/s);
  assert.match(serviceSource, /rpc\("list_place_hierarchy_history_v1",\s*\{[\s\S]*?p_place_id:\s*id/s);
  for (const [operation, rpc] of [
    ["related", "list_place_related_v1"],
    ["parishes", "list_place_parishes_v1"],
    ["archives", "list_place_archives_v1"],
  ]) {
    assert.match(serviceSource, new RegExp(`listPlaceDatedRpc\\("${operation}",\\s*"${rpc}"`));
  }
  assert.match(serviceSource, /listPlacePageRpc\("people",\s*"list_place_people_v1"/u);
  for (const [operation, modernRpc, legacyRpc] of [
    ["documents", "list_place_documents_v2", "list_place_documents_v1"],
    ["events", "list_place_events_v2", "list_place_events_v1"],
  ]) {
    assert.match(
      serviceSource,
      new RegExp(`listPlaceTemporalPageRpc\\("${operation}",\\s*"${modernRpc}",\\s*"${legacyRpc}"`),
    );
  }
  assert.doesNotMatch(serviceSource, /\.from\(\s*["'](?:places|place_names|place_hierarchy_relations)["']\s*\)/);
});

test("place merge is preview-first and sends both optimistic lock versions", () => {
  assert.match(serviceSource, /rpc\("merge_places_preview_v1",\s*\{[\s\S]*?p_source_place_id:\s*sourceId,[\s\S]*?p_target_place_id:\s*targetId/s);
  assert.match(serviceSource, /rpc\("merge_places_v1",\s*\{[\s\S]*?p_expected_source_lock_version:\s*positiveLockVersion\(input\.expectedSourceLockVersion\),[\s\S]*?p_expected_target_lock_version:\s*positiveLockVersion\(input\.expectedTargetLockVersion\)/s);
  assert.ok(
    pageSource.indexOf("previewHistoricalPlaceMerge(source.id, place.id)")
      < pageSource.indexOf("mergeHistoricalPlaces({"),
    "merge UI must request preview before exposing the mutation",
  );
  assert.match(pageSource, /Підтверджую, що перевірив координати, назви, людей і документи обох місць/u);
  assert.match(pageSource, /disabled=\{!confirmed \|\| evidenceIssues\.length > 0 \|\| merging\}/);
  const mergePanelSource = pageSource.slice(
    pageSource.indexOf("async function hydrateHistoricalPlaceMergePreview"),
    pageSource.indexOf("function HistoricalPlaceMap"),
  );
  assert.match(mergePanelSource, /listHistoricalPlaceNames\(snapshot\.place\.id\)/u);
  assert.match(mergePanelSource, /listHistoricalPlacePeople\(snapshot\.place\.id, limit, offset\)/u);
  assert.match(mergePanelSource, /listHistoricalPlaceDocuments\(snapshot\.place\.id, limit, offset\)/u);
  assert.match(mergePanelSource, /names\.length !== snapshot\.counts\.names/u);
  assert.match(mergePanelSource, /people\.length !== snapshot\.counts\.visiblePeople/u);
  assert.match(mergePanelSource, /documents\.length !== snapshot\.counts\.visibleDocuments/u);
  assert.match(mergePanelSource, /evidenceIssues\.length > 0/u);
  assert.match(mergePanelSource, /const freshRawPreview = await previewHistoricalPlaceMerge/u);
  assert.match(mergePanelSource, /mergeReviewSignature\(fresh\.preview\) !== mergeReviewSignature\(preview\)/u);
  assert.match(mergePanelSource, /snapshot\.place\.lockVersion/u);
  assert.match(mergePanelSource, /nameIds:\s*sortedMergeReviewIds\(snapshot\.names\.map\(\(name\) => name\.id\)\)/u);
  assert.match(mergePanelSource, /personIds:\s*sortedMergeReviewIds\(snapshot\.people\.map\(\(person\) => person\.personId\)\)/u);
  assert.match(mergePanelSource, /documentLinkIds:\s*sortedMergeReviewIds\(snapshot\.documents\.map\(\(document\) => document\.linkId\)\)/u);
  assert.match(mergePanelSource, /documentIds:\s*sortedMergeReviewIds\(snapshot\.documents\.map\(\(document\) => document\.documentId\)\)/u);
  assert.match(mergePanelSource, /hierarchyRelationIds:\s*sortedMergeReviewIds\(snapshot\.hierarchy\?\.map\(\(node\) => node\.relationId\) \?\? \[\]\)/u);
  assert.match(mergePanelSource, /hierarchyPlaceIds:\s*sortedMergeReviewIds\(snapshot\.hierarchy\?\.map\(\(node\) => node\.place\.id\) \?\? \[\]\)/u);
  assert.match(serviceSource, /value\(row, "adminContext", "admin_context"\)/u);
  assert.match(serviceSource, /currentHierarchy[\s\S]*?ancestors[\s\S]*?history/u);
  assert.match(mergePanelSource, /snapshot\.adminContext\.currentHierarchy\.hierarchy/u);
  assert.match(mergePanelSource, /snapshot\.adminContext\.history\.flatMap/u);
  assert.match(mergePanelSource, /adminRelationIds:\s*sortedMergeReviewIds/u);
  assert.match(mergePanelSource, /adminPlaceIds:\s*sortedMergeReviewIds/u);
  assert.match(mergePanelSource, /function sortedMergeReviewIds[\s\S]*?\.sort\(\(left, right\) => left\.localeCompare\(right\)\)/u);
  assert.doesNotMatch(mergePanelSource, /snapshot\.(?:names|people|documents)\.slice\(/u);
  assert.match(mergePanelSource, /Показати всі назви/u);
  assert.match(mergePanelSource, /Показати всіх пов’язаних людей/u);
  assert.match(mergePanelSource, /Показати всі документи/u);
  assert.match(mergePanelSource, /Сучасна адміністративна належність/u);
  assert.match(mergePanelSource, /Показати повну адміністративну історію/u);
});

test("historical places UI exposes supported capabilities without lossy person wiring", () => {
  assert.match(sidebarSource, /key:\s*"places",\s*label:\s*"Історичні місця"/u);
  assert.match(pageSource, />Огляд</u);
  assert.match(pageSource, />Історичні назви/u);
  assert.match(pageSource, />Адміністративна історія/u);
  for (const label of ["Пов’язані місця", "Парафії", "Архіви", "Документи", "Люди", "Події"]) {
    assert.match(pageSource, new RegExp(`>${label}\\s*<span>`, "u"));
  }
  assert.match(pageSource, /canEditPrivate && props\.mode !== "edit" && props\.onEditPlace/u);
  assert.match(pageSource, /place\.scope === "global" \? "Зміни глобального каталогу/u);
  assert.match(pageSource, /placeOriginalText\s*\?\s*<p>Місце в джерелі:/u);
  assert.match(fieldSource, /selectHistoricalPlace\(value, place\)/);
  assert.doesNotMatch(fieldSource, /GeoPlaceField/);
  assert.doesNotMatch(fieldSource, /savePerson|onSavePerson/);
  assert.match(pageSource, /name:\s*canonicalName\.trim\(\),[\s\S]*?originalText,/u);
  assert.doesNotMatch(pageSource, /name:\s*originalText\.trim\(\),/u);
});

test("write service uses migration 006 RPC contracts and immutable source wording", () => {
  for (const rpc of [
    "patch_project_place_v1", "add_place_name_v1", "update_place_name_v1",
    "add_place_hierarchy_relation_v1", "add_place_parish_relation_v1",
    "create_archive_resource_v1", "add_place_archive_relation_v1",
    "create_and_link_place_archive_resource_v1",
    "add_document_place_link_v1", "list_place_audit_history_v1",
  ]) assert.match(serviceSource, new RegExp(`"${rpc}"`));
  assert.match(pageSource, /createAndLinkHistoricalPlaceArchive\(place\.id,/u);
  assert.doesNotMatch(pageSource, /createHistoricalArchive\([\s\S]*?linkHistoricalPlaceArchive\(/u);
  assert.match(serviceSource, /p_expected_lock_version:\s*positiveLockVersion\(input\.expectedLockVersion,\s*"write"\)/);
  assert.match(serviceSource, /function requiredExactText[\s\S]*?if \(typeof input === "string" && input\.trim\(\)\) return input;/u);
  assert.match(serviceSource, /const originalText = requiredExactText\(input\.originalText/u);
  assert.match(serviceSource, /add_document_place_link_v1[\s\S]*?originalText: requiredExactText\(input\.originalText/u);
  assert.match(pageSource, /readOnly=\{Boolean\(editingName\)\}/);
  assert.match(pageSource, /Документ проєкту/u);
  assert.match(pageSource, />Історія змін/u);
  assert.doesNotMatch(pageSource, /Видалити місце|Видалити назву/u);
  assert.match(
    serviceSource,
    /typeof nested === "string" && Object\.keys\(wrapper\)\.length === 1/u,
    "a direct add_place_name_v1 response must not confuse its name field with a scalar envelope",
  );
});

test("historical place profile remains operable on narrow touch screens", () => {
  assert.match(pageSource, /role="tabpanel"/);
  assert.match(pageSource, /tabIndex=\{activeTab === "overview" \? 0 : -1\}/);
  assert.match(pageSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(pageSource, /const coarsePointer = window\.matchMedia\("\(pointer: coarse\)"\)\.matches/);
  assert.match(pageSource, /dragging: !coarsePointer/);
  assert.match(pageSource, /role="region" aria-label=\{`Інтерактивна карта/u);
  assert.match(pageSource, /На телефоні використовуйте кнопки масштабу/u);
});

test("profile navigation remounts place state and global profiles do not request private audit", () => {
  assert.match(pageSource, /<PlaceProfile key=\{props\.placeId\}/u);
  assert.match(pageSource, /if \(profile\?\.place\.scope !== "project"\)[\s\S]*?setAudit\(\[\]\)/u);
  assert.ok(
    pageSource.indexOf("listHistoricalPlaceAudit(props.placeId, 50)")
      > pageSource.indexOf('if (profile?.place.scope !== "project")'),
    "audit RPC must remain behind the project-scope guard",
  );
});

test("a merged global Place follows only the server-provided safe redirect", () => {
  assert.match(serviceSource, /\bisRedirect,\s*\n/u);
  assert.match(serviceSource, /finalTargetPlaceId:\s*redirectFinalTargetPlaceId/u);
  assert.match(serviceSource, /basePlace\.isRedirect\s*\?\s*\[\]/u);
  assert.match(pageSource, /nextProfile\.place\.redirect\?\.finalTargetPlaceId/u);
  assert.match(pageSource, /props\.onOpenPlace\(redirectTarget\)/u);
});

test("profile edit conflicts can reload safely and tabs expose keyboard semantics", () => {
  assert.match(pageSource, /cause instanceof HistoricalPlacesServiceError && cause\.code === "40001"/u);
  assert.match(pageSource, />Оновити дані<\/button>/u);
  assert.match(pageSource, /onKeyDown=\{handleTabKeyDown\}/u);
  assert.match(pageSource, /role="tabpanel" aria-labelledby=\{`historical-place-tab-\$\{activeTab\}`\}/u);
  assert.match(pageSource, /tabIndex=\{activeTab === "overview" \? 0 : -1\}/u);
});

test("dated profile responses cannot be overwritten by an older request", () => {
  assert.equal(isCurrentHistoricalPlaceRequest(3, 3, false), true);
  assert.equal(isCurrentHistoricalPlaceRequest(3, 2, false), false);
  assert.equal(isCurrentHistoricalPlaceRequest(3, 3, true), false);
  assert.equal(historicalPlaceProfileMatchesDate("1862-07-01", "1862-07-01"), true);
  assert.equal(historicalPlaceProfileMatchesDate(null, "1862-07-01"), false);
  assert.equal(historicalPlaceProfileMatchesDate(null, ""), true);
  assert.match(pageSource, /const profileRequestRef = useRef\(0\)/u);
  assert.match(pageSource, /const requestId = \+\+profileRequestRef\.current/u);
  assert.match(
    pageSource,
    /isCurrentHistoricalPlaceRequest\([\s\S]*?profileRequestRef\.current,[\s\S]*?requestId,[\s\S]*?controller\.signal\.aborted,[\s\S]*?\)[\s\S]*?setProfile\(nextProfile\)/u,
  );
  assert.match(pageSource, /const profileDateIsCurrent = atYear \? !loading : historicalPlaceProfileMatchesDate\(profile\.atDate, atDate\)/u);
  assert.match(pageSource, /Оновлюємо адміністративну належність для вибраної дати/u);
});

test("completed historical-place UI exposes the full evidence forms", () => {
  for (const label of [
    "Тип місця", "Wikidata ID", "GeoNames ID", "Інші зовнішні ID",
    "Тип назви", "Точність дат", "Документ-джерело", "Джерело / цитата",
    "Пов’язане місце", "Історична межа", "GeoJSON Polygon або MultiPolygon",
  ]) assert.match(pageSource, new RegExp(label, "u"));
  assert.match(pageSource, /addHistoricalPlaceRelated\(input\)/u);
  assert.match(pageSource, /addHistoricalPlaceBoundary\(\{/u);
  assert.match(pageSource, /createAndLinkHistoricalPlaceArchive[\s\S]*?catalogueReference:/u);
  assert.match(pageSource, /auditChanges\(item\.before, item\.after\)/u);
  assert.match(pageSource, /snapshot\.hierarchy\?\.length/u);
  assert.match(pageSource, /snapshot\.people\.length/u);
  assert.match(pageSource, /snapshot\.documents\.length/u);
  const commonRelationPayload = serviceSource.slice(
    serviceSource.indexOf("function datedRelationPayload"),
    serviceSource.indexOf("export async function addHistoricalPlaceHierarchy"),
  );
  assert.doesNotMatch(commonRelationPayload, /religion|originalText/u);
  assert.match(serviceSource, /addHistoricalPlaceParish[\s\S]*?religion:\s*input\.religion,[\s\S]*?originalText:\s*input\.originalText/u);
  assert.match(serviceSource, /addHistoricalPlaceRelated[\s\S]*?originalText:\s*input\.originalText/u);
  assert.match(pageSource, /sourceDocumentId:\s*relationSourceDocumentId \|\| null/u);
  assert.match(pageSource, /validFromText:\s*boundaryValidFromText \|\| null/u);
  assert.match(pageSource, /return \{ value: geometry, error: "" \}/u);
});

test("place field supports keyboard selection and inline unresolved creation", () => {
  assert.match(fieldSource, /aria-activedescendant=/u);
  assert.match(fieldSource, /\["ArrowDown", "ArrowUp", "Home", "End"\]/u);
  assert.match(fieldSource, /event\.key === "Enter"/u);
  assert.match(fieldSource, /event\.key === "Escape"/u);
  assert.match(fieldSource, /needsIdentification:\s*true/u);
  assert.match(fieldSource, /Створити й прив’язати/u);
  assert.match(fieldSource, /originalText:\s*value\.originalText/u);
  assert.match(fieldSource, /dismissedQuery !== query/u);
  assert.match(fieldSource, /allowInlineCreate \|\| Boolean\(onCreateRequested\)/u);
  assert.match(fieldSource, /<option value="small_settlement">Присілок<\/option>/u);
  assert.doesNotMatch(fieldSource, /value="prisilok"/u);
});

test("year precision is passed as a period and never as an invented exact date", () => {
  assert.match(pageSource, /periodFrom:\s*`\$\{year\}-01-01`/u);
  assert.match(pageSource, /periodTo:\s*`\$\{year\}-12-31`/u);
  assert.match(pageSource, /precision:\s*"year" as const/u);
  assert.match(pageSource, /Рік передається як період із точністю «рік»/u);
  assert.match(serviceSource, /rpc\("search_places_v2"/u);
  assert.match(serviceSource, /rpc\("resolve_place_hierarchy_period_v1"/u);
  assert.match(serviceSource, /isMissingRpcError\(error\)[\s\S]*?rpc\("search_places_v1"/u);
});

test("dated map renders boundaries and period document/event context", () => {
  assert.match(serviceSource, /rpc\("get_place_map_context_v1"/u);
  assert.match(pageSource, /getHistoricalPlaceMapContext\(props\.placeId, activeTemporalContext/u);
  assert.match(serviceSource, /list_place_boundaries_v1/u);
  assert.match(pageSource, /L\.geoJSON\(boundary\.geometryGeojson/u);
  assert.match(pageSource, /contextDocuments\.length/u);
  assert.match(pageSource, /contextEvents\.length/u);
  assert.match(pageSource, />Історичні межі <span>/u);
  assert.match(pageSource, /visibleBoundaries = boundaries\.filter\(\(item\) => datedEvidenceMatchesDate\(item, datedContext\)\)/u);
  assert.match(pageSource, /const contextFrom = yearOnly \? `\$\{contextYear\}-01-01` : context/u);
  assert.match(pageSource, /const contextTo = yearOnly \? `\$\{contextYear\}-12-31` : context/u);
});

test("an exact map date is not also sent as a conflicting period", () => {
  assert.match(pageSource, /exactDate:\s*atDate,[\s\S]*?originalText:\s*atDate,[\s\S]*?precision:\s*"day"/u);
  const exactContext = pageSource.slice(
    pageSource.indexOf("const activeTemporalContext"),
    pageSource.indexOf("const [profile"),
  );
  assert.doesNotMatch(exactContext, /periodFrom|periodTo/u);
});

test("catalogue supports administrative and coordinate filters", () => {
  assert.match(pageSource, /ancestorPlaceId:\s*ancestorPlace\.placeId/u);
  assert.match(pageSource, /latitude:\s*coordinateFilterReady \? Number\(searchLatitude\) : null/u);
  assert.match(pageSource, /radiusKm:\s*coordinateFilterReady \? Number\(searchRadiusKm\) : null/u);
  assert.match(pageSource, /У складі адміністративної одиниці/u);
  assert.match(pageSource, /allowInlineCreate=\{false\}/u);
  assert.match(pageSource, /place\.distanceKm\.toLocaleString/u);
  assert.match(serviceSource, /if \(!query && !input\.ancestorPlaceId && !hasCoordinateFilter\) return \[\]/u);
});

test("large place profiles page through every people, document and event result", () => {
  assert.match(pageSource, /const PLACE_PROFILE_PAGE_SIZE = 100/u);
  assert.match(pageSource, /listHistoricalPlacePeople\([\s\S]*?people\.length/u);
  assert.match(pageSource, /listHistoricalPlaceDocuments\([\s\S]*?documents\.length/u);
  assert.match(pageSource, /listHistoricalPlaceEvents\([\s\S]*?events\.length/u);
  assert.match(pageSource, /function appendUnique<T>/u);
  assert.match(pageSource, /Завантажуємо…[^\n]*Показати ще/u);
});

test("new Place and its optional parent are submitted in one atomic RPC payload", () => {
  assert.match(pageSource, /createProjectPlace\(\{[\s\S]*?parentRelation:\s*parentPlace\.placeId\s*\?/u);
  const createFlow = pageSource.slice(
    pageSource.indexOf("const place = await createProjectPlace({"),
    pageSource.indexOf("props.onOpenPlace(place.id);"),
  );
  assert.doesNotMatch(createFlow, /addHistoricalPlaceHierarchy\(/u);
  assert.match(serviceSource, /const parentRelation = input\.parentRelation\s*\?/u);
  assert.match(serviceSource, /\.\.\.\(parentRelation \? \{ parentRelation \} : \{\}\)/u);
});
