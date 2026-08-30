import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDocumentaryGraphLayeredLayout,
  filterDocumentaryGraphSnapshot,
} from "../src/features/context-graph/documentaryGraphModel.ts";
import type {
  DocumentaryGraphEdge,
  DocumentaryGraphEntityType,
  DocumentaryGraphNode,
  DocumentaryGraphNodeId,
  PersonDocumentaryGraphSnapshot,
} from "../src/types/contextGraph.ts";

const nodes: DocumentaryGraphNode[] = [
  node("person:center", "person", "Центральна особа", 0, true),
  node("document:doc-b", "document", "Метрична книга Б", 1),
  node("finding:finding-a", "finding", "Запис про шлюб", 1),
  node("person_event:event-a", "person_event", "Шлюб", 1),
  node("place:place-a", "place", "Політанки", 2),
  node("person:related-a", "person", "Анна Гнатюк", 2),
];

const edges: DocumentaryGraphEdge[] = [
  edge("edge-3", "person_event:event-a", "place:place-a", "occurred_at"),
  edge("edge-2", "finding:finding-a", "document:doc-b", "recorded_in"),
  edge("edge-1", "person:center", "finding:finding-a", "participated_in"),
  edge("edge-4", "finding:finding-a", "person:related-a", "has_participant"),
];

test("documentary layout is deterministic across reversed RPC arrays", () => {
  const first = buildDocumentaryGraphLayeredLayout(nodes, edges);
  const reversed = buildDocumentaryGraphLayeredLayout([...nodes].reverse(), [...edges].reverse());

  assert.deepEqual(first, reversed);
  assert.deepEqual(first.layers.map((layer) => layer.depth), [0, 1, 2]);
  assert.deepEqual(first.layers[0]?.nodeIds, ["person:center"]);
  assert.deepEqual(first.layers[1]?.nodeIds, [
    "finding:finding-a",
    "person_event:event-a",
    "document:doc-b",
  ]);
});

test("documentary layout exposes node centers and ready-to-render paths", () => {
  const layout = buildDocumentaryGraphLayeredLayout(nodes, edges, { width: 980, height: 640 });
  const center = layout.nodes.find((item) => item.id === "person:center");
  const place = layout.nodes.find((item) => item.id === "place:place-a");
  const centerEdge = layout.edges.find((item) => item.id === "edge-1");
  const relatedPerson = layout.nodes.find((item) => item.id === "person:related-a");
  const relatedPersonEdge = layout.edges.find((item) => item.id === "edge-4");
  assert.ok(center);
  assert.ok(place);
  assert.ok(centerEdge);
  assert.ok(relatedPerson);
  assert.ok(relatedPersonEdge);
  assert.equal(center.layerIndex, 0);
  assert.equal(place.layerIndex, 2);
  assert.ok(center.x >= center.width / 2);
  assert.ok(place.x <= layout.width - place.width / 2);
  assert.ok(layout.edges.every((item) => item.path.startsWith("M ")));
  assert.ok(layout.edges.every((item) => item.path.includes(" C ")));
  assert.ok(layout.edges.every((item) => Number.isFinite(item.sourceX)));
  const centerRadius = Math.min(center.width, center.height) / 2;
  const relatedPersonRadius = Math.min(relatedPerson.width, relatedPerson.height) / 2;
  assert.equal(centerEdge.sourceX, center.x + centerRadius);
  assert.equal(relatedPersonEdge.targetX, relatedPerson.x - relatedPersonRadius);
  assert.notEqual(centerEdge.sourceX, center.x + center.width / 2);
});

test("documentary filtering retains the center and removes dangling and duplicate edges", () => {
  const snapshot = snapshotOf(
    [...nodes, nodes[0]!],
    [
      ...edges,
      edges[0]!,
      edge("dangling", "person:center", "place:missing", "mentions_place"),
    ],
  );
  const filtered = filterDocumentaryGraphSnapshot(
    snapshot,
    (item) => item.entityType !== "place" && item.entityType !== "document",
  );

  assert.ok(filtered.nodes.some((item) => item.id === snapshot.centerNodeId));
  assert.equal(new Set(filtered.nodes.map((item) => item.id)).size, filtered.nodes.length);
  assert.equal(new Set(filtered.edges.map((item) => item.id)).size, filtered.edges.length);
  const ids = new Set(filtered.nodes.map((item) => item.id));
  assert.ok(filtered.edges.every((item) => ids.has(item.source) && ids.has(item.target)));
  assert.ok(filtered.nodes.every((item) => item.entityType !== "place"));
  assert.ok(filtered.nodes.every((item) => item.entityType !== "document"));
});

test("documentary layout remains non-overlapping for the one-hundred-node RPC cap", () => {
  const denseNodes: DocumentaryGraphNode[] = [node("person:center", "person", "Центр", 0, true)];
  for (let index = 0; index < 99; index += 1) {
    const type: DocumentaryGraphEntityType = index % 2 === 0 ? "finding" : "document";
    denseNodes.push(node(`${type}:item-${index}` as DocumentaryGraphNodeId, type, `Вузол ${index}`, 1));
  }
  const layout = buildDocumentaryGraphLayeredLayout(denseNodes, []);
  const layerOne = layout.nodes.filter((item) => item.layerIndex === 1);

  assert.equal(layout.nodes.length, 100);
  for (let index = 1; index < layerOne.length; index += 1) {
    const previous = layerOne[index - 1];
    const current = layerOne[index];
    assert.ok(previous && current);
    assert.ok(current.y - previous.y >= current.height);
  }
  for (const item of layout.nodes) {
    assert.ok(item.x - item.width / 2 >= 0);
    assert.ok(item.x + item.width / 2 <= layout.width);
    assert.ok(item.y - item.height / 2 >= 0);
    assert.ok(item.y + item.height / 2 <= layout.height);
  }
});

function node(
  id: DocumentaryGraphNodeId,
  entityType: DocumentaryGraphEntityType,
  label: string,
  depth: number,
  isCenter = false,
): DocumentaryGraphNode {
  return {
    id,
    entityType,
    entityId: id.slice(id.indexOf(":") + 1),
    label,
    secondaryLabel: "",
    depth,
    masked: false,
    metadata: isCenter ? { isCenter: true } : {},
  };
}

function edge(
  id: string,
  source: DocumentaryGraphNodeId,
  target: DocumentaryGraphNodeId,
  relationType: string,
): DocumentaryGraphEdge {
  return {
    id,
    source,
    target,
    relationType,
    label: relationType,
    status: "unknown",
    confidence: 50,
    sourceCount: 1,
    generated: false,
    metadata: {},
  };
}

function snapshotOf(
  snapshotNodes: DocumentaryGraphNode[],
  snapshotEdges: DocumentaryGraphEdge[],
): PersonDocumentaryGraphSnapshot {
  return {
    centerNodeId: "person:center",
    nodes: snapshotNodes,
    edges: snapshotEdges,
    generatedAt: "2026-08-29T10:00:00Z",
    snapshotUpdatedAt: "2026-08-29T09:00:00Z",
    truncated: false,
    edgesTruncated: false,
  };
}
