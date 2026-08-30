import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChurchRoleRelationshipGraph,
  buildChurchRoleRadialLayout,
  churchRoleCapReasonLabel,
  churchRoleOccurrenceLabel,
  churchRolePeriodLabel,
  churchRoleProblemCapReasons,
  defaultChurchRoleNetworkFilterDraft,
  mergeChurchRoleNetworkPages,
  parseChurchRoleNetworkFilterDraft,
} from "../src/features/context-graph/churchRoleNetworkModel.ts";
import type {
  PersonChurchRoleNetworkItem,
  PersonChurchRoleNetworkPage,
} from "../src/types/contextGraph.ts";

function item(key: string, label: string, occurrenceCount: number): PersonChurchRoleNetworkItem {
  return {
    counterpartGroup: { key, label, normalizedSurname: key, memberCount: 2 },
    occurrenceCount,
    relationCount: occurrenceCount,
    personPairCount: 1,
    sourcePersonCount: 1,
    targetPersonCount: 1,
    incomingCount: 0,
    outgoingCount: occurrenceCount,
    roleCounts: [{ code: "godfather", label: "Хрещений батько", count: occurrenceCount }],
    firstYear: 1861,
    lastYear: 1864,
    ambiguousRoleCount: 0,
    generatedCount: occurrenceCount,
    manualCount: 0,
    samples: [],
    sources: [],
  };
}

function page(items: PersonChurchRoleNetworkItem[], truncated = false): PersonChurchRoleNetworkPage {
  return {
    centerPersonId: "center",
    algorithmVersion: "church_role_network_v1",
    groupingKind: "surname_cluster",
    groupingIsGenealogicalFact: false,
    centerGroup: { key: "kalenski", label: "Каленські", normalizedSurname: "каленський", memberCount: 3 },
    items,
    total: 3,
    truncated,
    capReasons: [],
    sameGroupOccurrenceCount: 0,
    omittedWithoutSurnameCount: 0,
  };
}

test("church-role filters default to repeated godparents and sponsors", () => {
  const parsed = parseChurchRoleNetworkFilterDraft(defaultChurchRoleNetworkFilterDraft());
  assert.equal(parsed.minOccurrences, 2);
  assert.deepEqual(parsed.roleCodes, [
    "godfather", "godmother", "godparent",
    "sponsor_for_bride", "sponsor_for_groom", "sponsor",
  ]);
});

test("church-role filters reject inverted years and invalid occurrence limits", () => {
  assert.throws(() => parseChurchRoleNetworkFilterDraft({
    preset: "godparents",
    yearFrom: "1900",
    yearTo: "1850",
    minOccurrences: "2",
  }), /Початковий рік/u);
  assert.throws(() => parseChurchRoleNetworkFilterDraft({
    preset: "sponsors",
    yearFrom: "",
    yearTo: "",
    minOccurrences: "0",
  }), /від 1 до 1000/u);
});

test("wedding-witness preset excludes witnesses from unrelated event kinds", () => {
  const parsed = parseChurchRoleNetworkFilterDraft({
    preset: "witnesses",
    yearFrom: "",
    yearTo: "",
    minOccurrences: "2",
  });
  assert.deepEqual(parsed.roleCodes, [
    "witness_for_bride",
    "witness_for_groom",
  ]);
});

test("all ritual roles exclude generic witnesses from non-ritual events", () => {
  const parsed = parseChurchRoleNetworkFilterDraft({
    preset: "all-ritual",
    yearFrom: "",
    yearTo: "",
    minOccurrences: "1",
  });
  assert.ok(parsed.roleCodes?.includes("witness_for_bride"));
  assert.ok(parsed.roleCodes?.includes("witness_for_groom"));
  assert.ok(!parsed.roleCodes?.includes("event_witness"));
  assert.ok(!parsed.roleCodes?.includes("witness"));
});

test("church-role radial layout is deterministic and ranks stronger clusters first", () => {
  const values = [item("bondar", "Бондарі", 2), item("merzliak", "Мерзляки", 7)];
  const first = buildChurchRoleRadialLayout(values);
  const reversed = buildChurchRoleRadialLayout([...values].reverse());
  assert.deepEqual(first, reversed);
  assert.equal(first.nodes[0]?.key, "merzliak");
  assert.ok(first.nodes.every((node) => node.x > 0 && node.y > 0));
});

test("church-role labels are readable Ukrainian research summaries", () => {
  assert.equal(churchRoleOccurrenceLabel(1), "1 згадка");
  assert.equal(churchRoleOccurrenceLabel(3), "3 згадки");
  assert.equal(churchRoleOccurrenceLabel(12), "12 згадок");
  assert.equal(churchRolePeriodLabel(item("a", "A", 2)), "1861–1864");
});

test("church-role pagination deduplicates clusters and stops an empty continuation", () => {
  const first = page([item("a", "A", 4)], true);
  const duplicate = page([item("a", "A", 4)], true);
  const merged = mergeChurchRoleNetworkPages(first, duplicate);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.truncated, false);
});

test("church-role pagination marker disappears after the final page", () => {
  const first = page([item("a", "A", 4)], true);
  first.total = 2;
  first.capReasons = ["pagination"];
  const finalPage = page([item("b", "B", 3)], false);
  finalPage.total = 2;
  finalPage.capReasons = [];

  const merged = mergeChurchRoleNetworkPages(first, finalPage);

  assert.equal(merged.truncated, false);
  assert.deepEqual(merged.capReasons, []);
});

test("church-role problematic cap reasons exclude pagination and explain backend limits", () => {
  assert.deepEqual(
    churchRoleProblemCapReasons([
      "pagination",
      "center_without_surname",
      "relations",
      "relations",
      "occurrences",
    ]),
    ["relations", "occurrences"],
  );
  assert.equal(
    churchRoleCapReasonLabel("center_people"),
    "Для центрального прізвища враховано не більше 500 видимих осіб.",
  );
  assert.equal(
    churchRoleCapReasonLabel("relations"),
    "Перевірено не більше 10 000 доступних соціальних зв’язків.",
  );
  assert.equal(
    churchRoleCapReasonLabel("evidence_per_relation"),
    "Для кожного зв’язку враховано не більше 50 підтверджувальних записів.",
  );
  assert.equal(
    churchRoleCapReasonLabel("occurrences"),
    "Оброблено не більше 20 000 конкретних згадок.",
  );
  assert.equal(
    churchRoleCapReasonLabel("pagination"),
    "Результати завантажуються окремими сторінками.",
  );
});

test("person-centred church-role graph separates surname aggregates from exact sample roles", () => {
  const merzliaky = item("merzliak", "Мерзляки", 7);
  merzliaky.samples = [{
    relationId: "relation-1",
    roleCode: "godfather",
    roleLabel: "Хрещений батько",
    sourcePersonId: "center-member",
    sourceDisplayName: "Іван Каленський",
    targetPersonId: "counterpart-member",
    targetDisplayName: "Петро Мерзляк",
    direction: "outgoing",
    assertionKind: "generated",
    evidenceStatus: "proven",
    confidence: 95,
    year: 1861,
    evidenceCount: 2,
    source: null,
  }];
  const graph = buildChurchRoleRelationshipGraph(
    page([merzliaky]),
    { id: "center", label: "Андрій Каленський" },
  );

  assert.equal(graph.centerNode.id, "person:center");
  assert.ok(graph.nodes.some((node) => node.id === "group:kalenski" && node.kind === "group"));
  assert.ok(graph.nodes.some((node) => node.id === "group:merzliak" && node.kind === "group"));
  assert.ok(graph.nodes.some((node) => node.id === "person:center-member" && node.kind === "person"));
  assert.ok(graph.nodes.some((node) => node.id === "person:counterpart-member" && node.kind === "person"));
  assert.ok(graph.edges.some((edge) => (
    edge.id === "group-link:kalenski:merzliak"
    && edge.directed === false
    && edge.label === "7 згадок між прізвищами"
    && edge.description?.includes("не доказ споріднення")
  )));
  assert.ok(graph.edges.some((edge) => (
    edge.id === "surname-membership:center-member:kalenski"
    && edge.labelVisibility === "details-only"
    && edge.lineStyle === "dashed"
  )));
  assert.ok(graph.edges.some((edge) => (
    edge.id === "relation:relation-1"
    && edge.label === "Хрещений батько"
    && edge.directed === true
    && edge.description?.includes("репрезентативний приклад")
  )));
  assert.equal(graph.groupKeyByEdgeId["relation:relation-1"], "merzliak");
  assert.equal(graph.personIdByNodeId["person:counterpart-member"], "counterpart-member");
});

test("bounded church-role graph keeps representative groups and exact samples atomic", () => {
  const firstGroup = item("bondar", "Бондарі", 8);
  firstGroup.samples = [
    {
      relationId: "relation-kept",
      roleCode: "godfather",
      roleLabel: "Хрещений батько",
      sourcePersonId: "center",
      sourceDisplayName: "Андрій Каленський",
      targetPersonId: "bondar-1",
      targetDisplayName: "Петро Бондар",
      direction: "outgoing",
      assertionKind: "generated",
      evidenceStatus: "proven",
      confidence: 96,
      year: 1862,
      evidenceCount: 2,
      source: null,
    },
    {
      relationId: "relation-omitted",
      roleCode: "godmother",
      roleLabel: "Хрещена мати",
      sourcePersonId: "kalenska-2",
      sourceDisplayName: "Марія Каленська",
      targetPersonId: "bondar-2",
      targetDisplayName: "Ганна Бондар",
      direction: "outgoing",
      assertionKind: "generated",
      evidenceStatus: "proven",
      confidence: 91,
      year: 1863,
      evidenceCount: 1,
      source: null,
    },
  ];
  const secondGroup = item("koval", "Ковалі", 4);
  secondGroup.samples = [{
    relationId: "relation-second-group",
    roleCode: "sponsor_for_groom",
    roleLabel: "Поручитель нареченого",
    sourcePersonId: "center",
    sourceDisplayName: "Андрій Каленський",
    targetPersonId: "koval-1",
    targetDisplayName: "Іван Коваль",
    direction: "outgoing",
    assertionKind: "generated",
    evidenceStatus: "proven",
    confidence: 88,
    year: 1864,
    evidenceCount: 1,
    source: null,
  }];

  const graph = buildChurchRoleRelationshipGraph(
    page([firstGroup, secondGroup]),
    { id: "center", label: "Андрій Каленський" },
    { maxNodes: 4, maxEdges: 4 },
  );
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));

  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 4);
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    "person:center",
    "group:kalenski",
    "group:bondar",
    "person:bondar-1",
  ]);
  assert.ok(edgeIds.has("group-link:kalenski:bondar"));
  assert.ok(edgeIds.has("surname-membership:bondar-1:bondar"));
  assert.ok(edgeIds.has("relation:relation-kept"));
  assert.ok(!edgeIds.has("relation:relation-omitted"));
  assert.ok(!nodeIds.has("person:kalenska-2"));
  assert.ok(!nodeIds.has("person:bondar-2"));
  assert.ok(!nodeIds.has("group:koval"));
  assert.ok(graph.edges.every((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId)));
  assert.equal(graph.omittedGroupCount, 1);
  assert.equal(graph.omittedSampleCount, 2);

  const aggregateOnlyWouldFit = buildChurchRoleRelationshipGraph(
    page([firstGroup]),
    { id: "center", label: "Андрій Каленський" },
    { maxNodes: 3, maxEdges: 2 },
  );
  assert.deepEqual(
    aggregateOnlyWouldFit.nodes.map((node) => node.id),
    ["person:center", "group:kalenski"],
  );
  assert.ok(!aggregateOnlyWouldFit.edges.some((edge) => edge.id === "group-link:kalenski:bondar"));
  assert.equal(aggregateOnlyWouldFit.omittedGroupCount, 1);
  assert.equal(aggregateOnlyWouldFit.omittedSampleCount, 2);
});
