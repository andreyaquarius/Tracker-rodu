import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGraphIndex,
  comparePeopleByBirth,
} from "../src/features/family-tree-view/layout/graphIndex.ts";
import {
  layoutDirectAncestors,
  type DirectAncestorGridItem,
} from "../src/features/family-tree-view/layout/directAncestorLayout.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import { packLayer } from "../src/features/family-tree-view/layout/pavaPacking.ts";
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import type {
  FamilyGraphData,
  FamilyTreeLayoutOptions,
  LayoutResult,
  ParentChildRelation,
  ParentRelationshipKind,
  PreviousNodePosition,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

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

function run(
  graph: FamilyGraphData,
  options: Partial<FamilyTreeLayoutOptions> = {},
): LayoutResult {
  const ancestorDepth = options.ancestorDepth ?? 7;
  const descendantDepth = options.descendantDepth ?? 0;
  const collateralDepth = options.collateralDepth ?? 0;
  const layoutMode = options.layoutMode ?? (
    ancestorDepth === 0 && descendantDepth > 0 && collateralDepth === 0
      ? "descendant-forest"
      : "family-graph"
  );
  const input = {
    graph,
    options: {
      focusPersonId: options.focusPersonId ?? graph.persons[0]!.id,
      layoutMode,
      ancestorDepth,
      descendantDepth,
      collateralDepth,
      maxVisibleNodes: options.maxVisibleNodes ?? 400,
      showUnknownParentPlaceholders:
        options.showUnknownParentPlaceholders ?? false,
      ...(options.showAllParentSets === undefined
        ? {}
        : { showAllParentSets: options.showAllParentSets }),
      ...(options.collapsedPersonIds === undefined
        ? {}
        : { collapsedPersonIds: options.collapsedPersonIds }),
      ...(options.primaryLineagePersonIds === undefined
        ? {}
        : { primaryLineagePersonIds: options.primaryLineagePersonIds }),
      ...(options.lineageTargetPersonId === undefined
        ? {}
        : { lineageTargetPersonId: options.lineageTargetPersonId }),
      ...(options.lineageGroupDepth === undefined
        ? {}
        : { lineageGroupDepth: options.lineageGroupDepth }),
      ...(options.previousPositions === undefined
        ? {}
        : { previousPositions: options.previousPositions }),
    },
  };
  return layoutMode === "descendant-forest"
    ? layoutDescendantForest(input)
    : layoutFamilyGraph(input);
}

function assertNoCardOverlap(result: LayoutResult, context = "layout"): void {
  for (let leftIndex = 0; leftIndex < result.nodes.length; leftIndex += 1) {
    const left = result.nodes[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < result.nodes.length;
      rightIndex += 1
    ) {
      const right = result.nodes[rightIndex]!;
      const overlap =
        left.x < right.x + right.width &&
        left.x + left.width > right.x &&
        left.y < right.y + right.height &&
        left.y + left.height > right.y;
      assert.equal(
        overlap,
        false,
        `${context}: ${left.occurrenceId} overlaps ${right.occurrenceId}`,
      );
    }
  }
}

function assertFamilyRoutesConnected(
  result: LayoutResult,
  context = "family routes",
): void {
  const epsilon = 0.001;
  const onHorizontalBus = (
    point: { x: number; y: number },
    bus: LayoutResult["edges"][number],
  ): boolean => {
    const [start, end] = bus.points;
    if (!start || !end) return false;
    return (
      Math.abs(point.y - start.y) <= epsilon &&
      point.x >= Math.min(start.x, end.x) - epsilon &&
      point.x <= Math.max(start.x, end.x) + epsilon
    );
  };
  const onPolyline = (
    point: { x: number; y: number },
    edge: LayoutResult["edges"][number],
  ): boolean => edge.points.slice(1).some((end, index) => {
    const start = edge.points[index]!;
    if (Math.abs(start.x - end.x) <= epsilon) {
      return (
        Math.abs(point.x - start.x) <= epsilon &&
        point.y >= Math.min(start.y, end.y) - epsilon &&
        point.y <= Math.max(start.y, end.y) + epsilon
      );
    }
    if (Math.abs(start.y - end.y) <= epsilon) {
      return (
        Math.abs(point.y - start.y) <= epsilon &&
        point.x >= Math.min(start.x, end.x) - epsilon &&
        point.x <= Math.max(start.x, end.x) + epsilon
      );
    }
    return false;
  });

  for (const stem of result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  )) {
    const familyId = stem.id.slice(0, -":family-stem".length);
    const bus = result.edges.find(edge => edge.id === `${familyId}:siblings`);
    assert.ok(bus, `${context}: missing bus for ${familyId}`);
    assert.ok(
      onHorizontalBus(stem.points.at(-1)!, bus),
      `${context}: family stem misses bus for ${familyId}`,
    );
    for (const child of result.edges.filter(edge =>
      edge.id.startsWith(`${familyId}:child:`),
    )) {
      assert.ok(
        onHorizontalBus(child.points[0]!, bus),
        `${context}: child stem misses bus for ${familyId}`,
      );
    }
    const partnership = result.edges.find(
      edge =>
        edge.unionOccurrenceId === stem.unionOccurrenceId &&
        (edge.kind === "partnership" ||
          edge.kind === "separated-partnership"),
    );
    if (partnership) {
      assert.ok(
        onPolyline(stem.points[0]!, partnership),
        `${context}: family stem misses partnership for ${familyId}`,
      );
    }
  }
}

/**
 * Different family routes may meet only at a shared card endpoint. They must
 * never cross, form an unrelated T-junction, or reuse a positive-length lane.
 * Multiple partnerships use distinct parallel side-to-side lines. The caller
 * supplies domain union ids so merged/non-structural layout edges outside the
 * scenario do not create false positives.
 */
function assertNoUnrelatedFamilyRouteIntersections(
  result: LayoutResult,
  unionIds: readonly string[],
  context = "family routes",
): void {
  const includedUnionIds = new Set(unionIds);
  const familyIdByOccurrenceId = new Map(
    result.unions
      .filter(union => includedUnionIds.has(union.unionId))
      .map(union => [union.occurrenceId, union.unionId]),
  );
  type Edge = LayoutResult["edges"][number];
  type Point = Edge["points"][number];
  type Segment = {
    edge: Edge;
    familyId: string;
    start: Point;
    end: Point;
  };
  const epsilon = 0.001;
  const near = (left: number, right: number): boolean =>
    Math.abs(left - right) <= epsilon;
  const pointEquals = (left: Point, right: Point): boolean =>
    near(left.x, right.x) && near(left.y, right.y);
  const pointIsEndpoint = (point: Point, segment: Segment): boolean =>
    pointEquals(point, segment.start) || pointEquals(point, segment.end);
  const sharedCardEndpoint = (left: Segment, right: Segment): boolean => {
    const leftIds = new Set([left.edge.sourceId, left.edge.targetId]);
    return [right.edge.sourceId, right.edge.targetId].some(id =>
      leftIds.has(id),
    );
  };
  const segments: Segment[] = result.edges.flatMap(edge => {
    const familyId = familyIdByOccurrenceId.get(edge.unionOccurrenceId);
    if (!familyId) return [];
    return edge.points.slice(1).flatMap((end, index) => {
      const start = edge.points[index]!;
      if (pointEquals(start, end)) return [];
      assert.ok(
        near(start.x, end.x) || near(start.y, end.y),
        `${context}: expected orthogonal segment for ${edge.id}`,
      );
      return [{ edge, familyId, start, end }];
    });
  });
  const between = (value: number, start: number, end: number): boolean =>
    value >= Math.min(start, end) - epsilon &&
    value <= Math.max(start, end) + epsilon;
  const assertPointAllowed = (
    point: Point,
    left: Segment,
    right: Segment,
  ): void => {
    const allowed =
      pointIsEndpoint(point, left) &&
      pointIsEndpoint(point, right) &&
      sharedCardEndpoint(left, right);
    assert.ok(
      allowed,
      `${context}: ${left.familyId}/${left.edge.id} intersects ` +
        `${right.familyId}/${right.edge.id} at (${point.x}, ${point.y})`,
    );
  };

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < segments.length;
      rightIndex += 1
    ) {
      const right = segments[rightIndex]!;
      if (left.familyId === right.familyId) continue;
      const leftVertical = near(left.start.x, left.end.x);
      const rightVertical = near(right.start.x, right.end.x);
      if (leftVertical !== rightVertical) {
        const vertical = leftVertical ? left : right;
        const horizontal = leftVertical ? right : left;
        const point = { x: vertical.start.x, y: horizontal.start.y };
        if (
          between(point.x, horizontal.start.x, horizontal.end.x) &&
          between(point.y, vertical.start.y, vertical.end.y)
        ) {
          assertPointAllowed(point, left, right);
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
      if (overlapEnd < overlapStart - epsilon) continue;
      assert.ok(
        overlapEnd - overlapStart <= epsilon,
        `${context}: ${left.familyId}/${left.edge.id} overlaps ` +
          `${right.familyId}/${right.edge.id} on one lane`,
      );
      const point = leftVertical
        ? { x: left.start.x, y: (overlapStart + overlapEnd) / 2 }
        : { x: (overlapStart + overlapEnd) / 2, y: left.start.y };
      assertPointAllowed(point, left, right);
    }
  }
}

interface SidePartnerLine {
  readonly familyUnionId: string;
  readonly side: "left" | "right";
  readonly partnerCenter: number;
  readonly distanceFromHub: number;
  readonly y: number;
}

function assertParallelSidePartnerLines(
  result: LayoutResult,
  hubPersonId: string,
  familyUnionIds: readonly string[],
  context: string,
): void {
  const epsilon = 0.001;
  const hubCards = result.nodes.filter(node => node.personId === hubPersonId);
  assert.equal(hubCards.length, 1, `${context}: one canonical hub card`);
  const hub = hubCards[0]!;
  const hubCenter = hub.x + hub.width / 2;
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  const rails = familyUnionIds.flatMap((familyUnionId): SidePartnerLine[] => {
    const union = result.unions.find(
      candidate => candidate.unionId === familyUnionId,
    );
    assert.ok(union, `${context}: missing ${familyUnionId}`);
    const partnership = result.edges.find(
      edge =>
        edge.unionOccurrenceId === union.occurrenceId &&
        (edge.kind === "partnership" ||
          edge.kind === "separated-partnership"),
    );
    assert.ok(partnership, `${context}: missing ${familyUnionId} partnership`);
    if (partnership.points.length !== 2) return [];

    const horizontalSegments = partnership.points
      .slice(1)
      .flatMap((end, index) => {
        const start = partnership.points[index]!;
        return Math.abs(start.y - end.y) <= epsilon &&
          Math.abs(start.x - end.x) > epsilon
          ? [{ start, end }]
          : [];
      });
    assert.equal(
      horizontalSegments.length,
      1,
      `${context}: ${familyUnionId} must have one horizontal side line`,
    );
    const partner = union.memberOccurrenceIds
      .map(occurrenceId => nodesByOccurrenceId.get(occurrenceId))
      .find(node => node?.personId !== hubPersonId);
    assert.ok(partner, `${context}: missing ${familyUnionId} side partner`);
    const partnerCenter = partner.x + partner.width / 2;
    assert.ok(
      Math.abs(partnerCenter - hubCenter) > epsilon,
      `${context}: ${familyUnionId} partner must sit beside the hub`,
    );
    const rail = horizontalSegments[0]!;
    const side = partnerCenter < hubCenter ? "left" : "right";
    const expectedHubPortX = side === "left" ? hub.x : hub.x + hub.width;
    const expectedPartnerPortX = side === "left"
      ? partner.x + partner.width
      : partner.x;
    assert.ok(
      rail.start.y > Math.max(hub.y, partner.y) + epsilon &&
        rail.start.y <
          Math.min(hub.y + hub.height, partner.y + partner.height) - epsilon,
      `${context}: ${familyUnionId} must run through side ports inside the card row`,
    );
    assert.ok(
      partnership.points.some(point =>
        Math.abs(point.x - expectedHubPortX) <= epsilon,
      ),
      `${context}: ${familyUnionId} must leave the hub through its ${side} side`,
    );
    assert.ok(
      partnership.points.some(point =>
        Math.abs(point.x - expectedPartnerPortX) <= epsilon,
      ),
      `${context}: ${familyUnionId} must enter the partner through the facing side`,
    );
    return [{
      familyUnionId,
      side,
      partnerCenter,
      distanceFromHub: Math.abs(partnerCenter - hubCenter),
      y: rail.start.y,
    }];
  });

  const left = rails
    .filter(rail => rail.side === "left")
    .sort((a, b) => a.distanceFromHub - b.distanceFromHub);
  const right = rails
    .filter(rail => rail.side === "right")
    .sort((a, b) => a.distanceFromHub - b.distanceFromHub);
  assert.ok(left.length > 0, `${context}: missing a left side-partner line`);
  assert.ok(right.length > 0, `${context}: missing a right side-partner line`);
  for (const sameSideRails of [left, right]) {
    for (let leftIndex = 0; leftIndex < sameSideRails.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < sameSideRails.length;
        rightIndex += 1
      ) {
        assert.ok(
          Math.abs(
            sameSideRails[leftIndex]!.y - sameSideRails[rightIndex]!.y,
          ) > epsilon,
          `${context}: ${sameSideRails[leftIndex]!.familyUnionId} and ` +
            `${sameSideRails[rightIndex]!.familyUnionId} need distinct parallel ` +
            `${sameSideRails[leftIndex]!.side} side ports`,
        );
      }
    }
    for (let index = 1; index < sameSideRails.length; index += 1) {
      assert.ok(
        sameSideRails[index]!.y < sameSideRails[index - 1]!.y - epsilon,
        `${context}: farther ${sameSideRails[index]!.side} partners must use ` +
          `the next parallel line above the nearer partner`,
      );
    }
  }
}

function parentRelations(
  parentIds: readonly string[],
  childId: string,
  unionId: string,
): ParentChildRelation[] {
  return parentIds.map((parentId, index) => ({
    id: `${unionId}-${parentId}-${childId}`,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role: index === 0 ? "father" : "mother",
  }));
}

function personIdsByX(
  result: LayoutResult,
  personIds: readonly string[],
): string[] {
  const included = new Set(personIds);
  return result.nodes
    .filter(node => node.personId && included.has(node.personId))
    .sort(
      (left, right) =>
        left.x + left.width / 2 - (right.x + right.width / 2) ||
        left.occurrenceId.localeCompare(right.occurrenceId),
    )
    .map(node => node.personId!);
}

test("direct ancestor grid scales the same midpoint rule through four, five and seven generations", () => {
  for (const depth of [4, 5, 7]) {
    const items = [
      { occurrenceId: "root", width: 156, path: [] as number[] },
    ];
    for (let generation = 1; generation <= depth; generation += 1) {
      for (let index = 0; index < 2 ** generation; index += 1) {
        const path = index
          .toString(2)
          .padStart(generation, "0")
          .split("")
          .map(Number);
        items.push({
          occurrenceId: path.join(""),
          width: 156,
          path,
        });
      }
    }
    const layout = layoutDirectAncestors(items, { sectorGap: 12 });
    assert.ok(layout, `missing direct grid for depth ${depth}`);
    assert.equal(layout.centerByOccurrenceId.size, 2 ** (depth + 1) - 1);
    for (const item of items.filter(item => item.path.length < depth)) {
      const id = item.path.length === 0 ? "root" : item.path.join("");
      const paternalId = `${item.path.join("")}0`;
      const maternalId = `${item.path.join("")}1`;
      const childCenter = layout.centerByOccurrenceId.get(id)!;
      const paternalCenter = layout.centerByOccurrenceId.get(paternalId)!;
      const maternalCenter = layout.centerByOccurrenceId.get(maternalId)!;
      assert.ok(
        Math.abs(childCenter - (paternalCenter + maternalCenter) / 2) <
          0.001,
        `depth ${depth}, path ${item.path.join("") || "root"}`,
      );
    }
  }
});

test("direct ancestor contours preserve the established pure-pedigree coordinates", () => {
  const items: DirectAncestorGridItem[] = [
    { occurrenceId: "root", width: 100, path: [] },
    { occurrenceId: "paternal", width: 100, path: [0] },
    { occurrenceId: "maternal", width: 100, path: [1] },
    { occurrenceId: "paternal-paternal", width: 100, path: [0, 0] },
    { occurrenceId: "paternal-maternal", width: 100, path: [0, 1] },
    { occurrenceId: "maternal-paternal", width: 100, path: [1, 0] },
    { occurrenceId: "maternal-maternal", width: 100, path: [1, 1] },
  ];
  const baseline = layoutDirectAncestors(items, { sectorGap: 20 });
  const withDirectCardContours = layoutDirectAncestors(
    items.map(item => ({
      ...item,
      contourByGeneration: new Map([
        [
          item.path.length,
          { left: -item.width / 2, right: item.width / 2 },
        ],
      ]),
    })),
    { sectorGap: 20 },
  );

  assert.ok(baseline);
  assert.ok(withDirectCardContours);
  assert.deepEqual(
    [...withDirectCardContours.centerByOccurrenceId].sort(),
    [...baseline.centerByOccurrenceId].sort(),
  );
  assert.equal(baseline.centerByOccurrenceId.get("root"), 0);
  assert.equal(baseline.centerByOccurrenceId.get("paternal"), -120);
  assert.equal(baseline.centerByOccurrenceId.get("maternal"), 120);
  assert.equal(
    baseline.centerByOccurrenceId.get("paternal-paternal"),
    -180,
  );
  assert.equal(
    baseline.centerByOccurrenceId.get("paternal-maternal"),
    -60,
  );
  assert.equal(
    baseline.centerByOccurrenceId.get("maternal-paternal"),
    60,
  );
  assert.equal(
    baseline.centerByOccurrenceId.get("maternal-maternal"),
    180,
  );
});

function collateralContourItems(): DirectAncestorGridItem[] {
  return [
    {
      occurrenceId: "root",
      width: 100,
      path: [],
      contourByGeneration: new Map([
        [0, { left: -50, right: 50 }],
      ]),
    },
    {
      occurrenceId: "paternal",
      width: 100,
      leftExtent: 170,
      rightExtent: 50,
      path: [0],
      contourByGeneration: new Map([
        [0, { left: -170, right: 50 }],
        [1, { left: -50, right: 50 }],
      ]),
    },
    {
      occurrenceId: "maternal",
      width: 100,
      leftExtent: 50,
      rightExtent: 170,
      path: [1],
      contourByGeneration: new Map([
        [0, { left: -50, right: 170 }],
        [1, { left: -50, right: 50 }],
      ]),
    },
  ];
}

test("a collateral contour on the child's generation pushes both parent sectors outward symmetrically", () => {
  const withoutContours = layoutDirectAncestors(
    collateralContourItems().map(
      ({ contourByGeneration: _contourByGeneration, ...item }) => item,
    ),
    { sectorGap: 20 },
  );
  const withContours = layoutDirectAncestors(collateralContourItems(), {
    sectorGap: 20,
  });

  assert.ok(withoutContours);
  assert.ok(withContours);
  assert.equal(withoutContours.centerByOccurrenceId.get("paternal"), -60);
  assert.equal(withoutContours.centerByOccurrenceId.get("maternal"), 60);
  assert.equal(withContours.centerByOccurrenceId.get("root"), 0);
  assert.equal(withContours.centerByOccurrenceId.get("paternal"), -120);
  assert.equal(withContours.centerByOccurrenceId.get("maternal"), 120);
  assert.equal(
    withContours.centerByOccurrenceId.get("paternal"),
    -withContours.centerByOccurrenceId.get("maternal")!,
  );
});

test("a single maternal contour keeps the known mother on the right", () => {
  const layout = layoutDirectAncestors(
    [
      {
        occurrenceId: "root",
        width: 100,
        path: [],
        contourByGeneration: new Map([[0, { left: -50, right: 50 }]]),
      },
      {
        occurrenceId: "mother",
        width: 100,
        path: [1],
        contourByGeneration: new Map([
          [0, { left: -50, right: 120 }],
          [1, { left: -50, right: 50 }],
        ]),
      },
    ],
    { sectorGap: 20 },
  );

  assert.ok(layout);
  assert.equal(layout.centerByOccurrenceId.get("root"), 0);
  assert.equal(layout.centerByOccurrenceId.get("mother"), 120);
});

test("direct ancestor contour packing is deterministic and keeps every shared row disjoint", () => {
  const items = collateralContourItems();
  const layouts = [
    items,
    [...items].reverse(),
    [items[2]!, items[0]!, items[1]!],
  ].map(permutation =>
    layoutDirectAncestors(permutation, { sectorGap: 20 }),
  );
  const [reference, ...rest] = layouts;
  assert.ok(reference);
  for (const layout of rest) {
    assert.ok(layout);
    assert.deepEqual(
      [...layout.centerByOccurrenceId].sort(),
      [...reference.centerByOccurrenceId].sort(),
    );
    assert.equal(layout.left, reference.left);
    assert.equal(layout.right, reference.right);
  }

  const intervalsByGeneration = new Map<
    number,
    { occurrenceId: string; left: number; right: number }[]
  >();
  for (const item of items) {
    const center = reference.centerByOccurrenceId.get(item.occurrenceId)!;
    for (const [generation, contour] of item.contourByGeneration ?? []) {
      const interval = {
        occurrenceId: item.occurrenceId,
        left: center + contour.left,
        right: center + contour.right,
      };
      const row = intervalsByGeneration.get(generation);
      if (row) row.push(interval);
      else intervalsByGeneration.set(generation, [interval]);
    }
  }
  for (const [generation, intervals] of intervalsByGeneration) {
    intervals.sort(
      (left, right) =>
        left.left - right.left ||
        left.occurrenceId.localeCompare(right.occurrenceId),
    );
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1]!;
      const current = intervals[index]!;
      assert.ok(
        previous.right + 20 <= current.left,
        `generation ${generation}: ${previous.occurrenceId} overlaps ${current.occurrenceId}`,
      );
    }
  }
});

test("layout defaults to seven direct ancestor generations only", () => {
  const ancestorIds = Array.from(
    { length: 8 },
    (_, index) => `ancestor-${index + 1}`,
  );
  const lineageUnions = ancestorIds.map((ancestorId, index) => ({
    id: `lineage-${index + 1}`,
    kind: "parent-set" as const,
    memberIds: [ancestorId],
  }));
  const lineageRelations = ancestorIds.map((ancestorId, index) => ({
    id: `lineage-relation-${index + 1}`,
    parentId: ancestorId,
    childId: index === 0 ? "focus" : ancestorIds[index - 1]!,
    unionId: `lineage-${index + 1}`,
    kind: "biological" as const,
    role: "parent" as const,
  }));
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      ...ancestorIds.map(id => person(id)),
      person("descendant"),
      person("sibling"),
    ],
    unions: [
      ...lineageUnions,
      {
        id: "focus-descendants",
        kind: "parent-set",
        memberIds: ["focus"],
      },
    ],
    parentChildRelations: [
      ...lineageRelations,
      {
        id: "focus-descendant",
        parentId: "focus",
        childId: "descendant",
        unionId: "focus-descendants",
        kind: "biological",
        role: "parent",
      },
      {
        id: "focus-sibling",
        parentId: "ancestor-1",
        childId: "sibling",
        unionId: "lineage-1",
        kind: "biological",
        role: "parent",
      },
    ],
  };

  const result = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "focus",
      showUnknownParentPlaceholders: false,
    },
  });
  const renderedPeople = result.nodes
    .filter(node => node.kind === "person")
    .map(node => node.personId)
    .sort();

  assert.deepEqual(
    renderedPeople,
    ["focus", ...ancestorIds.slice(0, 7)].sort(),
  );
  assert.equal(renderedPeople.includes("ancestor-8"), false);
  assert.equal(renderedPeople.includes("descendant"), false);
  assert.equal(renderedPeople.includes("sibling"), false);
});

test("layout groups fourteen ordered children under one union without overlap", () => {
  const children = Array.from({ length: 14 }, (_, index) =>
    person(
      `child-${String(index + 1).padStart(2, "0")}`,
      "unknown",
      String(2000 + index),
    ),
  );
  const graph: FamilyGraphData = {
    persons: [person("father", "male"), person("mother", "female"), ...children],
    unions: [
      {
        id: "family",
        kind: "partnership",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(["father", "mother"], child.id, "family"),
    ),
  };

  const result = run(graph, {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 0,
  });
  const childNodes = result.nodes.filter(node =>
    node.personId?.startsWith("child-"),
  );

  assert.equal(
    result.unions.filter(union => union.unionId === "family").length,
    1,
  );
  assert.equal(childNodes.length, 14);
  assert.ok(childNodes.every(node => node.generation === -1));
  assertNoCardOverlap(result, "fourteen children");
});

test("siblings are laid out oldest to youngest with undated children last", () => {
  const children = [
    { ...person("child-a", "unknown", "1805-04-01"), displayOrder: "02" },
    { ...person("child-f", "unknown", "1769-11-30"), displayOrder: "06" },
    {
      ...person("child-c", "unknown", "1790-12-31"),
      birth: { sort: "1790", display: "1790-12-31" },
      displayOrder: "03",
    },
    { ...person("child-e", "unknown", "1783"), displayOrder: "05" },
    { ...person("child-b"), displayOrder: "01" },
    {
      ...person("child-d", "unknown", "1790-02-01"),
      birth: { sort: "1790", display: "1790-02-01" },
      displayOrder: "04",
    },
  ];
  const familyGroupId = "chronological-family";
  const graph: FamilyGraphData = {
    persons: [person("father", "male"), person("mother", "female"), ...children],
    unions: children.map(child => ({
      id: `parent-set:${child.id}`,
      kind: "parent-set" as const,
      memberIds: ["father", "mother"],
      familyGroupId,
      displayOrder: child.displayOrder,
    })),
    parentChildRelations: children.flatMap(child =>
      parentRelations(
        ["father", "mother"],
        child.id,
        `parent-set:${child.id}`,
      ).map(relation => ({
        ...relation,
        displayOrder: child.displayOrder,
      })),
    ),
  };
  const reversed: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions]
      .reverse()
      .map(union => ({ ...union, memberIds: [...union.memberIds].reverse() })),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  const options = {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 0,
    showAllParentSets: true,
  } as const;
  const childIds = new Set(children.map(child => child.id));
  const childOrder = (result: LayoutResult): string[] =>
    result.nodes
      .filter(node => node.personId && childIds.has(node.personId))
      .sort(
        (left, right) =>
          left.x - right.x ||
          left.occurrenceId.localeCompare(right.occurrenceId),
      )
      .map(node => node.personId!);
  const expectedOrder = [
    "child-f",
    "child-e",
    "child-d",
    "child-c",
    "child-a",
    "child-b",
  ];

  const result = run(graph, options);
  const reversedResult = run(reversed, options);

  assert.equal(
    result.edges.filter(edge => edge.kind === "siblings-bus").length,
    1,
  );
  assert.deepEqual(childOrder(result), expectedOrder);
  assert.deepEqual(childOrder(reversedResult), expectedOrder);
  assert.deepEqual(projectLayout(reversedResult), projectLayout(result));
});

test("birth ordering refines a canonical year but never replaces it with a conflicting display", () => {
  const canonical1800: TreePerson = {
    ...person("canonical-1800"),
    birth: { sort: "1800", display: "1700-01-01" },
  };
  const canonical1750 = person("canonical-1750", "unknown", "1750");
  const february1790: TreePerson = {
    ...person("february-1790"),
    birth: { sort: "1790", display: "1790-02-01" },
  };
  const december1790: TreePerson = {
    ...person("december-1790"),
    birth: { sort: "1790", display: "1790-12-01" },
  };

  assert.ok(comparePeopleByBirth(canonical1750, canonical1800) < 0);
  assert.ok(comparePeopleByBirth(february1790, december1790) < 0);
});

test("a middle-born focus remains between older and younger siblings", () => {
  const children = [
    {
      ...person("middle-focus", "unknown", "1800-06-15"),
      displayOrder: "02",
    },
    { ...person("younger-sibling", "unknown", "1810"), displayOrder: "01" },
    { ...person("older-sibling", "unknown", "1790"), displayOrder: "03" },
  ];
  const unionId = "focus-sibling-parent-set";
  const graph: FamilyGraphData = {
    persons: [
      children[0]!,
      children[1]!,
      person("father", "male"),
      children[2]!,
      person("mother", "female"),
    ],
    unions: [
      {
        id: unionId,
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(["father", "mother"], child.id, unionId).map(
        relation => ({ ...relation, displayOrder: child.displayOrder }),
      ),
    ),
  };

  const result = run(graph, {
    focusPersonId: "middle-focus",
    ancestorDepth: 1,
    descendantDepth: 0,
    collateralDepth: 1,
    showAllParentSets: true,
  });

  assert.deepEqual(
    personIdsByX(result, children.map(child => child.id)),
    ["older-sibling", "middle-focus", "younger-sibling"],
  );
});

test("direct ancestor side branches remain chronological after pedigree grid placement", () => {
  const father = {
    ...person("father", "male", "1970"),
    displayOrder: "02",
  };
  const mother = {
    ...person("mother", "female", "1972"),
    displayOrder: "02",
  };
  const paternalChildren = [
    father,
    {
      ...person("paternal-younger", "unknown", "1980"),
      displayOrder: "01",
    },
    {
      ...person("paternal-older", "unknown", "1960"),
      displayOrder: "03",
    },
  ];
  const maternalChildren = [
    mother,
    {
      ...person("maternal-younger", "unknown", "1982"),
      displayOrder: "01",
    },
    {
      ...person("maternal-older", "unknown", "1962"),
      displayOrder: "03",
    },
  ];
  const orderedRelations = (
    parentIds: readonly string[],
    child: (typeof paternalChildren)[number],
    unionId: string,
  ): ParentChildRelation[] =>
    parentRelations(parentIds, child.id, unionId).map(relation => ({
      ...relation,
      displayOrder: child.displayOrder,
    }));
  const graph: FamilyGraphData = {
    persons: [
      person("focus", "unknown", "2000"),
      maternalChildren[1]!,
      father,
      person("paternal-grandmother", "female"),
      paternalChildren[1]!,
      mother,
      person("maternal-grandfather", "male"),
      paternalChildren[2]!,
      person("paternal-grandfather", "male"),
      maternalChildren[2]!,
      person("maternal-grandmother", "female"),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "paternal-grandparents",
        kind: "parent-set",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "maternal-grandparents",
        kind: "parent-set",
        memberIds: ["maternal-grandfather", "maternal-grandmother"],
      },
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      ...paternalChildren.flatMap(child =>
        orderedRelations(
          ["paternal-grandfather", "paternal-grandmother"],
          child,
          "paternal-grandparents",
        ),
      ),
      ...maternalChildren.flatMap(child =>
        orderedRelations(
          ["maternal-grandfather", "maternal-grandmother"],
          child,
          "maternal-grandparents",
        ),
      ),
    ],
  };

  const result = run(graph, {
    focusPersonId: "focus",
    ancestorDepth: 2,
    descendantDepth: 0,
    collateralDepth: 1,
    showAllParentSets: true,
    lineageGroupDepth: 2,
  });

  assert.deepEqual(
    {
      paternal: personIdsByX(
        result,
        paternalChildren.map(child => child.id),
      ),
      maternal: personIdsByX(
        result,
        maternalChildren.map(child => child.id),
      ),
    },
    {
      paternal: ["paternal-older", "father", "paternal-younger"],
      maternal: ["maternal-older", "mother", "maternal-younger"],
    },
  );
  const lineageRole = (personId: string) =>
    result.nodes.find(node => node.personId === personId)?.lineageRole;
  assert.equal(lineageRole("focus"), "focus");
  assert.equal(lineageRole("father"), "direct-ancestor");
  assert.equal(lineageRole("mother"), "direct-ancestor");
  assert.equal(lineageRole("paternal-grandfather"), "direct-ancestor");
  assert.equal(lineageRole("paternal-grandmother"), "direct-ancestor");
  assert.equal(lineageRole("maternal-grandfather"), "direct-ancestor");
  assert.equal(lineageRole("maternal-grandmother"), "direct-ancestor");
  assert.equal(lineageRole("paternal-older"), undefined);
  assert.equal(lineageRole("paternal-younger"), undefined);
  assert.equal(lineageRole("maternal-older"), undefined);
  assert.equal(lineageRole("maternal-younger"), undefined);
  const lineageGroup = (personId: string) =>
    result.nodes.find(node => node.personId === personId)?.lineageGroup;
  assert.equal(lineageGroup("focus"), undefined);
  assert.equal(lineageGroup("father"), undefined);
  assert.equal(lineageGroup("mother"), undefined);
  assert.equal(lineageGroup("paternal-grandfather"), 0);
  assert.equal(lineageGroup("paternal-grandmother"), 1);
  assert.equal(lineageGroup("maternal-grandfather"), 2);
  assert.equal(lineageGroup("maternal-grandmother"), 3);
  assertNoCardOverlap(result, "chronological direct ancestor side branches");
});

test("partner families stay separate while each child row is chronological", () => {
  const children = [
    {
      familyGroupId: "family-a",
      partnerId: "partner-a",
      person: {
        ...person("family-a-younger", "unknown", "1900"),
        displayOrder: "03",
      },
    },
    {
      familyGroupId: "family-b",
      partnerId: "partner-b",
      person: {
        ...person("family-b-younger", "unknown", "1800"),
        displayOrder: "04",
      },
    },
    {
      familyGroupId: "family-a",
      partnerId: "partner-a",
      person: {
        ...person("family-a-older", "unknown", "1700"),
        displayOrder: "01",
      },
    },
    {
      familyGroupId: "family-b",
      partnerId: "partner-b",
      person: {
        ...person("family-b-older", "unknown", "1750"),
        displayOrder: "02",
      },
    },
  ];
  const graph: FamilyGraphData = {
    persons: [
      person("shared-parent", "male"),
      person("partner-b", "female"),
      ...children.map(child => child.person),
      person("partner-a", "female"),
    ],
    unions: [
      {
        id: "partnership:family-a",
        kind: "partnership",
        memberIds: ["shared-parent", "partner-a"],
        familyGroupId: "leaked-family-group",
        displayOrder: "00-a",
      },
      {
        id: "partnership:family-b",
        kind: "partnership",
        memberIds: ["shared-parent", "partner-b"],
        familyGroupId: "leaked-family-group",
        displayOrder: "00-b",
      },
      ...children.map(child => ({
        id: `parent-set:${child.person.id}`,
        kind: "parent-set" as const,
        memberIds: ["shared-parent", child.partnerId],
        familyGroupId: "leaked-family-group",
        displayOrder: child.person.displayOrder,
      })),
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(
        ["shared-parent", child.partnerId],
        child.person.id,
        `parent-set:${child.person.id}`,
      ).map(relation => ({
        ...relation,
        displayOrder: child.person.displayOrder,
      })),
    ),
  };

  const result = run(graph, {
    focusPersonId: "shared-parent",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
    showAllParentSets: true,
  });
  const familyAIds = ["family-a-older", "family-a-younger"];
  const familyBIds = ["family-b-older", "family-b-younger"];
  const allChildIds = [...familyAIds, ...familyBIds];

  assert.equal(
    result.edges.filter(edge => edge.kind === "siblings-bus").length,
    2,
  );
  assert.deepEqual(personIdsByX(result, familyAIds), familyAIds);
  assert.deepEqual(personIdsByX(result, familyBIds), familyBIds);
  const familyASet = new Set(familyAIds);
  const familySequence = personIdsByX(result, allChildIds)
    .map(personId => familyASet.has(personId) ? "a" : "b")
    .join("");
  assert.ok(
    familySequence === "aabb" || familySequence === "bbaa",
    `children from separate partner families must not interleave: ${familySequence}`,
  );
});

test("overlapping parent sets share one child card and preserve both birth precedences", () => {
  const childA = {
    ...person("overlap-a", "unknown", "1800"),
    displayOrder: "02",
  };
  const childB = {
    ...person("overlap-b", "unknown", "1700"),
    displayOrder: "03",
  };
  const childC = {
    ...person("overlap-c", "unknown", "1900"),
    displayOrder: "01",
  };
  const parentSets = [
    {
      id: "parent-set:f1-c",
      familyGroupId: "overlap-family-1",
      memberIds: ["shared-parent", "partner-1"],
      childId: childC.id,
      displayOrder: "01",
    },
    {
      id: "parent-set:f2-c",
      familyGroupId: "overlap-family-2",
      memberIds: ["shared-parent", "partner-2"],
      childId: childC.id,
      displayOrder: "02",
    },
    {
      id: "parent-set:f1-a",
      familyGroupId: "overlap-family-1",
      memberIds: ["shared-parent", "partner-1"],
      childId: childA.id,
      displayOrder: "03",
    },
    {
      id: "parent-set:f2-b",
      familyGroupId: "overlap-family-2",
      memberIds: ["shared-parent", "partner-2"],
      childId: childB.id,
      displayOrder: "04",
    },
  ] as const;
  const graph: FamilyGraphData = {
    persons: [
      childC,
      person("partner-2", "female"),
      childA,
      person("shared-parent", "male"),
      childB,
      person("partner-1", "female"),
    ],
    unions: [
      {
        id: "partnership:overlap-family-1",
        kind: "partnership",
        memberIds: ["shared-parent", "partner-1"],
        familyGroupId: "overlap-family-1",
        displayOrder: "00-a",
      },
      {
        id: "partnership:overlap-family-2",
        kind: "partnership",
        memberIds: ["shared-parent", "partner-2"],
        familyGroupId: "overlap-family-2",
        displayOrder: "00-b",
      },
      ...parentSets.map(parentSet => ({
        id: parentSet.id,
        kind: "parent-set" as const,
        memberIds: parentSet.memberIds,
        familyGroupId: parentSet.familyGroupId,
        displayOrder: parentSet.displayOrder,
      })),
    ],
    parentChildRelations: parentSets.flatMap(parentSet =>
      parentRelations(
        parentSet.memberIds,
        parentSet.childId,
        parentSet.id,
      ).map(relation => ({
        ...relation,
        displayOrder: parentSet.displayOrder,
      })),
    ),
  };
  const reversed: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions]
      .reverse()
      .map(union => ({ ...union, memberIds: [...union.memberIds].reverse() })),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  const options = {
    focusPersonId: "shared-parent",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
    showAllParentSets: true,
  } as const;
  const childIds = [childA.id, childB.id, childC.id];
  const assertOverlappingOrder = (result: LayoutResult): string[] => {
    const order = personIdsByX(result, childIds);
    assert.equal(order.length, 3, "A, B and shared C must each render once");
    assert.ok(order.indexOf(childA.id) < order.indexOf(childC.id));
    assert.ok(order.indexOf(childB.id) < order.indexOf(childC.id));
    assert.equal(order.at(-1), childC.id);
    const sharedOccurrences = result.unions
      .filter(union =>
        union.unionId === "parent-set:f1-c" ||
        union.unionId === "parent-set:f2-c"
      )
      .flatMap(union => union.childOccurrenceIds);
    assert.equal(sharedOccurrences.length, 2);
    assert.equal(
      new Set(sharedOccurrences).size,
      1,
      "both family groups must point to the same C occurrence",
    );
    return order;
  };

  const order = assertOverlappingOrder(run(graph, options));
  assert.deepEqual(assertOverlappingOrder(run(reversed, options)), order);
});

test("reversed previous positions cannot reverse chronological sibling order", () => {
  const children = [
    { ...person("previous-younger", "unknown", "1920"), displayOrder: "01" },
    { ...person("previous-middle", "unknown", "1910"), displayOrder: "02" },
    { ...person("previous-older", "unknown", "1900"), displayOrder: "03" },
  ];
  const graph: FamilyGraphData = {
    persons: [person("father", "male"), ...children, person("mother", "female")],
    unions: [
      {
        id: "previous-family",
        kind: "partnership",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(["father", "mother"], child.id, "previous-family"),
    ),
  };
  const options = {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 0,
  } as const;
  const expectedOrder = [
    "previous-older",
    "previous-middle",
    "previous-younger",
  ];
  const base = run(graph, options);
  const previousXByPersonId = new Map(
    expectedOrder.map((personId, index) => [personId, 600 - index * 600]),
  );
  const previousPositions = base.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.personId
      ? previousXByPersonId.get(node.personId) ?? node.x
      : node.x,
    y: node.y,
  }));

  assert.deepEqual(
    expectedOrder.map(personId => previousXByPersonId.get(personId)),
    [600, 0, -600],
    "the supplied historical coordinates must be the reverse of birth order",
  );
  const result = run(graph, { ...options, previousPositions });
  assert.deepEqual(personIdsByX(result, expectedOrder), expectedOrder);
});

test("invalid and missing births are placed after every valid birth year", () => {
  const children = [
    {
      ...person("invalid-birth", "unknown", "1780-02-30"),
      displayOrder: "01",
    },
    { ...person("missing-birth"), displayOrder: "02" },
    { ...person("valid-younger", "unknown", "1900"), displayOrder: "03" },
    { ...person("valid-older", "unknown", "1700"), displayOrder: "04" },
  ];
  const graph: FamilyGraphData = {
    persons: [person("father", "male"), ...children, person("mother", "female")],
    unions: [
      {
        id: "invalid-birth-family",
        kind: "partnership",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(
        ["father", "mother"],
        child.id,
        "invalid-birth-family",
      ),
    ),
  };

  const result = run(graph, {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 0,
  });
  const order = personIdsByX(result, children.map(child => child.id));

  assert.deepEqual(order.slice(0, 2), ["valid-older", "valid-younger"]);
  assert.deepEqual(order.slice(2).sort(), ["invalid-birth", "missing-birth"]);
});

test("layout keeps three partners and each partner's child on the correct union", () => {
  const persons = [
    person("focus"),
    ...[1, 2, 3].map(index => person(`partner-${index}`)),
    ...[1, 2, 3].map(index => person(`child-${index}`)),
  ];
  const unions: FamilyGraphData["unions"] = [1, 2, 3].map(index => ({
    id: `union-${index}`,
    kind: "partnership",
    memberIds: ["focus", `partner-${index}`],
    displayOrder: String(index),
  }));
  const parentChildRelations = [1, 2, 3].flatMap(index =>
    parentRelations(
      ["focus", `partner-${index}`],
      `child-${index}`,
      `union-${index}`,
    ),
  );
  const result = run({ persons, unions, parentChildRelations }, {
    focusPersonId: "focus",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
  });

  for (let index = 1; index <= 3; index += 1) {
    const union = result.unions.find(item => item.unionId === `union-${index}`);
    const expectedChild = result.nodes.find(
      node => node.personId === `child-${index}`,
    );
    assert.ok(union, `union-${index} was not rendered`);
    assert.ok(expectedChild, `child-${index} was not rendered`);
    assert.deepEqual(union.childOccurrenceIds, [expectedChild.occurrenceId]);
  }
  assert.equal(
    result.edges.filter(edge => edge.kind === "partnership").length,
    3,
  );
  assertNoCardOverlap(result, "three partners");
});

test("partnership and parent-set junctions reuse one canonical card per person", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("partner-a"),
      person("partner-b"),
      person("child-a"),
      person("child-b"),
    ],
    unions: [
      {
        id: "partnership:relation-a",
        kind: "partnership",
        memberIds: ["focus", "partner-a"],
        displayOrder: "01",
      },
      {
        id: "partnership:relation-b",
        kind: "partnership",
        memberIds: ["focus", "partner-b"],
        displayOrder: "02",
      },
      {
        id: "parent-set:set-a",
        kind: "parent-set",
        memberIds: ["focus", "partner-a"],
        displayOrder: "01",
      },
      {
        id: "parent-set:set-b",
        kind: "parent-set",
        memberIds: ["focus", "partner-b"],
        displayOrder: "02",
      },
    ],
    parentChildRelations: [
      ...parentRelations(
        ["focus", "partner-a"],
        "child-a",
        "parent-set:set-a",
      ),
      ...parentRelations(
        ["focus", "partner-b"],
        "child-b",
        "parent-set:set-b",
      ),
    ],
  };
  const result = run(graph, {
    focusPersonId: "focus",
    ancestorDepth: 1,
    descendantDepth: 1,
    collateralDepth: 1,
    showAllParentSets: true,
  });
  const personCards = result.nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );

  assert.deepEqual(
    personCards.map(node => node.personId).sort(),
    ["child-a", "child-b", "focus", "partner-a", "partner-b"],
  );
  assert.equal(personCards.some(node => node.kind === "reference"), false);
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    graph.unions.map(union => union.id).sort(),
  );
  assertNoCardOverlap(result, "partnership and parent sets");
});

test("per-child parent sets with duplicate explicit partnerships form one centered family bus", () => {
  const children = [person("child-a"), person("child-b"), person("child-c")];
  const graph: FamilyGraphData = {
    persons: [person("father", "male"), person("mother", "female"), ...children],
    unions: [
      {
        id: "partnership:parents-a",
        kind: "partnership",
        memberIds: ["father", "mother"],
        familyGroupId: "persisted-family-a",
        displayOrder: "00-a",
        status: "divorced",
      },
      {
        id: "partnership:parents-b",
        kind: "partnership",
        memberIds: ["father", "mother"],
        familyGroupId: "persisted-family-b",
        displayOrder: "00-b",
        status: "current",
      },
      ...children.map((child, index) => ({
        id: `parent-set:${child.id}`,
        kind: "parent-set" as const,
        memberIds: ["father", "mother"],
        familyGroupId: `derived-scope-${index}`,
        displayOrder: String(index).padStart(2, "0"),
      })),
    ],
    parentChildRelations: children.flatMap(child =>
      parentRelations(
        ["father", "mother"],
        child.id,
        `parent-set:${child.id}`,
      ),
    ),
  };
  const result = run(graph, {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
  });
  const father = result.nodes.find(node => node.personId === "father")!;
  const mother = result.nodes.find(node => node.personId === "mother")!;
  const partnerCards = [father, mother].sort((a, b) => a.x - b.x);
  const childCards = result.nodes
    .filter(node => node.personId?.startsWith("child-"))
    .sort((a, b) => a.x - b.x);
  const familyAnchor =
    (father.x + father.width / 2 + mother.x + mother.width / 2) / 2;
  const childrenCenter =
    (childCards[0]!.x + childCards[0]!.width / 2 +
      childCards.at(-1)!.x + childCards.at(-1)!.width / 2) /
    2;
  const buses = result.edges.filter(edge => edge.kind === "siblings-bus");
  const partnershipEdges = result.edges.filter(
    edge => edge.kind === "partnership" || edge.kind === "separated-partnership",
  );
  const childEdges = result.edges.filter(
    edge => (edge.relationshipKinds?.length ?? 0) > 0,
  );
  const familyStems = result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );

  assert.equal(
    partnerCards[1]!.x - (partnerCards[0]!.x + partnerCards[0]!.width),
    12,
  );
  assert.equal(partnershipEdges.length, 1);
  const currentPartnership = result.unions.find(
    union => union.unionId === "partnership:parents-b",
  );
  assert.ok(currentPartnership);
  assert.equal(partnershipEdges[0]!.kind, "partnership");
  assert.equal(
    partnershipEdges[0]!.unionOccurrenceId,
    currentPartnership.occurrenceId,
  );
  assert.equal(familyStems.length, 1);
  assert.equal(buses.length, 1);
  assert.equal(childEdges.length, 3);
  assert.ok(Math.abs(childrenCenter - familyAnchor) < 0.001);
  assert.ok(
    result.unions.every(union => Math.abs(union.x - familyAnchor) < 0.001),
  );
  assert.deepEqual(
    result.unions
      .filter(union => union.kind === "partnership")
      .map(union => union.childOccurrenceIds.length),
    [0, 0],
  );
  assert.deepEqual(
    result.unions
      .filter(union => union.kind === "parent-set")
      .map(union => union.childOccurrenceIds.length),
    [1, 1, 1],
  );
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    graph.unions.map(union => union.id).sort(),
  );
  assert.deepEqual(
    childEdges.flatMap(edge => edge.relationIds ?? []).sort(),
    graph.parentChildRelations.map(relation => relation.id).sort(),
  );
  assertNoCardOverlap(result, "one structural family bus");
  assertFamilyRoutesConnected(result, "duplicate partnership family bus");
});

test("direct children stay centered when each child has a spouse on the same side", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("father", "male"),
      person("mother", "female"),
      person("child-a"),
      person("child-b"),
      person("spouse-a"),
      person("spouse-b"),
    ],
    unions: [
      {
        id: "partnership:parents",
        kind: "partnership",
        memberIds: ["father", "mother"],
      },
      {
        id: "parent-set:child-a",
        kind: "parent-set",
        memberIds: ["father", "mother"],
        displayOrder: "01",
      },
      {
        id: "parent-set:child-b",
        kind: "parent-set",
        memberIds: ["father", "mother"],
        displayOrder: "02",
      },
      {
        id: "partnership:child-a",
        kind: "partnership",
        memberIds: ["child-a", "spouse-a"],
      },
      {
        id: "partnership:child-b",
        kind: "partnership",
        memberIds: ["child-b", "spouse-b"],
      },
    ],
    parentChildRelations: [
      ...parentRelations(
        ["father", "mother"],
        "child-a",
        "parent-set:child-a",
      ),
      ...parentRelations(
        ["father", "mother"],
        "child-b",
        "parent-set:child-b",
      ),
    ],
  };
  const result = run(graph, {
    focusPersonId: "father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
  });
  const father = result.nodes.find(node => node.personId === "father")!;
  const mother = result.nodes.find(node => node.personId === "mother")!;
  const children = ["child-a", "child-b"]
    .map(personId => result.nodes.find(node => node.personId === personId)!)
    .sort((a, b) => a.x - b.x);
  const spouses = ["spouse-a", "spouse-b"].map(
    personId => result.nodes.find(node => node.personId === personId)!,
  );
  const parentAnchor =
    (father.x + father.width / 2 + mother.x + mother.width / 2) / 2;
  const directChildCenter =
    (children[0]!.x + children[0]!.width / 2 +
      children[1]!.x + children[1]!.width / 2) /
    2;

  assert.ok(
    spouses.every((spouse, index) => {
      const child = result.nodes.find(
        node => node.personId === `child-${index === 0 ? "a" : "b"}`,
      )!;
      return spouse.x > child.x;
    }),
  );
  assert.ok(
    Math.abs(directChildCenter - parentAnchor) < 0.01,
    `direct children centered at ${directChildCenter}, parent anchor ${parentAnchor}`,
  );
  assert.equal(result.edges.filter(edge => edge.kind === "siblings-bus").length, 1);
  assertNoCardOverlap(result, "children with same-side spouses");
});

test("a childless partnership keeps its junction on the partner line", () => {
  const graph: FamilyGraphData = {
    persons: [person("partner-a"), person("partner-b")],
    unions: [
      {
        id: "partnership:childless",
        kind: "partnership",
        memberIds: ["partner-a", "partner-b"],
      },
    ],
    parentChildRelations: [],
  };
  const result = run(graph, {
    focusPersonId: "partner-a",
    ancestorDepth: 0,
    descendantDepth: 0,
    collateralDepth: 0,
  });
  const partnershipEdge = result.edges.find(edge => edge.kind === "partnership")!;
  const union = result.unions[0]!;

  assert.ok(partnershipEdge);
  assert.equal(partnershipEdge.points[0]?.y, partnershipEdge.points.at(-1)?.y);
  assert.equal(union.y, partnershipEdge.points[0]?.y);
  assert.equal(result.edges.some(edge => edge.kind === "union-stem"), false);
});

test("per-child two-parent sets share one family bus without inventing a partnership", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("parent-a"),
      person("parent-b"),
      person("child-a"),
      person("child-b"),
    ],
    unions: [
      {
        id: "parent-set:a",
        kind: "parent-set",
        memberIds: ["parent-a", "parent-b"],
        displayOrder: "01",
      },
      {
        id: "parent-set:b",
        kind: "parent-set",
        memberIds: ["parent-a", "parent-b"],
        displayOrder: "02",
      },
    ],
    parentChildRelations: [
      ...parentRelations(["parent-a", "parent-b"], "child-a", "parent-set:a"),
      ...parentRelations(["parent-a", "parent-b"], "child-b", "parent-set:b"),
    ],
  };
  const result = run(graph, {
    focusPersonId: "parent-a",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
  });

  const familyStems = result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );
  const childStems = result.edges.filter(edge => edge.id.includes(":child:"));

  assert.equal(result.edges.filter(edge => edge.kind === "siblings-bus").length, 1);
  assert.equal(familyStems.length, 1);
  assert.equal(childStems.length, 2);
  assert.equal(
    result.edges.some(
      edge => edge.kind === "partnership" || edge.kind === "separated-partnership",
    ),
    false,
  );
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    ["parent-set:a", "parent-set:b"],
  );
  assert.deepEqual(
    result.unions.map(union => union.childOccurrenceIds.length),
    [1, 1],
  );
  assert.deepEqual(
    childStems.flatMap(edge => edge.relationIds ?? []).sort(),
    graph.parentChildRelations.map(relation => relation.id).sort(),
  );
  assertFamilyRoutesConnected(result, "implicit two-parent family bus");
});

test("non-biological parent sets retain their kinds without inventing partnerships", () => {
  const kinds: ParentRelationshipKind[] = [
    "adoptive",
    "foster",
    "guardian",
    "step",
    "donor",
    "surrogate",
    "social_parent",
    "legal_parent",
  ];
  const graph: FamilyGraphData = {
    persons: [
      person("child"),
      ...kinds.map(kind => person(`parent-${kind}`)),
    ],
    unions: kinds.map((kind, index) => ({
      id: `set-${kind}`,
      kind: "parent-set" as const,
      memberIds: [`parent-${kind}`],
      displayOrder: String(index).padStart(2, "0"),
    })),
    parentChildRelations: kinds.map((kind, index) => ({
      id: `relation-${kind}`,
      parentId: `parent-${kind}`,
      childId: "child",
      unionId: `set-${kind}`,
      kind,
      displayOrder: String(index).padStart(2, "0"),
      isPreferred: index === 0,
    })),
  };

  const result = run(graph, {
    focusPersonId: "child",
    ancestorDepth: 2,
    descendantDepth: 0,
    collateralDepth: 0,
    maxVisibleNodes: 50,
    showAllParentSets: true,
  });
  const renderedKinds = new Set(
    result.edges.flatMap(edge => edge.relationshipKinds ?? []),
  );

  assert.deepEqual(renderedKinds, new Set(kinds));
  assert.ok(result.unions.every(union => union.kind === "parent-set"));
  assert.equal(
    result.edges.some(
      edge =>
        edge.kind === "partnership" || edge.kind === "separated-partnership",
    ),
    false,
  );
  assertNoCardOverlap(result, "non-biological parent sets");
});

test("multiple parent-set records for one child reuse the same parent card", () => {
  const graph: FamilyGraphData = {
    persons: [person("child"), person("parent")],
    unions: [
      {
        id: "parent-set:biological",
        kind: "parent-set",
        memberIds: ["parent"],
        displayOrder: "01",
      },
      {
        id: "parent-set:legal",
        kind: "parent-set",
        memberIds: ["parent"],
        displayOrder: "02",
      },
    ],
    parentChildRelations: [
      {
        id: "biological-parent",
        parentId: "parent",
        childId: "child",
        unionId: "parent-set:biological",
        kind: "biological",
        isPreferred: true,
      },
      {
        id: "legal-parent",
        parentId: "parent",
        childId: "child",
        unionId: "parent-set:legal",
        kind: "legal_parent",
      },
    ],
  };
  const result = run(graph, {
    focusPersonId: "child",
    ancestorDepth: 1,
    descendantDepth: 0,
    collateralDepth: 0,
    showAllParentSets: true,
  });
  const parentCards = result.nodes.filter(node => node.personId === "parent");

  assert.equal(parentCards.length, 1);
  assert.equal(parentCards[0]?.kind, "person");
  assert.equal(result.unions.length, 2);
  assert.ok(
    result.unions.every(
      union => union.memberOccurrenceIds[0] === parentCards[0]?.occurrenceId,
    ),
  );
});

test("pedigree collapse creates one canonical and one reference occurrence", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("shared-ancestor"),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "father-parent",
        kind: "parent-set",
        memberIds: ["shared-ancestor"],
      },
      {
        id: "mother-parent",
        kind: "parent-set",
        memberIds: ["shared-ancestor"],
      },
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      {
        id: "shared-father",
        parentId: "shared-ancestor",
        childId: "father",
        unionId: "father-parent",
        kind: "biological",
      },
      {
        id: "shared-mother",
        parentId: "shared-ancestor",
        childId: "mother",
        unionId: "mother-parent",
        kind: "biological",
      },
    ],
  };
  const result = run(graph, {
    focusPersonId: "focus",
    ancestorDepth: 3,
    descendantDepth: 0,
    collateralDepth: 0,
    showAllParentSets: true,
    lineageGroupDepth: 2,
  });
  const occurrences = result.nodes.filter(
    node => node.personId === "shared-ancestor",
  );
  const canonical = occurrences.find(node => node.kind === "person");
  const reference = occurrences.find(node => node.kind === "reference");

  assert.equal(occurrences.length, 2);
  assert.ok(canonical);
  assert.ok(reference);
  assert.equal(reference.referenceToOccurrenceId, canonical.occurrenceId);
  assert.deepEqual(
    occurrences.map(node => node.lineageRole),
    ["direct-ancestor", "direct-ancestor"],
  );
  const collapseGroups = occurrences
    .map(node => node.lineageGroup)
    .filter((value): value is number => value !== undefined)
    .sort();
  assert.equal(collapseGroups.length, 2);
  assert.ok(collapseGroups[0]! < 2);
  assert.ok(collapseGroups[1]! >= 2);
  assert.notEqual(
    collapseGroups[0],
    collapseGroups[1],
    "each pedigree-collapse occurrence keeps the color of its concrete branch",
  );
  assertNoCardOverlap(result, "pedigree collapse");
});

test("five ancestor generations keep recursive paternal-left and maternal-right sectors", () => {
  const depth = 5;
  const persons: TreePerson[] = [person("focus")];
  const unions: Array<FamilyGraphData["unions"][number]> = [];
  const parentChildRelations: ParentChildRelation[] = [];
  const pathByPersonId = new Map<string, string>([["focus", ""]]);
  let children = [{ id: "focus", path: "" }];

  for (let generation = 1; generation <= depth; generation += 1) {
    const next: Array<{ id: string; path: string }> = [];
    for (const child of children) {
      // IDs deliberately sort opposite to the genealogical role order.
      const fatherId = `z-father-${generation}-${child.path || "root"}`;
      const motherId = `a-mother-${generation}-${child.path || "root"}`;
      const unionId = `parents:${child.id}`;
      persons.push(person(fatherId), person(motherId));
      pathByPersonId.set(fatherId, `${child.path}0`);
      pathByPersonId.set(motherId, `${child.path}1`);
      unions.push({
        id: unionId,
        kind: "parent-set",
        memberIds: [motherId, fatherId],
      });
      unions.push({
        id: `partnership:${child.id}`,
        kind: "partnership",
        memberIds: [motherId, fatherId],
      });
      parentChildRelations.push(
        {
          id: `a-maternal:${unionId}`,
          parentId: motherId,
          childId: child.id,
          unionId,
          kind: "genetic_mother",
          role: "parent",
        },
        {
          id: `z-paternal:${unionId}`,
          parentId: fatherId,
          childId: child.id,
          unionId,
          kind: "genetic_father",
          role: "parent",
        },
      );
      next.push(
        { id: fatherId, path: `${child.path}0` },
        { id: motherId, path: `${child.path}1` },
      );
    }
    children = next;
  }

  const graph: FamilyGraphData = { persons, unions, parentChildRelations };
  const options: Partial<FamilyTreeLayoutOptions> = {
    focusPersonId: "focus",
    ancestorDepth: depth,
    descendantDepth: 0,
    collateralDepth: 0,
    maxVisibleNodes: 100,
  };
  const result = run(graph, options);

  const nodeByPath = new Map(
    result.nodes
      .filter(node => node.personId && pathByPersonId.has(node.personId))
      .map(node => [pathByPersonId.get(node.personId!)!, node]),
  );
  for (let generation = 0; generation < depth; generation += 1) {
    const childPaths = [...nodeByPath.keys()].filter(
      path => path.length === generation,
    );
    for (const childPath of childPaths) {
      const child = nodeByPath.get(childPath)!;
      const paternalParent = nodeByPath.get(`${childPath}0`)!;
      const maternalParent = nodeByPath.get(`${childPath}1`)!;
      const childCenter = child.x + child.width / 2;
      const parentMidpoint =
        (paternalParent.x + paternalParent.width / 2 +
          maternalParent.x + maternalParent.width / 2) /
        2;
      assert.ok(
        Math.abs(childCenter - parentMidpoint) < 0.001,
        `generation ${generation}: ${childPath || "root"} is not below parent midpoint`,
      );
      const paternalBranch = [...nodeByPath]
        .filter(([path]) => path.startsWith(`${childPath}0`))
        .map(([, node]) => node);
      const maternalBranch = [...nodeByPath]
        .filter(([path]) => path.startsWith(`${childPath}1`))
        .map(([, node]) => node);
      assert.ok(
        Math.max(...paternalBranch.map(node => node.x + node.width)) <=
          childCenter,
        `generation ${generation}: paternal branch crossed ${childPath || "root"}`,
      );
      assert.ok(
        Math.min(...maternalBranch.map(node => node.x)) >= childCenter,
        `generation ${generation}: maternal branch crossed ${childPath || "root"}`,
      );
    }
  }

  for (let generation = 2; generation <= depth; generation += 1) {
    const layer = result.nodes.filter(
      node =>
        node.generation === generation &&
        node.personId !== undefined &&
        pathByPersonId.get(node.personId)?.length === generation,
    );
    for (let prefixLength = 0; prefixLength < generation; prefixLength += 1) {
      const prefixes = new Set(
        layer.map(node =>
          pathByPersonId.get(node.personId!)!.slice(0, prefixLength),
        ),
      );
      for (const prefix of prefixes) {
        const paternal = layer.filter(node => {
          const path = pathByPersonId.get(node.personId!)!;
          return path.startsWith(prefix) && path[prefixLength] === "0";
        });
        const maternal = layer.filter(node => {
          const path = pathByPersonId.get(node.personId!)!;
          return path.startsWith(prefix) && path[prefixLength] === "1";
        });
        assert.ok(paternal.length > 0, `missing paternal sector ${prefix}`);
        assert.ok(maternal.length > 0, `missing maternal sector ${prefix}`);
        assert.ok(
          Math.max(...paternal.map(node => node.x + node.width)) <=
            Math.min(...maternal.map(node => node.x)),
          `generation ${generation}, prefix ${prefix || "root"} crossed`,
        );
      }
    }
  }
  assertNoCardOverlap(result, "recursive ancestor sectors");
  assertFamilyRoutesConnected(result, "five-generation pedigree");

  const reversed = run(
    {
      persons: [...persons].reverse(),
      unions: [...unions].reverse(),
      parentChildRelations: [...parentChildRelations].reverse(),
    },
    options,
  );
  const projection = (layout: LayoutResult) =>
    layout.nodes
      .filter(node => node.personId && pathByPersonId.has(node.personId))
      .map(node => ({
        personId: node.personId,
        generation: node.generation,
        x: node.x,
        y: node.y,
      }))
      .sort((a, b) => a.personId!.localeCompare(b.personId!));
  assert.deepEqual(projection(reversed), projection(result));
});

test("direct pedigree keeps a sparse single-parent chain centered and compact", () => {
  const depth = 7;
  const persons = Array.from({ length: depth + 1 }, (_, index) =>
    person(index === 0 ? "focus" : `ancestor-${index}`),
  );
  const unions = Array.from({ length: depth }, (_, index) => ({
    id: `parents-${index}`,
    kind: "parent-set" as const,
    memberIds: [`ancestor-${index + 1}`],
  }));
  const parentChildRelations = Array.from({ length: depth }, (_, index) => ({
    id: `relation-${index}`,
    parentId: `ancestor-${index + 1}`,
    childId: index === 0 ? "focus" : `ancestor-${index}`,
    unionId: `parents-${index}`,
    kind: "biological" as const,
    role: "father" as const,
  }));
  const result = run({ persons, unions, parentChildRelations }, {
    focusPersonId: "focus",
    ancestorDepth: depth,
    descendantDepth: 0,
    collateralDepth: 0,
    showUnknownParentPlaceholders: false,
  });
  const centers = result.nodes
    .filter(node => node.kind === "person")
    .map(node => node.x + node.width / 2);

  assert.ok(centers.every(center => Math.abs(center) < 0.001));
  assert.ok(result.bounds.right - result.bounds.left < 500);
  assertNoCardOverlap(result, "sparse direct pedigree");
  assertFamilyRoutesConnected(result, "sparse direct pedigree");
});

test("a new partner of a seventh-generation ancestor stays inside that ancestor sector", () => {
  const depth = 7;
  const persons: TreePerson[] = [person("focus")];
  const unions: Array<FamilyGraphData["unions"][number]> = [];
  const parentChildRelations: ParentChildRelation[] = [];
  const pathByPersonId = new Map<string, string>([["focus", ""]]);
  let children = [{ id: "focus", path: "" }];

  for (let generation = 1; generation <= depth; generation += 1) {
    const next: Array<{ id: string; path: string }> = [];
    for (const child of children) {
      const fatherId = `father-${generation}-${child.path || "root"}`;
      const motherId = `mother-${generation}-${child.path || "root"}`;
      const unionId = `parents:${child.id}`;
      persons.push(person(fatherId, "male"), person(motherId, "female"));
      pathByPersonId.set(fatherId, `${child.path}0`);
      pathByPersonId.set(motherId, `${child.path}1`);
      unions.push(
        { id: unionId, kind: "parent-set", memberIds: [motherId, fatherId] },
        {
          id: `partnership:${child.id}`,
          kind: "partnership",
          memberIds: [motherId, fatherId],
        },
      );
      parentChildRelations.push(
        {
          id: `father:${unionId}`,
          parentId: fatherId,
          childId: child.id,
          unionId,
          kind: "genetic_father",
          role: "father",
        },
        {
          id: `mother:${unionId}`,
          parentId: motherId,
          childId: child.id,
          unionId,
          kind: "genetic_mother",
          role: "mother",
        },
      );
      next.push(
        { id: fatherId, path: `${child.path}0` },
        { id: motherId, path: `${child.path}1` },
      );
    }
    children = next;
  }

  const baseGraph: FamilyGraphData = { persons, unions, parentChildRelations };
  const options: Partial<FamilyTreeLayoutOptions> = {
    focusPersonId: "focus",
    ancestorDepth: depth,
    descendantDepth: 0,
    collateralDepth: 0,
    maxVisibleNodes: 400,
  };
  const base = run(baseGraph, options);
  const paternalLeafId = [...pathByPersonId].find(([, path]) =>
    path === "0000000"
  )?.[0];
  assert.ok(paternalLeafId);
  const partnerId = "partner-of-paternal-leaf";
  pathByPersonId.set(partnerId, "0000000");
  const graph: FamilyGraphData = {
    persons: [...persons, person(partnerId, "female")],
    unions: [
      ...unions,
      {
        id: "paternal-leaf-extra-partnership",
        kind: "partnership",
        memberIds: [paternalLeafId, partnerId],
      },
    ],
    parentChildRelations,
  };
  const previousPositions = base.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const result = run(graph, { ...options, previousPositions });
  const nodesByPath = new Map<string, typeof result.nodes>(
    Array.from({ length: depth + 1 }, (_, generation) => [
      String(generation),
      result.nodes.filter(node => {
        const path = node.personId ? pathByPersonId.get(node.personId) : undefined;
        return path?.length === generation;
      }),
    ]),
  );
  const focus = result.nodes.find(node => node.personId === "focus")!;
  const focusCenter = focus.x + focus.width / 2;
  const father = result.nodes.find(
    node => node.personId && pathByPersonId.get(node.personId) === "0",
  )!;
  const mother = result.nodes.find(
    node => node.personId && pathByPersonId.get(node.personId) === "1",
  )!;
  const rootParentMidpoint =
    (father.x + father.width / 2 + mother.x + mother.width / 2) / 2;

  assert.ok(Math.abs(focusCenter) < 0.001);
  assert.ok(Math.abs(rootParentMidpoint - focusCenter) < 0.001);
  const directNodeByPath = new Map(
    result.nodes
      .filter(node => node.personId && node.personId !== partnerId)
      .map(node => [pathByPersonId.get(node.personId!)!, node]),
  );
  for (let generation = 0; generation < depth; generation += 1) {
    for (const [path, child] of directNodeByPath) {
      if (path.length !== generation) continue;
      const paternalParent = directNodeByPath.get(`${path}0`)!;
      const maternalParent = directNodeByPath.get(`${path}1`)!;
      const childCenter = child.x + child.width / 2;
      const parentMidpoint =
        (paternalParent.x + paternalParent.width / 2 +
          maternalParent.x + maternalParent.width / 2) / 2;
      const paternalSector = result.nodes.filter(node => {
        const candidatePath = node.personId
          ? pathByPersonId.get(node.personId)
          : undefined;
        return candidatePath?.startsWith(`${path}0`);
      });
      const maternalSector = result.nodes.filter(node => {
        const candidatePath = node.personId
          ? pathByPersonId.get(node.personId)
          : undefined;
        return candidatePath?.startsWith(`${path}1`);
      });
      assert.ok(
        Math.abs(parentMidpoint - childCenter) < 0.001,
        `${path || "root"}: child is not under the parent midpoint`,
      );
      assert.ok(
        Math.max(...paternalSector.map(node => node.x + node.width)) <=
          childCenter,
        `${path || "root"}: paternal sector crossed its local axis`,
      );
      assert.ok(
        Math.min(...maternalSector.map(node => node.x)) >= childCenter,
        `${path || "root"}: maternal sector crossed its local axis`,
      );
    }
  }
  for (let generation = 1; generation <= depth; generation += 1) {
    const layer = nodesByPath.get(String(generation)) ?? [];
    const paternal = layer.filter(node =>
      pathByPersonId.get(node.personId!)!.startsWith("0")
    );
    const maternal = layer.filter(node =>
      pathByPersonId.get(node.personId!)!.startsWith("1")
    );
    assert.ok(
      Math.max(...paternal.map(node => node.x + node.width)) <= focusCenter,
      `generation ${generation}: paternal card crossed the focus axis`,
    );
    assert.ok(
      Math.min(...maternal.map(node => node.x)) >= focusCenter,
      `generation ${generation}: maternal card crossed the focus axis`,
    );
  }

  const partner = result.nodes.find(node => node.personId === partnerId)!;
  const anchor = result.nodes.find(node => node.personId === paternalLeafId)!;
  assert.equal(partner.generation, depth);
  assert.ok(partner.x + partner.width <= anchor.x);
  const extraUnion = result.unions.find(
    union => union.unionId === "paternal-leaf-extra-partnership",
  );
  assert.ok(extraUnion);
  assert.ok(
    result.edges.some(
      edge =>
        edge.unionOccurrenceId === extraUnion.occurrenceId &&
        edge.kind === "partnership",
    ),
  );
  assertNoCardOverlap(result, "seventh-generation partner sector");
  assertFamilyRoutesConnected(result, "seventh-generation partner sector");

  const reversed = run(
    {
      persons: [...graph.persons].reverse(),
      unions: [...graph.unions].reverse(),
      parentChildRelations: [...graph.parentChildRelations].reverse(),
    },
    { ...options, previousPositions },
  );
  const projection = (layout: LayoutResult) => layout.nodes
    .filter(node => node.personId)
    .map(node => ({ personId: node.personId, x: node.x, y: node.y }))
    .sort((left, right) => left.personId!.localeCompare(right.personId!));
  assert.deepEqual(projection(reversed), projection(result));
});

test("continuation controls stay attached to cards without changing pedigree coordinates", () => {
  const base: FamilyGraphData = {
    persons: [person("focus"), person("father"), person("mother")],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
    ],
    parentChildRelations: parentRelations(
      ["father", "mother"],
      "focus",
      "focus-parents",
    ),
  };
  const withContinuations: FamilyGraphData = {
    ...base,
    continuations: [
      {
        id: "focus-children",
        personId: "focus",
        direction: "children",
        token: "server:children",
      },
      {
        id: "focus-siblings",
        personId: "focus",
        direction: "siblings",
        token: "server:siblings",
      },
      {
        id: "father-partners",
        personId: "father",
        direction: "partners",
        token: "server:partners",
      },
      {
        id: "father-partners-duplicate",
        personId: "father",
        direction: "partners",
        token: "server:partners:duplicate",
      },
    ],
  };
  const options: Partial<FamilyTreeLayoutOptions> = {
    focusPersonId: "focus",
    ancestorDepth: 7,
    descendantDepth: 0,
    collateralDepth: 0,
    showUnknownParentPlaceholders: false,
  };
  const plain = run(base, options);
  const decorated = run(withContinuations, options);
  const peopleProjection = (layout: LayoutResult) => layout.nodes
    .filter(node => node.kind === "person" || node.kind === "reference")
    .map(node => ({
      personId: node.personId,
      generation: node.generation,
      x: node.x,
      y: node.y,
    }))
    .sort((left, right) => left.personId!.localeCompare(right.personId!));
  const controls = decorated.nodes.filter(node => node.kind === "continuation");

  assert.deepEqual(peopleProjection(decorated), peopleProjection(plain));
  assert.equal(controls.length, 3);
  assert.equal(
    decorated.edges.some(edge => edge.kind === "continuation"),
    false,
  );
  for (const control of controls) {
    const source = decorated.nodes.find(
      node => node.occurrenceId === control.sourceOccurrenceId,
    )!;
    assert.equal(source.personId, control.continuation?.personId);
    assert.ok(control.x >= source.x);
    assert.ok(control.x + control.width <= source.x + source.width);
    assert.ok(control.y > source.y + source.height);
  }
  assertNoCardOverlap(decorated, "compact continuation controls");
});

test("ancestor-sector packing keeps paternal and maternal collateral couples outside the root parent pair", () => {
  const persons = [
    person("focus"),
    person("father"),
    person("mother"),
    person("paternal-grandfather"),
    person("paternal-grandmother"),
    person("a-paternal-uncle"),
    person("z-paternal-uncle-spouse"),
    person("maternal-grandfather"),
    person("maternal-grandmother"),
    person("z-maternal-aunt"),
    person("a-maternal-aunt-spouse"),
  ];
  const unions: FamilyGraphData["unions"] = [
    {
      id: "root-parent-set",
      kind: "parent-set",
      memberIds: ["mother", "father"],
    },
    {
      id: "root-partnership",
      kind: "partnership",
      memberIds: ["mother", "father"],
    },
    {
      id: "paternal-parent-set",
      kind: "parent-set",
      memberIds: ["paternal-grandmother", "paternal-grandfather"],
    },
    {
      id: "maternal-parent-set",
      kind: "parent-set",
      memberIds: ["maternal-grandmother", "maternal-grandfather"],
    },
    {
      id: "paternal-collateral-partnership",
      kind: "partnership",
      memberIds: ["z-paternal-uncle-spouse", "a-paternal-uncle"],
    },
    {
      id: "maternal-collateral-partnership",
      kind: "partnership",
      memberIds: ["a-maternal-aunt-spouse", "z-maternal-aunt"],
    },
  ];
  const parentChildRelations: ParentChildRelation[] = [
    ...parentRelations(["father", "mother"], "focus", "root-parent-set"),
    ...parentRelations(
      ["paternal-grandfather", "paternal-grandmother"],
      "father",
      "paternal-parent-set",
    ),
    ...parentRelations(
      ["paternal-grandfather", "paternal-grandmother"],
      "a-paternal-uncle",
      "paternal-parent-set",
    ),
    ...parentRelations(
      ["maternal-grandfather", "maternal-grandmother"],
      "mother",
      "maternal-parent-set",
    ),
    ...parentRelations(
      ["maternal-grandfather", "maternal-grandmother"],
      "z-maternal-aunt",
      "maternal-parent-set",
    ),
  ];
  const graph: FamilyGraphData = { persons, unions, parentChildRelations };
  const options: Partial<FamilyTreeLayoutOptions> = {
    focusPersonId: "focus",
    ancestorDepth: 4,
    descendantDepth: 0,
    collateralDepth: 1,
    maxVisibleNodes: 100,
  };
  const result = run(graph, options);
  const node = (personId: string) => {
    const match = result.nodes.find(candidate => candidate.personId === personId);
    assert.ok(match, `missing ${personId}`);
    return match;
  };
  const father = node("father");
  const mother = node("mother");
  const paternalCollateral = [
    node("a-paternal-uncle"),
    node("z-paternal-uncle-spouse"),
  ];
  const maternalCollateral = [
    node("z-maternal-aunt"),
    node("a-maternal-aunt-spouse"),
  ];

  assert.ok(
    Math.max(...paternalCollateral.map(card => card.x + card.width)) <= father.x,
    "paternal collateral bundle must close before the father card",
  );
  assert.ok(
    mother.x + mother.width <=
      Math.min(...maternalCollateral.map(card => card.x)),
    "maternal collateral bundle must open after the mother card",
  );
  assertNoCardOverlap(result, "collateral ancestor sectors");

  const reversed = run(
    {
      persons: [...persons].reverse(),
      unions: [...unions].reverse(),
      parentChildRelations: [...parentChildRelations].reverse(),
    },
    options,
  );
  assert.deepEqual(projectLayout(reversed), projectLayout(result));
});

test("self, two-node, and three-node cycles are cut deterministically", () => {
  const cases: Array<{
    name: string;
    personIds: string[];
    relations: ParentChildRelation[];
    expectedCut: string[];
  }> = [
    {
      name: "self cycle",
      personIds: ["a"],
      relations: [
        { id: "aa", parentId: "a", childId: "a", kind: "biological" },
      ],
      expectedCut: ["aa"],
    },
    {
      name: "two-node cycle",
      personIds: ["a", "b"],
      relations: [
        { id: "ab", parentId: "a", childId: "b", kind: "biological" },
        { id: "ba", parentId: "b", childId: "a", kind: "biological" },
      ],
      expectedCut: ["ba"],
    },
    {
      name: "three-node cycle",
      personIds: ["a", "b", "c"],
      relations: [
        { id: "ab", parentId: "a", childId: "b", kind: "biological" },
        { id: "bc", parentId: "b", childId: "c", kind: "biological" },
        { id: "ca", parentId: "c", childId: "a", kind: "biological" },
      ],
      expectedCut: ["ca"],
    },
  ];

  for (const scenario of cases) {
    const graph: FamilyGraphData = {
      persons: scenario.personIds.map(id => person(id)),
      unions: [],
      parentChildRelations: scenario.relations,
    };
    const reversed: FamilyGraphData = {
      persons: [...graph.persons].reverse(),
      unions: [],
      parentChildRelations: [...graph.parentChildRelations].reverse(),
    };
    const forwardIndex = buildGraphIndex(graph);
    const reversedIndex = buildGraphIndex(reversed);
    const forwardCut = [...forwardIndex.invalidCycleRelationIds].sort();
    const reversedCut = [...reversedIndex.invalidCycleRelationIds].sort();

    assert.deepEqual(forwardCut, scenario.expectedCut, scenario.name);
    assert.deepEqual(reversedCut, scenario.expectedCut, `${scenario.name}, reversed`);

    const forwardLayout = run(graph, {
      focusPersonId: "a",
      ancestorDepth: 8,
      descendantDepth: 8,
      maxVisibleNodes: 50,
    });
    const reversedLayout = run(reversed, {
      focusPersonId: "a",
      ancestorDepth: 8,
      descendantDepth: 8,
      maxVisibleNodes: 50,
    });
    const forwardWarning = forwardLayout.warnings.find(
      warning => warning.code === "CYCLE_DETECTED",
    );
    const reversedWarning = reversedLayout.warnings.find(
      warning => warning.code === "CYCLE_DETECTED",
    );
    assert.deepEqual(forwardWarning?.relationIds, scenario.expectedCut, scenario.name);
    assert.deepEqual(reversedWarning, forwardWarning, `${scenario.name}, warning order`);
    assert.ok(forwardLayout.nodes.length <= scenario.personIds.length * 2);
  }
});

test("graph indexing is reused only while immutable collection identities stay stable", () => {
  const graph: FamilyGraphData = {
    persons: [person("a"), person("b")],
    unions: [],
    parentChildRelations: [],
  };
  const initial = buildGraphIndex(graph);
  assert.equal(buildGraphIndex(graph), initial, "an unchanged graph reuses its index");

  graph.parentChildRelations = [
    { id: "ab", parentId: "a", childId: "b", kind: "biological" },
  ];
  const updated = buildGraphIndex(graph);
  assert.notEqual(updated, initial, "a replaced readonly collection invalidates the cache");
  assert.deepEqual(
    updated.relationsByParentId.get("a")?.map(relation => relation.id),
    ["ab"],
  );
});

test("layout traverses a sixty-generation chain without a product cap", () => {
  const depth = 60;
  const persons = Array.from({ length: depth + 1 }, (_, index) =>
    person(`person-${index}`),
  );
  const parentChildRelations: ParentChildRelation[] = Array.from(
    { length: depth },
    (_, index) => ({
      id: `relation-${index}`,
      parentId: `person-${index + 1}`,
      childId: `person-${index}`,
      kind: "biological",
    }),
  );
  const result = run({ persons, unions: [], parentChildRelations }, {
    focusPersonId: "person-0",
    ancestorDepth: depth,
    descendantDepth: 0,
    collateralDepth: 0,
    maxVisibleNodes: depth + 1,
  });

  assert.equal(
    Math.max(...result.nodes.map(node => node.generation)),
    depth,
  );
  assert.equal(
    result.nodes.filter(node => node.kind === "person").length,
    depth + 1,
  );
  assert.ok(result.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test("collapsed people become local continuations and re-expand without losing relatives", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("partner"),
      person("child"),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "focus-family",
        kind: "partnership",
        memberIds: ["focus", "partner"],
      },
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      ...parentRelations(["focus", "partner"], "child", "focus-family"),
    ],
    continuations: [
      {
        id: "server-more-children",
        personId: "focus",
        direction: "children",
        token: "server:more-children",
      },
    ],
  };
  const options: Partial<FamilyTreeLayoutOptions> = {
    focusPersonId: "focus",
    ancestorDepth: 1,
    descendantDepth: 1,
    collateralDepth: 1,
    maxVisibleNodes: 20,
  };
  const expanded = run(graph, options);
  const collapsed = run(graph, {
    ...options,
    collapsedPersonIds: ["focus"],
  });
  const reexpanded = run(graph, {
    ...options,
    collapsedPersonIds: [],
  });

  const expandedPeople = expanded.nodes
    .filter(node => node.kind === "person" || node.kind === "reference")
    .map(node => node.personId)
    .sort();
  const collapsedPeople = collapsed.nodes
    .filter(node => node.kind === "person" || node.kind === "reference")
    .map(node => node.personId);
  const collapsedDirections = collapsed.nodes
    .filter(node => node.kind === "continuation")
    .map(node => node.continuation?.direction)
    .sort();

  assert.deepEqual(expandedPeople, ["child", "father", "focus", "mother", "partner"]);
  assert.deepEqual(collapsedPeople, ["focus"]);
  assert.deepEqual(collapsedDirections, ["children", "parents", "partners"]);
  assert.ok(
    collapsed.nodes
      .filter(node => node.kind === "continuation")
      .every(node => node.continuation?.token.endsWith(":collapsed")),
  );
  assert.deepEqual(
    reexpanded.nodes.map(node => node.occurrenceId),
    expanded.nodes.map(node => node.occurrenceId),
  );
  assertNoCardOverlap(collapsed, "collapsed focus");
});

test("layout coordinates are independent of input array order", () => {
  const persons = [
    person("focus"),
    person("partner-a"),
    person("partner-b"),
    person("child-a"),
    person("child-b"),
  ];
  const unions: FamilyGraphData["unions"] = [
    {
      id: "union-a",
      kind: "partnership",
      memberIds: ["focus", "partner-a"],
      displayOrder: "1",
    },
    {
      id: "union-b",
      kind: "partnership",
      memberIds: ["focus", "partner-b"],
      displayOrder: "2",
    },
  ];
  const parentChildRelations = [
    ...parentRelations(["focus", "partner-a"], "child-a", "union-a"),
    ...parentRelations(["focus", "partner-b"], "child-b", "union-b"),
  ];
  const graph: FamilyGraphData = { persons, unions, parentChildRelations };
  const reversed: FamilyGraphData = {
    persons: [...persons].reverse(),
    unions: [...unions].reverse(),
    parentChildRelations: [...parentChildRelations].reverse(),
  };

  assert.deepEqual(
    projectLayout(run(graph, { focusPersonId: "focus" })),
    projectLayout(run(reversed, { focusPersonId: "focus" })),
  );
});

test("family graph keeps children and parallel partner lines from an uncle's marriages disjoint", () => {
  const firstMarriageChildren = Array.from(
    { length: 5 },
    (_, index) => `uncle-first-child-${index + 1}`,
  );
  const secondMarriageChildren = ["uncle-second-child-1"];
  const thirdMarriageChildren = ["uncle-third-child-1"];
  const graph: FamilyGraphData = {
    persons: [
      person("focus", "unknown", "2000"),
      person("father", "male", "1970"),
      person("mother", "female", "1972"),
      person("paternal-grandfather", "male", "1940"),
      person("paternal-grandmother", "female", "1942"),
      person("uncle", "male", "1968"),
      person("uncle-partner-1", "female", "1970"),
      person("uncle-partner-2", "female", "1974"),
      person("uncle-partner-3", "female", "1976"),
      ...firstMarriageChildren.map((childId, index) =>
        person(childId, "unknown", String(1990 + index)),
      ),
      ...secondMarriageChildren.map(childId =>
        person(childId, "unknown", "2001"),
      ),
      ...thirdMarriageChildren.map(childId =>
        person(childId, "unknown", "2003"),
      ),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "paternal-grandparents",
        kind: "partnership",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "uncle-first-marriage",
        kind: "partnership",
        memberIds: ["uncle", "uncle-partner-1"],
        displayOrder: "01",
      },
      {
        id: "uncle-second-marriage",
        kind: "partnership",
        memberIds: ["uncle", "uncle-partner-2"],
        displayOrder: "02",
      },
      {
        id: "uncle-third-marriage",
        kind: "partnership",
        memberIds: ["uncle", "uncle-partner-3"],
        displayOrder: "03",
      },
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      ...parentRelations(
        ["paternal-grandfather", "paternal-grandmother"],
        "father",
        "paternal-grandparents",
      ),
      ...parentRelations(
        ["paternal-grandfather", "paternal-grandmother"],
        "uncle",
        "paternal-grandparents",
      ),
      ...firstMarriageChildren.flatMap(childId =>
        parentRelations(
          ["uncle", "uncle-partner-1"],
          childId,
          "uncle-first-marriage",
        ),
      ),
      ...secondMarriageChildren.flatMap(childId =>
        parentRelations(
          ["uncle", "uncle-partner-2"],
          childId,
          "uncle-second-marriage",
        ),
      ),
      ...thirdMarriageChildren.flatMap(childId =>
        parentRelations(
          ["uncle", "uncle-partner-3"],
          childId,
          "uncle-third-marriage",
        ),
      ),
    ],
  };
  const result = run(graph, {
    focusPersonId: "focus",
    layoutMode: "family-graph",
    ancestorDepth: 2,
    descendantDepth: 0,
    collateralDepth: 3,
    maxVisibleNodes: 100,
    showAllParentSets: true,
  });
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  const expectedChildrenByUnion = new Map<string, readonly string[]>([
    ["uncle-first-marriage", firstMarriageChildren],
    ["uncle-second-marriage", secondMarriageChildren],
    ["uncle-third-marriage", thirdMarriageChildren],
  ]);
  const childBusIntervals = [...expectedChildrenByUnion].map(
    ([unionId, expectedChildren]) => {
      const union = result.unions.find(candidate => candidate.unionId === unionId);
      assert.ok(union, `missing ${unionId}`);
      const renderedChildren = union.childOccurrenceIds.map(occurrenceId =>
        nodesByOccurrenceId.get(occurrenceId)?.personId,
      );
      assert.deepEqual(
        new Set(renderedChildren),
        new Set(expectedChildren),
        `${unionId} must own only its actual children`,
      );
      const buses = result.edges.filter(
        edge =>
          edge.kind === "siblings-bus" &&
          edge.unionOccurrenceId === union.occurrenceId,
      );
      assert.equal(buses.length, 1, `${unionId} must have one children bus`);
      const bus = buses[0]!;
      return {
        unionId,
        left: Math.min(bus.points[0]!.x, bus.points[1]!.x),
        right: Math.max(bus.points[0]!.x, bus.points[1]!.x),
      };
    },
  ).sort((left, right) => left.left - right.left);

  assert.equal(
    result.nodes.filter(node => node.personId === "uncle").length,
    1,
    "all marriages must reuse one canonical uncle card",
  );
  for (let index = 1; index < childBusIntervals.length; index += 1) {
    assert.ok(
      childBusIntervals[index - 1]!.right + 12 <=
        childBusIntervals[index]!.left,
      `children from different marriages need disjoint bus corridors: ` +
        JSON.stringify(childBusIntervals),
    );
  }
  assertNoCardOverlap(result, "uncle with three marriages");
  assertFamilyRoutesConnected(result, "uncle with three marriages");
  assertNoUnrelatedFamilyRouteIntersections(
    result,
    [
      "uncle-first-marriage",
      "uncle-second-marriage",
      "uncle-third-marriage",
    ],
    "uncle with three marriages",
  );
  assertParallelSidePartnerLines(
    result,
    "uncle",
    [
      "uncle-first-marriage",
      "uncle-second-marriage",
      "uncle-third-marriage",
    ],
    "uncle with three marriages",
  );
});

test("deterministic sweep packs every sibling count from one through forty", () => {
  for (let childCount = 1; childCount <= 40; childCount += 1) {
    const children = Array.from({ length: childCount }, (_, index) =>
      person(`child-${String(index).padStart(2, "0")}`),
    );
    const graph: FamilyGraphData = {
      persons: [person("father"), person("mother"), ...children],
      unions: [
        {
          id: "parents",
          kind: "partnership",
          memberIds: ["father", "mother"],
        },
      ],
      parentChildRelations: children.flatMap(child =>
        parentRelations(["father", "mother"], child.id, "parents"),
      ),
    };
    const result = run(graph, {
      focusPersonId: "father",
      ancestorDepth: 100,
      descendantDepth: 100,
      collateralDepth: 2,
      maxVisibleNodes: 500,
    });
    const childOccurrences = result.nodes.filter(node =>
      node.personId?.startsWith("child-"),
    );
    assert.equal(childOccurrences.length, childCount);
    assert.equal(
      childOccurrences.some(node => node.kind === "reference"),
      false,
    );
    assertNoCardOverlap(result, `${childCount} siblings`);
  }
});

test("neighboring expanded ancestor families reflow into disjoint child corridors", () => {
  const paternalChildren = ["father", "paternal-aunt-a", "paternal-aunt-b"];
  const maternalChildren = ["mother", "maternal-uncle-a", "maternal-uncle-b"];
  const neighboringFamilies = [
    {
      personId: "paternal-aunt-a",
      partnerId: "paternal-aunt-a-partner",
      unionId: "paternal-aunt-a-family",
      childIds: ["paternal-aunt-a-child-a", "paternal-aunt-a-child-b"],
    },
    {
      personId: "paternal-aunt-b",
      partnerId: "paternal-aunt-b-partner",
      unionId: "paternal-aunt-b-family",
      childIds: ["paternal-aunt-b-child-a", "paternal-aunt-b-child-b"],
    },
  ] as const;
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("paternal-grandfather", "male"),
      person("paternal-grandmother", "female"),
      person("maternal-grandfather", "male"),
      person("maternal-grandmother", "female"),
      ...paternalChildren
        .filter(personId => personId !== "father")
        .map(personId => person(personId)),
      ...maternalChildren
        .filter(personId => personId !== "mother")
        .map(personId => person(personId)),
      ...neighboringFamilies.flatMap(family => [
        person(family.partnerId),
        ...family.childIds.map(personId => person(personId)),
      ]),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "paternal-grandparents",
        kind: "partnership",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "maternal-grandparents",
        kind: "partnership",
        memberIds: ["maternal-grandfather", "maternal-grandmother"],
      },
      ...neighboringFamilies.map(family => ({
        id: family.unionId,
        kind: "partnership" as const,
        memberIds: [family.personId, family.partnerId],
      })),
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      ...paternalChildren.flatMap(childId =>
        parentRelations(
          ["paternal-grandfather", "paternal-grandmother"],
          childId,
          "paternal-grandparents",
        ),
      ),
      ...maternalChildren.flatMap(childId =>
        parentRelations(
          ["maternal-grandfather", "maternal-grandmother"],
          childId,
          "maternal-grandparents",
        ),
      ),
      ...neighboringFamilies.flatMap(family =>
        family.childIds.flatMap(childId =>
          parentRelations(
            [family.personId, family.partnerId],
            childId,
            family.unionId,
          ),
        ),
      ),
    ],
  };
  const options = {
    focusPersonId: "focus",
    ancestorDepth: 2,
    descendantDepth: 0,
    collateralDepth: 3,
  } as const;
  const directChildIds = new Set(["focus", "father", "mother"]);
  const base = run(
    {
      ...graph,
      parentChildRelations: graph.parentChildRelations.filter(relation =>
        directChildIds.has(relation.childId),
      ),
    },
    options,
  );
  const paternalExpanded = run(
    {
      ...graph,
      parentChildRelations: graph.parentChildRelations.filter(
        relation =>
          directChildIds.has(relation.childId) ||
          relation.unionId === "paternal-grandparents",
      ),
    },
    {
      ...options,
      previousPositions: base.nodes.map(node => ({
        occurrenceId: node.occurrenceId,
        x: node.x,
        y: node.y,
      })),
    },
  );
  const result = run(graph, {
    ...options,
    previousPositions: paternalExpanded.nodes.map(node => ({
      occurrenceId: node.occurrenceId,
      x: node.x,
      y: node.y,
    })),
  });
  const buses = neighboringFamilies.map(({ unionId }) => {
      const union = result.unions.find(item => item.unionId === unionId);
      assert.ok(union, `missing ${unionId} union`);
      const bus = result.edges.find(
        edge =>
          edge.kind === "siblings-bus" &&
          edge.unionOccurrenceId === union.occurrenceId,
      );
      assert.ok(bus, `missing ${unionId} child bus`);
      return { unionId, union, bus };
  });
  const horizontalInterval = (bus: LayoutResult["edges"][number]) => {
    assert.equal(bus.points.length, 2);
    return {
      start: Math.min(bus.points[0]!.x, bus.points[1]!.x),
      end: Math.max(bus.points[0]!.x, bus.points[1]!.x),
      y: bus.points[0]!.y,
    };
  };
  const firstBus = horizontalInterval(buses[0]!.bus);
  const secondBus = horizontalInterval(buses[1]!.bus);
  const horizontalGap =
    Math.max(firstBus.start, secondBus.start) -
    Math.min(firstBus.end, secondBus.end);

  assert.ok(
    horizontalGap >= 12,
    `neighboring child buses must be horizontally disjoint with a visible gap: ${JSON.stringify({ firstBus, secondBus, horizontalGap })}`,
  );
  assert.equal(
    firstBus.y,
    secondBus.y,
    "disjoint family buses in one generation corridor must share one height",
  );

  type Segment = {
    edgeId: string;
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  const edgeSegments = (
    edge: LayoutResult["edges"][number],
  ): Segment[] => edge.points.slice(1).map((end, index) => ({
    edgeId: edge.id,
    start: edge.points[index]!,
    end,
  }));
  const epsilon = 0.001;
  const pointOnSegment = (
    point: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): boolean =>
    Math.abs(
      (end.x - start.x) * (point.y - start.y) -
        (end.y - start.y) * (point.x - start.x),
    ) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon;
  const segmentsIntersect = (left: Segment, right: Segment): boolean => {
    const cross = (
      start: { x: number; y: number },
      end: { x: number; y: number },
      point: { x: number; y: number },
    ) =>
      (end.x - start.x) * (point.y - start.y) -
      (end.y - start.y) * (point.x - start.x);
    const leftStart = cross(left.start, left.end, right.start);
    const leftEnd = cross(left.start, left.end, right.end);
    const rightStart = cross(right.start, right.end, left.start);
    const rightEnd = cross(right.start, right.end, left.end);
    if (
      ((leftStart > epsilon && leftEnd < -epsilon) ||
        (leftStart < -epsilon && leftEnd > epsilon)) &&
      ((rightStart > epsilon && rightEnd < -epsilon) ||
        (rightStart < -epsilon && rightEnd > epsilon))
    ) {
      return true;
    }
    return (
      (Math.abs(leftStart) <= epsilon &&
        pointOnSegment(right.start, left.start, left.end)) ||
      (Math.abs(leftEnd) <= epsilon &&
        pointOnSegment(right.end, left.start, left.end)) ||
      (Math.abs(rightStart) <= epsilon &&
        pointOnSegment(left.start, right.start, right.end)) ||
      (Math.abs(rightEnd) <= epsilon &&
        pointOnSegment(left.end, right.start, right.end))
    );
  };
  const routeSegments = buses.map(({ union }) =>
    result.edges
      .filter(edge => edge.unionOccurrenceId === union.occurrenceId)
      .flatMap(edgeSegments),
  );
  for (const left of routeSegments[0]!) {
    for (const right of routeSegments[1]!) {
      assert.equal(
        segmentsIntersect(left, right),
        false,
        `unrelated family routes must not intersect: ${left.edgeId} and ${right.edgeId}`,
      );
    }
  }

  const segmentCrossesCardInterior = (
    segment: Segment,
    node: LayoutResult["nodes"][number],
  ): boolean => {
    const left = node.x + epsilon;
    const right = node.x + node.width - epsilon;
    const top = node.y + epsilon;
    const bottom = node.y + node.height - epsilon;
    if (Math.abs(segment.start.y - segment.end.y) <= epsilon) {
      const segmentStart = Math.min(segment.start.x, segment.end.x);
      const segmentEnd = Math.max(segment.start.x, segment.end.x);
      return (
        segment.start.y > top &&
        segment.start.y < bottom &&
        Math.max(segmentStart, left) < Math.min(segmentEnd, right)
      );
    }
    if (Math.abs(segment.start.x - segment.end.x) <= epsilon) {
      const segmentStart = Math.min(segment.start.y, segment.end.y);
      const segmentEnd = Math.max(segment.start.y, segment.end.y);
      return (
        segment.start.x > left &&
        segment.start.x < right &&
        Math.max(segmentStart, top) < Math.min(segmentEnd, bottom)
      );
    }
    assert.fail(`expected orthogonal route segment for ${segment.edgeId}`);
  };
  for (const edge of result.edges) {
    for (const segment of edgeSegments(edge)) {
      for (const node of result.nodes) {
        assert.equal(
          segmentCrossesCardInterior(segment, node),
          false,
          `${edge.id} must not cross the card for ${node.occurrenceId}`,
        );
      }
    }
  }

  const expectedChildrenByUnion = new Map(
    neighboringFamilies.map(family => [
      family.unionId,
      new Set<string>(family.childIds),
    ]),
  );
  for (const { unionId, union } of buses) {
    const expectedChildren = expectedChildrenByUnion.get(unionId)!;
    const renderedChildren = union.childOccurrenceIds.map(occurrenceId =>
      result.nodes.find(node => node.occurrenceId === occurrenceId)?.personId,
    );
    assert.deepEqual(
      new Set(renderedChildren),
      expectedChildren,
      `${unionId} bus owns only its actual children`,
    );
    for (const occurrenceId of union.childOccurrenceIds) {
      const child = result.nodes.find(node => node.occurrenceId === occurrenceId);
      assert.ok(child?.personId);
      const edge = result.edges.find(
        item =>
          item.targetId === occurrenceId &&
          item.unionOccurrenceId === union.occurrenceId &&
          (item.relationshipKinds?.length ?? 0) > 0,
      );
      assert.ok(edge, `missing routed child edge for ${child.personId}`);
      assert.ok(
        edge.relationIds?.every(relationId =>
          relationId.startsWith(`${unionId}-`),
        ),
        `${child.personId} edge contains only ${unionId} relations`,
      );
    }
  }
  assertNoCardOverlap(result, "neighboring expanded family buses");
  assertFamilyRoutesConnected(result, "neighboring expanded family buses");
});

test("six neighboring side families keep independent horizontal buses during incremental expansion", () => {
  const sideFamilies = [
    ...Array.from({ length: 3 }, (_, index) => ({
      branch: "paternal" as const,
      personId: `paternal-side-${index + 1}`,
      partnerId: `paternal-side-${index + 1}-partner`,
      unionId: `paternal-side-${index + 1}-family`,
      childIds: [
        `paternal-side-${index + 1}-child-a`,
        `paternal-side-${index + 1}-child-b`,
      ] as const,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      branch: "maternal" as const,
      personId: `maternal-side-${index + 1}`,
      partnerId: `maternal-side-${index + 1}-partner`,
      unionId: `maternal-side-${index + 1}-family`,
      childIds: [
        `maternal-side-${index + 1}-child-a`,
        `maternal-side-${index + 1}-child-b`,
      ] as const,
    })),
  ];
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("paternal-grandfather", "male"),
      person("paternal-grandmother", "female"),
      person("maternal-grandfather", "male"),
      person("maternal-grandmother", "female"),
      ...sideFamilies.flatMap(family => [
        person(family.personId),
        person(family.partnerId),
        ...family.childIds.map(personId => person(personId)),
      ]),
    ],
    unions: [
      {
        id: "focus-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "paternal-grandparents",
        kind: "partnership",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "maternal-grandparents",
        kind: "partnership",
        memberIds: ["maternal-grandfather", "maternal-grandmother"],
      },
      ...sideFamilies.map(family => ({
        id: family.unionId,
        kind: "partnership" as const,
        memberIds: [family.personId, family.partnerId],
      })),
    ],
    parentChildRelations: [
      ...parentRelations(["father", "mother"], "focus", "focus-parents"),
      ...parentRelations(
        ["paternal-grandfather", "paternal-grandmother"],
        "father",
        "paternal-grandparents",
      ),
      ...parentRelations(
        ["maternal-grandfather", "maternal-grandmother"],
        "mother",
        "maternal-grandparents",
      ),
      ...sideFamilies.flatMap(family => [
        ...parentRelations(
          family.branch === "paternal"
            ? ["paternal-grandfather", "paternal-grandmother"]
            : ["maternal-grandfather", "maternal-grandmother"],
          family.personId,
          family.branch === "paternal"
            ? "paternal-grandparents"
            : "maternal-grandparents",
        ),
        ...family.childIds.flatMap(childId =>
          parentRelations(
            [family.personId, family.partnerId],
            childId,
            family.unionId,
          ),
        ),
      ]),
    ],
  };
  const options = {
    focusPersonId: "focus",
    ancestorDepth: 2,
    descendantDepth: 0,
    collateralDepth: 3,
    maxVisibleNodes: 200,
  } as const;
  const alwaysVisibleChildIds = new Set(["focus", "father", "mother"]);
  let result = run(
    {
      ...graph,
      parentChildRelations: graph.parentChildRelations.filter(relation =>
        alwaysVisibleChildIds.has(relation.childId),
      ),
    },
    options,
  );

  for (let expandedCount = 1; expandedCount <= sideFamilies.length; expandedCount += 1) {
    const expandedPersonIds = new Set(
      sideFamilies.slice(0, expandedCount).flatMap(family => [
        family.personId,
        ...family.childIds,
      ]),
    );
    result = run(
      {
        ...graph,
        parentChildRelations: graph.parentChildRelations.filter(
          relation =>
            alwaysVisibleChildIds.has(relation.childId) ||
            expandedPersonIds.has(relation.childId),
        ),
      },
      {
        ...options,
        previousPositions: result.nodes.map(node => ({
          occurrenceId: node.occurrenceId,
          x: node.x,
          y: node.y,
        })),
      },
    );
  }

  const intervals = sideFamilies.map(family => {
    const union = result.unions.find(item => item.unionId === family.unionId);
    assert.ok(union, `missing ${family.unionId} union after incremental expansion`);
    const bus = result.edges.find(
      edge =>
        edge.kind === "siblings-bus" &&
        edge.unionOccurrenceId === union.occurrenceId,
    );
    assert.ok(bus, `missing ${family.unionId} horizontal child bus`);
    assert.equal(bus.points.length, 2, `${family.unionId} bus must be horizontal`);
    assert.equal(
      bus.points[0]!.y,
      bus.points[1]!.y,
      `${family.unionId} children must share one horizontal bus`,
    );
    return {
      unionId: family.unionId,
      start: Math.min(bus.points[0]!.x, bus.points[1]!.x),
      end: Math.max(bus.points[0]!.x, bus.points[1]!.x),
    };
  });
  const orderedIntervals = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < orderedIntervals.length; index += 1) {
    const previous = orderedIntervals[index - 1]!;
    const current = orderedIntervals[index]!;
    const gap = current.start - previous.end;
    assert.ok(
      gap >= 12,
      `independent family buses must remain at least 12px apart: ${JSON.stringify({ previous, current, gap })}`,
    );
  }

  assertNoCardOverlap(result, "six incrementally expanded side families");
  assertFamilyRoutesConnected(result, "six incrementally expanded side families");
});

test("dense per-child parent sets share one bus without inflating the generation corridor", () => {
  const familyCount = 18;
  const children = Array.from({ length: familyCount }, (_, index) =>
    person(`dense-child-${String(index).padStart(2, "0")}`),
  );
  const graph: FamilyGraphData = {
    persons: [person("dense-father", "male"), person("dense-mother", "female"), ...children],
    unions: children.map((child, index) => ({
      id: `dense-parent-set-${String(index).padStart(2, "0")}`,
      kind: "parent-set" as const,
      memberIds: ["dense-father", "dense-mother"],
      displayOrder: String(index).padStart(2, "0"),
    })),
    parentChildRelations: children.flatMap((child, index) =>
      parentRelations(
        ["dense-father", "dense-mother"],
        child.id,
        `dense-parent-set-${String(index).padStart(2, "0")}`,
      ),
    ),
  };
  const result = run(graph, {
    focusPersonId: "dense-father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
    maxVisibleNodes: 100,
    showAllParentSets: true,
  });
  const buses = result.edges.filter(edge => edge.kind === "siblings-bus");
  const familyStems = result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );
  const childStems = result.edges.filter(edge => edge.id.includes(":child:"));

  assert.equal(buses.length, 1);
  assert.equal(familyStems.length, 1);
  assert.equal(childStems.length, familyCount);
  assert.equal(result.unions.length, familyCount);
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    graph.unions.map(union => union.id).sort(),
  );
  assert.deepEqual(
    childStems.flatMap(edge => edge.relationIds ?? []).sort(),
    graph.parentChildRelations.map(relation => relation.id).sort(),
  );
  assert.equal(
    result.edges.some(
      edge => edge.kind === "partnership" || edge.kind === "separated-partnership",
    ),
    false,
  );
  const parents = ["dense-father", "dense-mother"].map(personId =>
    result.nodes.find(node => node.personId === personId)!,
  );
  const renderedChildren = result.nodes.filter(node =>
    node.personId?.startsWith("dense-child-"),
  );
  const parentBottom = Math.max(...parents.map(node => node.y + node.height));
  const childTop = Math.min(...renderedChildren.map(node => node.y));

  assert.ok(
    childTop - parentBottom <= 82.001,
    `one shared bus must not inflate the default 82px generation corridor: ${childTop - parentBottom}`,
  );
  assertNoCardOverlap(result, "dense shared family bus");
  assertFamilyRoutesConnected(result, "dense shared family bus");
});

test("single known parent with per-child parent sets uses one shared children bus", () => {
  const childCount = 12;
  const children = Array.from({ length: childCount }, (_, index) =>
    person(`single-parent-child-${String(index).padStart(2, "0")}`),
  );
  const graph: FamilyGraphData = {
    persons: [person("single-parent", "male"), ...children],
    unions: children.map((child, index) => ({
      id: `single-parent-set-${String(index).padStart(2, "0")}`,
      kind: "parent-set" as const,
      memberIds: ["single-parent"],
      displayOrder: String(index).padStart(2, "0"),
      expectedParentSlots: 2,
    })),
    parentChildRelations: children.flatMap((child, index) =>
      parentRelations(
        ["single-parent"],
        child.id,
        `single-parent-set-${String(index).padStart(2, "0")}`,
      ),
    ),
  };
  const result = run(graph, {
    focusPersonId: "single-parent",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
    maxVisibleNodes: 100,
    showAllParentSets: true,
    showUnknownParentPlaceholders: true,
  });
  const parent = result.nodes.find(
    node => node.personId === "single-parent",
  )!;
  const renderedChildren = result.nodes.filter(node =>
    node.personId?.startsWith("single-parent-child-"),
  );
  const buses = result.edges.filter(edge => edge.kind === "siblings-bus");
  const memberStems = result.edges.filter(edge =>
    edge.id.includes(":member:"),
  );
  const familyStems = result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );
  const childStems = result.edges.filter(edge => edge.id.includes(":child:"));
  const placeholders = result.nodes.filter(node => node.kind === "placeholder");

  assert.equal(renderedChildren.length, childCount);
  assert.equal(
    placeholders.length,
    childCount,
    "the fixture must exercise one unique missing-parent placeholder per parent set",
  );
  assert.equal(buses.length, 1, "all children must share one horizontal bus");
  assert.equal(memberStems.length, 1, "the visible parent needs one union stem");
  assert.equal(familyStems.length, 1, "the family needs one stem to its bus");
  assert.equal(childStems.length, childCount);

  const bus = buses[0]!;
  const memberStem = memberStems[0]!;
  const familyStem = familyStems[0]!;
  const epsilon = 0.001;
  assert.equal(bus.points.length, 2);
  assert.ok(
    Math.abs(bus.points[0]!.y - bus.points[1]!.y) <= epsilon,
    "the shared children bus must be horizontal",
  );
  assert.ok(
    memberStem.points.every(
      point => Math.abs(point.x - memberStem.points[0]!.x) <= epsilon,
    ),
    "the parent-to-union path must be vertical",
  );
  assert.ok(
    familyStem.points.every(
      point => Math.abs(point.x - familyStem.points[0]!.x) <= epsilon,
    ),
    "the union-to-bus path must be vertical",
  );
  assert.deepEqual(memberStem.points.at(-1), familyStem.points[0]);
  assert.ok(
    Math.abs(familyStem.points.at(-1)!.y - bus.points[0]!.y) <= epsilon,
    "the single family stem must terminate on the shared bus",
  );
  assert.ok(
    Math.abs(memberStem.points[0]!.x - (parent.x + parent.width / 2)) <=
      epsilon,
  );
  assert.ok(
    Math.abs(memberStem.points[0]!.y - (parent.y + parent.height)) <= epsilon,
  );

  for (const childStem of childStems) {
    assert.ok(
      childStem.points.every(
        point => Math.abs(point.x - childStem.points[0]!.x) <= epsilon,
      ),
      `${childStem.id} must be one vertical drop from the shared bus`,
    );
    assert.ok(
      Math.abs(childStem.points[0]!.y - bus.points[0]!.y) <= epsilon,
      `${childStem.id} must start on the shared bus`,
    );
  }

  assert.equal(result.unions.length, childCount);
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    graph.unions.map(union => union.id).sort(),
  );
  assert.ok(
    result.unions.every(union => union.childOccurrenceIds.length === 1),
    "visual merging must retain every per-child LayoutUnion",
  );
  assert.deepEqual(
    childStems.flatMap(edge => edge.relationIds ?? []).sort(),
    graph.parentChildRelations.map(relation => relation.id).sort(),
  );
  assertFamilyRoutesConnected(result, "single-parent shared family bus");
  assertNoCardOverlap(result, "single-parent shared family bus");
});

test("familyGroupId joins a partnership to single-parent child sets on one bus", () => {
  const childCount = 12;
  const familyGroupId = "editable-family-group";
  const children = Array.from({ length: childCount }, (_, index) =>
    person(`grouped-child-${String(index).padStart(2, "0")}`),
  );
  const graph: FamilyGraphData = {
    persons: [
      person("grouped-father", "male"),
      person("grouped-mother", "female"),
      ...children,
    ],
    unions: [
      {
        id: "grouped-partnership",
        kind: "partnership",
        memberIds: ["grouped-father", "grouped-mother"],
        familyGroupId,
        status: "current",
        displayOrder: "00",
      },
      ...children.map((child, index) => ({
        id: `grouped-parent-set-${String(index).padStart(2, "0")}`,
        kind: "parent-set" as const,
        memberIds: ["grouped-father"],
        familyGroupId,
        displayOrder: String(index + 1).padStart(2, "0"),
        expectedParentSlots: 2,
      })),
    ],
    parentChildRelations: children.flatMap((child, index) =>
      parentRelations(
        ["grouped-father"],
        child.id,
        `grouped-parent-set-${String(index).padStart(2, "0")}`,
      ),
    ),
  };
  const result = run(graph, {
    focusPersonId: "grouped-father",
    ancestorDepth: 0,
    descendantDepth: 1,
    collateralDepth: 1,
    maxVisibleNodes: 100,
    showAllParentSets: true,
    showUnknownParentPlaceholders: true,
  });
  const partnershipUnion = result.unions.find(
    union => union.unionId === "grouped-partnership",
  );
  const partnershipEdges = result.edges.filter(
    edge => edge.kind === "partnership" || edge.kind === "separated-partnership",
  );
  const familyStems = result.edges.filter(edge =>
    edge.id.endsWith(":family-stem"),
  );
  const buses = result.edges.filter(edge => edge.kind === "siblings-bus");
  const childStems = result.edges.filter(edge => edge.id.includes(":child:"));
  const placeholders = result.nodes.filter(node => node.kind === "placeholder");

  assert.ok(partnershipUnion);
  assert.equal(placeholders.length, childCount);
  assert.equal(partnershipEdges.length, 1);
  assert.equal(familyStems.length, 1);
  assert.equal(buses.length, 1);
  assert.equal(childStems.length, childCount);
  assert.equal(
    partnershipEdges[0]!.unionOccurrenceId,
    partnershipUnion.occurrenceId,
  );
  assert.equal(
    familyStems[0]!.unionOccurrenceId,
    partnershipUnion.occurrenceId,
    "the shared family stem must be anchored to the explicit partnership",
  );
  assert.equal(
    buses[0]!.unionOccurrenceId,
    partnershipUnion.occurrenceId,
    "the shared children bus must be anchored to the explicit partnership",
  );
  assert.equal(result.unions.length, childCount + 1);
  assert.deepEqual(
    result.unions.map(union => union.unionId).sort(),
    graph.unions.map(union => union.id).sort(),
  );
  assert.deepEqual(
    childStems.flatMap(edge => edge.relationIds ?? []).sort(),
    graph.parentChildRelations.map(relation => relation.id).sort(),
  );
  assertFamilyRoutesConnected(result, "family-group shared family bus");
  assertNoCardOverlap(result, "family-group shared family bus");
});

test("PAVA packing preserves order, removes overlap, and is deterministic", () => {
  const overlapping = [
    { id: "a", width: 100, desiredX: 0, weight: 1 },
    { id: "b", width: 140, desiredX: 10, weight: 1 },
    { id: "c", width: 80, desiredX: -5, weight: 1 },
  ];
  const packed = packLayer(overlapping, 20);
  assert.ok(packed.get("b")! - packed.get("a")! >= 140);
  assert.ok(packed.get("c")! - packed.get("b")! >= 130);

  const deterministicItems = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    width: 40 + (index % 4) * 7,
    desiredX: Math.sin(index) * 20,
    weight: 1 + (index % 3),
  }));
  const first = [...packLayer(deterministicItems, 12)];
  const second = [...packLayer(deterministicItems, 12)];
  assert.deepEqual(first, second);
  assert.ok(first.every(([, x]) => Number.isFinite(x)));
});

test("neighboring descendant families reserve subtree width and stay centered", () => {
  const families = [
    { id: "left", childCount: 1, birth: "1870" },
    { id: "center", childCount: 5, birth: "1871" },
    { id: "right", childCount: 3, birth: "1872" },
  ] as const;
  const rootChildren = families.map(family => `branch-${family.id}`);
  const graph: FamilyGraphData = {
    persons: [
      person("root", "male"),
      person("root-partner", "female"),
      ...families.flatMap(family => [
        person(`branch-${family.id}`, "male", family.birth),
        person(`partner-${family.id}`, "female"),
        ...Array.from({ length: family.childCount }, (_, index) =>
          person(
            `${family.id}-child-${index + 1}`,
            index % 2 === 0 ? "male" : "female",
            String(1900 + index),
          ),
        ),
      ]),
    ],
    unions: [
      {
        id: "root-family",
        kind: "partnership",
        memberIds: ["root", "root-partner"],
      },
      ...families.map(family => ({
        id: `${family.id}-family`,
        kind: "partnership" as const,
        memberIds: [`branch-${family.id}`, `partner-${family.id}`],
      })),
    ],
    parentChildRelations: [
      ...rootChildren.flatMap(childId =>
        parentRelations(["root", "root-partner"], childId, "root-family"),
      ),
      ...families.flatMap(family =>
        Array.from({ length: family.childCount }, (_, index) =>
          `${family.id}-child-${index + 1}`,
        ).flatMap(childId =>
          parentRelations(
            [`branch-${family.id}`, `partner-${family.id}`],
            childId,
            `${family.id}-family`,
          ),
        ),
      ),
    ],
  };
  const options = {
    focusPersonId: "root",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
  } as const;
  const result = run(buildAllDescendantsProjection({
    graph,
    rootPersonId: "root",
  }).graph, options);
  const reversedGraph: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions]
      .reverse()
      .map(union => ({ ...union, memberIds: [...union.memberIds].reverse() })),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  const reversed = run(buildAllDescendantsProjection({
    graph: reversedGraph,
    rootPersonId: "root",
  }).graph, options);
  assert.deepEqual(projectLayout(reversed), projectLayout(result));
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  const contours = families.map(family => {
    const union = result.unions.find(item => item.unionId === `${family.id}-family`);
    assert.ok(union, `missing ${family.id} family`);
    const parents = union.memberOccurrenceIds.map(id => nodesByOccurrenceId.get(id)!);
    const children = union.childOccurrenceIds.map(id => nodesByOccurrenceId.get(id)!);
    assert.equal(parents.length, 2);
    assert.equal(children.length, family.childCount);
    const parentCenter =
      parents.reduce((sum, node) => sum + node.x + node.width / 2, 0) /
      parents.length;
    const childCenters = children.map(node => node.x + node.width / 2);
    const childrenCenter =
      (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
    assert.ok(
      Math.abs(parentCenter - childrenCenter) < 0.001,
      `${family.id} parents at ${parentCenter} must center over children at ${childrenCenter}`,
    );
    const bus = result.edges.find(
      edge =>
        edge.kind === "siblings-bus" &&
        edge.unionOccurrenceId === union.occurrenceId,
    );
    assert.ok(bus);
    assert.equal(bus.points.length, 2);
    assert.ok(Math.abs(bus.points[0]!.y - bus.points[1]!.y) < 0.001);
    const childStems = result.edges.filter(edge =>
      edge.id.startsWith(`${bus.id.slice(0, -":siblings".length)}:child:`),
    );
    assert.equal(childStems.length, family.childCount);
    assert.ok(
      childStems.every(
        edge =>
          edge.points.length === 2 &&
          Math.abs(edge.points[0]!.x - edge.points[1]!.x) < 0.001,
      ),
    );
    const cards = [...parents, ...children];
    return {
      id: family.id,
      center: parentCenter,
      left: Math.min(...cards.map(node => node.x)),
      right: Math.max(...cards.map(node => node.x + node.width)),
      busLeft: Math.min(bus.points[0]!.x, bus.points[1]!.x),
      busRight: Math.max(bus.points[0]!.x, bus.points[1]!.x),
    };
  }).sort((left, right) => left.center - right.center);
  assert.deepEqual(
    contours.map(contour => contour.id),
    ["left", "center", "right"],
  );

  for (let index = 1; index < contours.length; index += 1) {
    const previous = contours[index - 1]!;
    const current = contours[index]!;
    assert.ok(
      previous.right + 28 <= current.left,
      `descendant contours must be disjoint: ${JSON.stringify({ previous, current })}`,
    );
    assert.ok(
      previous.busRight + 12 <= current.busLeft,
      `descendant family buses must be disjoint: ${JSON.stringify({ previous, current })}`,
    );
  }
  assertNoCardOverlap(result, "neighboring descendant subtrees");
  assertFamilyRoutesConnected(result, "neighboring descendant subtrees");
});

test("a growing middle descendant family pushes neighboring couples outward despite saved positions", () => {
  const familyIds = ["left", "center", "right"] as const;
  const buildGraph = (centerChildCount: number): FamilyGraphData => {
    const childCounts = new Map<string, number>([
      ["left", 2],
      ["center", centerChildCount],
      ["right", 2],
    ]);
    return {
      persons: [
        person("growth-root", "male"),
        person("growth-root-partner", "female"),
        ...familyIds.flatMap((familyId, familyIndex) => [
          person(
            `growth-${familyId}`,
            "male",
            String(1870 + familyIndex),
          ),
          person(`growth-${familyId}-partner`, "female"),
          ...Array.from(
            { length: childCounts.get(familyId)! },
            (_, childIndex) =>
              person(
                `growth-${familyId}-child-${childIndex + 1}`,
                "unknown",
                String(1900 + childIndex),
              ),
          ),
        ]),
      ],
      unions: [
        {
          id: "growth-root-family",
          kind: "partnership",
          memberIds: ["growth-root", "growth-root-partner"],
        },
        ...familyIds.map(familyId => ({
          id: `growth-${familyId}-family`,
          kind: "partnership" as const,
          memberIds: [
            `growth-${familyId}`,
            `growth-${familyId}-partner`,
          ],
        })),
      ],
      parentChildRelations: [
        ...familyIds.flatMap(familyId =>
          parentRelations(
            ["growth-root", "growth-root-partner"],
            `growth-${familyId}`,
            "growth-root-family",
          ),
        ),
        ...familyIds.flatMap(familyId =>
          Array.from(
            { length: childCounts.get(familyId)! },
            (_, childIndex) => `growth-${familyId}-child-${childIndex + 1}`,
          ).flatMap(childId =>
            parentRelations(
              [`growth-${familyId}`, `growth-${familyId}-partner`],
              childId,
              `growth-${familyId}-family`,
            ),
          ),
        ),
      ],
    };
  };
  const inspect = (result: LayoutResult) => {
    const nodesByOccurrenceId = new Map(
      result.nodes.map(node => [node.occurrenceId, node]),
    );
    const contours = familyIds.map(familyId => {
      const union = result.unions.find(
        item => item.unionId === `growth-${familyId}-family`,
      );
      assert.ok(union);
      const parents = union.memberOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      const children = union.childOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      const parentCenter =
        parents.reduce((sum, node) => sum + node.x + node.width / 2, 0) /
        parents.length;
      const childCenters = children.map(node => node.x + node.width / 2);
      const childCenter =
        (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      assert.ok(Math.abs(parentCenter - childCenter) < 0.001);
      const cards = [...parents, ...children];
      return {
        familyId,
        center: parentCenter,
        left: Math.min(...cards.map(node => node.x)),
        right: Math.max(...cards.map(node => node.x + node.width)),
      };
    }).sort((left, right) => left.center - right.center);
    assert.deepEqual(
      contours.map(contour => contour.familyId),
      familyIds,
    );
    for (let index = 1; index < contours.length; index += 1) {
      assert.ok(contours[index - 1]!.right + 28 <= contours[index]!.left);
    }
    const focus = result.nodes.find(node => node.personId === "growth-root");
    assert.ok(focus);
    assert.ok(Math.abs(focus.x + focus.width / 2) < 0.001);
    assertNoCardOverlap(result, "incrementally growing descendant family");
    assertFamilyRoutesConnected(result, "incrementally growing descendant family");
    return contours;
  };

  let previousPositions: PreviousNodePosition[] | undefined;
  let initial: ReturnType<typeof inspect> | undefined;
  let final: ReturnType<typeof inspect> | undefined;
  for (let childCount = 1; childCount <= 6; childCount += 1) {
    const graph = buildGraph(childCount);
    const result = run(buildAllDescendantsProjection({
      graph,
      rootPersonId: "growth-root",
    }).graph, {
      focusPersonId: "growth-root",
      ancestorDepth: 0,
      descendantDepth: 10,
      collateralDepth: 0,
      maxVisibleNodes: 100,
      ...(previousPositions ? { previousPositions } : {}),
    });
    const contours = inspect(result);
    if (childCount === 1) initial = contours;
    if (childCount === 6) final = contours;
    previousPositions = result.nodes.map(node => ({
      occurrenceId: node.occurrenceId,
      x: node.x,
      y: node.y,
    }));
  }
  assert.ok(initial && final);
  assert.ok(final[0]!.center < initial[0]!.center);
  assert.ok(final[2]!.center > initial[2]!.center);
});

test("multiple partners keep the focus-line family primary and place side children below their own partner", () => {
  const families = [
    { id: "side-a", partnerId: "partner-a", childCount: 2 },
    { id: "primary", partnerId: "partner-primary", childCount: 3 },
    { id: "side-b", partnerId: "partner-b", childCount: 2 },
  ] as const;
  const graph: FamilyGraphData = {
    persons: [
      person("multi-hub", "male", "1850"),
      person("partner-a", "female", "1851"),
      person("partner-primary", "female", "1852"),
      person("partner-b", "female", "1853"),
      ...families.flatMap(family =>
        Array.from({ length: family.childCount }, (_, index) =>
          person(
            `${family.id}-child-${index + 1}`,
            "unknown",
            String(1880 + index),
          ),
        ),
      ),
    ],
    unions: families.map(family => ({
      id: `${family.id}-family`,
      kind: "partnership" as const,
      memberIds: ["multi-hub", family.partnerId],
    })),
    parentChildRelations: families.flatMap(family =>
      Array.from(
        { length: family.childCount },
        (_, index) => `${family.id}-child-${index + 1}`,
      ).flatMap(childId =>
        parentRelations(
          ["multi-hub", family.partnerId],
          childId,
          `${family.id}-family`,
        ),
      ),
    ),
  };
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "multi-hub",
    originalFocusPersonId: "primary-child-1",
  });
  assert.deepEqual(projection.focusLineagePersonIds, [
    "multi-hub",
    "partner-primary",
    "primary-child-1",
  ]);
  const options = {
    focusPersonId: "multi-hub",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  } as const;
  const familyUnionIds = families.map(family => `${family.id}-family`);
  const inspectResult = (result: LayoutResult, context: string): void => {
    const nodesByOccurrenceId = new Map(
      result.nodes.map(node => [node.occurrenceId, node]),
    );
    const blocks = families.map(family => {
      const union = result.unions.find(
        candidate => candidate.unionId === `${family.id}-family`,
      );
      assert.ok(union);
      const members = union.memberOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      const hub = members.find(node => node.personId === "multi-hub");
      const partner = members.find(node => node.personId === family.partnerId);
      assert.ok(hub && partner);
      const children = union.childOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      const childCenters = children.map(node => node.x + node.width / 2);
      const childrenCenter =
        (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      const partnerCenter = partner.x + partner.width / 2;
      const pairCenter =
        (hub.x + hub.width / 2 + partnerCenter) / 2;
      const expectedCenter = family.id === "primary"
        ? pairCenter
        : partnerCenter;
      assert.ok(
        Math.abs(childrenCenter - expectedCenter) < 0.001,
        `${context}: ${family.id} children at ${childrenCenter} must align ` +
          `to ${expectedCenter}`,
      );
      if (family.id === "primary") {
        const orderedMembers = [...members].sort(
          (left, right) => left.x - right.x,
        );
        assert.ok(
          orderedMembers[1]!.x -
            (orderedMembers[0]!.x + orderedMembers[0]!.width) <= 18,
          `${context}: the primary bloodline pair must remain adjacent`,
        );
      }
      const branchCards = family.id === "primary"
        ? [hub, partner, ...children]
        : [partner, ...children];
      const bus = result.edges.find(
        edge =>
          edge.kind === "siblings-bus" &&
          edge.unionOccurrenceId === union.occurrenceId,
      );
      assert.ok(bus);
      return {
        id: family.id,
        center: childrenCenter,
        left: Math.min(...branchCards.map(node => node.x)),
        right: Math.max(...branchCards.map(node => node.x + node.width)),
        busLeft: Math.min(bus.points[0]!.x, bus.points[1]!.x),
        busRight: Math.max(bus.points[0]!.x, bus.points[1]!.x),
      };
    }).sort((left, right) => left.center - right.center);
    assert.equal(blocks[1]!.id, "primary", `${context}: primary block`);
    for (let index = 1; index < blocks.length; index += 1) {
      assert.ok(
        blocks[index - 1]!.right + 28 <= blocks[index]!.left,
        `${context}: family card contours must be disjoint`,
      );
      assert.ok(
        blocks[index - 1]!.busRight + 12 <= blocks[index]!.busLeft,
        `${context}: family buses must be disjoint`,
      );
    }
    assertNoCardOverlap(result, context);
    assertFamilyRoutesConnected(result, context);
    assertNoUnrelatedFamilyRouteIntersections(
      result,
      familyUnionIds,
      context,
    );
    assertParallelSidePartnerLines(
      result,
      "multi-hub",
      familyUnionIds,
      context,
    );
  };

  const result = run(projection.graph, options);
  inspectResult(result, "multiple partner descendant families");

  const previousPositions = result.nodes.map((node, index) => ({
    occurrenceId: node.occurrenceId,
    x: (index % 2 === 0 ? -1 : 1) * (4_000 + index * 733),
    y: -node.y + (index % 3) * 500,
  }));
  const restored = run(projection.graph, {
    ...options,
    previousPositions,
  });
  inspectResult(restored, "multiple partners with adversarial saved positions");
  assert.deepEqual(
    projectLayout(restored),
    projectLayout(result),
    "stale saved positions must not change the semantic descendants layout",
  );

  const reversedGraph: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions]
      .reverse()
      .map(union => ({ ...union, memberIds: [...union.memberIds].reverse() })),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  const reversedProjection = buildAllDescendantsProjection({
    graph: reversedGraph,
    rootPersonId: "multi-hub",
    originalFocusPersonId: "primary-child-1",
  });
  const reversed = run(reversedProjection.graph, {
    ...options,
    primaryLineagePersonIds: reversedProjection.focusLineagePersonIds,
  });
  inspectResult(reversed, "multiple partners from reversed graph input");
  assert.deepEqual(
    projectLayout(reversed),
    projectLayout(result),
  );
});

test("parent-set-only side families keep their layout junction on both parent stems and the family stem", () => {
  const families = [
    { id: "left", partnerId: "parent-set-partner-left" },
    { id: "primary", partnerId: "parent-set-partner-primary" },
    { id: "right", partnerId: "parent-set-partner-right" },
  ] as const;
  const graph: FamilyGraphData = {
    persons: [
      person("parent-set-hub", "male", "1850"),
      ...families.flatMap((family, familyIndex) => [
        person(family.partnerId, "female", String(1851 + familyIndex)),
        person(`${family.id}-parent-set-child-1`, "unknown", "1880"),
        person(`${family.id}-parent-set-child-2`, "unknown", "1882"),
      ]),
    ],
    unions: families.map(family => ({
      id: `${family.id}-parent-set`,
      kind: "parent-set" as const,
      memberIds: ["parent-set-hub", family.partnerId],
    })),
    parentChildRelations: families.flatMap(family =>
      [1, 2].flatMap(childIndex =>
        parentRelations(
          ["parent-set-hub", family.partnerId],
          `${family.id}-parent-set-child-${childIndex}`,
          `${family.id}-parent-set`,
        ),
      ),
    ),
  };
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "parent-set-hub",
    originalFocusPersonId: "primary-parent-set-child-1",
  });
  const result = run(projection.graph, {
    focusPersonId: "parent-set-hub",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  });

  const epsilon = 0.001;
  const pointOnPolyline = (
    point: { x: number; y: number },
    edge: LayoutResult["edges"][number],
  ): boolean => edge.points.slice(1).some((end, index) => {
    const start = edge.points[index]!;
    if (Math.abs(start.x - end.x) <= epsilon) {
      return (
        Math.abs(point.x - start.x) <= epsilon &&
        point.y >= Math.min(start.y, end.y) - epsilon &&
        point.y <= Math.max(start.y, end.y) + epsilon
      );
    }
    if (Math.abs(start.y - end.y) <= epsilon) {
      return (
        Math.abs(point.y - start.y) <= epsilon &&
        point.x >= Math.min(start.x, end.x) - epsilon &&
        point.x <= Math.max(start.x, end.x) + epsilon
      );
    }
    return false;
  });

  for (const familyId of ["left", "right"] as const) {
    const union = result.unions.find(
      candidate => candidate.unionId === `${familyId}-parent-set`,
    );
    assert.ok(union, `missing ${familyId} parent-set layout junction`);
    const junction = { x: union.x, y: union.y };
    const memberStems = result.edges.filter(
      edge =>
        edge.unionOccurrenceId === union.occurrenceId &&
        edge.kind === "union-stem" &&
        edge.id.includes(":member:"),
    );
    assert.equal(memberStems.length, 2, `${familyId} member stem count`);
    for (const memberStem of memberStems) {
      assert.ok(
        pointOnPolyline(junction, memberStem),
        `${familyId} junction must lie on ${memberStem.id}`,
      );
    }
    const familyStem = result.edges.find(
      edge =>
        edge.unionOccurrenceId === union.occurrenceId &&
        edge.id.endsWith(":family-stem"),
    );
    assert.ok(familyStem, `missing ${familyId} family stem`);
    assert.ok(
      pointOnPolyline(junction, familyStem),
      `${familyId} junction must lie on its family stem`,
    );
  }
  assertNoCardOverlap(result, "parent-set-only multi-partner hub");
});

test("four side partners retain isolated family corridors around one primary lineage", () => {
  const families = [
    { id: "side-a", partnerId: "five-partner-a", childCount: 1 },
    { id: "side-b", partnerId: "five-partner-b", childCount: 4 },
    { id: "primary", partnerId: "five-partner-primary", childCount: 3 },
    { id: "side-c", partnerId: "five-partner-c", childCount: 2 },
    { id: "side-d", partnerId: "five-partner-d", childCount: 5 },
  ] as const;
  const hubUnionIds = families.map(family => `five-${family.id}-family`);
  const nestedUnionId = "five-primary-grandchild-family";
  const graph: FamilyGraphData = {
    persons: [
      person("five-hub", "male", "1840"),
      ...families.flatMap((family, familyIndex) => [
        person(
          family.partnerId,
          "female",
          String(1841 + familyIndex),
        ),
        ...Array.from({ length: family.childCount }, (_, childIndex) =>
          person(
            `${family.id}-child-${childIndex + 1}`,
            childIndex % 2 === 0 ? "male" : "female",
            String(1870 + childIndex),
          ),
        ),
      ]),
      person("primary-child-partner", "female", "1872"),
      person("nested-focus", "male", "1900"),
    ],
    unions: [
      ...families.map((family, index) => ({
        id: `five-${family.id}-family`,
        kind: "partnership" as const,
        memberIds: ["five-hub", family.partnerId],
        displayOrder: String(index + 1).padStart(2, "0"),
      })),
      {
        id: nestedUnionId,
        kind: "partnership",
        memberIds: ["primary-child-1", "primary-child-partner"],
      },
    ],
    parentChildRelations: [
      ...families.flatMap(family =>
        Array.from(
          { length: family.childCount },
          (_, index) => `${family.id}-child-${index + 1}`,
        ).flatMap(childId =>
          parentRelations(
            ["five-hub", family.partnerId],
            childId,
            `five-${family.id}-family`,
          ),
        ),
      ),
      ...parentRelations(
        ["primary-child-1", "primary-child-partner"],
        "nested-focus",
        nestedUnionId,
      ),
    ],
  };
  const project = (source: FamilyGraphData) =>
    buildAllDescendantsProjection({
      graph: source,
      rootPersonId: "five-hub",
      originalFocusPersonId: "nested-focus",
    });
  const projection = project(graph);
  assert.deepEqual(projection.focusLineagePersonIds, [
    "five-hub",
    "five-partner-primary",
    "nested-focus",
    "primary-child-1",
    "primary-child-partner",
  ]);
  const options = {
    focusPersonId: "five-hub",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  } as const;
  const allUnionIds = [...hubUnionIds, nestedUnionId];

  const inspect = (result: LayoutResult, context: string): void => {
    const hubCards = result.nodes.filter(node => node.personId === "five-hub");
    assert.equal(hubCards.length, 1, `${context}: one canonical hub card`);
    const hub = hubCards[0]!;
    const nodesByOccurrenceId = new Map(
      result.nodes.map(node => [node.occurrenceId, node]),
    );
    const hubOccurrences = new Set<string>();

    for (const family of families) {
      const union = result.unions.find(
        candidate => candidate.unionId === `five-${family.id}-family`,
      );
      assert.ok(union, `${context}: missing ${family.id} union`);
      const members = union.memberOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      const familyHub = members.find(node => node.personId === "five-hub");
      const partner = members.find(node => node.personId === family.partnerId);
      assert.ok(familyHub && partner, `${context}: ${family.id} parents`);
      hubOccurrences.add(familyHub.occurrenceId);
      const children = union.childOccurrenceIds.map(
        occurrenceId => nodesByOccurrenceId.get(occurrenceId)!,
      );
      assert.equal(
        children.length,
        family.childCount,
        `${context}: ${family.id} child count`,
      );
      const childCenters = children.map(node => node.x + node.width / 2);
      const childCenter =
        (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      const partnerCenter = partner.x + partner.width / 2;
      const hubCenter = familyHub.x + familyHub.width / 2;
      const expectedCenter = family.id === "primary"
        ? (hubCenter + partnerCenter) / 2
        : partnerCenter;
      assert.ok(
        Math.abs(childCenter - expectedCenter) < 0.001,
        `${context}: ${family.id} children at ${childCenter} must align ` +
          `to ${expectedCenter}`,
      );
      if (family.id === "primary") {
        const ordered = [familyHub, partner].sort(
          (left, right) => left.x - right.x,
        );
        assert.ok(
          ordered[1]!.x - (ordered[0]!.x + ordered[0]!.width) <= 18,
          `${context}: primary pair must remain adjacent`,
        );
      }
    }
    assert.deepEqual(
      [...hubOccurrences],
      [hub.occurrenceId],
      `${context}: every family must reuse the canonical hub occurrence`,
    );
    assertNoCardOverlap(result, context);
    assertFamilyRoutesConnected(result, context);
    assertNoUnrelatedFamilyRouteIntersections(result, allUnionIds, context);
    assertParallelSidePartnerLines(
      result,
      "five-hub",
      hubUnionIds,
      context,
    );
  };

  const result = run(projection.graph, options);
  inspect(result, "five partner descendant layout");

  const previousPositions = result.nodes.map((node, index) => ({
    occurrenceId: node.occurrenceId,
    x: (index % 2 === 0 ? 1 : -1) * (8_000 + index * 977),
    y: -node.y + (index % 4) * 700,
  }));
  const restored = run(projection.graph, {
    ...options,
    previousPositions,
  });
  inspect(restored, "five partners with adversarial saved positions");
  assert.deepEqual(
    projectLayout(restored),
    projectLayout(result),
    "adversarial saved positions must not alter the five-family layout",
  );

  const reversedGraph: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions]
      .reverse()
      .map(union => ({ ...union, memberIds: [...union.memberIds].reverse() })),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  const reversedProjection = project(reversedGraph);
  const reversed = run(reversedProjection.graph, {
    ...options,
    primaryLineagePersonIds: reversedProjection.focusLineagePersonIds,
  });
  inspect(reversed, "five partner reversed graph input");
  assert.deepEqual(projectLayout(reversed), projectLayout(result));
});

test("a visible childless partner remains a deterministic side satellite in a loaded partner star", () => {
  const childFamilies = ["primary", "a", "b"] as const;
  const graph: FamilyGraphData = {
    persons: [
      person("childless-hub", "male", "1850"),
      ...childFamilies.map(familyId =>
        person(`childless-partner-${familyId}`, "female"),
      ),
      person("childless-partner-empty", "female"),
      ...childFamilies.map(familyId =>
        person(`childless-child-${familyId}`, "unknown", "1880"),
      ),
    ],
    unions: [
      ...childFamilies.map(familyId => ({
        id: `childless-union-${familyId}`,
        kind: "partnership" as const,
        memberIds: ["childless-hub", `childless-partner-${familyId}`],
      })),
      {
        id: "childless-union-empty",
        kind: "partnership",
        memberIds: ["childless-hub", "childless-partner-empty"],
      },
    ],
    parentChildRelations: childFamilies.flatMap(familyId =>
      parentRelations(
        ["childless-hub", `childless-partner-${familyId}`],
        `childless-child-${familyId}`,
        `childless-union-${familyId}`,
      ),
    ),
  };
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "childless-hub",
    originalFocusPersonId: "childless-child-primary",
  });
  const options = {
    focusPersonId: "childless-hub",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  } as const;
  const familyUnionIds = [
    ...childFamilies.map(familyId => `childless-union-${familyId}`),
    "childless-union-empty",
  ];

  const inspect = (result: LayoutResult, context: string): void => {
    const hubCards = result.nodes.filter(
      node => node.personId === "childless-hub",
    );
    const primaryPartner = result.nodes.find(
      node => node.personId === "childless-partner-primary",
    );
    const emptyPartner = result.nodes.find(
      node => node.personId === "childless-partner-empty",
    );
    assert.equal(hubCards.length, 1, `${context}: one canonical hub card`);
    assert.ok(primaryPartner && emptyPartner);

    const hub = hubCards[0]!;
    const primaryLeft = Math.min(hub.x, primaryPartner.x);
    const primaryRight = Math.max(
      hub.x + hub.width,
      primaryPartner.x + primaryPartner.width,
    );
    assert.ok(
      emptyPartner.x + emptyPartner.width + 28 <= primaryLeft ||
        primaryRight + 28 <= emptyPartner.x,
      `${context}: the childless partner must sit outside the primary pair`,
    );

    const emptyUnion = result.unions.find(
      union => union.unionId === "childless-union-empty",
    );
    assert.ok(emptyUnion);
    assert.equal(emptyUnion.childOccurrenceIds.length, 0);
    const emptyPartnership = result.edges.find(
      edge =>
        edge.unionOccurrenceId === emptyUnion.occurrenceId &&
        (edge.kind === "partnership" ||
          edge.kind === "separated-partnership"),
    );
    assert.ok(emptyPartnership);
    assert.equal(
      emptyPartnership.points.length,
      2,
      `${context}: the childless partner must use one direct side line`,
    );
    assert.ok(
      emptyPartnership.points.every(
        point =>
          point.y > Math.max(hub.y, emptyPartner.y) &&
          point.y <
            Math.min(hub.y + hub.height, emptyPartner.y + emptyPartner.height),
      ),
      `${context}: the partnership must connect side ports inside the row`,
    );

    assertNoCardOverlap(result, context);
    assertFamilyRoutesConnected(result, context);
    assertNoUnrelatedFamilyRouteIntersections(
      result,
      familyUnionIds,
      context,
    );
  };

  const result = run(projection.graph, options);
  inspect(result, "partner star with a childless satellite");
  const previousPositions = result.nodes.map((node, index) => ({
    occurrenceId: node.occurrenceId,
    x: (index % 2 === 0 ? 1 : -1) * (6_000 + index * 911),
    y: -node.y + (index % 4) * 700,
  }));
  const restored = run(projection.graph, {
    ...options,
    previousPositions,
  });
  inspect(restored, "childless satellite with adversarial saved positions");
  assert.deepEqual(
    projectLayout(restored),
    projectLayout(result),
    "saved coordinates must not detach or overlap a childless partner",
  );
});

test("a root-only descendant family stays centered below the hub beside a childless partner", () => {
  const childIds = ["mixed-solo-older", "mixed-solo-middle", "mixed-solo-younger"];
  const graph: FamilyGraphData = {
    persons: [
      person("mixed-solo-root", "male", "1840"),
      person("mixed-solo-childless-partner", "female", "1842"),
      ...childIds.map((childId, index) =>
        person(childId, "unknown", String(1870 + index)),
      ),
    ],
    unions: [
      {
        id: "mixed-solo-childless-partnership",
        kind: "partnership",
        memberIds: ["mixed-solo-root", "mixed-solo-childless-partner"],
      },
      ...childIds.map((childId, index) => ({
        id: `mixed-solo-parent-set-${index + 1}`,
        kind: "parent-set" as const,
        memberIds: ["mixed-solo-root"],
        familyGroupId: `mixed-solo-technical-group-${index + 1}`,
      })),
    ],
    parentChildRelations: childIds.flatMap((childId, index) =>
      parentRelations(
        ["mixed-solo-root"],
        childId,
        `mixed-solo-parent-set-${index + 1}`,
      ),
    ),
  };
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "mixed-solo-root",
    originalFocusPersonId: "mixed-solo-middle",
  });
  const result = run(projection.graph, {
    focusPersonId: "mixed-solo-root",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  });
  const root = result.nodes.find(node => node.personId === "mixed-solo-root");
  const partner = result.nodes.find(
    node => node.personId === "mixed-solo-childless-partner",
  );
  const children = childIds.map(childId =>
    result.nodes.find(node => node.personId === childId),
  );
  assert.ok(root && partner && children.every(Boolean));

  const rootCenter = root.x + root.width / 2;
  const childCenters = children.map(node => node!.x + node!.width / 2);
  const childMidpoint =
    (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
  assert.ok(
    Math.abs(childMidpoint - rootCenter) < 0.001,
    `root-only children at ${childMidpoint} must remain centered below the hub at ${rootCenter}`,
  );

  const loadedBlockLeft = Math.min(root.x, ...children.map(node => node!.x));
  const loadedBlockRight = Math.max(
    root.x + root.width,
    ...children.map(node => node!.x + node!.width),
  );
  assert.ok(
    partner.x + partner.width + 28 <= loadedBlockLeft ||
      loadedBlockRight + 28 <= partner.x,
    "the childless partner must remain a side satellite outside the loaded root-only family",
  );
  const childlessUnion = result.unions.find(
    union => union.unionId === "mixed-solo-childless-partnership",
  );
  assert.ok(childlessUnion);
  const childlessRoute = result.edges.find(
    edge =>
      edge.unionOccurrenceId === childlessUnion.occurrenceId &&
      (edge.kind === "partnership" || edge.kind === "separated-partnership"),
  );
  assert.ok(childlessRoute);
  assert.equal(
    childlessRoute.points.length,
    2,
    "the childless partner must use a direct side-to-side line",
  );
  assert.equal(
    result.edges.filter(edge => edge.kind === "siblings-bus").length,
    1,
    "the three root-only children must share one bus",
  );
  assertNoCardOverlap(result, "root-only family beside childless partner");
  assertFamilyRoutesConnected(result, "root-only family beside childless partner");
  assertNoUnrelatedFamilyRouteIntersections(
    result,
    ["mixed-solo-childless-partnership", "mixed-solo-parent-set-1"],
    "root-only family beside childless partner",
  );
});

test("paired and root-only descendant families keep centered disjoint family blocks", () => {
  const pairedChildIds = ["mixed-paired-child-1", "mixed-paired-child-2"];
  const rootOnlyChildIds = [
    "mixed-root-only-child-1",
    "mixed-root-only-child-2",
    "mixed-root-only-child-3",
  ];
  const graph: FamilyGraphData = {
    persons: [
      person("mixed-family-hub", "male", "1840"),
      person("mixed-family-partner", "female", "1842"),
      ...pairedChildIds.map((childId, index) =>
        person(childId, "unknown", String(1870 + index)),
      ),
      ...rootOnlyChildIds.map((childId, index) =>
        person(childId, "unknown", String(1880 + index)),
      ),
    ],
    unions: [
      {
        id: "mixed-paired-family",
        kind: "partnership",
        memberIds: ["mixed-family-hub", "mixed-family-partner"],
      },
      ...rootOnlyChildIds.map((childId, index) => ({
        id: `mixed-root-only-parent-set-${index + 1}`,
        kind: "parent-set" as const,
        memberIds: ["mixed-family-hub"],
        familyGroupId: `mixed-root-only-technical-group-${index + 1}`,
      })),
    ],
    parentChildRelations: [
      ...pairedChildIds.flatMap(childId =>
        parentRelations(
          ["mixed-family-hub", "mixed-family-partner"],
          childId,
          "mixed-paired-family",
        ),
      ),
      ...rootOnlyChildIds.flatMap((childId, index) =>
        parentRelations(
          ["mixed-family-hub"],
          childId,
          `mixed-root-only-parent-set-${index + 1}`,
        ),
      ),
    ],
  };
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "mixed-family-hub",
    originalFocusPersonId: "mixed-paired-child-1",
  });
  const result = run(projection.graph, {
    focusPersonId: "mixed-family-hub",
    ancestorDepth: 0,
    descendantDepth: 10,
    collateralDepth: 0,
    maxVisibleNodes: 100,
    primaryLineagePersonIds: projection.focusLineagePersonIds,
  });
  const hub = result.nodes.find(node => node.personId === "mixed-family-hub");
  const partner = result.nodes.find(
    node => node.personId === "mixed-family-partner",
  );
  const pairedChildren = pairedChildIds.map(childId =>
    result.nodes.find(node => node.personId === childId),
  );
  const rootOnlyChildren = rootOnlyChildIds.map(childId =>
    result.nodes.find(node => node.personId === childId),
  );
  assert.ok(
    hub &&
      partner &&
      pairedChildren.every(Boolean) &&
      rootOnlyChildren.every(Boolean),
  );

  const hubCenter = hub.x + hub.width / 2;
  const rootOnlyCenters = rootOnlyChildren.map(
    node => node!.x + node!.width / 2,
  );
  const rootOnlyMidpoint =
    (Math.min(...rootOnlyCenters) + Math.max(...rootOnlyCenters)) / 2;
  assert.ok(
    Math.abs(rootOnlyMidpoint - hubCenter) < 0.001,
    `root-only children at ${rootOnlyMidpoint} must remain centered below the hub at ${hubCenter}`,
  );

  const partnerCenter = partner.x + partner.width / 2;
  const pairedCenters = pairedChildren.map(node => node!.x + node!.width / 2);
  const pairedMidpoint =
    (Math.min(...pairedCenters) + Math.max(...pairedCenters)) / 2;
  assert.ok(
    Math.abs(pairedMidpoint - partnerCenter) < 0.001,
    `side-family children at ${pairedMidpoint} must remain below their partner at ${partnerCenter}`,
  );

  const blocks = [
    {
      id: "root-only",
      nodes: [hub, ...rootOnlyChildren.map(node => node!)],
    },
    {
      id: "paired",
      nodes: [partner, ...pairedChildren.map(node => node!)],
    },
  ]
    .map(block => ({
      id: block.id,
      left: Math.min(...block.nodes.map(node => node.x)),
      right: Math.max(...block.nodes.map(node => node.x + node.width)),
    }))
    .sort((left, right) => left.left - right.left);
  assert.ok(
    blocks[0]!.right + 28 <= blocks[1]!.left,
    `mixed family card blocks must be disjoint: ${JSON.stringify(blocks)}`,
  );

  const buses = result.edges
    .filter(edge => edge.kind === "siblings-bus")
    .map(edge => ({
      left: Math.min(edge.points[0]!.x, edge.points[1]!.x),
      right: Math.max(edge.points[0]!.x, edge.points[1]!.x),
    }))
    .sort((left, right) => left.left - right.left);
  assert.equal(buses.length, 2, "each mixed family must keep one shared bus");
  assert.ok(
    buses[0]!.right + 12 <= buses[1]!.left,
    `mixed family buses must remain disjoint: ${JSON.stringify(buses)}`,
  );
  assertNoCardOverlap(result, "paired and root-only descendant families");
  assertFamilyRoutesConnected(result, "paired and root-only descendant families");
  assertNoUnrelatedFamilyRouteIntersections(
    result,
    ["mixed-paired-family", "mixed-root-only-parent-set-1"],
    "paired and root-only descendant families",
  );
});

function projectLayout(result: LayoutResult): unknown {
  return {
    focusOccurrenceId: result.focusOccurrenceId,
    bounds: result.bounds,
    nodes: result.nodes
      .map(node => ({
        id: node.occurrenceId,
        personId: node.personId,
        kind: node.kind,
        generation: node.generation,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        referenceToOccurrenceId: node.referenceToOccurrenceId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    unions: result.unions
      .map(union => ({
        id: union.occurrenceId,
        unionId: union.unionId,
        generation: union.generation,
        x: union.x,
        y: union.y,
        memberOccurrenceIds: [...union.memberOccurrenceIds].sort(),
        childOccurrenceIds: [...union.childOccurrenceIds].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: result.edges
      .map(edge => ({
        id: edge.id,
        kind: edge.kind,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        points: edge.points,
        relationIds: edge.relationIds ? [...edge.relationIds].sort() : undefined,
        relationshipKinds: edge.relationshipKinds
          ? [...edge.relationshipKinds].sort()
          : undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    warnings: result.warnings,
  };
}
