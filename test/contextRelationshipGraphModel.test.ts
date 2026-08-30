import assert from "node:assert/strict";
import test from "node:test";
import {
  applyContextRelationshipGraphNodeOffsets,
  buildBoundedContextRelationshipGraph,
  buildContextRelationshipGraphLayout,
  clampGraphZoom,
  groupContextRelationshipGraphEdgesByPair,
  projectContextRelationshipGraph2D,
  projectContextRelationshipGraph3D,
  wrapContextRelationshipGraphLabel,
  type ContextRelationshipGraphEdge,
  type ContextRelationshipGraphNode,
} from "../src/features/context-graph/contextRelationshipGraphModel.ts";

const center: ContextRelationshipGraphNode = {
  id: "person:center",
  label: "Петро Василенко",
  kind: "person",
};

const nodes: ContextRelationshipGraphNode[] = [
  { id: "person:godmother", label: "Ганна Коваленко", kind: "person", activatable: false, subtitle: "Хрещена мати" },
  { id: "person:witness", label: "Іван Бондар", kind: "person", subtitle: "Свідок" },
  { id: "group:bondar", label: "Рід Бондарів", kind: "group" },
  { id: "person:neighbor", label: "Марія Левченко", kind: "person" },
];

const edges: ContextRelationshipGraphEdge[] = [
  { id: "edge:godmother", sourceId: "person:godmother", targetId: center.id, label: "Хрещена мати", directed: true },
  { id: "edge:witness", sourceId: "person:witness", targetId: center.id, label: "Свідок по нареченому", directed: true },
  { id: "edge:family", sourceId: "person:witness", targetId: "group:bondar", label: "Представник роду" },
  { id: "edge:neighbor", sourceId: center.id, targetId: "person:neighbor", label: "Сусіди" },
];

test("bounded relationship graph is stable, keeps center and supports person/group nodes", () => {
  const forward = buildBoundedContextRelationshipGraph(center, nodes, edges);
  const reversed = buildBoundedContextRelationshipGraph(center, [...nodes].reverse(), [...edges].reverse());

  assert.deepEqual(forward, reversed);
  assert.equal(forward.nodes[0]?.id, center.id);
  assert.equal(forward.nodes.some((node) => node.kind === "group"), true);
  assert.equal(forward.nodes.find((node) => node.id === "person:godmother")?.activatable, false);
  assert.equal(forward.edges.every((edge) => forward.nodes.some((node) => node.id === edge.sourceId)), true);
  assert.equal(forward.omittedNodeCount, 0);
  assert.equal(forward.omittedEdgeCount, 0);
});

test("bounded relationship graph enforces safe node and edge limits", () => {
  const bounded = buildBoundedContextRelationshipGraph(center, nodes, edges, {
    maxNodes: 3,
    maxEdges: 1,
  });

  assert.equal(bounded.nodes.length, 3);
  assert.equal(bounded.edges.length, 1);
  assert.equal(bounded.nodes.some((node) => node.id === center.id), true);
  assert.equal(bounded.omittedNodeCount, 2);
  assert.ok(bounded.omittedEdgeCount >= 1);
});

test("deterministic layout produces stable xyz independent of input order", () => {
  const first = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const second = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, [...nodes].reverse(), [...edges].reverse()),
  );

  assert.deepEqual(first, second);
  assert.equal(first.nodes.find((node) => node.id === center.id)?.z, 0);
  assert.equal(first.nodes.some((node) => node.id !== center.id && Math.abs(node.z) > 1), true);
  assert.equal(first.nodes.find((node) => node.id === "person:godmother")?.activatable, false);
  assert.ok(first.width >= 760);
  assert.ok(first.height >= 520);
  const nearestPerson = first.nodes.find((node) => node.id !== center.id)!;
  assert.ok(Math.hypot(nearestPerson.x - first.centerX, nearestPerson.y - first.centerY) >= 245);
  const surrounding = first.nodes.filter((node) => node.id !== center.id);
  assert.equal(surrounding.some((node) => node.worldZ > 0), true);
  assert.equal(surrounding.some((node) => node.worldZ < 0), true);
  assert.equal(surrounding.every((node) => Math.hypot(node.worldX, node.worldY, node.worldZ) >= 244), true);
});

test("parallel social evidence becomes one visible connection without losing source rows", () => {
  const parallel: ContextRelationshipGraphEdge[] = [
    { id: "e-1", sourceId: "person:witness", targetId: center.id, label: "Хрещений батько", directed: true },
    { id: "e-2", sourceId: "person:witness", targetId: center.id, label: "Хрещений батько", directed: true },
    { id: "e-3", sourceId: "person:witness", targetId: center.id, label: "Свідок по нареченому", directed: true },
  ];
  const grouped = groupContextRelationshipGraphEdgesByPair(parallel, center.id);
  const reversedInput = groupContextRelationshipGraphEdgesByPair([...parallel].reverse(), center.id);

  assert.deepEqual(grouped, reversedInput);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.members?.length, 3);
  assert.deepEqual(grouped[0]?.roles, [
    { label: "Свідок по нареченому", count: 1 },
    { label: "Хрещений батько", count: 2 },
  ]);
  assert.equal(grouped[0]?.label, "Свідок по нареченому · Хрещений батько");
  assert.equal(grouped[0]?.directed, true);
});

test("visible labels keep ordinary Ukrainian full names and relationships readable", () => {
  const name = wrapContextRelationshipGraphLabel("Василенко Петро Іванович", 20, 3);
  assert.deepEqual(name.lines, ["Василенко Петро", "Іванович"]);
  assert.equal(name.truncated, false);
  assert.equal(name.lines.join(" "), "Василенко Петро Іванович");

  const relationship = wrapContextRelationshipGraphLabel("Свідок по нареченому", 28, 2);
  assert.deepEqual(relationship.lines, ["Свідок по нареченому"]);
  assert.equal(relationship.truncated, false);

  const bounded = wrapContextRelationshipGraphLabel(
    "Надзвичайно довгий документально підтверджений соціальний зв’язок",
    18,
    2,
  );
  assert.equal(bounded.lines.length, 2);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.lines.at(-1) ?? "", /…$/u);
});

test("3D mode uses perspective, depth sorting, scale and opacity", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const projection = projectContextRelationshipGraph3D(layout, {
    zoom: 1,
    yaw: -0.52,
    pitch: 0.28,
  });

  assert.deepEqual(
    projection.nodes.map((node) => node.z),
    projection.nodes.map((node) => node.z).slice().sort((left, right) => left - right),
  );
  assert.equal(new Set(projection.nodes.map((node) => node.scale)).size > 1, true);
  assert.equal(new Set(projection.nodes.map((node) => node.opacity)).size > 1, true);
  assert.equal(projection.nodes.every((node) => node.scale >= 0.62 && node.scale <= 1.48), true);
  assert.equal(projection.nodes.every((node) => node.opacity >= 0.48 && node.opacity <= 1), true);
  const scaleValues = projection.nodes.map((node) => node.scale);
  assert.ok(Math.max(...scaleValues) - Math.min(...scaleValues) >= 0.2);
  assert.deepEqual(
    projection.edges.map((edge) => edge.depth),
    projection.edges.map((edge) => edge.depth).slice().sort((left, right) => left - right),
  );
});

test("drag rotation parameters change the real perspective projection deterministically", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const before = projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: -0.52, pitch: 0.28 });
  const after = projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: 0.36, pitch: -0.2 });
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));

  assert.equal(after.nodes.some((node) => {
    const previous = beforeById.get(node.id)!;
    return previous.screenX !== node.screenX || previous.screenY !== node.screenY || previous.z !== node.z;
  }), true);
  assert.deepEqual(
    after,
    projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: 0.36, pitch: -0.2 }),
  );
});

test("3D rotation uses the scene centroid so the focal card participates in motion", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const before = projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: -0.52, pitch: 0.28 });
  const after = projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: 0.36, pitch: -0.2 });
  const centerBefore = before.nodes.find((node) => node.id === center.id)!;
  const centerAfter = after.nodes.find((node) => node.id === center.id)!;

  assert.notDeepEqual(
    { x: centerBefore.screenX, y: centerBefore.screenY },
    { x: centerAfter.screenX, y: centerAfter.screenY },
  );
});

test("manual scene-local node offsets move only requested cards and rebuild attached edges", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const projection = projectContextRelationshipGraph2D(layout, { zoom: 1 });
  const movedId = "person:witness";
  const originalNode = projection.nodes.find((node) => node.id === movedId)!;
  const originalCenter = projection.nodes.find((node) => node.id === center.id)!;
  const originalEdge = projection.edges.find((edge) => edge.id === "edge:witness")!;
  const displaced = applyContextRelationshipGraphNodeOffsets(
    projection,
    { [movedId]: { x: 37.25, y: -18.5 } },
  );
  const movedNode = displaced.nodes.find((node) => node.id === movedId)!;
  const unchangedCenter = displaced.nodes.find((node) => node.id === center.id)!;
  const movedEdge = displaced.edges.find((edge) => edge.id === "edge:witness")!;

  assert.equal(movedNode.screenX, originalNode.screenX + 37.25);
  assert.equal(movedNode.screenY, originalNode.screenY - 18.5);
  assert.equal(movedNode.x, originalNode.x, "manual projection offsets do not mutate deterministic layout coordinates");
  assert.equal(movedNode.worldX, originalNode.worldX);
  assert.deepEqual(unchangedCenter, originalCenter);
  assert.equal(movedEdge.sourceX, movedNode.screenX);
  assert.equal(movedEdge.sourceY, movedNode.screenY);
  assert.equal(movedEdge.targetX, unchangedCenter.screenX);
  assert.equal(movedEdge.targetY, unchangedCenter.screenY);
  assert.equal(movedEdge.sourceX, originalEdge.sourceX + 37.25);
  assert.equal(movedEdge.sourceY, originalEdge.sourceY - 18.5);
});

test("invalid, zero and unknown node offsets are harmless", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const projection = projectContextRelationshipGraph3D(layout, { zoom: 1, yaw: -0.52, pitch: 0.28 });

  assert.equal(applyContextRelationshipGraphNodeOffsets(projection, {}), projection);
  assert.equal(
    applyContextRelationshipGraphNodeOffsets(projection, {
      [center.id]: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      missing: { x: 50, y: 50 },
    }),
    projection,
  );
});

test("2D view supports fit-centered zoom and bounded zoom controls", () => {
  const layout = buildContextRelationshipGraphLayout(
    buildBoundedContextRelationshipGraph(center, nodes, edges),
  );
  const projection = projectContextRelationshipGraph2D(layout, { zoom: 1.5, panX: 20, panY: -10 });
  const projectedCenter = projection.nodes.find((node) => node.id === center.id)!;

  assert.equal(projectedCenter.screenX, layout.centerX + 20);
  assert.equal(projectedCenter.screenY, layout.centerY - 10);
  assert.equal(projection.nodes.every((node) => node.z === 0 && node.scale === 1 && node.opacity === 1), true);
  assert.equal(clampGraphZoom(-20), 0.45);
  assert.equal(clampGraphZoom(20), 2.6);
});
