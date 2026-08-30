import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchGraphForceLayout,
  buildResearchGraphHierarchicalLayout,
  buildResearchGraphLayout,
  buildResearchGraphRadialLayout,
  filterResearchGraphSnapshot,
  isResearchHypothesisEdge,
  type PersonResearchGraphSnapshot,
  type ResearchGraphEdge,
  type ResearchGraphEntityType,
  type ResearchGraphNode,
  type ResearchGraphNodeId,
} from "../src/features/context-graph/researchGraphModel.ts";

const baseNodes: ResearchGraphNode[] = [
  node("person:center", "person", "Іван Коваль", 0, true),
  node("hypothesis:h-1", "hypothesis", "Можливий брат", 1),
  node("person:person-2", "person", "Петро Коваль", 1),
  node("document:doc-1", "document", "Сповідний розпис", 2),
  node("place:place-1", "place", "Політанки", 2),
];

const baseEdges: ResearchGraphEdge[] = [
  edge("edge-1", "person:center", "hypothesis:h-1", "research_hypothesis", "disputed", 55),
  edge("edge-2", "hypothesis:h-1", "person:person-2", "research_hypothesis", "likely", 65),
  edge("edge-3", "person:center", "document:doc-1", "generated", "proven", 100),
  edge("edge-4", "document:doc-1", "place:place-1", "generated", "proven", 100),
];

test("research layout is deterministic and keeps the center fixed", () => {
  const first = buildResearchGraphRadialLayout(baseNodes, baseEdges);
  const reversed = buildResearchGraphRadialLayout([...baseNodes].reverse(), [...baseEdges].reverse());

  assert.deepEqual(first, reversed);
  const center = first.nodes.find((item) => item.isCenter);
  assert.ok(center);
  assert.equal(center.ring, 0);
  assert.equal(center.x, first.width / 2);
  assert.equal(center.y, first.height / 2);
  assert.ok(first.edges.every((item) => item.path.startsWith("M ")));
  assert.ok(first.edges.every((item) => item.path.includes(" Q ")));
});

test("research filter retains only connected matching assertions and never mutates input", () => {
  const original = snapshotOf(
    [...baseNodes, baseNodes[0]!],
    [...baseEdges, baseEdges[0]!, edge("dangling", "person:center", "place:missing", "research_hypothesis")],
  );
  const before = structuredClone(original);
  const filtered = filterResearchGraphSnapshot(original, {
    assertionKinds: ["research_hypothesis"],
    evidenceStatuses: ["disputed", "likely"],
    confidenceMin: 60,
  });

  assert.deepEqual(original, before);
  assert.deepEqual(filtered.edges.map((item) => item.id), ["edge-2"]);
  assert.deepEqual(
    new Set(filtered.nodes.map((item) => item.id)),
    new Set(["person:center", "hypothesis:h-1", "person:person-2"]),
  );
  assert.equal(new Set(filtered.nodes.map((item) => item.id)).size, filtered.nodes.length);
  assert.ok(filtered.edges.every((item) => filtered.nodes.some((nodeItem) => nodeItem.id === item.source)));
  assert.ok(filtered.edges.every((item) => filtered.nodes.some((nodeItem) => nodeItem.id === item.target)));
});

test("research filter keeps only the selected relation type", () => {
  const otherTypeEdge = {
    ...edge("edge-other", "person:center", "person:person-2", "manual"),
    relationTypeId: "type-2",
    relationTypeLabel: "Інший зв’язок",
  };
  const filtered = filterResearchGraphSnapshot(
    snapshotOf(baseNodes, [...baseEdges, otherTypeEdge]),
    { relationTypeIds: ["type-2"] },
  );

  assert.deepEqual(filtered.edges.map((item) => item.id), ["edge-other"]);
  assert.deepEqual(
    new Set(filtered.nodes.map((item) => item.id)),
    new Set(["person:center", "person:person-2"]),
  );
});

test("research filter enforces visualization caps and marks truncation", () => {
  const nodes: ResearchGraphNode[] = [node("person:center", "person", "Центр", 0, true)];
  const edges: ResearchGraphEdge[] = [];
  for (let index = 0; index < 130; index += 1) {
    const type: ResearchGraphEntityType = index % 3 === 0 ? "hypothesis" : "person";
    const id = `${type}:item-${index}` as ResearchGraphNodeId;
    nodes.push(node(id, type, `Вузол ${index}`, 1));
    edges.push(edge(`edge-${index}`, "person:center", id, type === "hypothesis" ? "research_hypothesis" : "manual"));
  }
  const filtered = filterResearchGraphSnapshot(snapshotOf(nodes, edges), {
    maxNodes: 100,
    maxEdges: 50,
  });

  assert.equal(filtered.nodes.length, 51);
  assert.equal(filtered.edges.length, 50);
  assert.equal(filtered.truncated.nodes, true);
  assert.equal(filtered.truncated.edges, true);
  assert.ok(filtered.nodes.some((item) => item.isCenter));
  assert.ok(filtered.nodes.filter((item) => item.entityType === "hypothesis").length > 0);
});

test("one-hundred-node radial layout allocates extra rings without duplicate coordinates", () => {
  const nodes: ResearchGraphNode[] = [node("person:center", "person", "Центр", 0, true)];
  for (let index = 0; index < 99; index += 1) {
    const type: ResearchGraphEntityType = index % 2 ? "document" : "hypothesis";
    nodes.push(node(`${type}:item-${index}` as ResearchGraphNodeId, type, `Вузол ${index}`, 1));
  }
  const layout = buildResearchGraphRadialLayout(nodes, []);
  const coordinates = new Set(layout.nodes.map((item) => `${item.x}:${item.y}`));

  assert.equal(layout.nodes.length, 100);
  assert.equal(coordinates.size, 100);
  assert.ok(Math.max(...layout.nodes.map((item) => item.ring)) > 2);
  assert.ok(layout.nodes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y)));
  assert.ok(layout.nodes.every((item) => item.x >= 0 && item.x <= layout.width));
  assert.ok(layout.nodes.every((item) => item.y >= 0 && item.y <= layout.height));
  assertNoResearchLayoutOverlap(layout.nodes);
});

test("hierarchical and force research layouts are deterministic across RPC order", () => {
  const reversedNodes = [...baseNodes].reverse();
  const reversedEdges = [...baseEdges].reverse();

  for (const layoutId of ["hierarchical", "force", "radial"] as const) {
    const first = buildResearchGraphLayout(baseNodes, baseEdges, layoutId);
    const reversed = buildResearchGraphLayout(reversedNodes, reversedEdges, layoutId);
    assert.deepEqual(first, reversed, `${layoutId} is independent of input order`);

    const center = first.nodes.find((item) => item.id === "person:center");
    assert.ok(center, `${layoutId} keeps the center`);
    assert.equal(center.x, first.width / 2, `${layoutId} keeps a stable horizontal anchor`);
    assert.equal(center.ring, 0);
    assert.ok(first.edges.every((item) => item.path.startsWith("M ")));
    assert.ok(first.edges.every((item) => Number.isFinite(item.sourceX) && Number.isFinite(item.targetY)));
  }
});

test("hierarchical layout preserves depth layers and emits orthogonal render paths", () => {
  const layout = buildResearchGraphHierarchicalLayout(baseNodes, baseEdges, {
    maxColumns: 3,
    width: 920,
  });
  const center = layout.nodes.find((item) => item.id === "person:center");
  const depthOne = layout.nodes.filter((item) => item.depth === 1);
  const depthTwo = layout.nodes.filter((item) => item.depth === 2);

  assert.ok(center);
  assert.ok(depthOne.every((item) => item.y > center.y));
  assert.ok(depthTwo.every((item) => item.y > Math.max(...depthOne.map((item) => item.y))));
  assert.ok(layout.edges.some((item) => item.path.includes(" C ")));
  assertNoResearchLayoutOverlap(layout.nodes);
  assertResearchLayoutInsideCanvas(layout);
});

test("force layout is finite, collision-free and center-anchored at the 100-node cap", () => {
  const { nodes, edges } = denseResearchGraph();
  const startedAt = performance.now();
  const layout = buildResearchGraphForceLayout(nodes, edges, { iterations: Number.MAX_SAFE_INTEGER });
  const elapsed = performance.now() - startedAt;
  const center = layout.nodes.find((item) => item.isCenter);

  assert.equal(layout.nodes.length, 100);
  assert.ok(center);
  assert.equal(center.x, layout.width / 2);
  assert.equal(center.y, layout.height / 2);
  assert.ok(elapsed < 2_500, `bounded force layout took ${elapsed.toFixed(1)}ms`);
  assertResearchLayoutInsideCanvas(layout);
  assertNoResearchLayoutOverlap(layout.nodes);
  assert.ok(layout.edges.length > 0);
  assert.ok(layout.edges.every((item) => item.path.startsWith("M ") && item.path.includes(" Q ")));
});

test("hierarchical layout wraps a dense layer without collisions or unbounded width", () => {
  const { nodes, edges } = denseResearchGraph();
  const layout = buildResearchGraphHierarchicalLayout(nodes, edges, { maxColumns: 8 });

  assert.equal(layout.nodes.length, 100);
  assert.ok(layout.width < 2_000);
  assertResearchLayoutInsideCanvas(layout);
  assertNoResearchLayoutOverlap(layout.nodes);
  assert.equal(layout.edges.length, edges.length);
});

test("all research layout engines handle empty projections", () => {
  assert.deepEqual(buildResearchGraphHierarchicalLayout([], []), {
    width: 760,
    height: 520,
    nodes: [],
    edges: [],
  });
  assert.deepEqual(buildResearchGraphForceLayout([], []), {
    width: 760,
    height: 520,
    nodes: [],
    edges: [],
  });
});

test("hypothesis detection covers assertion edges and explicit hypothesis nodes", () => {
  assert.equal(isResearchHypothesisEdge(baseEdges[0]!), true);
  assert.equal(isResearchHypothesisEdge(baseEdges[2]!), false);
  assert.equal(
    isResearchHypothesisEdge(edge("edge-node", "hypothesis:h-1", "document:doc-1", "manual")),
    true,
  );
});

function node(
  id: ResearchGraphNodeId,
  entityType: ResearchGraphEntityType,
  label: string,
  depth: ResearchGraphNode["depth"],
  isCenter = false,
): ResearchGraphNode {
  return {
    id,
    entityType,
    entityId: id.slice(id.indexOf(":") + 1),
    label,
    secondaryLabel: "",
    isCenter,
    depth,
    masked: false,
    metadata: {},
  };
}

function edge(
  id: string,
  source: ResearchGraphNodeId,
  target: ResearchGraphNodeId,
  assertionKind: ResearchGraphEdge["assertionKind"],
  evidenceStatus: ResearchGraphEdge["evidenceStatus"] = "unknown",
  confidence = 50,
): ResearchGraphEdge {
  return {
    id,
    source,
    target,
    sourceEntityType: source.slice(0, source.indexOf(":")) as ResearchGraphEntityType,
    sourceEntityId: source.slice(source.indexOf(":") + 1),
    targetEntityType: target.slice(0, target.indexOf(":")) as ResearchGraphEntityType,
    targetEntityId: target.slice(target.indexOf(":") + 1),
    relationTypeId: "type-1",
    relationTypeCode: "possible_relation",
    relationTypeLabel: "Можливий зв’язок",
    relationCategory: "research",
    directionality: "symmetric",
    sourceRoleLabel: "",
    targetRoleLabel: "",
    validFrom: "",
    validTo: "",
    periodText: "",
    evidenceStatus,
    confidence,
    privacyStatus: "project",
    assertionKind,
    evidenceCount: assertionKind === "research_hypothesis" ? 1 : 0,
    generated: assertionKind === "generated",
    lockVersion: 1,
    metadata: {},
  };
}

function snapshotOf(
  nodes: ResearchGraphNode[],
  edges: ResearchGraphEdge[],
): PersonResearchGraphSnapshot {
  return {
    projectId: "project-1",
    center: { entityType: "person", entityId: "center" },
    depth: 2,
    revision: 4,
    nodes,
    edges,
    limits: { maxNodes: 100, maxEdges: 220 },
    truncated: { nodes: false, edges: false },
    filters: { focusDate: null, focusYear: null, placeIds: [], includeUndated: false },
  };
}

function denseResearchGraph(): { nodes: ResearchGraphNode[]; edges: ResearchGraphEdge[] } {
  const nodes: ResearchGraphNode[] = [node("person:center", "person", "Центр", 0, true)];
  const edges: ResearchGraphEdge[] = [];
  for (let index = 0; index < 99; index += 1) {
    const type: ResearchGraphEntityType = index % 4 === 0
      ? "hypothesis"
      : index % 4 === 1
        ? "document"
        : index % 4 === 2
          ? "person"
          : "place";
    const id = `${type}:dense-${index}` as ResearchGraphNodeId;
    nodes.push(node(id, type, `Щільний вузол ${String(index).padStart(2, "0")}`, index % 3 + 1 as 1 | 2 | 3));
    edges.push(edge(`dense-edge-${index}`, index === 0 ? "person:center" : nodes[index]!.id, id));
  }
  return { nodes, edges };
}

function assertResearchLayoutInsideCanvas(layout: {
  width: number;
  height: number;
  nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
}): void {
  for (const item of layout.nodes) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y), `${item.id} has finite coordinates`);
    assert.ok(item.x - item.width / 2 >= -0.01, `${item.id} stays inside the left edge`);
    assert.ok(item.x + item.width / 2 <= layout.width + 0.01, `${item.id} stays inside the right edge`);
    assert.ok(item.y - item.height / 2 >= -0.01, `${item.id} stays inside the top edge`);
    assert.ok(item.y + item.height / 2 <= layout.height + 0.01, `${item.id} stays inside the bottom edge`);
  }
}

function assertNoResearchLayoutOverlap(
  nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>,
): void {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      const separated = left.x + left.width / 2 <= right.x - right.width / 2 + 0.01
        || right.x + right.width / 2 <= left.x - left.width / 2 + 0.01
        || left.y + left.height / 2 <= right.y - right.height / 2 + 0.01
        || right.y + right.height / 2 <= left.y - left.height / 2 + 0.01;
      assert.ok(separated, `${left.id} does not overlap ${right.id}`);
    }
  }
}
