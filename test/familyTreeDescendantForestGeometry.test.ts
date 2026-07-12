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
  PersonId,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

const EPSILON = 0.001;

interface StructuralFamilyExpectation {
  readonly key: string;
  readonly memberIds: readonly PersonId[];
  readonly childIds: readonly PersonId[];
  readonly unionIds: readonly string[];
}

interface DescendantFixture {
  readonly graph: FamilyGraphData;
  readonly families: readonly StructuralFamilyExpectation[];
}

interface FamilyOptions {
  readonly perChildParentSets?: boolean;
  readonly displayOrder?: string;
}

class DescendantFixtureBuilder {
  private readonly people = new Map<string, TreePerson>();
  private readonly unions: TreeUnion[] = [];
  private readonly relations: ParentChildRelation[] = [];
  private readonly families: StructuralFamilyExpectation[] = [];

  person(
    id: string,
    sex: TreePerson["sex"] = "unknown",
    birth?: string,
  ): this {
    this.people.set(id, {
      id,
      displayName: id,
      sex,
      ...(birth ? { birth: { display: birth, sort: birth } } : {}),
    });
    return this;
  }

  family(
    key: string,
    memberIds: readonly string[],
    childIds: readonly string[],
    options: FamilyOptions = {},
  ): this {
    assert.ok(memberIds.length > 0, `${key} must have at least one parent`);
    const missing = [...memberIds, ...childIds].filter(
      personId => !this.people.has(personId),
    );
    assert.deepEqual(missing, [], `${key} refers to missing fixture people`);

    const familyGroupId = `family-group:${key}`;
    const partnershipId = `partnership:${key}`;
    const unionIds = [partnershipId];
    this.unions.push({
      id: partnershipId,
      kind: "partnership",
      memberIds: [...memberIds],
      familyGroupId,
      status: "married",
      displayOrder: options.displayOrder ?? key,
    });

    for (const [childIndex, childId] of childIds.entries()) {
      const relationUnionId = options.perChildParentSets === false
        ? partnershipId
        : `parent-set:${key}:${childId}`;
      if (relationUnionId !== partnershipId) {
        unionIds.push(relationUnionId);
        this.unions.push({
          id: relationUnionId,
          kind: "parent-set",
          memberIds: [...memberIds],
          familyGroupId,
          displayOrder: `${options.displayOrder ?? key}:${String(childIndex).padStart(3, "0")}`,
        });
      }
      for (const [parentIndex, parentId] of memberIds.entries()) {
        this.relations.push({
          id: `relation:${key}:${parentId}:${childId}`,
          parentId,
          childId,
          unionId: relationUnionId,
          kind: "biological",
          role: parentIndex === 0 ? "father" : parentIndex === 1 ? "mother" : "parent",
          displayOrder: String(childIndex).padStart(3, "0"),
        });
      }
    }

    this.families.push({
      key,
      memberIds: [...memberIds],
      childIds: [...childIds],
      unionIds,
    });
    return this;
  }

  build(): DescendantFixture {
    return {
      graph: {
        persons: [...this.people.values()],
        unions: this.unions,
        parentChildRelations: this.relations,
      },
      families: this.families,
    };
  }
}

function runDescendantFixture(
  fixture: DescendantFixture,
  rootPersonId: PersonId,
  originalFocusPersonId?: PersonId,
): LayoutResult {
  const projection = buildAllDescendantsProjection({
    graph: fixture.graph,
    rootPersonId,
    ...(originalFocusPersonId ? { originalFocusPersonId } : {}),
  });
  const input: FamilyTreeLayoutInput = {
    graph: projection.graph,
    options: {
      focusPersonId: rootPersonId,
      ancestorDepth: 0,
      descendantDepth: 30,
      collateralDepth: 0,
      maxVisibleNodes: 2_000,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
      primaryLineagePersonIds: projection.focusLineagePersonIds,
    },
  };
  return layoutDescendantForest(input);
}

function assertNoCardCardIntersections(
  result: LayoutResult,
  context: string,
): void {
  for (let leftIndex = 0; leftIndex < result.nodes.length; leftIndex += 1) {
    const left = result.nodes[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < result.nodes.length;
      rightIndex += 1
    ) {
      const right = result.nodes[rightIndex]!;
      const overlapWidth =
        Math.min(left.x + left.width, right.x + right.width) -
        Math.max(left.x, right.x);
      const overlapHeight =
        Math.min(left.y + left.height, right.y + right.height) -
        Math.max(left.y, right.y);
      assert.ok(
        overlapWidth <= EPSILON || overlapHeight <= EPSILON,
        `${context}: cards ${left.occurrenceId} and ${right.occurrenceId} ` +
          `overlap by ${overlapWidth} x ${overlapHeight}`,
      );
    }
  }
}

interface RoutedSegment {
  readonly edge: LayoutEdge;
  readonly familyKey: string;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
}

interface FamilyGeometryIndex {
  readonly familyPeopleByKey: ReadonlyMap<string, ReadonlySet<PersonId>>;
  readonly familyKeyByUnionOccurrenceId: ReadonlyMap<string, string>;
  readonly segments: readonly RoutedSegment[];
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function samePoint(left: LayoutPoint, right: LayoutPoint): boolean {
  return near(left.x, right.x) && near(left.y, right.y);
}

function between(value: number, left: number, right: number): boolean {
  return (
    value >= Math.min(left, right) - EPSILON &&
    value <= Math.max(left, right) + EPSILON
  );
}

function isSegmentEndpoint(point: LayoutPoint, segment: RoutedSegment): boolean {
  return samePoint(point, segment.start) || samePoint(point, segment.end);
}

function buildFamilyGeometryIndex(
  result: LayoutResult,
  families: readonly StructuralFamilyExpectation[],
  context: string,
): FamilyGeometryIndex {
  const familyKeyByUnionId = new Map<string, string>();
  const familyPeopleByKey = new Map<string, ReadonlySet<PersonId>>();
  for (const family of families) {
    familyPeopleByKey.set(
      family.key,
      new Set([...family.memberIds, ...family.childIds]),
    );
    for (const unionId of family.unionIds) {
      const previous = familyKeyByUnionId.get(unionId);
      assert.ok(
        !previous || previous === family.key,
        `${context}: ${unionId} belongs to two structural families`,
      );
      familyKeyByUnionId.set(unionId, family.key);
    }
  }

  const familyKeyByUnionOccurrenceId = new Map<string, string>();
  for (const union of result.unions) {
    const familyKey = familyKeyByUnionId.get(union.unionId);
    if (familyKey) {
      familyKeyByUnionOccurrenceId.set(union.occurrenceId, familyKey);
    }
  }

  const segments: RoutedSegment[] = [];
  for (const edge of result.edges) {
    if (!edge.unionOccurrenceId) continue;
    const familyKey = familyKeyByUnionOccurrenceId.get(edge.unionOccurrenceId);
    assert.ok(
      familyKey,
      `${context}: ${edge.id} points to an unknown structural union ` +
        `${edge.unionOccurrenceId}`,
    );
    for (let pointIndex = 1; pointIndex < edge.points.length; pointIndex += 1) {
      const start = edge.points[pointIndex - 1]!;
      const end = edge.points[pointIndex]!;
      if (samePoint(start, end)) continue;
      assert.ok(
        near(start.x, end.x) || near(start.y, end.y),
        `${context}: ${edge.id} contains a diagonal segment ` +
          `${JSON.stringify({ start, end })}`,
      );
      segments.push({ edge, familyKey, start, end });
    }
  }
  return { familyPeopleByKey, familyKeyByUnionOccurrenceId, segments };
}

type SegmentIntersection =
  | { readonly kind: "none" }
  | { readonly kind: "point"; readonly point: LayoutPoint }
  | {
      readonly kind: "overlap";
      readonly start: LayoutPoint;
      readonly end: LayoutPoint;
    };

function intersectSegments(
  left: RoutedSegment,
  right: RoutedSegment,
): SegmentIntersection {
  const leftVertical = near(left.start.x, left.end.x);
  const rightVertical = near(right.start.x, right.end.x);
  if (leftVertical !== rightVertical) {
    const vertical = leftVertical ? left : right;
    const horizontal = leftVertical ? right : left;
    const point = { x: vertical.start.x, y: horizontal.start.y };
    return between(point.x, horizontal.start.x, horizontal.end.x) &&
      between(point.y, vertical.start.y, vertical.end.y)
      ? { kind: "point", point }
      : { kind: "none" };
  }

  const sameLane = leftVertical
    ? near(left.start.x, right.start.x)
    : near(left.start.y, right.start.y);
  if (!sameLane) return { kind: "none" };

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
  if (overlapEnd < overlapStart - EPSILON) return { kind: "none" };
  const pointFor = (value: number): LayoutPoint =>
    leftVertical
      ? { x: left.start.x, y: value }
      : { x: value, y: left.start.y };
  if (overlapEnd - overlapStart <= EPSILON) {
    return { kind: "point", point: pointFor((overlapStart + overlapEnd) / 2) };
  }
  return {
    kind: "overlap",
    start: pointFor(overlapStart),
    end: pointFor(overlapEnd),
  };
}

function pointOnCardBoundary(point: LayoutPoint, node: LayoutNode): boolean {
  const insideX = between(point.x, node.x, node.x + node.width);
  const insideY = between(point.y, node.y, node.y + node.height);
  return (
    (insideX && (near(point.y, node.y) || near(point.y, node.y + node.height))) ||
    (insideY && (near(point.x, node.x) || near(point.x, node.x + node.width)))
  );
}

function assertNoUnrelatedLineLineIntersections(
  result: LayoutResult,
  geometry: FamilyGeometryIndex,
  context: string,
): void {
  const nodesByOccurrenceId = new Map(
    result.nodes.map(node => [node.occurrenceId, node]),
  );
  for (let leftIndex = 0; leftIndex < geometry.segments.length; leftIndex += 1) {
    const left = geometry.segments[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < geometry.segments.length;
      rightIndex += 1
    ) {
      const right = geometry.segments[rightIndex]!;
      if (left.familyKey === right.familyKey) continue;
      const intersection = intersectSegments(left, right);
      if (intersection.kind === "none") continue;
      assert.notEqual(
        intersection.kind,
        "overlap",
        `${context}: unrelated routes ${left.familyKey}/${left.edge.id} and ` +
          `${right.familyKey}/${right.edge.id} reuse the lane ` +
          `${JSON.stringify(intersection)}`,
      );
      if (intersection.kind !== "point") continue;

      const sharedOccurrenceIds = [left.edge.sourceId, left.edge.targetId]
        .filter(occurrenceId =>
          occurrenceId === right.edge.sourceId ||
          occurrenceId === right.edge.targetId,
        );
      const allowedSharedCardEndpoint =
        isSegmentEndpoint(intersection.point, left) &&
        isSegmentEndpoint(intersection.point, right) &&
        sharedOccurrenceIds.some(occurrenceId => {
          const node = nodesByOccurrenceId.get(occurrenceId);
          return node ? pointOnCardBoundary(intersection.point, node) : false;
        });
      assert.ok(
        allowedSharedCardEndpoint,
        `${context}: unrelated routes ${left.familyKey}/${left.edge.id} and ` +
          `${right.familyKey}/${right.edge.id} cross at ` +
          `(${intersection.point.x}, ${intersection.point.y}); ` +
          `segments=${JSON.stringify({
            left: { start: left.start, end: left.end },
            right: { start: right.start, end: right.end },
          })}`,
      );
    }
  }
}

function segmentCrossesCardInterior(
  segment: RoutedSegment,
  node: LayoutNode,
): boolean {
  const left = node.x + EPSILON;
  const right = node.x + node.width - EPSILON;
  const top = node.y + EPSILON;
  const bottom = node.y + node.height - EPSILON;
  if (near(segment.start.y, segment.end.y)) {
    const start = Math.min(segment.start.x, segment.end.x);
    const end = Math.max(segment.start.x, segment.end.x);
    return (
      segment.start.y > top &&
      segment.start.y < bottom &&
      Math.max(start, left) < Math.min(end, right) - EPSILON
    );
  }
  const start = Math.min(segment.start.y, segment.end.y);
  const end = Math.max(segment.start.y, segment.end.y);
  return (
    segment.start.x > left &&
    segment.start.x < right &&
    Math.max(start, top) < Math.min(end, bottom) - EPSILON
  );
}

function assertNoLineThroughUnrelatedCardInteriors(
  result: LayoutResult,
  geometry: FamilyGeometryIndex,
  context: string,
): void {
  for (const segment of geometry.segments) {
    const familyPeople = geometry.familyPeopleByKey.get(segment.familyKey);
    assert.ok(familyPeople, `${context}: unknown family ${segment.familyKey}`);
    for (const node of result.nodes) {
      if (node.personId && familyPeople.has(node.personId)) continue;
      assert.equal(
        segmentCrossesCardInterior(segment, node),
        false,
        `${context}: ${segment.familyKey}/${segment.edge.id} crosses the ` +
          `unrelated card ${node.occurrenceId}`,
      );
    }
  }
}

function assertOneSiblingBusPerStructuralFamily(
  result: LayoutResult,
  geometry: FamilyGeometryIndex,
  families: readonly StructuralFamilyExpectation[],
  context: string,
): void {
  for (const family of families.filter(candidate => candidate.childIds.length > 0)) {
    const buses = result.edges.filter(
      edge =>
        edge.kind === "siblings-bus" &&
        edge.unionOccurrenceId !== undefined &&
        geometry.familyKeyByUnionOccurrenceId.get(edge.unionOccurrenceId) ===
          family.key,
    );
    assert.equal(
      buses.length,
      1,
      `${context}: ${family.key} must own exactly one siblings bus`,
    );
    const bus = buses[0]!;
    assert.equal(bus.points.length, 2, `${context}: ${family.key} bus segments`);
    assert.ok(
      near(bus.points[0]!.y, bus.points[1]!.y),
      `${context}: ${family.key} bus must be horizontal`,
    );

    const stems = result.edges.filter(
      edge =>
        edge.id.endsWith(":family-stem") &&
        edge.unionOccurrenceId !== undefined &&
        geometry.familyKeyByUnionOccurrenceId.get(edge.unionOccurrenceId) ===
          family.key,
    );
    assert.equal(
      stems.length,
      1,
      `${context}: ${family.key} must own exactly one family stem`,
    );
  }
}

function assertStrictForestGeometry(
  result: LayoutResult,
  fixture: DescendantFixture,
  context: string,
): void {
  assert.ok(result.nodes.length > 0, `${context}: the layout is empty`);
  assert.ok(
    result.nodes.every(node =>
      [node.x, node.y, node.width, node.height].every(Number.isFinite),
    ),
    `${context}: every card coordinate must be finite`,
  );
  assertNoCardCardIntersections(result, context);
  const geometry = buildFamilyGeometryIndex(result, fixture.families, context);
  assertOneSiblingBusPerStructuralFamily(
    result,
    geometry,
    fixture.families,
    context,
  );
  assertNoUnrelatedLineLineIntersections(result, geometry, context);
  assertNoLineThroughUnrelatedCardInteriors(result, geometry, context);
}

function adjacentNestedFixture(): DescendantFixture {
  const builder = new DescendantFixtureBuilder();
  builder.person("root", "male", "1810").person("root-partner", "female", "1812");
  const branches = [
    { key: "left", childCount: 2, birth: "1840" },
    { key: "middle", childCount: 5, birth: "1842" },
    { key: "right", childCount: 3, birth: "1844" },
  ] as const;
  for (const [branchIndex, branch] of branches.entries()) {
    builder
      .person(`branch-${branch.key}`, branchIndex % 2 ? "female" : "male", branch.birth)
      .person(`branch-${branch.key}-partner`, branchIndex % 2 ? "male" : "female", String(1841 + branchIndex * 2));
    for (let childIndex = 0; childIndex < branch.childCount; childIndex += 1) {
      builder.person(
        `${branch.key}-child-${childIndex + 1}`,
        childIndex % 2 ? "female" : "male",
        String(1870 + branchIndex * 4 + childIndex),
      );
    }
  }
  builder.family(
    "root-family",
    ["root", "root-partner"],
    branches.map(branch => `branch-${branch.key}`),
    { perChildParentSets: true },
  );
  for (const branch of branches) {
    builder.family(
      `${branch.key}-family`,
      [`branch-${branch.key}`, `branch-${branch.key}-partner`],
      Array.from(
        { length: branch.childCount },
        (_, index) => `${branch.key}-child-${index + 1}`,
      ),
      { perChildParentSets: true },
    );
  }

  const nested = [
    { parent: "left-child-1", key: "left-nested", count: 3 },
    { parent: "middle-child-3", key: "middle-nested", count: 4 },
    { parent: "right-child-2", key: "right-nested", count: 2 },
  ] as const;
  for (const [nestedIndex, family] of nested.entries()) {
    const partnerId = `${family.key}-partner`;
    builder.person(partnerId, nestedIndex % 2 ? "female" : "male", String(1890 + nestedIndex));
    const children = Array.from({ length: family.count }, (_, index) => {
      const id = `${family.key}-child-${index + 1}`;
      builder.person(id, index % 2 ? "male" : "female", String(1900 + nestedIndex * 4 + index));
      return id;
    });
    builder.family(family.key, [family.parent, partnerId], children, {
      perChildParentSets: true,
    });
  }

  builder
    .person("deep-partner", "female", "1925")
    .person("deep-child-1", "male", "1950")
    .person("deep-child-2", "female", "1953")
    .person("deep-child-3", "male", "1956")
    .family(
      "deep-family",
      ["middle-nested-child-2", "deep-partner"],
      ["deep-child-1", "deep-child-2", "deep-child-3"],
      { perChildParentSets: true },
    );
  return builder.build();
}

function multiplePartnerFixture(): DescendantFixture {
  const builder = new DescendantFixtureBuilder();
  builder.person("hub", "male", "1800");
  const branches = [
    { key: "hub-a", partner: "partner-a", count: 2 },
    { key: "hub-b", partner: "partner-b", count: 4 },
    { key: "hub-primary", partner: "partner-primary", count: 3 },
    { key: "hub-c", partner: "partner-c", count: 1 },
    { key: "hub-d", partner: "partner-d", count: 5 },
  ] as const;
  for (const [familyIndex, branch] of branches.entries()) {
    builder.person(branch.partner, "female", String(1801 + familyIndex));
    const children = Array.from({ length: branch.count }, (_, childIndex) => {
      const id = `${branch.key}-child-${childIndex + 1}`;
      builder.person(id, childIndex % 2 ? "female" : "male", String(1830 + familyIndex * 4 + childIndex));
      return id;
    });
    builder.family(branch.key, ["hub", branch.partner], children, {
      perChildParentSets: true,
      displayOrder: String(familyIndex).padStart(2, "0"),
    });
  }

  for (const [familyIndex, branch] of branches.entries()) {
    const parentId = `${branch.key}-child-1`;
    const partnerId = `${branch.key}-nested-partner`;
    builder.person(partnerId, "female", String(1855 + familyIndex));
    const children = Array.from(
      { length: (familyIndex % 3) + 1 },
      (_, childIndex) => {
        const id = `${branch.key}-grandchild-${childIndex + 1}`;
        builder.person(id, childIndex % 2 ? "female" : "male", String(1880 + familyIndex * 3 + childIndex));
        return id;
      },
    );
    builder.family(`${branch.key}-nested`, [parentId, partnerId], children, {
      perChildParentSets: true,
    });
  }
  return builder.build();
}

function dagFixture(): DescendantFixture {
  return new DescendantFixtureBuilder()
    .person("dag-root", "male", "1800")
    .person("dag-root-partner", "female", "1801")
    .person("dag-left", "male", "1830")
    .person("dag-right", "female", "1832")
    .person("dag-left-partner", "female", "1831")
    .person("dag-right-partner", "male", "1833")
    .person("dag-shared-child", "female", "1860")
    .person("dag-left-only", "male", "1862")
    .person("dag-right-only", "female", "1864")
    .person("dag-shared-partner", "male", "1859")
    .person("dag-leaf-a", "male", "1890")
    .person("dag-leaf-b", "female", "1892")
    .family(
      "dag-root-family",
      ["dag-root", "dag-root-partner"],
      ["dag-left", "dag-right"],
      { perChildParentSets: true },
    )
    .family(
      "dag-left-family",
      ["dag-left", "dag-left-partner"],
      ["dag-shared-child", "dag-left-only"],
      { perChildParentSets: true },
    )
    .family(
      "dag-right-family",
      ["dag-right", "dag-right-partner"],
      ["dag-shared-child", "dag-right-only"],
      { perChildParentSets: true },
    )
    .family(
      "dag-leaf-family",
      ["dag-shared-child", "dag-shared-partner"],
      ["dag-leaf-a", "dag-leaf-b"],
      { perChildParentSets: true },
    )
    .build();
}

test("descendant forest keeps adjacent nested family routes and cards disjoint", () => {
  const fixture = adjacentNestedFixture();
  const result = runDescendantFixture(fixture, "root", "deep-child-2");

  assert.equal(
    result.nodes.filter(node => node.kind === "person").length,
    fixture.graph.persons.length,
  );
  assertStrictForestGeometry(result, fixture, "adjacent nested descendant forest");
});

test("descendant forest isolates five partner families and their nested descendants", () => {
  const fixture = multiplePartnerFixture();
  const result = runDescendantFixture(
    fixture,
    "hub",
    "hub-primary-grandchild-1",
  );

  assert.equal(
    result.nodes.filter(node => node.personId === "hub").length,
    1,
    "all partner families must reuse one canonical hub card",
  );
  assertStrictForestGeometry(result, fixture, "five-partner descendant forest");

  const geometry = buildFamilyGeometryIndex(
    result,
    fixture.families,
    "five-partner descendant forest",
  );
  const hubFamilyKeys = new Set([
    "hub-a",
    "hub-b",
    "hub-primary",
    "hub-c",
    "hub-d",
  ]);
  const intervals = result.edges
    .filter(edge => edge.kind === "siblings-bus" && edge.unionOccurrenceId)
    .map(edge => ({
      edge,
      familyKey: geometry.familyKeyByUnionOccurrenceId.get(
        edge.unionOccurrenceId!,
      ),
    }))
    .filter(
      (entry): entry is { edge: LayoutEdge; familyKey: string } =>
        Boolean(entry.familyKey && hubFamilyKeys.has(entry.familyKey)),
    )
    .map(({ edge, familyKey }) => ({
      familyKey,
      left: Math.min(edge.points[0]!.x, edge.points[1]!.x),
      right: Math.max(edge.points[0]!.x, edge.points[1]!.x),
    }))
    .sort((left, right) => left.left - right.left);
  assert.equal(intervals.length, hubFamilyKeys.size);
  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(
      intervals[index - 1]!.right + EPSILON < intervals[index]!.left,
      `partner-family child corridors must be horizontally disjoint: ` +
        JSON.stringify({ left: intervals[index - 1], right: intervals[index] }),
    );
  }
});

test("descendant forest routes a shared DAG child without duplicated cards or shared lanes", () => {
  const fixture = dagFixture();
  const result = runDescendantFixture(fixture, "dag-root", "dag-leaf-a");

  assert.equal(
    result.nodes.filter(node => node.personId === "dag-shared-child").length,
    1,
    "both parent sets must terminate at one canonical shared-child card",
  );
  const sharedChildUnions = result.unions.filter(union =>
    union.childOccurrenceIds.some(occurrenceId =>
      result.nodes.some(
        node =>
          node.occurrenceId === occurrenceId &&
          node.personId === "dag-shared-child",
      ),
    ),
  );
  assert.ok(
    sharedChildUnions.length >= 2,
    "the DAG fixture must retain both structural parent families",
  );
  assertStrictForestGeometry(result, fixture, "shared-child descendant DAG");
});
