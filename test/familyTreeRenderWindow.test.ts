import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutFamilyUnit,
  FamilyTreeLayoutNode,
  FamilyTreeViewerLayout,
} from "../src/utils/familyTreeViewerLayout.ts";
import {
  layoutVisibleInViewport,
  visibleLayoutForViewport,
} from "../src/utils/familyTreeRenderWindow.ts";

function layoutNode(id: string, x: number, y = 0): FamilyTreeLayoutNode {
  return {
    occurrence: {
      id,
      personId: id.replace(/:.+$/, ""),
      mode: "family",
      path: [id],
      generation: Math.round(y / 100),
      depth: 0,
      duplicateIndex: 0,
      isRepeated: false,
    },
    person: {
      personId: id.replace(/:.+$/, ""),
      displayName: id,
      primaryName: null,
      names: [],
      events: [],
      gender: "unknown",
      status: "proven",
      isLiving: false,
      privacyStatus: "private",
      redacted: false,
      occurrenceIds: [id],
    },
    x,
    y,
    width: 100,
    height: 60,
    badges: [],
  };
}

function layoutWithNodes(nodes: FamilyTreeLayoutNode[]): FamilyTreeViewerLayout {
  return {
    nodes,
    edges: [],
    familyUnits: [],
    width: 1000,
    height: 500,
    minX: Math.min(...nodes.map((node) => node.x)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
    rootOccurrenceId: nodes[0]?.occurrence.id ?? null,
  };
}

test("render window keeps small layouts unfiltered", () => {
  const layout = layoutWithNodes([
    layoutNode("root:0", 0),
    layoutNode("father:0", -160, -100),
  ]);

  const rendered = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 1 },
    { width: 400, height: 300 },
  );

  assert.equal(rendered.nodes.length, 2);
  assert.deepEqual([...rendered.visibleOccurrenceIds].sort(), ["father:0", "root:0"]);
});

test("render window filters large layouts by viewport and keeps pinned nodes", () => {
  const nodes = Array.from({ length: 260 }, (_, index) => layoutNode(`person-${index}:0`, index * 180, 0));
  const layout = layoutWithNodes(nodes);

  const rendered = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 1 },
    { width: 420, height: 260 },
    {
      selectedOccurrenceId: "person-240:0",
      highlightedOccurrenceIds: ["person-250:0"],
    },
    { overscan: 0 },
  );

  const ids = new Set(rendered.nodes.map((node) => node.occurrence.id));
  assert.equal(ids.has("person-0:0"), true);
  assert.equal(ids.has("person-1:0"), true);
  assert.equal(ids.has("person-2:0"), true);
  assert.equal(ids.has("person-10:0"), false);
  assert.equal(ids.has("person-240:0"), true);
  assert.equal(ids.has("person-250:0"), true);
  assert.equal(rendered.nodes.length < layout.nodes.length, true);
});

test("render window selection does not mutate layout coordinates", () => {
  const nodes = Array.from({ length: 260 }, (_, index) => layoutNode(`person-${index}:0`, index * 180, 0));
  const layout = layoutWithNodes(nodes);
  const before = layout.nodes.map((node) => [node.occurrence.id, node.x, node.y, node.width, node.height]);

  visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 0.5 },
    { width: 420, height: 260 },
    { selectedOccurrenceId: "person-240:0" },
    { overscan: 0, visualScale: 2 },
  );

  const after = layout.nodes.map((node) => [node.occurrence.id, node.x, node.y, node.width, node.height]);
  assert.deepEqual(after, before);
});

test("render window accounts for visually enlarged cards near viewport edges", () => {
  const nodes = Array.from({ length: 260 }, (_, index) => layoutNode(`person-${index}:0`, 1000 + index * 180, 0));
  const edgeNode = layoutNode("edge-person:0", 2110, 0);
  const layout = layoutWithNodes([edgeNode, ...nodes]);

  const plain = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 0.2 },
    { width: 420, height: 260 },
    {},
    { overscan: 0, visualScale: 1 },
  );
  const enlarged = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 0.2 },
    { width: 420, height: 260 },
    {},
    { overscan: 0, visualScale: 2 },
  );

  assert.equal(plain.visibleOccurrenceIds.has("edge-person:0"), false);
  assert.equal(enlarged.visibleOccurrenceIds.has("edge-person:0"), true);
});

test("render window keeps family units and edges attached to visible nodes", () => {
  const parent = layoutNode("parent:0", 0, -100);
  const child = layoutNode("child:0", 0, 0);
  const hidden = layoutNode("hidden:0", 5000, 0);
  const visibleEdge: FamilyTreeLayoutEdge = {
    edge: {
      id: "parent-child",
      relationshipId: "parent-child",
      kind: "parent_child",
      fromPersonId: "parent",
      toPersonId: "child",
      fromOccurrenceId: "parent:0",
      toOccurrenceId: "child:0",
      relationshipType: "biological",
      evidenceStatus: "proven",
      confidence: 100,
      isBloodline: true,
      parentSetId: "family-1",
      familyGroupId: "family-1",
      sourceDocumentId: null,
      sourceFindingId: null,
      style: { lineStyle: "solid", visibility: "visible" },
      metadata: {},
    },
    from: parent,
    to: child,
    path: "M 50 -40 V 0",
    dashArray: "",
    opacity: 1,
  };
  const hiddenEdge: FamilyTreeLayoutEdge = {
    ...visibleEdge,
    edge: {
      ...visibleEdge.edge,
      id: "hidden-child",
      relationshipId: "hidden-child",
      fromPersonId: "hidden",
      fromOccurrenceId: "hidden:0",
    },
    from: hidden,
  };
  const visibleFamilyUnit: FamilyTreeLayoutFamilyUnit = {
    key: "family-1",
    parentOccurrenceIds: ["parent:0"],
    childOccurrenceIds: ["child:0"],
    parents: [parent],
    children: [child],
    edges: [visibleEdge],
    unitX: 50,
    parentBusY: -20,
    childBusY: 0,
    path: "M 50 -40 V 0",
    dashArray: "",
    opacity: 1,
  };
  const layout: FamilyTreeViewerLayout = {
    ...layoutWithNodes([parent, child, hidden]),
    nodes: Array.from({ length: 260 }, (_, index) =>
      index === 0 ? parent : index === 1 ? child : index === 2 ? hidden : layoutNode(`extra-${index}:0`, 6000 + index * 160, 0),
    ),
    edges: [visibleEdge, hiddenEdge],
    familyUnits: [visibleFamilyUnit],
  };

  const rendered = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 1 },
    { width: 420, height: 260 },
    {},
    { overscan: 0 },
  );

  assert.equal(rendered.familyUnits.map((unit) => unit.key).join(","), "family-1");
  assert.equal(rendered.edges.some((edge) => edge.edge.id === "parent-child"), true);
  assert.equal(rendered.edges.some((edge) => edge.edge.id === "hidden-child"), false);
});

test("render window keeps immediate relationship context around pinned nodes", () => {
  const parent = layoutNode("parent:0", 5000, -100);
  const child = layoutNode("child:0", 5000, 0);
  const edge: FamilyTreeLayoutEdge = {
    edge: {
      id: "parent-child",
      relationshipId: "parent-child",
      kind: "parent_child",
      fromPersonId: "parent",
      toPersonId: "child",
      fromOccurrenceId: "parent:0",
      toOccurrenceId: "child:0",
      relationshipType: "biological",
      evidenceStatus: "proven",
      confidence: 100,
      isBloodline: true,
      parentSetId: "family-1",
      familyGroupId: "family-1",
      sourceDocumentId: null,
      sourceFindingId: null,
      style: { lineStyle: "solid", visibility: "visible" },
      metadata: {},
    },
    from: parent,
    to: child,
    path: "M 5050 -40 V 0",
    dashArray: "",
    opacity: 1,
  };
  const layout: FamilyTreeViewerLayout = {
    ...layoutWithNodes([parent, child]),
    nodes: Array.from({ length: 260 }, (_, index) =>
      index === 0 ? parent : index === 1 ? child : layoutNode(`extra-${index}:0`, 7000 + index * 160, 0),
    ),
    edges: [edge],
    familyUnits: [{
      key: "family-1",
      parentOccurrenceIds: ["parent:0"],
      childOccurrenceIds: ["child:0"],
      parents: [parent],
      children: [child],
      edges: [edge],
      unitX: 5050,
      parentBusY: -20,
      childBusY: -10,
      path: "M 5050 -40 V 0",
      dashArray: "",
      opacity: 1,
    }],
  };

  const rendered = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 1 },
    { width: 420, height: 260 },
    { selectedOccurrenceId: "child:0" },
    { overscan: 0 },
  );

  assert.equal(rendered.visibleOccurrenceIds.has("child:0"), true);
  assert.equal(rendered.visibleOccurrenceIds.has("parent:0"), true);
  assert.equal(rendered.edges.some((item) => item.edge.id === "parent-child"), true);
  assert.equal(rendered.familyUnits.some((unit) => unit.key === "family-1"), true);
});

test("render window clips family unit trunks to visible relatives", () => {
  const parent = layoutNode("parent:0", 0, -100);
  const visibleChild = layoutNode("visible-child:0", 0, 0);
  const hiddenChild = layoutNode("hidden-child:0", 5000, 0);
  const edgeToVisible: FamilyTreeLayoutEdge = {
    edge: {
      id: "parent-visible-child",
      relationshipId: "parent-visible-child",
      kind: "parent_child",
      fromPersonId: "parent",
      toPersonId: "visible-child",
      fromOccurrenceId: "parent:0",
      toOccurrenceId: "visible-child:0",
      relationshipType: "biological",
      evidenceStatus: "proven",
      confidence: 100,
      isBloodline: true,
      parentSetId: "family-1",
      familyGroupId: "family-1",
      sourceDocumentId: null,
      sourceFindingId: null,
      style: { lineStyle: "solid", visibility: "visible" },
      metadata: {},
    },
    from: parent,
    to: visibleChild,
    path: "M 50 -40 V 0",
    dashArray: "",
    opacity: 1,
  };
  const edgeToHidden: FamilyTreeLayoutEdge = {
    ...edgeToVisible,
    edge: {
      ...edgeToVisible.edge,
      id: "parent-hidden-child",
      relationshipId: "parent-hidden-child",
      toPersonId: "hidden-child",
      toOccurrenceId: "hidden-child:0",
    },
    to: hiddenChild,
  };
  const layout: FamilyTreeViewerLayout = {
    ...layoutWithNodes([parent, visibleChild, hiddenChild]),
    nodes: Array.from({ length: 260 }, (_, index) =>
      index === 0 ? parent : index === 1 ? visibleChild : index === 2 ? hiddenChild : layoutNode(`extra-${index}:0`, 7000 + index * 160, 0),
    ),
    edges: [edgeToVisible, edgeToHidden],
    familyUnits: [{
      key: "family-1",
      parentOccurrenceIds: ["parent:0"],
      childOccurrenceIds: ["visible-child:0", "hidden-child:0"],
      parents: [parent],
      children: [visibleChild, hiddenChild],
      edges: [edgeToVisible, edgeToHidden],
      unitX: 50,
      parentBusY: -20,
      childBusY: -10,
      path: "M 50 -40 V -20 M 50 -20 V -10 M 50 -10 H 5050 M 50 -10 V 0 M 5050 -10 V 0",
      dashArray: "",
      opacity: 1,
    }],
  };

  const rendered = visibleLayoutForViewport(
    layout,
    { x: 0, y: 0, scale: 1 },
    { width: 420, height: 260 },
    {},
    { overscan: 0 },
  );
  const unit = rendered.familyUnits[0];

  assert.ok(unit);
  assert.deepEqual(unit.childOccurrenceIds, ["visible-child:0"]);
  assert.equal(unit.path.includes("5050"), false);
  assert.equal(rendered.edges.some((edge) => edge.edge.id === "parent-visible-child"), true);
  assert.equal(rendered.edges.some((edge) => edge.edge.id === "parent-hidden-child"), false);
});

test("layout visible check detects when the tree is outside the viewport", () => {
  const layout = layoutWithNodes([layoutNode("root:0", 1000, 1000)]);

  assert.equal(layoutVisibleInViewport(layout, { x: 0, y: 0, scale: 1 }, 500, 300), false);
  assert.equal(layoutVisibleInViewport(layout, { x: -900, y: -900, scale: 1 }, 500, 300), true);
});
