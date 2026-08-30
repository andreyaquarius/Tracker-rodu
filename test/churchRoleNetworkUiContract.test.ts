import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonChurchRoleNetworkV1.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../src/features/context-graph/PersonChurchRoleNetworkV1.css", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);

test("church-role network is a distinct routed research mode", () => {
  assert.match(workspace, /onChangeView\("ritual"\)/u);
  assert.match(workspace, /Хрещені й поручителі/u);
  assert.match(component, /Роди й зв’язки/u);
  assert.match(component, /Особа та зв’язки між родами/u);
  assert.match(component, /Групування за прізвищем, не доказ споріднення/u);
  assert.match(component, /репрезентативна вибірка, не повний перелік і не доказ споріднення/u);
  assert.match(component, /initialMode="3d"/u);
  assert.match(component, /centerConnectionLabels="node"/u);
  assert.match(component, /layoutBuilder=\{buildChurchRoleRelationshipGraphLayout\}/u);
});

test("church-role graph shows surname semantics before the visualization", () => {
  const warningStart = component.indexOf('className="church-role-network-v1__surname-warning"');
  const graphStart = component.indexOf("<ContextRelationshipGraphV1");
  assert.ok(warningStart >= 0 && graphStart > warningStart);
  assert.match(component, /До прізвищевої групи:/u);
  assert.match(component, /Від прізвищевої групи:/u);
  assert.doesNotMatch(component, /До центру:|Від центру:/u);
  assert.match(css, /\.church-role-network-v1__surname-warning/u);
});

test("church-role network keeps the main role choice visible and progressively discloses refinements", () => {
  assert.match(component, /<span>Ролі<\/span>[\s\S]*?<select/u);
  assert.match(
    component,
    /<details className="church-role-network-v1__advanced-filters">[\s\S]*?<summary>[\s\S]*?Додаткові фільтри[\s\S]*?Період і мінімальна кількість повторень[\s\S]*?Рік від[\s\S]*?Рік до[\s\S]*?Мінімум повторень[\s\S]*?<\/details>/u,
  );
  const advancedStart = component.indexOf('className="church-role-network-v1__advanced-filters"');
  const advancedEnd = component.indexOf("</details>", advancedStart);
  const resultStart = component.indexOf("<ContextRelationshipGraphV1");
  assert.ok(advancedStart >= 0 && advancedEnd > advancedStart);
  assert.ok(resultStart > advancedEnd, "the graph/list result must remain outside the collapsed filters");
  assert.match(css, /\.church-role-network-v1__advanced-filters[\s\S]*?summary:focus-visible/u);
  assert.match(css, /grid-template-columns:\s*auto minmax\(220px, 1fr\) auto auto/u);
  assert.match(css, /\.church-role-network-v1__advanced-grid[\s\S]*?position:\s*absolute/u);
});

test("church-role network covers loading, retry, empty, single and capped results", () => {
  assert.match(component, /ChurchRoleNetworkSkeleton/u);
  assert.match(component, /Повторити/u);
  assert.match(component, /Повторюваних зв’язків не знайдено/u);
  assert.match(component, /Показати також поодинокі/u);
  assert.match(component, /Розрахунок частково обмежено/u);
  assert.match(component, /Показати ще/u);
  assert.match(component, /churchRoleProblemCapReasons\(page\?\.capReasons \?\? \[\]\)/u);
  assert.match(component, /const calculationLimited = problemCapReasons\.length > 0/u);
  assert.doesNotMatch(component, /page\?\.truncated && !hasMore/u);
  assert.match(component, /\{problemCapReasons[\s\S]*?churchRoleCapReasonLabel/u);
});

test("church-role graph is person-centred and separates aggregate groups from exact samples", () => {
  assert.match(component, /<ContextRelationshipGraphV1/u);
  assert.match(component, /buildChurchRoleRelationshipGraph\(page, \{ id: center\.id, label: centerDisplayName \}\)/u);
  assert.match(component, /centerNode=\{relationshipGraph\.centerNode\}/u);
  assert.match(component, /nodes=\{relationshipGraph\.nodes\}/u);
  assert.match(component, /edges=\{relationshipGraph\.edges\}/u);
  assert.match(component, /centerConnectionLabels="node"/u);
  assert.match(component, /Граф починається з конкретної особи/u);
  assert.match(component, /до 5[\s\S]*?точних прикладів на кожен рід/u);
  assert.match(component, /репрезентативна вибірка, не повний[\s\S]*?не доказ споріднення/u);
  assert.match(component, /personIdByNodeId\[node\.id\][\s\S]*?onOpenPerson\(personId\)/u);
});

test("church-role graph reports only a shortened visual sample without hiding loaded details", () => {
  assert.match(component, /CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS/u);
  assert.match(component, /maxNodes=\{CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS\.maxNodes\}/u);
  assert.match(component, /maxEdges=\{CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS\.maxEdges\}/u);
  assert.match(
    component,
    /relationshipGraph\.omittedGroupCount > 0 \|\| relationshipGraph\.omittedSampleCount > 0[\s\S]*?role="note"[\s\S]*?графічну вибірку скорочено[\s\S]*?Завантажені агрегати й деталі не видалено/u,
  );
  assert.match(css, /\.church-role-network-v1__graph-limit-note/u);
});

test("detailed counts, people and sources stay in a collapsed disclosure below the graph", () => {
  const graphStart = component.indexOf("<ContextRelationshipGraphV1");
  const detailsStart = component.indexOf('<details className="church-role-network-v1__result-details">');
  assert.ok(graphStart >= 0 && detailsStart > graphStart);
  assert.match(component, /Детальні списки та джерела/u);
  assert.match(component, /Підрахунки, конкретні приклади й документи/u);
  const detailsBlock = component.slice(detailsStart, component.indexOf("</details>", detailsStart) + 10);
  assert.doesNotMatch(detailsBlock.slice(0, detailsBlock.indexOf("<summary>")), /open=/u);
  assert.match(detailsBlock, /<ChurchRoleNetworkCard/u);
  assert.match(css, /\.church-role-network-v1__result-details > summary/u);
});

test("church-role network exposes source and person navigation without hover-only controls", () => {
  assert.match(component, /onOpenFinding\(source\.id\)/u);
  assert.match(component, /onOpenDocument\(source\.id\)/u);
  assert.match(component, /onOpenPerson\(sample\.sourcePersonId\)/u);
  assert.match(component, /onFocusPerson\(person\.id\)/u);
  assert.match(component, /<button type="button"/u);
  assert.match(component, /onNodeActivate/u);
  assert.match(component, /Фрагмент документа/u);
  assert.match(component, /Цитата/u);
});

test("church-role mobile view keeps the graph primary and collapsed details touch accessible", () => {
  assert.doesNotMatch(component, /setMobileView|aria-label="Спосіб перегляду мережі"/u);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?max-height:\s*none[\s\S]*?overflow:\s*visible/u);
  assert.match(css, /min-height:\s*44px/u);
});
