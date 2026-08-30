import assert from "node:assert/strict";
import test from "node:test";
import { buildChurchRoleRelationshipGraphLayout } from "../src/features/context-graph/churchRoleRelationshipLayout.ts";
import type {
  BoundedContextRelationshipGraph,
  ContextRelationshipGraphEdge,
  ContextRelationshipGraphNode,
} from "../src/features/context-graph/contextRelationshipGraphModel.ts";

const center: ContextRelationshipGraphNode = {
  id: "person:center",
  label: "Андрій Каленський",
  kind: "person",
};

const nodes: ContextRelationshipGraphNode[] = [
  center,
  { id: "group:kalenski", label: "Каленські", kind: "group" },
  { id: "group:merzliak", label: "Мерзляки", kind: "group" },
  { id: "person:center-member-1", label: "Іван Каленський", kind: "person" },
  { id: "person:center-member-2", label: "Марія Каленська", kind: "person" },
  { id: "person:counterpart-1", label: "Петро Мерзляк", kind: "person" },
  { id: "person:counterpart-2", label: "Ганна Мерзляк", kind: "person" },
];

const edges: ContextRelationshipGraphEdge[] = [
  membership("person:center", "group:kalenski"),
  membership("person:center-member-1", "group:kalenski"),
  membership("person:center-member-2", "group:kalenski"),
  // A shared membership must not pull this person away from the centre group.
  membership("person:center-member-2", "group:merzliak"),
  membership("person:counterpart-1", "group:merzliak"),
  membership("person:counterpart-2", "group:merzliak"),
  {
    id: "group-link:kalenski:merzliak",
    sourceId: "group:kalenski",
    targetId: "group:merzliak",
    label: "7 згадок",
  },
  relation("r1", "person:center-member-1", "person:counterpart-1"),
  relation("r2", "person:center-member-2", "person:counterpart-2"),
];

function membership(personId: string, groupId: string): ContextRelationshipGraphEdge {
  return {
    id: `surname-membership:${personId}:${groupId}`,
    sourceId: personId,
    targetId: groupId,
    label: "згруповано за прізвищем",
  };
}

function relation(id: string, sourceId: string, targetId: string): ContextRelationshipGraphEdge {
  return {
    id: `relation:${id}`,
    sourceId,
    targetId,
    label: "Хрещений батько",
    directed: true,
  };
}

function graph(
  graphNodes: ContextRelationshipGraphNode[] = nodes,
  graphEdges: ContextRelationshipGraphEdge[] = edges,
): BoundedContextRelationshipGraph {
  return {
    centerNodeId: center.id,
    nodes: graphNodes,
    edges: graphEdges,
    omittedNodeCount: 0,
    omittedEdgeCount: 0,
  };
}

test("ritual layout is deterministic and separates centre, surname groups and exact people", () => {
  const first = buildChurchRoleRelationshipGraphLayout(graph());
  const reversed = buildChurchRoleRelationshipGraphLayout(graph([...nodes].reverse(), [...edges].reverse()));

  assert.deepEqual(first, reversed);
  assert.equal(first.nodes.find((node) => node.id === center.id)?.depth, 0);
  assert.equal(first.nodes.find((node) => node.id === "group:kalenski")?.depth, 1);
  assert.equal(first.nodes.find((node) => node.id === "group:merzliak")?.depth, 2);
  assert.equal(first.nodes.find((node) => node.id === "person:counterpart-1")?.depth, 3);
  assert.ok(first.width >= 760);
  assert.ok(first.height >= 520);
  assert.ok(first.centerX > 0 && first.centerX < first.width);
  assert.ok(first.centerY > 0 && first.centerY < first.height);
});

test("two surname groups, four exact people and the centre have no 196 by 94 card overlaps", () => {
  const layout = buildChurchRoleRelationshipGraphLayout(graph());

  for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
      const left = layout.nodes[leftIndex]!;
      const right = layout.nodes[rightIndex]!;
      const overlaps = Math.abs(left.x - right.x) < 196 && Math.abs(left.y - right.y) < 94;
      assert.equal(overlaps, false, `${left.id} overlaps ${right.id}`);
    }
  }
});

test("exact people stay with their deterministic owner group and shared people prefer the centre group", () => {
  const layout = buildChurchRoleRelationshipGraphLayout(graph());
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const centerGroup = byId.get("group:kalenski")!;
  const counterpartGroup = byId.get("group:merzliak")!;
  const shared = byId.get("person:center-member-2")!;
  const counterpart = byId.get("person:counterpart-1")!;

  assert.ok(distance(shared, centerGroup) < distance(shared, counterpartGroup));
  assert.ok(distance(counterpart, counterpartGroup) < distance(counterpart, centerGroup));
});

test("world coordinates preserve finite 3D depth while all edges keep selected endpoints", () => {
  const layout = buildChurchRoleRelationshipGraphLayout(graph());
  const ids = new Set(layout.nodes.map((node) => node.id));

  assert.equal(layout.nodes.every((node) => (
    Number.isFinite(node.worldX)
    && Number.isFinite(node.worldY)
    && Number.isFinite(node.worldZ)
  )), true);
  assert.ok(new Set(layout.nodes.map((node) => node.worldZ)).size > 2);
  assert.equal(layout.edges.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)), true);
});

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
