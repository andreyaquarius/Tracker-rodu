import test from "node:test";
import assert from "node:assert/strict";
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
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

const EPSILON = 0.001;

class ReductionFixtureBuilder {
  private readonly persons = new Map<string, TreePerson>();
  private readonly unions: TreeUnion[] = [];
  private readonly relations: ParentChildRelation[] = [];

  person(id: string, sex: TreePerson["sex"], birth: number): this {
    this.persons.set(id, {
      id,
      displayName: id,
      sex,
      birth: { display: String(birth), sort: String(birth) },
    });
    return this;
  }

  family(
    id: string,
    memberIds: readonly string[],
    childIds: readonly string[],
  ): this {
    this.unions.push({
      id,
      kind: "partnership",
      status: "married",
      memberIds: [...memberIds],
      familyGroupId: id,
      displayOrder: id,
    });
    for (const [childIndex, childId] of childIds.entries()) {
      for (const [parentIndex, parentId] of memberIds.entries()) {
        this.relations.push({
          id: `${id}:${parentId}:${childId}`,
          parentId,
          childId,
          unionId: id,
          kind: "biological",
          role:
            parentIndex === 0
              ? "father"
              : parentIndex === 1
                ? "mother"
                : "parent",
          displayOrder: String(childIndex).padStart(3, "0"),
        });
      }
    }
    return this;
  }

  build(): FamilyGraphData {
    return {
      persons: [...this.persons.values()],
      unions: this.unions,
      parentChildRelations: this.relations,
    };
  }
}

function pedigreeReductionFixture(): FamilyGraphData {
  const builder = new ReductionFixtureBuilder();
  builder
    .person("I500254", "male", 1680)
    .person("root-partner", "female", 1682)
    .person("left-1", "male", 1710)
    .person("right-1", "female", 1712)
    .person("root-side-1", "male", 1714)
    .person("root-side-2", "female", 1716)
    .person("left-1-partner", "female", 1711)
    .person("right-1-partner", "male", 1713)
    .person("left-2", "male", 1740)
    .person("right-2", "female", 1742);
  for (let index = 1; index <= 4; index += 1) {
    builder
      .person(`left-2-side-${index}`, index % 2 ? "female" : "male", 1742 + index)
      .person(`right-2-side-${index}`, index % 2 ? "male" : "female", 1748 + index);
  }
  builder
    .person("left-2-partner", "female", 1741)
    .person("right-2-partner", "male", 1743)
    .person("left-3", "male", 1770)
    .person("right-3", "female", 1772);
  for (let index = 1; index <= 5; index += 1) {
    builder
      .person(`left-3-side-${index}`, index % 2 ? "female" : "male", 1772 + index)
      .person(`right-3-side-${index}`, index % 2 ? "male" : "female", 1779 + index);
  }
  builder
    .person("left-3-partner", "female", 1771)
    .person("right-3-partner", "male", 1773)
    .person("shared-reduction-person", "female", 1800)
    .person("left-only", "male", 1802)
    .person("right-only", "female", 1804)
    .person("shared-partner", "male", 1798);

  const children = Array.from({ length: 9 }, (_, index) => `child-${index + 1}`);
  for (const [index, childId] of children.entries()) {
    builder
      .person(childId, index % 2 ? "female" : "male", 1825 + index)
      .person(`${childId}-partner`, index % 2 ? "male" : "female", 1826 + index);
    for (let grandchildIndex = 1; grandchildIndex <= 3; grandchildIndex += 1) {
      builder.person(
        `${childId}-grandchild-${grandchildIndex}`,
        grandchildIndex % 2 ? "male" : "female",
        1850 + index * 3 + grandchildIndex,
      );
    }
  }

  builder
    .family("root-family", ["I500254", "root-partner"], [
      "left-1",
      "right-1",
      "root-side-1",
      "root-side-2",
    ])
    .family("left-1-family", ["left-1", "left-1-partner"], [
      "left-2",
      ...Array.from({ length: 4 }, (_, index) => `left-2-side-${index + 1}`),
    ])
    .family("right-1-family", ["right-1", "right-1-partner"], [
      "right-2",
      ...Array.from({ length: 4 }, (_, index) => `right-2-side-${index + 1}`),
    ])
    .family("left-2-family", ["left-2", "left-2-partner"], [
      "left-3",
      ...Array.from({ length: 5 }, (_, index) => `left-3-side-${index + 1}`),
    ])
    .family("right-2-family", ["right-2", "right-2-partner"], [
      "right-3",
      ...Array.from({ length: 5 }, (_, index) => `right-3-side-${index + 1}`),
    ])
    .family(
      "left-convergence-family",
      ["left-3", "left-3-partner"],
      ["shared-reduction-person", "left-only"],
    )
    .family(
      "right-convergence-family",
      ["right-3", "right-3-partner"],
      ["shared-reduction-person", "right-only"],
    )
    .family(
      "shared-descendant-family",
      ["shared-reduction-person", "shared-partner"],
      children,
    );

  for (const childId of children) {
    builder.family(
      `${childId}-family`,
      [childId, `${childId}-partner`],
      Array.from(
        { length: 3 },
        (_, index) => `${childId}-grandchild-${index + 1}`,
      ),
    );
  }
  return builder.build();
}

/**
 * Exact @I500254@-style reduction: the two descendant branches do not point
 * at the same canonical person. Instead, each branch owns a different child
 * and those two children become partners. The partnership therefore makes
 * one rigid bundle that is also the child bundle of two upstream families.
 */
function convergenceCoupleFixture(): FamilyGraphData {
  const builder = new ReductionFixtureBuilder();
  builder
    .person("I500254", "male", 1680)
    .person("root-partner", "female", 1682)
    .person("left-1", "male", 1710)
    .person("right-1", "female", 1712)
    .person("root-side-1", "male", 1714)
    .person("root-side-2", "female", 1716)
    .person("left-1-partner", "female", 1711)
    .person("right-1-partner", "male", 1713)
    .person("left-2", "male", 1740)
    .person("right-2", "female", 1742);
  for (let index = 1; index <= 4; index += 1) {
    builder
      .person(`left-2-side-${index}`, index % 2 ? "female" : "male", 1742 + index)
      .person(`right-2-side-${index}`, index % 2 ? "male" : "female", 1748 + index);
  }
  builder
    .person("left-2-partner", "female", 1741)
    .person("right-2-partner", "male", 1743)
    .person("convergence-left", "male", 1770)
    .person("convergence-right", "female", 1772);
  for (let index = 1; index <= 5; index += 1) {
    builder
      .person(`left-3-side-${index}`, index % 2 ? "female" : "male", 1772 + index)
      .person(`right-3-side-${index}`, index % 2 ? "male" : "female", 1779 + index);
  }

  const children = Array.from({ length: 9 }, (_, index) => `child-${index + 1}`);
  for (const [index, childId] of children.entries()) {
    builder
      .person(childId, index % 2 ? "female" : "male", 1800 + index)
      .person(`${childId}-partner`, index % 2 ? "male" : "female", 1801 + index);
    for (let grandchildIndex = 1; grandchildIndex <= 3; grandchildIndex += 1) {
      builder.person(
        `${childId}-grandchild-${grandchildIndex}`,
        grandchildIndex % 2 ? "male" : "female",
        1830 + index * 3 + grandchildIndex,
      );
    }
  }

  builder
    .family("root-family", ["I500254", "root-partner"], [
      "left-1",
      "right-1",
      "root-side-1",
      "root-side-2",
    ])
    .family("left-1-family", ["left-1", "left-1-partner"], [
      "left-2",
      ...Array.from({ length: 4 }, (_, index) => `left-2-side-${index + 1}`),
    ])
    .family("right-1-family", ["right-1", "right-1-partner"], [
      "right-2",
      ...Array.from({ length: 4 }, (_, index) => `right-2-side-${index + 1}`),
    ])
    .family("left-convergence-family", ["left-2", "left-2-partner"], [
      "convergence-left",
      ...Array.from({ length: 5 }, (_, index) => `left-3-side-${index + 1}`),
    ])
    .family("right-convergence-family", ["right-2", "right-2-partner"], [
      "convergence-right",
      ...Array.from({ length: 5 }, (_, index) => `right-3-side-${index + 1}`),
    ])
    .family(
      "convergence-couple-family",
      ["convergence-left", "convergence-right"],
      children,
    );

  for (const childId of children) {
    builder.family(
      `${childId}-family`,
      [childId, `${childId}-partner`],
      Array.from(
        { length: 3 },
        (_, index) => `${childId}-grandchild-${index + 1}`,
      ),
    );
  }
  return builder.build();
}

function run(
  graph: FamilyGraphData,
  previousPositions?: readonly PreviousNodePosition[],
): LayoutResult {
  const projection = buildAllDescendantsProjection({
    graph,
    rootPersonId: "I500254",
    originalFocusPersonId: "child-5-grandchild-2",
  });
  const input: FamilyTreeLayoutInput = {
    graph: projection.graph,
    options: {
      layoutMode: "descendant-forest",
      focusPersonId: "I500254",
      ancestorDepth: 0,
      descendantDepth: 100,
      collateralDepth: 0,
      maxVisibleNodes: 2_000,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
      primaryLineagePersonIds: projection.focusLineagePersonIds,
      ...(previousPositions ? { previousPositions } : {}),
    },
  };
  return layoutDescendantForest(input);
}

function nodeFor(result: LayoutResult, personId: string): LayoutNode {
  const matches = result.nodes.filter(node => node.personId === personId);
  assert.equal(matches.length, 1, `${personId} must have one canonical card`);
  return matches[0]!;
}

function centerX(node: LayoutNode): number {
  return node.x + node.width / 2;
}

function assertNoCardOverlaps(result: LayoutResult): void {
  for (let leftIndex = 0; leftIndex < result.nodes.length; leftIndex += 1) {
    const left = result.nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < result.nodes.length; rightIndex += 1) {
      const right = result.nodes[rightIndex]!;
      const overlapWidth =
        Math.min(left.x + left.width, right.x + right.width) -
        Math.max(left.x, right.x);
      const overlapHeight =
        Math.min(left.y + left.height, right.y + right.height) -
        Math.max(left.y, right.y);
      assert.ok(
        overlapWidth <= EPSILON || overlapHeight <= EPSILON,
        `${left.occurrenceId} overlaps ${right.occurrenceId}`,
      );
    }
  }
}

interface Segment {
  readonly edge: LayoutEdge;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function segments(result: LayoutResult): Segment[] {
  return result.edges.flatMap(edge =>
    edge.points.slice(1).flatMap((end, index) => {
      const start = edge.points[index]!;
      if (near(start.x, end.x) && near(start.y, end.y)) return [];
      assert.ok(
        near(start.x, end.x) || near(start.y, end.y),
        `${edge.id} contains a diagonal segment`,
      );
      return [{ edge, start, end }];
    }),
  );
}

function between(value: number, left: number, right: number): boolean {
  return value >= Math.min(left, right) - EPSILON &&
    value <= Math.max(left, right) + EPSILON;
}

function samePoint(left: LayoutPoint, right: LayoutPoint): boolean {
  return near(left.x, right.x) && near(left.y, right.y);
}

function isEndpoint(point: LayoutPoint, segment: Segment): boolean {
  return samePoint(point, segment.start) || samePoint(point, segment.end);
}

function sharedEndpoint(left: Segment, right: Segment): boolean {
  const sharedOccurrenceIds = [left.edge.sourceId, left.edge.targetId].filter(
    id => id === right.edge.sourceId || id === right.edge.targetId,
  );
  if (sharedOccurrenceIds.length === 0) return false;
  const candidates = [left.start, left.end].filter(point =>
    [right.start, right.end].some(other => samePoint(point, other)),
  );
  return candidates.some(point => isEndpoint(point, left) && isEndpoint(point, right));
}

function assertNoUnrelatedRouteIntersections(result: LayoutResult): void {
  const routed = segments(result);
  for (let leftIndex = 0; leftIndex < routed.length; leftIndex += 1) {
    const left = routed[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < routed.length; rightIndex += 1) {
      const right = routed[rightIndex]!;
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
        if (
          between(point.y, vertical.start.y, vertical.end.y) &&
          between(point.x, horizontal.start.x, horizontal.end.x)
        ) {
          assert.ok(
            sharedEndpoint(left, right),
            `${left.edge.id} crosses ${right.edge.id} at ${JSON.stringify(point)}`,
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
      assert.ok(
        overlapEnd - overlapStart <= EPSILON && sharedEndpoint(left, right),
        `${left.edge.id} shares a lane with ${right.edge.id}`,
      );
    }
  }
}

function assertNoRouteCrossesUnrelatedCard(result: LayoutResult): void {
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
          Math.max(
            Math.min(segment.start.y, segment.end.y),
            node.y + EPSILON,
          ) <
            Math.min(
              Math.max(segment.start.y, segment.end.y),
              node.y + node.height - EPSILON,
            )
        : segment.start.y > node.y + EPSILON &&
          segment.start.y < node.y + node.height - EPSILON &&
          Math.max(
            Math.min(segment.start.x, segment.end.x),
            node.x + EPSILON,
          ) <
            Math.min(
              Math.max(segment.start.x, segment.end.x),
              node.x + node.width - EPSILON,
            );
      assert.equal(
        crossesInterior,
        false,
        `${segment.edge.id} crosses unrelated card ${node.occurrenceId}`,
      );
    }
  }
}

function childInterval(
  result: LayoutResult,
  unionId: string,
): { readonly left: number; readonly right: number } {
  const union = result.unions.find(candidate => candidate.unionId === unionId);
  assert.ok(union, `missing ${unionId}`);
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  const children = union.childOccurrenceIds.map(id => {
    const node = nodesByOccurrenceId.get(id);
    assert.ok(node, `missing child ${id} for ${unionId}`);
    return node;
  });
  return {
    left: Math.min(...children.map(node => node.x)),
    right: Math.max(...children.map(node => node.x + node.width)),
  };
}

function assertUpstreamFamilyBlocksSeparated(
  result: LayoutResult,
  includeConvergenceFamilies = false,
): void {
  const familyPairs: Array<readonly [string, string]> = [
    ["left-1-family", "right-1-family"],
    ["left-2-family", "right-2-family"],
  ];
  if (includeConvergenceFamilies) {
    familyPairs.push([
      "left-convergence-family",
      "right-convergence-family",
    ]);
  }
  for (const [leftFamilyId, rightFamilyId] of familyPairs) {
    if (
      !result.unions.some(union => union.unionId === leftFamilyId) ||
      !result.unions.some(union => union.unionId === rightFamilyId)
    ) {
      continue;
    }
    const left = childInterval(result, leftFamilyId);
    const right = childInterval(result, rightFamilyId);
    assert.ok(
      left.right + EPSILON < right.left,
      `${leftFamilyId} and ${rightFamilyId} must own disjoint child blocks: ` +
        JSON.stringify({ left, right }),
    );
  }
}

function assertOrdinaryFamiliesCentered(
  result: LayoutResult,
  excludedUnionIds: ReadonlySet<string> = new Set(),
): void {
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  for (const union of result.unions) {
    if (
      union.childOccurrenceIds.length === 0 ||
      excludedUnionIds.has(union.unionId)
    ) {
      continue;
    }
    const parents = union.memberOccurrenceIds
      .map(id => nodesByOccurrenceId.get(id))
      .filter((node): node is LayoutNode => Boolean(node));
    const children = union.childOccurrenceIds
      .map(id => nodesByOccurrenceId.get(id))
      .filter((node): node is LayoutNode => Boolean(node));
    assert.ok(parents.length > 0 && children.length > 0, union.unionId);
    const parentCenter =
      parents.reduce((sum, node) => sum + centerX(node), 0) / parents.length;
    const childCenter =
      (Math.min(...children.map(centerX)) + Math.max(...children.map(centerX))) / 2;
    assert.ok(
      Math.abs(parentCenter - childCenter) <= EPSILON,
      `${union.unionId} is not centered: ${JSON.stringify({ parentCenter, childCenter })}`,
    );
  }
}

function stableProjection(result: LayoutResult): unknown {
  return {
    nodes: result.nodes.map(node => [node.occurrenceId, node.x, node.y]),
    unions: result.unions.map(union => [union.occurrenceId, union.x, union.y]),
    edges: result.edges.map(edge => [
      edge.id,
      edge.kind,
      edge.points.map(point => [point.x, point.y]),
    ]),
  };
}

function assertNodeCoordinatesStable(
  expected: LayoutResult,
  actual: LayoutResult,
): void {
  const actualByOccurrenceId = new Map(
    actual.nodes.map(node => [node.occurrenceId, node]),
  );
  for (const expectedNode of expected.nodes) {
    const actualNode = actualByOccurrenceId.get(expectedNode.occurrenceId);
    assert.ok(actualNode, `missing retained card ${expectedNode.occurrenceId}`);
    assert.ok(
      near(expectedNode.x, actualNode.x) && near(expectedNode.y, actualNode.y),
      `${expectedNode.occurrenceId} moved despite previousPositions: ` +
        JSON.stringify({
          expected: { x: expectedNode.x, y: expectedNode.y },
          actual: { x: actualNode.x, y: actualNode.y },
        }),
    );
  }
}

test("deep descendant pedigree reduction keeps one canonical shared card", () => {
  const graph = pedigreeReductionFixture();
  const initial = run(graph);

  assert.equal(
    initial.nodes.filter(node => node.personId === "shared-reduction-person").length,
    1,
    "both upstream branches must reuse one canonical shared-person card",
  );
  assertNoCardOverlaps(initial);
});

test("deep descendant pedigree reduction keeps upstream blocks centered and routes disjoint", () => {
  const initial = run(pedigreeReductionFixture());

  assertOrdinaryFamiliesCentered(
    initial,
    new Set([
      "left-1-family",
      "right-1-family",
      "left-2-family",
      "right-2-family",
      "left-convergence-family",
      "right-convergence-family",
    ]),
  );
  assertUpstreamFamilyBlocksSeparated(initial);
  assertNoUnrelatedRouteIntersections(initial);
  assertNoRouteCrossesUnrelatedCard(initial);
});

test("deep descendant pedigree reduction is stable with retained positions", () => {
  const graph = pedigreeReductionFixture();
  const initial = run(graph);

  const previousPositions = initial.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const first = run(graph, previousPositions);
  const second = run(graph, previousPositions);

  assertNodeCoordinatesStable(initial, first);
  assert.deepEqual(stableProjection(first), stableProjection(second));
  assertNoCardOverlaps(first);
  assertOrdinaryFamiliesCentered(
    first,
    new Set([
      "left-1-family",
      "right-1-family",
      "left-2-family",
      "right-2-family",
      "left-convergence-family",
      "right-convergence-family",
    ]),
  );
  assertUpstreamFamilyBlocksSeparated(first);
  assertNoUnrelatedRouteIntersections(first);
  assertNoRouteCrossesUnrelatedCard(first);
});

test("@I500254@ reduction keeps one downstream couple and one non-duplicate convergence portal", () => {
  const result = run(convergenceCoupleFixture());
  const left = nodeFor(result, "convergence-left");
  const right = nodeFor(result, "convergence-right");
  const couple = result.unions.find(
    union => union.unionId === "convergence-couple-family",
  );
  const leftUpstream = result.unions.find(
    union => union.unionId === "left-convergence-family",
  );
  const rightUpstream = result.unions.find(
    union => union.unionId === "right-convergence-family",
  );

  assert.ok(couple && leftUpstream && rightUpstream);
  assert.deepEqual(
    new Set(couple.memberOccurrenceIds),
    new Set([left.occurrenceId, right.occurrenceId]),
  );
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  const reachesTarget = (
    union: NonNullable<typeof leftUpstream>,
    targetOccurrenceId: string,
  ): boolean =>
    union.childOccurrenceIds.some(childOccurrenceId => {
      if (childOccurrenceId === targetOccurrenceId) return true;
      const child = nodesByOccurrenceId.get(childOccurrenceId);
      return (
        child?.kind === "convergence" &&
        child.referenceToOccurrenceId === targetOccurrenceId
      );
    });
  assert.ok(reachesTarget(leftUpstream, left.occurrenceId));
  assert.ok(reachesTarget(rightUpstream, right.occurrenceId));
  const portals = result.nodes.filter(node => node.kind === "convergence");
  assert.equal(portals.length, 1, "a reduction uses one compact portal, not a duplicate card");
  assert.equal(
    portals[0]!.personId,
    undefined,
    "the convergence portal must not increment a person's card count",
  );
  assert.ok(near(left.y, right.y), "the convergence partners must share a row");
  assertNoCardOverlaps(result);
});

test("@I500254@ convergence-couple keeps upstream families centered and separated", () => {
  const result = run(convergenceCoupleFixture());

  assertOrdinaryFamiliesCentered(result);
  assertUpstreamFamilyBlocksSeparated(result, true);
});

test("@I500254@ convergence-couple keeps cards and unrelated routes disjoint", () => {
  const result = run(convergenceCoupleFixture());

  assertNoCardOverlaps(result);
  assertNoUnrelatedRouteIntersections(result);
  assertNoRouteCrossesUnrelatedCard(result);
});

test("@I500254@ convergence-couple retains coordinates with previousPositions", () => {
  const graph = convergenceCoupleFixture();
  const initial = run(graph);
  const previousPositions = initial.nodes.map(node => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const first = run(graph, previousPositions);
  const second = run(graph, previousPositions);

  assertNodeCoordinatesStable(initial, first);
  assert.deepEqual(stableProjection(first), stableProjection(second));
});
