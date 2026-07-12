import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import type {
  FamilyGraphData,
  FamilyTreeLayoutInput,
  LayoutEdge,
  LayoutNode,
  LayoutPoint,
  LayoutResult,
  ParentChildRelation,
  PreviousNodePosition,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

const EPSILON = 0.001;

function person(
  id: string,
  sex: TreePerson["sex"] = "unknown",
  birth?: string,
): TreePerson {
  return {
    id,
    displayName: id,
    sex,
    ...(birth ? { birth: { display: birth, sort: birth } } : {}),
  };
}

function parentRelations(
  unionId: string,
  parentIds: readonly string[],
  childId: string,
): ParentChildRelation[] {
  return parentIds.map((parentId, index) => ({
    id: `${unionId}:${parentId}:${childId}`,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role: index === 0 ? "father" : "mother",
  }));
}

/**
 * Page one contains every already-visible family but only its first child.
 * Page two expands both partner families of the middle branch and adds one
 * deeper family. This models progressive BFS pages without changing identity
 * or input order for the nodes that were already committed.
 */
function descendantGraph(expanded: boolean): FamilyGraphData {
  const middleMainChildren = expanded
    ? ["middle-main-1", "middle-main-2", "middle-main-3", "middle-main-4", "middle-main-5", "middle-main-6"]
    : ["middle-main-1"];
  const middleSideChildren = expanded
    ? ["middle-side-1", "middle-side-2", "middle-side-3"]
    : ["middle-side-1"];
  const grandChildren = expanded
    ? ["middle-grand-1", "middle-grand-2", "middle-grand-3", "middle-grand-4"]
    : [];

  return {
    persons: [
      person("root", "male", "1840"),
      person("root-partner", "female", "1842"),
      person("branch-left", "male", "1870"),
      person("branch-middle", "male", "1871"),
      person("branch-right", "male", "1872"),
      person("left-partner", "female", "1871"),
      person("middle-main-partner", "female", "1872"),
      person("middle-side-partner", "female", "1873"),
      person("right-partner", "female", "1874"),
      person("left-child", "unknown", "1900"),
      ...middleMainChildren.map((id, index) =>
        person(id, index % 2 === 0 ? "male" : "female", String(1901 + index)),
      ),
      ...middleSideChildren.map((id, index) =>
        person(id, index % 2 === 0 ? "female" : "male", String(1910 + index)),
      ),
      person("right-child", "unknown", "1902"),
      ...(expanded
        ? [
            person("middle-grand-partner", "female", "1925"),
            ...grandChildren.map((id, index) =>
              person(id, "unknown", String(1950 + index)),
            ),
          ]
        : []),
    ],
    unions: [
      {
        id: "root-family",
        kind: "partnership",
        status: "married",
        memberIds: ["root", "root-partner"],
      },
      {
        id: "left-family",
        kind: "partnership",
        status: "married",
        memberIds: ["branch-left", "left-partner"],
      },
      {
        id: "middle-main-family",
        kind: "partnership",
        status: "married",
        isPreferredForDisplay: true,
        memberIds: ["branch-middle", "middle-main-partner"],
      },
      {
        id: "middle-side-family",
        kind: "partnership",
        status: "ended",
        memberIds: ["branch-middle", "middle-side-partner"],
      },
      {
        id: "right-family",
        kind: "partnership",
        status: "married",
        memberIds: ["branch-right", "right-partner"],
      },
      ...(expanded
        ? [{
            id: "middle-grand-family",
            kind: "partnership" as const,
            status: "married" as const,
            memberIds: ["middle-main-1", "middle-grand-partner"],
          }]
        : []),
    ],
    parentChildRelations: [
      ...["branch-left", "branch-middle", "branch-right"].flatMap(childId =>
        parentRelations("root-family", ["root", "root-partner"], childId),
      ),
      ...parentRelations(
        "left-family",
        ["branch-left", "left-partner"],
        "left-child",
      ),
      ...middleMainChildren.flatMap(childId =>
        parentRelations(
          "middle-main-family",
          ["branch-middle", "middle-main-partner"],
          childId,
        ),
      ),
      ...middleSideChildren.flatMap(childId =>
        parentRelations(
          "middle-side-family",
          ["branch-middle", "middle-side-partner"],
          childId,
        ),
      ),
      ...parentRelations(
        "right-family",
        ["branch-right", "right-partner"],
        "right-child",
      ),
      ...(expanded
        ? grandChildren.flatMap(childId =>
            parentRelations(
              "middle-grand-family",
              ["middle-main-1", "middle-grand-partner"],
              childId,
            ),
          )
        : []),
    ],
  };
}

function runDescendantLayout(
  graph: FamilyGraphData,
  previousPositions?: readonly PreviousNodePosition[],
): LayoutResult {
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
    originalFocusPersonId: "middle-main-1",
  });
  const input: FamilyTreeLayoutInput = {
    graph: projection.graph,
    options: {
      layoutMode: "descendant-forest",
      focusPersonId: "root",
      ancestorDepth: 0,
      descendantDepth: 100,
      collateralDepth: 0,
      maxVisibleNodes: 500,
      primaryLineagePersonIds: ["root", "branch-middle", "middle-main-1"],
      ...(previousPositions ? { previousPositions } : {}),
    },
  };
  return layoutDescendantForest(input);
}

function nodeForPerson(result: LayoutResult, personId: string): LayoutNode {
  const matches = result.nodes.filter(node => node.personId === personId);
  assert.equal(matches.length, 1, `expected one occurrence for ${personId}`);
  return matches[0]!;
}

function centerX(node: LayoutNode): number {
  return node.x + node.width / 2;
}

function familyCenter(result: LayoutResult, unionId: string): number {
  const union = result.unions.find(candidate => candidate.unionId === unionId);
  assert.ok(union, `missing layout union ${unionId}`);
  const nodes = union.memberOccurrenceIds.map(occurrenceId => {
    const node = result.nodes.find(candidate => candidate.occurrenceId === occurrenceId);
    assert.ok(node, `missing member ${occurrenceId} for ${unionId}`);
    return node;
  });
  return nodes.reduce((sum, node) => sum + centerX(node), 0) / nodes.length;
}

function assertNoCardOverlaps(result: LayoutResult): void {
  for (let leftIndex = 0; leftIndex < result.nodes.length; leftIndex += 1) {
    const left = result.nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < result.nodes.length; rightIndex += 1) {
      const right = result.nodes[rightIndex]!;
      const overlaps =
        left.x < right.x + right.width - EPSILON &&
        left.x + left.width > right.x + EPSILON &&
        left.y < right.y + right.height - EPSILON &&
        left.y + left.height > right.y + EPSILON;
      assert.equal(
        overlaps,
        false,
        `${left.occurrenceId} overlaps ${right.occurrenceId}`,
      );
    }
  }
}

interface Segment {
  edge: LayoutEdge;
  start: LayoutPoint;
  end: LayoutPoint;
}

function segments(result: LayoutResult): Segment[] {
  return result.edges.flatMap(edge =>
    edge.points.slice(1).map((end, index) => {
      const start = edge.points[index]!;
      assert.ok(
        Math.abs(start.x - end.x) <= EPSILON ||
          Math.abs(start.y - end.y) <= EPSILON,
        `${edge.id} must use orthogonal segments`,
      );
      return { edge, start, end };
    }),
  );
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function isEndpoint(point: LayoutPoint, segment: Segment): boolean {
  return (
    (near(point.x, segment.start.x) && near(point.y, segment.start.y)) ||
    (near(point.x, segment.end.x) && near(point.y, segment.end.y))
  );
}

function sharedOccurrence(left: LayoutEdge, right: LayoutEdge): boolean {
  const leftIds = new Set([left.sourceId, left.targetId]);
  return leftIds.has(right.sourceId) || leftIds.has(right.targetId);
}

function assertNoUnrelatedLineIntersections(result: LayoutResult): void {
  const allSegments = segments(result);
  const allowedEndpoint = (
    point: LayoutPoint,
    left: Segment,
    right: Segment,
  ): boolean =>
    isEndpoint(point, left) &&
    isEndpoint(point, right) &&
    sharedOccurrence(left.edge, right.edge);

  for (let leftIndex = 0; leftIndex < allSegments.length; leftIndex += 1) {
    const left = allSegments[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < allSegments.length; rightIndex += 1) {
      const right = allSegments[rightIndex]!;
      if (left.edge.id === right.edge.id) continue;
      if (
        left.edge.unionOccurrenceId &&
        left.edge.unionOccurrenceId === right.edge.unionOccurrenceId
      ) {
        continue;
      }

      const leftVertical = near(left.start.x, left.end.x);
      const rightVertical = near(right.start.x, right.end.x);
      if (leftVertical !== rightVertical) {
        const vertical = leftVertical ? left : right;
        const horizontal = leftVertical ? right : left;
        const point = { x: vertical.start.x, y: horizontal.start.y };
        const insideVertical =
          point.y >= Math.min(vertical.start.y, vertical.end.y) - EPSILON &&
          point.y <= Math.max(vertical.start.y, vertical.end.y) + EPSILON;
        const insideHorizontal =
          point.x >= Math.min(horizontal.start.x, horizontal.end.x) - EPSILON &&
          point.x <= Math.max(horizontal.start.x, horizontal.end.x) + EPSILON;
        if (insideVertical && insideHorizontal) {
          assert.ok(
            allowedEndpoint(point, left, right),
            `${left.edge.id} crosses unrelated ${right.edge.id} at ${JSON.stringify(point)}`,
          );
        }
        continue;
      }

      const sameLane = leftVertical
        ? near(left.start.x, right.start.x)
        : near(left.start.y, right.start.y);
      if (!sameLane) continue;
      const leftStart = leftVertical ? left.start.y : left.start.x;
      const leftEnd = leftVertical ? left.end.y : left.end.x;
      const rightStart = leftVertical ? right.start.y : right.start.x;
      const rightEnd = leftVertical ? right.end.y : right.end.x;
      const overlapStart = Math.max(
        Math.min(leftStart, leftEnd),
        Math.min(rightStart, rightEnd),
      );
      const overlapEnd = Math.min(
        Math.max(leftStart, leftEnd),
        Math.max(rightStart, rightEnd),
      );
      if (overlapEnd < overlapStart - EPSILON) continue;
      const point = leftVertical
        ? { x: left.start.x, y: (overlapStart + overlapEnd) / 2 }
        : { x: (overlapStart + overlapEnd) / 2, y: left.start.y };
      assert.ok(
        overlapEnd - overlapStart <= EPSILON && allowedEndpoint(point, left, right),
        `${left.edge.id} shares an unrelated lane with ${right.edge.id}`,
      );
    }
  }
}

function assertNoLineCrossesUnrelatedCard(result: LayoutResult): void {
  for (const segment of segments(result)) {
    const vertical = near(segment.start.x, segment.end.x);
    for (const node of result.nodes) {
      if (
        node.occurrenceId === segment.edge.sourceId ||
        node.occurrenceId === segment.edge.targetId
      ) {
        continue;
      }
      const crossesInterior = vertical
        ? segment.start.x > node.x + EPSILON &&
          segment.start.x < node.x + node.width - EPSILON &&
          Math.max(Math.min(segment.start.y, segment.end.y), node.y + EPSILON) <
            Math.min(Math.max(segment.start.y, segment.end.y), node.y + node.height - EPSILON)
        : segment.start.y > node.y + EPSILON &&
          segment.start.y < node.y + node.height - EPSILON &&
          Math.max(Math.min(segment.start.x, segment.end.x), node.x + EPSILON) <
            Math.min(Math.max(segment.start.x, segment.end.x), node.x + node.width - EPSILON);
      assert.equal(
        crossesInterior,
        false,
        `${segment.edge.id} crosses card ${node.occurrenceId}`,
      );
    }
  }
}

function assertOneBusPerFamily(result: LayoutResult): void {
  for (const union of result.unions.filter(candidate => candidate.childOccurrenceIds.length > 0)) {
    const buses = result.edges.filter(
      edge =>
        edge.kind === "siblings-bus" &&
        edge.unionOccurrenceId === union.occurrenceId,
    );
    const stems = result.edges.filter(
      edge =>
        edge.id.endsWith(":family-stem") &&
        edge.unionOccurrenceId === union.occurrenceId,
    );
    assert.equal(buses.length, 1, `${union.unionId} must have one children bus`);
    assert.equal(stems.length, 1, `${union.unionId} must have one family stem`);
    assert.equal(buses[0]!.points.length, 2);
    assert.ok(near(buses[0]!.points[0]!.y, buses[0]!.points[1]!.y));
  }
}

function assertDisjointChildIntervals(result: LayoutResult): void {
  const nodes = new Map(result.nodes.map(node => [node.occurrenceId, node]));
  const byGeneration = new Map<number, Array<{ id: string; left: number; right: number }>>();
  for (const union of result.unions) {
    const children = union.childOccurrenceIds.map(id => nodes.get(id)).filter(Boolean) as LayoutNode[];
    if (children.length === 0) continue;
    const entries = byGeneration.get(union.generation) ?? [];
    entries.push({
      id: union.unionId,
      left: Math.min(...children.map(node => node.x)),
      right: Math.max(...children.map(node => node.x + node.width)),
    });
    byGeneration.set(union.generation, entries);
  }
  for (const intervals of byGeneration.values()) {
    intervals.sort((left, right) => left.left - right.left || left.id.localeCompare(right.id));
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1]!;
      const current = intervals[index]!;
      assert.ok(
        previous.right <= current.left + EPSILON,
        `${previous.id} child interval overlaps ${current.id}`,
      );
    }
  }
}

function assertGeometryContract(result: LayoutResult): void {
  assertNoCardOverlaps(result);
  assertOneBusPerFamily(result);
  assertDisjointChildIntervals(result);
  assertNoUnrelatedLineIntersections(result);
  assertNoLineCrossesUnrelatedCard(result);
}

test("Stage 5 has a dedicated descendant forest engine and explicit production dispatch", () => {
  const descendantModuleUrl = new URL(
    "../src/features/family-tree-view/layout/layoutDescendantForest.ts",
    import.meta.url,
  );
  assert.ok(existsSync(descendantModuleUrl), "layoutDescendantForest.ts must exist");
  const descendantSource = readFileSync(descendantModuleUrl, "utf8");
  const familyGraphSource = readFileSync(
    new URL("../src/features/family-tree-view/layout/layoutFamilyGraph.ts", import.meta.url),
    "utf8",
  );
  const workerSource = readFileSync(
    new URL("../src/features/family-tree-view/worker/familyTreeLayout.worker.ts", import.meta.url),
    "utf8",
  );
  const taskSource = readFileSync(
    new URL("../src/features/family-tree-view/react/familyTreeLayoutTask.ts", import.meta.url),
    "utf8",
  );
  const dispatcherSource = `${familyGraphSource}\n${workerSource}\n${taskSource}`;
  const typesSource = readFileSync(
    new URL("../src/features/family-tree-view/types.ts", import.meta.url),
    "utf8",
  );
  const pageSource = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    descendantSource,
    /export\s+(?:function\s+layoutDescendantForest|const\s+layoutDescendantForest\s*=)/,
  );
  assert.match(
    typesSource,
    /layoutMode\??\s*:\s*(?:FamilyTreeLayoutMode|"family-graph"\s*\|\s*"descendant-forest"|"descendant-forest"\s*\|\s*"family-graph")/,
  );
  assert.match(
    dispatcherSource,
    /import\s*\{\s*layoutDescendantForest\s*\}\s*from\s*["'][^"']*layoutDescendantForest\.ts["']/,
  );
  assert.match(
    dispatcherSource,
    /layoutMode\s*===\s*["']descendant-forest["']/,
  );
  assert.match(dispatcherSource, /layoutDescendantForest/);
  assert.match(pageSource, /layoutMode\s*:/);
  assert.match(pageSource, /["']all-descendants["'][\s\S]{0,500}["']descendant-forest["']/);
});

test("Stage 5 progressive pages preserve anchors and move unaffected branches only outward", () => {
  const pageOne = runDescendantLayout(descendantGraph(false));
  assertGeometryContract(pageOne);
  const previousPositions = pageOne.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const pageTwo = runDescendantLayout(descendantGraph(true), previousPositions);
  assertGeometryContract(pageTwo);

  const rootBefore = nodeForPerson(pageOne, "root");
  const rootAfter = nodeForPerson(pageTwo, "root");
  assert.ok(near(rootBefore.x, rootAfter.x), "root/focus anchor moved horizontally");
  assert.ok(near(rootBefore.y, rootAfter.y), "root/focus anchor moved vertically");
  assert.ok(
    near(familyCenter(pageOne, "root-family"), familyCenter(pageTwo, "root-family")),
    "primary root family axis moved horizontally",
  );
  assert.ok(
    near(
      nodeForPerson(pageOne, "branch-middle").y,
      nodeForPerson(pageTwo, "branch-middle").y,
    ),
    "primary lineage changed generation row",
  );

  const leftBefore = familyCenter(pageOne, "left-family");
  const leftAfter = familyCenter(pageTwo, "left-family");
  const rightBefore = familyCenter(pageOne, "right-family");
  const rightAfter = familyCenter(pageTwo, "right-family");
  assert.ok(leftAfter <= leftBefore + EPSILON, "left unaffected branch moved inward");
  assert.ok(rightAfter >= rightBefore - EPSILON, "right unaffected branch moved inward");

  const widthOne = pageOne.bounds.right - pageOne.bounds.left;
  const widthTwo = pageTwo.bounds.right - pageTwo.bounds.left;
  const maximumNecessaryShift = Math.max(28, (widthTwo - widthOne) / 2 + 28);
  assert.ok(
    Math.abs(leftAfter - leftBefore) <= maximumNecessaryShift + EPSILON,
    "left branch moved farther than the newly required half-width",
  );
  assert.ok(
    Math.abs(rightAfter - rightBefore) <= maximumNecessaryShift + EPSILON,
    "right branch moved farther than the newly required half-width",
  );

  for (const familyPersonIds of [
    ["branch-left", "left-partner", "left-child"],
    ["branch-right", "right-partner", "right-child"],
  ]) {
    const deltas = familyPersonIds.map(personId => {
      const before = nodeForPerson(pageOne, personId);
      const after = nodeForPerson(pageTwo, personId);
      assert.ok(near(before.y, after.y), `${personId} changed generation row`);
      return after.x - before.x;
    });
    assert.ok(
      deltas.every(delta => near(delta, deltas[0]!)),
      `${familyPersonIds[0]} subtree must move as one rigid block`,
    );
  }

  assert.deepEqual(
    ["left-family", "middle-main-family", "right-family"]
      .map(unionId => ({ unionId, x: familyCenter(pageTwo, unionId) }))
      .sort((left, right) => left.x - right.x)
      .map(item => item.unionId),
    ["left-family", "middle-main-family", "right-family"],
    "incremental loading must not reorder existing branches",
  );
});

test("Stage 5 descendant forest is deterministic with retained positions", () => {
  const initial = runDescendantLayout(descendantGraph(false));
  const previousPositions = initial.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const first = runDescendantLayout(descendantGraph(true), previousPositions);
  const second = runDescendantLayout(descendantGraph(true), previousPositions);
  const projection = (result: LayoutResult) => ({
    nodes: result.nodes.map(node => [node.occurrenceId, node.x, node.y]),
    unions: result.unions.map(union => [union.occurrenceId, union.x, union.y]),
    edges: result.edges.map(edge => [
      edge.id,
      edge.kind,
      edge.points.map(point => [point.x, point.y]),
    ]),
  });
  assert.deepEqual(projection(first), projection(second));
});
