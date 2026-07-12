import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeIssueDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../types/familyTree";
import type {
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutFamilyUnit,
  FamilyTreeLayoutNode,
  FamilyTreeNodeBadge,
  FamilyTreeViewerLayout,
} from "./familyTreeViewerLayout";

type OccurrenceLayoutItem = {
  occurrence: FamilyTreeOccurrenceDto;
  person: FamilyTreeNodeDto;
};

type PedigreeMetrics = {
  nodeWidth: number;
  nodeHeight: number;
  horizontalSpacing: number;
  verticalSpacing: number;
  padding: number;
};

type PedigreeLayoutOptions = PedigreeMetrics & {
  resolveNodeBadges: (
    graph: FamilyTreeGraphDto,
    node: FamilyTreeNodeDto,
    occurrence: FamilyTreeOccurrenceDto,
  ) => FamilyTreeNodeBadge[];
};

type Point = {
  x: number;
  y: number;
};

type ParentEntry = {
  edge: FamilyTreeEdgeDto;
  occurrenceId: string;
  personId: string;
  side: 0 | 1 | 2;
};

type ParentUnion = {
  key: string;
  childOccurrenceId: string;
  parents: ParentEntry[];
  score: number;
};

type SideBranchPlacement = {
  positions: Map<string, Point>;
  componentByOccurrence: Map<string, string>;
};

const MAX_BASE_PEDIGREE_DEPTH = 7;

export function buildPedigreeViewerLayout(
  graph: FamilyTreeGraphDto,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  options: PedigreeLayoutOptions,
): FamilyTreeViewerLayout {
  const itemByOccurrence = new Map(occurrenceNodes.map((item) => [item.occurrence.id, item]));
  const itemByPerson = itemsByPerson(occurrenceNodes);
  const parentChildEdges = graph.edges.filter((edge) => edge.kind === "parent_child");
  const selectedUnions = preferredParentUnionsByChild(parentChildEdges, itemByOccurrence, itemByPerson);
  const directIds = new Set<string>();
  const positionByOccurrence = new Map<string, Point>();
  const clippedHiddenParents = new Map<string, number>();
  const directSideByOccurrence = new Map<string, "left" | "right" | "center">();
  const measured = new Map<string, number>();

  measurePedigreeSubtree(rootItem.occurrence.id, selectedUnions, measured, options, 0, new Set());
  placePedigreeSubtree({
    occurrenceId: rootItem.occurrence.id,
    centerX: 0,
    depth: 0,
    side: "center",
    selectedUnions,
    itemByOccurrence,
    measured,
    positionByOccurrence,
    directIds,
    directSideByOccurrence,
    clippedHiddenParents,
    metrics: options,
    lineage: new Set(),
  });

  const sidePlacement = placeAnchoredSideBranches({
    graph,
    occurrenceNodes,
    itemByOccurrence,
    parentChildEdges,
    directIds,
    directSideByOccurrence,
    positionByOccurrence,
    rootOccurrenceId: rootItem.occurrence.id,
    metrics: options,
  });
  for (const [occurrenceId, point] of sidePlacement.positions.entries()) {
    if (!positionByOccurrence.has(occurrenceId)) positionByOccurrence.set(occurrenceId, point);
  }
  stabilizeLocalParentPairs(parentChildEdges, directIds, positionByOccurrence, options);
  enforceRootSideCorridors({
    rootOccurrenceId: rootItem.occurrence.id,
    itemByOccurrence,
    positionByOccurrence,
    directIds,
    sideByOccurrence: rootBranchSides({
      graph,
      rootOccurrenceId: rootItem.occurrence.id,
      itemByOccurrence,
      directSideByOccurrence,
    }),
    componentByOccurrence: sidePlacement.componentByOccurrence,
    metrics: options,
  });
  resolveGlobalSideRowOverlaps(positionByOccurrence, directIds, options, sidePlacement.componentByOccurrence);
  clearGlobalPartnerPairBlockers(graph.edges, positionByOccurrence, directIds, options, sidePlacement.componentByOccurrence);

  for (const item of occurrenceNodes) {
    if (positionByOccurrence.has(item.occurrence.id)) continue;
    const fallbackIndex = positionByOccurrence.size;
    positionByOccurrence.set(item.occurrence.id, {
      x: fallbackIndex * (options.nodeWidth + compactGap(options)),
      y: item.occurrence.generation * options.verticalSpacing,
    });
  }
  normalizeRootOrigin(positionByOccurrence, rootItem.occurrence.id);

  return layoutFromPositions({
    graph,
    occurrenceNodes,
    rootOccurrenceId: rootItem.occurrence.id,
    positionByOccurrence,
    clippedHiddenParents,
    resolveNodeBadges: options.resolveNodeBadges,
    metrics: options,
  });
}

function resolveGlobalSideRowOverlaps(
  positionByOccurrence: Map<string, Point>,
  directIds: Set<string>,
  metrics: PedigreeMetrics,
  componentByOccurrence: Map<string, string> = new Map(),
) {
  const rows = new Map<number, Array<{ id: string; point: Point }>>();
  for (const [id, point] of positionByOccurrence.entries()) {
    const rowKey = Math.round(point.y * 1000) / 1000;
    const row = rows.get(rowKey) ?? [];
    row.push({ id, point });
    rows.set(rowKey, row);
  }
  for (const row of rows.values()) {
    const leftSide = row.filter((item) => item.point.x + metrics.nodeWidth / 2 < 0);
    const rightSide = row.filter((item) => item.point.x + metrics.nodeWidth / 2 >= 0);
    leftSide.sort((left, right) => {
      const leftBounds = boundsForSideComponentOrPoint(left.id, positionByOccurrence, componentByOccurrence, metrics);
      const rightBounds = boundsForSideComponentOrPoint(right.id, positionByOccurrence, componentByOccurrence, metrics);
      return rightBounds.maxX - leftBounds.maxX || left.id.localeCompare(right.id, "uk");
    });
    let leftCursor = Infinity;
    const packedLeftComponents = new Set<string>();
    for (const item of leftSide) {
      const componentId = componentByOccurrence.get(item.id) ?? item.id;
      if (packedLeftComponents.has(componentId)) continue;
      packedLeftComponents.add(componentId);
      const bounds = boundsForSideComponentOrPoint(item.id, positionByOccurrence, componentByOccurrence, metrics);
      if (!directIds.has(item.id) && bounds.maxX > leftCursor) {
        shiftSideComponentOrPoint(item.id, leftCursor - bounds.maxX, positionByOccurrence, componentByOccurrence);
      }
      const shiftedBounds = boundsForSideComponentOrPoint(item.id, positionByOccurrence, componentByOccurrence, metrics);
      leftCursor = Math.min(leftCursor, shiftedBounds.minX - siblingBranchGap(metrics));
    }
    rightSide.sort((left, right) => {
      const leftBounds = boundsForSideComponentOrPoint(left.id, positionByOccurrence, componentByOccurrence, metrics);
      const rightBounds = boundsForSideComponentOrPoint(right.id, positionByOccurrence, componentByOccurrence, metrics);
      return leftBounds.minX - rightBounds.minX || left.id.localeCompare(right.id, "uk");
    });
    let rightCursor = -Infinity;
    const packedRightComponents = new Set<string>();
    for (const item of rightSide) {
      const componentId = componentByOccurrence.get(item.id) ?? item.id;
      if (packedRightComponents.has(componentId)) continue;
      packedRightComponents.add(componentId);
      const bounds = boundsForSideComponentOrPoint(item.id, positionByOccurrence, componentByOccurrence, metrics);
      if (!directIds.has(item.id) && bounds.minX < rightCursor) {
        shiftSideComponentOrPoint(item.id, rightCursor - bounds.minX, positionByOccurrence, componentByOccurrence);
      }
      const shiftedBounds = boundsForSideComponentOrPoint(item.id, positionByOccurrence, componentByOccurrence, metrics);
      rightCursor = Math.max(rightCursor, shiftedBounds.maxX + siblingBranchGap(metrics));
    }
  }
}

function shiftSideComponentOrPoint(
  occurrenceId: string,
  deltaX: number,
  positionByOccurrence: Map<string, Point>,
  componentByOccurrence: Map<string, string>,
) {
  if (Math.abs(deltaX) < 0.001) return;
  const componentId = componentByOccurrence.get(occurrenceId);
  if (!componentId) {
    const point = positionByOccurrence.get(occurrenceId);
    if (point) point.x += deltaX;
    return;
  }
  for (const [candidateId, candidateComponentId] of componentByOccurrence.entries()) {
    if (candidateComponentId !== componentId) continue;
    const point = positionByOccurrence.get(candidateId);
    if (point) point.x += deltaX;
  }
}

function clearGlobalPartnerPairBlockers(
  edges: FamilyTreeEdgeDto[],
  positionByOccurrence: Map<string, Point>,
  directIds: Set<string>,
  metrics: PedigreeMetrics,
  componentByOccurrence: Map<string, string> = new Map(),
) {
  for (const edge of edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    if (directIds.has(edge.fromOccurrenceId) || directIds.has(edge.toOccurrenceId)) continue;
    const first = positionByOccurrence.get(edge.fromOccurrenceId);
    const second = positionByOccurrence.get(edge.toOccurrenceId);
    if (!first || !second || first.y !== second.y) continue;
    const rowLoad = [...positionByOccurrence.entries()].filter(([id, point]) =>
      !directIds.has(id) && point.y === first.y,
    ).length;
    if (rowLoad > 8) continue;
    const left = first.x <= second.x ? first : second;
    const right = first.x <= second.x ? second : first;
    const blockers = [...positionByOccurrence.entries()]
      .filter(([id, point]) =>
        id !== edge.fromOccurrenceId &&
        id !== edge.toOccurrenceId &&
        !directIds.has(id) &&
        point.y === left.y &&
        point.x > left.x + metrics.nodeWidth &&
        point.x < right.x,
      )
      .sort((a, b) => b[1].x - a[1].x);
    if (blockers.length > 2) continue;
    let cursor = left.x - siblingBranchGap(metrics) - metrics.nodeWidth;
    const shiftedComponents = new Set<string>();
    const fromComponentId = componentByOccurrence.get(edge.fromOccurrenceId);
    const toComponentId = componentByOccurrence.get(edge.toOccurrenceId);
    const partnerComponentId = fromComponentId && fromComponentId === toComponentId ? fromComponentId : "";
    for (const [occurrenceId] of blockers) {
      const componentId = componentByOccurrence.get(occurrenceId) ?? occurrenceId;
      if (partnerComponentId && componentId === partnerComponentId) {
        const point = positionByOccurrence.get(occurrenceId);
        if (!point) continue;
        point.x = cursor;
        cursor -= metrics.nodeWidth + siblingBranchGap(metrics);
        continue;
      }
      if (shiftedComponents.has(componentId)) continue;
      shiftedComponents.add(componentId);
      const bounds = boundsForSideComponentOrPoint(occurrenceId, positionByOccurrence, componentByOccurrence, metrics);
      const targetMaxX = cursor + metrics.nodeWidth;
      const deltaX = targetMaxX - bounds.maxX;
      shiftSideComponentOrPoint(occurrenceId, deltaX, positionByOccurrence, componentByOccurrence);
      cursor = bounds.minX + deltaX - siblingBranchGap(metrics) - metrics.nodeWidth;
    }
    keepPartnerPairAdjacent(edge.fromOccurrenceId, edge.toOccurrenceId, positionByOccurrence, metrics);
  }
}

function keepPartnerPairAdjacent(
  fromOccurrenceId: string,
  toOccurrenceId: string,
  positionByOccurrence: Map<string, Point>,
  metrics: PedigreeMetrics,
) {
  const first = positionByOccurrence.get(fromOccurrenceId);
  const second = positionByOccurrence.get(toOccurrenceId);
  if (!first || !second || first.y !== second.y) return;
  const left = first.x <= second.x ? first : second;
  const right = first.x <= second.x ? second : first;
  const targetRightX = left.x + metrics.nodeWidth + partnerGap(metrics);
  if (right.x > targetRightX) {
    right.x = targetRightX;
  }
}

function boundsForSideComponentOrPoint(
  occurrenceId: string,
  positionByOccurrence: Map<string, Point>,
  componentByOccurrence: Map<string, string>,
  metrics: PedigreeMetrics,
): { minX: number; maxX: number } {
  const componentId = componentByOccurrence.get(occurrenceId);
  if (!componentId) {
    const point = positionByOccurrence.get(occurrenceId);
    const x = point?.x ?? 0;
    return { minX: x, maxX: x + metrics.nodeWidth };
  }
  const points = [...componentByOccurrence.entries()]
    .filter(([, candidateComponentId]) => candidateComponentId === componentId)
    .map(([candidateId]) => positionByOccurrence.get(candidateId))
    .filter((point): point is Point => Boolean(point));
  if (!points.length) {
    const point = positionByOccurrence.get(occurrenceId);
    const x = point?.x ?? 0;
    return { minX: x, maxX: x + metrics.nodeWidth };
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x + metrics.nodeWidth)),
  };
}

function rootBranchSides(input: {
  graph: FamilyTreeGraphDto;
  rootOccurrenceId: string;
  itemByOccurrence: Map<string, OccurrenceLayoutItem>;
  directSideByOccurrence: Map<string, "left" | "right" | "center">;
}): Map<string, "left" | "right"> {
  const sideByOccurrence = new Map<string, "left" | "right">();
  const directSideByPerson = new Map<string, "left" | "right">();
  for (const [occurrenceId, side] of input.directSideByOccurrence.entries()) {
    if (side === "center") continue;
    sideByOccurrence.set(occurrenceId, side);
    const item = input.itemByOccurrence.get(occurrenceId);
    if (item) directSideByPerson.set(item.person.personId, side);
  }

  const rootItem = input.itemByOccurrence.get(input.rootOccurrenceId);
  const rootPersonId = rootItem?.person.personId;
  if (rootPersonId) {
    for (const [occurrenceId, item] of input.itemByOccurrence.entries()) {
      if (sideByOccurrence.has(occurrenceId)) continue;
      const path = item.occurrence.path ?? [];
      if (path[0] !== rootPersonId) continue;
      for (let index = 1; index < path.length; index += 1) {
        const side = directSideByPerson.get(path[index]);
        if (side) {
          sideByOccurrence.set(occurrenceId, side);
          break;
        }
      }
    }
  }

  const adjacency = occurrenceAdjacency(input.graph.edges);
  const queue = [...sideByOccurrence.keys()];
  const visited = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    if (!current || current === input.rootOccurrenceId) continue;
    const side = sideByOccurrence.get(current);
    if (!side) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (next === input.rootOccurrenceId || visited.has(next)) continue;
      sideByOccurrence.set(next, side);
      visited.add(next);
      queue.push(next);
    }
  }
  sideByOccurrence.delete(input.rootOccurrenceId);
  return sideByOccurrence;
}

function enforceRootSideCorridors(input: {
  rootOccurrenceId: string;
  itemByOccurrence: Map<string, OccurrenceLayoutItem>;
  positionByOccurrence: Map<string, Point>;
  directIds: Set<string>;
  sideByOccurrence: Map<string, "left" | "right">;
  componentByOccurrence: Map<string, string>;
  metrics: PedigreeMetrics;
}) {
  const root = input.positionByOccurrence.get(input.rootOccurrenceId);
  if (!root) return;
  const rootLeftX = root.x;
  const rootRightX = root.x + input.metrics.nodeWidth;
  const corridor = compactGap(input.metrics);
  const rows = new Map<number, Array<{ id: string; point: Point; side: "left" | "right" }>>();
  for (const [id, side] of input.sideByOccurrence.entries()) {
    const point = input.positionByOccurrence.get(id);
    const item = input.itemByOccurrence.get(id);
    if (!point || !item) continue;
    const rowKey = Math.round(point.y * 1000) / 1000;
    if (input.directIds.has(id)) {
      continue;
    }
    const row = rows.get(rowKey) ?? [];
    row.push({ id, point, side });
    rows.set(rowKey, row);
  }

  const gap = siblingBranchGap(input.metrics);
  for (const row of rows.values()) {
    const leftItems = row
      .filter((item) => item.side === "left")
      .sort((left, right) => {
        const leftBounds = boundsForSideComponentOrPoint(left.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
        const rightBounds = boundsForSideComponentOrPoint(right.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
        return rightBounds.maxX - leftBounds.maxX || left.id.localeCompare(right.id, "uk");
      });
    let leftCursor = rootLeftX - corridor;
    const shiftedLeftComponents = new Set<string>();
    for (const item of leftItems) {
      const componentId = input.componentByOccurrence.get(item.id) ?? item.id;
      if (shiftedLeftComponents.has(componentId)) continue;
      shiftedLeftComponents.add(componentId);
      const bounds = boundsForSideComponentOrPoint(item.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
      if (bounds.maxX > leftCursor) {
        shiftSideComponentOrPoint(item.id, leftCursor - bounds.maxX, input.positionByOccurrence, input.componentByOccurrence);
      }
      const shiftedBounds = boundsForSideComponentOrPoint(item.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
      leftCursor = shiftedBounds.minX - gap;
    }

    const rightItems = row
      .filter((item) => item.side === "right")
      .sort((left, right) => {
        const leftBounds = boundsForSideComponentOrPoint(left.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
        const rightBounds = boundsForSideComponentOrPoint(right.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
        return leftBounds.minX - rightBounds.minX || left.id.localeCompare(right.id, "uk");
      });
    let rightCursor = rootRightX + corridor;
    const shiftedRightComponents = new Set<string>();
    for (const item of rightItems) {
      const componentId = input.componentByOccurrence.get(item.id) ?? item.id;
      if (shiftedRightComponents.has(componentId)) continue;
      shiftedRightComponents.add(componentId);
      const bounds = boundsForSideComponentOrPoint(item.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
      if (bounds.minX < rightCursor) {
        shiftSideComponentOrPoint(item.id, rightCursor - bounds.minX, input.positionByOccurrence, input.componentByOccurrence);
      }
      const shiftedBounds = boundsForSideComponentOrPoint(item.id, input.positionByOccurrence, input.componentByOccurrence, input.metrics);
      rightCursor = shiftedBounds.maxX + gap;
    }
  }
}

function normalizeRootOrigin(positionByOccurrence: Map<string, Point>, rootOccurrenceId: string) {
  const root = positionByOccurrence.get(rootOccurrenceId);
  if (!root) return;
  const offsetX = -root.x;
  const offsetY = -root.y;
  if (Math.abs(offsetX) < 0.001 && Math.abs(offsetY) < 0.001) return;
  for (const point of positionByOccurrence.values()) {
    point.x += offsetX;
    point.y += offsetY;
    if (Object.is(point.x, -0)) point.x = 0;
    if (Object.is(point.y, -0)) point.y = 0;
  }
}

function itemsByPerson(items: OccurrenceLayoutItem[]): Map<string, OccurrenceLayoutItem[]> {
  const result = new Map<string, OccurrenceLayoutItem[]>();
  for (const item of items) {
    const row = result.get(item.person.personId) ?? [];
    row.push(item);
    result.set(item.person.personId, row);
  }
  return result;
}

function preferredParentUnionsByChild(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  itemByPerson: Map<string, OccurrenceLayoutItem[]>,
): Map<string, ParentUnion> {
  const unionsByChild = new Map<string, ParentUnion[]>();
  for (const edge of parentChildEdges) {
    const childOccurrenceId = edge.toOccurrenceId ?? firstOccurrenceIdForPerson(edge.toPersonId, itemByPerson);
    const parentOccurrenceId = edge.fromOccurrenceId ?? firstOccurrenceIdForPerson(edge.fromPersonId, itemByPerson);
    if (!childOccurrenceId || !parentOccurrenceId) continue;
    if (!itemByOccurrence.has(childOccurrenceId) || !itemByOccurrence.has(parentOccurrenceId)) continue;
    const groupKey = unionGroupKey(edge, childOccurrenceId);
    const row = unionsByChild.get(childOccurrenceId) ?? [];
    let union = row.find((item) => item.key === groupKey);
    if (!union) {
      union = {
        key: groupKey,
        childOccurrenceId,
        parents: [],
        score: 0,
      };
      row.push(union);
      unionsByChild.set(childOccurrenceId, row);
    }
    if (!union.parents.some((parent) => parent.occurrenceId === parentOccurrenceId)) {
      union.parents.push({
        edge,
        occurrenceId: parentOccurrenceId,
        personId: edge.fromPersonId,
        side: parentSide(edge),
      });
    }
    union.score += parentEdgeScore(edge);
  }

  const result = new Map<string, ParentUnion>();
  for (const [childOccurrenceId, unions] of unionsByChild.entries()) {
    const sorted = unions
      .map((union) => ({
        ...union,
        parents: sortedParents(union.parents).slice(0, 2),
        score: union.score + union.parents.length * 20,
      }))
      .sort((left, right) =>
        right.score - left.score ||
        right.parents.length - left.parents.length ||
        left.key.localeCompare(right.key, "uk"),
      );
    const selected = sorted[0];
    if (selected?.parents.length) result.set(childOccurrenceId, selected);
  }
  return result;
}

function firstOccurrenceIdForPerson(
  personId: string,
  itemByPerson: Map<string, OccurrenceLayoutItem[]>,
): string | undefined {
  return itemByPerson.get(personId)
    ?.slice()
    .sort((left, right) =>
      Math.abs(left.occurrence.generation) - Math.abs(right.occurrence.generation) ||
      left.occurrence.depth - right.occurrence.depth ||
      left.occurrence.id.localeCompare(right.occurrence.id, "uk"),
    )[0]?.occurrence.id;
}

function unionGroupKey(edge: FamilyTreeEdgeDto, childOccurrenceId: string): string {
  if (edge.parentSetId) return `parent-set:${edge.parentSetId}`;
  if (edge.familyGroupId) return `family:${edge.familyGroupId}`;
  return `child:${childOccurrenceId}:type:${edge.relationshipType || "parent"}`;
}

function parentEdgeScore(edge: FamilyTreeEdgeDto): number {
  const relationshipType = String(edge.relationshipType ?? "").toLocaleLowerCase("uk");
  let score = 0;
  if (edge.isBloodline) score += 120;
  if (["biological", "birth_parent", "genetic_father", "genetic_mother", "gestational_parent"].includes(relationshipType)) {
    score += 100;
  }
  if (["adoptive", "legal_parent"].includes(relationshipType)) score += 45;
  if (["step", "foster", "guardian", "social_parent"].includes(relationshipType)) score += 20;
  if (edge.evidenceStatus === "proven") score += 18;
  if (edge.evidenceStatus === "likely") score += 10;
  if (edge.style.visibility === "visible") score += 5;
  return score + Math.max(0, Math.min(100, edge.confidence ?? 0)) / 10;
}

function parentSide(edge: FamilyTreeEdgeDto): 0 | 1 | 2 {
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? "").toLocaleLowerCase("uk");
  const relationshipType = String(edge.relationshipType ?? "").toLocaleLowerCase("uk");
  if (role.includes("father") || relationshipType.includes("father")) return 0;
  if (role.includes("mother") || relationshipType.includes("mother")) return 1;
  return 2;
}

function sortedParents(parents: ParentEntry[]): ParentEntry[] {
  return [...parents].sort((left, right) =>
    left.side - right.side ||
    left.edge.relationshipId.localeCompare(right.edge.relationshipId, "uk") ||
    left.occurrenceId.localeCompare(right.occurrenceId, "uk"),
  );
}

function measurePedigreeSubtree(
  occurrenceId: string,
  selectedUnions: Map<string, ParentUnion>,
  measured: Map<string, number>,
  metrics: PedigreeMetrics,
  depth: number,
  lineage: Set<string>,
): number {
  const cached = measured.get(`${occurrenceId}:${depth}`);
  if (cached !== undefined) return cached;
  if (depth >= MAX_BASE_PEDIGREE_DEPTH || lineage.has(occurrenceId)) return metrics.nodeWidth;
  const union = selectedUnions.get(occurrenceId);
  if (!union?.parents.length) return metrics.nodeWidth;

  const nextLineage = new Set(lineage);
  nextLineage.add(occurrenceId);
  const parentWidths = union.parents.map((parent) =>
    measurePedigreeSubtree(parent.occurrenceId, selectedUnions, measured, metrics, depth + 1, nextLineage),
  );
  const width = Math.max(
    metrics.nodeWidth,
    parentWidths.reduce((sum, value) => sum + value, 0) + parentGap(metrics) * Math.max(0, parentWidths.length - 1),
  );
  measured.set(`${occurrenceId}:${depth}`, width);
  return width;
}

function placePedigreeSubtree(input: {
  occurrenceId: string;
  centerX: number;
  depth: number;
  side: "left" | "right" | "center";
  selectedUnions: Map<string, ParentUnion>;
  itemByOccurrence: Map<string, OccurrenceLayoutItem>;
  measured: Map<string, number>;
  positionByOccurrence: Map<string, Point>;
  directIds: Set<string>;
  directSideByOccurrence: Map<string, "left" | "right" | "center">;
  clippedHiddenParents: Map<string, number>;
  metrics: PedigreeMetrics;
  lineage: Set<string>;
}) {
  const item = input.itemByOccurrence.get(input.occurrenceId);
  if (!item) return;
  input.positionByOccurrence.set(input.occurrenceId, {
    x: input.centerX - input.metrics.nodeWidth / 2,
    y: -input.depth * input.metrics.verticalSpacing,
  });
  input.directIds.add(input.occurrenceId);
  input.directSideByOccurrence.set(input.occurrenceId, input.side);

  const union = input.selectedUnions.get(input.occurrenceId);
  if (!union?.parents.length) return;
  if (input.depth >= MAX_BASE_PEDIGREE_DEPTH) {
    input.clippedHiddenParents.set(input.occurrenceId, union.parents.length);
    return;
  }
  if (input.lineage.has(input.occurrenceId)) return;

  const nextLineage = new Set(input.lineage);
  nextLineage.add(input.occurrenceId);
  const parentWidths = union.parents.map((parent) =>
    measurePedigreeSubtree(
      parent.occurrenceId,
      input.selectedUnions,
      input.measured,
      input.metrics,
      input.depth + 1,
      nextLineage,
    ),
  );
  const parentCenters = parentCentersForUnion(input.centerX, union.parents, parentWidths, input.metrics);
  union.parents.forEach((parent, index) => {
    const childSide = parent.side === 0 ? "left" : parent.side === 1 ? "right" : input.side;
    placePedigreeSubtree({
      ...input,
      occurrenceId: parent.occurrenceId,
      centerX: parentCenters[index] ?? input.centerX,
      depth: input.depth + 1,
      side: input.side === "center" ? childSide : input.side,
      lineage: nextLineage,
    });
  });
}

function parentCentersForUnion(
  childCenterX: number,
  parents: ParentEntry[],
  parentWidths: number[],
  metrics: PedigreeMetrics,
): number[] {
  if (parentWidths.length <= 1) {
    const width = parentWidths[0] ?? metrics.nodeWidth;
    const side = parents[0]?.side ?? 2;
    if (side === 0) return [childCenterX - parentGap(metrics) / 2 - width / 2];
    if (side === 1) return [childCenterX + parentGap(metrics) / 2 + width / 2];
    return [childCenterX];
  }
  const leftWidth = parentWidths[0] ?? metrics.nodeWidth;
  const rightWidth = parentWidths[1] ?? metrics.nodeWidth;
  const gap = parentGap(metrics);
  return [
    childCenterX - gap / 2 - leftWidth / 2,
    childCenterX + gap / 2 + rightWidth / 2,
  ];
}

function placeAnchoredSideBranches(input: {
  graph: FamilyTreeGraphDto;
  occurrenceNodes: OccurrenceLayoutItem[];
  itemByOccurrence: Map<string, OccurrenceLayoutItem>;
  parentChildEdges: FamilyTreeEdgeDto[];
  directIds: Set<string>;
  directSideByOccurrence: Map<string, "left" | "right" | "center">;
  positionByOccurrence: Map<string, Point>;
  rootOccurrenceId: string;
  metrics: PedigreeMetrics;
}): SideBranchPlacement {
  const remainingIds = input.occurrenceNodes
    .map((item) => item.occurrence.id)
    .filter((id) => !input.directIds.has(id));
  const positions = new Map<string, Point>();
  const componentByOccurrence = new Map<string, string>();
  if (!remainingIds.length) return { positions, componentByOccurrence };

  const adjacency = occurrenceAdjacency(input.graph.edges);
  const anchorByOccurrence = nearestDirectAnchor({
    occurrenceIds: remainingIds,
    directIds: input.directIds,
    adjacency,
    itemByOccurrence: input.itemByOccurrence,
    parentChildEdges: input.parentChildEdges,
  });
  const nodesByAnchor = new Map<string, string[]>();
  for (const occurrenceId of remainingIds) {
    const anchorId = anchorByOccurrence.get(occurrenceId);
    if (!anchorId) continue;
    const row = nodesByAnchor.get(anchorId) ?? [];
    row.push(occurrenceId);
    nodesByAnchor.set(anchorId, row);
  }

  const placedBounds: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = directNodeBounds(input.positionByOccurrence, input.metrics);
  for (const [anchorId, occurrenceIds] of [...nodesByAnchor.entries()].sort((left, right) => {
    const leftPoint = input.positionByOccurrence.get(left[0]);
    const rightPoint = input.positionByOccurrence.get(right[0]);
    return (leftPoint?.y ?? 0) - (rightPoint?.y ?? 0) || (leftPoint?.x ?? 0) - (rightPoint?.x ?? 0);
  })) {
    const anchorPoint = input.positionByOccurrence.get(anchorId);
    if (!anchorPoint) continue;
    const local = layoutLocalSideComponent(anchorId, occurrenceIds, input);
    if (!local.positions.size) continue;
    const localBounds = boundsForPoints(local.positions, input.metrics);
    const side = input.directSideByOccurrence.get(anchorId) ?? sideFromX(anchorPoint.x);
    const direction = side === "left" ? -1 : 1;
    const gap = local.hasSharedParentWithAnchor ? siblingBranchGap(input.metrics) : branchGap(input.metrics);
    let shiftX = local.hasAnchorPartner
      ? direction < 0
        ? anchorPoint.x - gap - localBounds.maxX
        : anchorPoint.x + input.metrics.nodeWidth + gap - localBounds.minX
      : direction < 0
        ? anchorPoint.x - gap - localBounds.maxX
        : anchorPoint.x + input.metrics.nodeWidth + gap - localBounds.minX;
    let shiftY = 0;

    const collisionPadding = local.hasSharedParentWithAnchor ? siblingBranchGap(input.metrics) : compactGap(input.metrics);
    const rootPoint = input.positionByOccurrence.get(input.rootOccurrenceId);
    if (rootPoint) {
      const shifted = shiftBounds(localBounds, shiftX, shiftY);
      const rootCorridor = compactGap(input.metrics);
      if (direction < 0 && shifted.maxX > rootPoint.x - rootCorridor) {
        shiftX -= shifted.maxX - (rootPoint.x - rootCorridor);
      } else if (direction > 0 && shifted.minX < rootPoint.x + input.metrics.nodeWidth + rootCorridor) {
        shiftX += rootPoint.x + input.metrics.nodeWidth + rootCorridor - shifted.minX;
      }
    }
    for (let guard = 0; guard < 80; guard += 1) {
      const shifted = shiftBounds(localBounds, shiftX, shiftY);
      if (!placedBounds.some((bound) => boundsOverlap(shifted, bound, collisionPadding))) break;
      shiftX += direction * (input.metrics.nodeWidth + compactGap(input.metrics));
      if (guard % 8 === 7) shiftY += input.metrics.verticalSpacing * 0.35;
    }

    const localComponentByOccurrence = sideComponentIdsForAnchor(anchorId, occurrenceIds, input.graph.edges);
    for (const [occurrenceId, point] of local.positions.entries()) {
      positions.set(occurrenceId, { x: point.x + shiftX, y: point.y + shiftY });
      componentByOccurrence.set(
        occurrenceId,
        localComponentByOccurrence.get(occurrenceId) ?? `anchor:${anchorId}:item:${occurrenceId}`,
      );
    }
    placedBounds.push(shiftBounds(localBounds, shiftX, shiftY));
  }
  return { positions, componentByOccurrence };
}

function sideComponentIdsForAnchor(
  anchorId: string,
  occurrenceIds: string[],
  edges: FamilyTreeEdgeDto[],
): Map<string, string> {
  const localIds = new Set(occurrenceIds);
  const adjacency = new Map<string, Set<string>>();
  for (const id of localIds) adjacency.set(id, new Set());
  for (const edge of edges) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const fromIsLocal = localIds.has(edge.fromOccurrenceId);
    const toIsLocal = localIds.has(edge.toOccurrenceId);
    if (!fromIsLocal && !toIsLocal) continue;
    if (edge.fromOccurrenceId === anchorId || edge.toOccurrenceId === anchorId) continue;
    if (!fromIsLocal || !toIsLocal) continue;
    adjacency.get(edge.fromOccurrenceId)?.add(edge.toOccurrenceId);
    adjacency.get(edge.toOccurrenceId)?.add(edge.fromOccurrenceId);
  }

  const componentByOccurrence = new Map<string, string>();
  const visited = new Set<string>();
  for (const id of occurrenceIds.slice().sort((left, right) => left.localeCompare(right, "uk"))) {
    if (visited.has(id)) continue;
    const queue = [id];
    const componentIds: string[] = [];
    visited.add(id);
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      componentIds.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    const componentId = `anchor:${anchorId}:component:${componentIds.slice().sort((left, right) => left.localeCompare(right, "uk"))[0] ?? id}`;
    for (const occurrenceId of componentIds) componentByOccurrence.set(occurrenceId, componentId);
  }
  return componentByOccurrence;
}

function occurrenceAdjacency(edges: FamilyTreeEdgeDto[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const left = result.get(edge.fromOccurrenceId) ?? new Set<string>();
    const right = result.get(edge.toOccurrenceId) ?? new Set<string>();
    left.add(edge.toOccurrenceId);
    right.add(edge.fromOccurrenceId);
    result.set(edge.fromOccurrenceId, left);
    result.set(edge.toOccurrenceId, right);
  }
  return result;
}

function nearestDirectAnchor(input: {
  occurrenceIds: string[];
  directIds: Set<string>;
  adjacency: Map<string, Set<string>>;
  itemByOccurrence: Map<string, OccurrenceLayoutItem>;
  parentChildEdges: FamilyTreeEdgeDto[];
}): Map<string, string> {
  const result = new Map<string, string>();
  const siblingAnchors = siblingAnchorByOccurrence(input.parentChildEdges, input.directIds, input.itemByOccurrence);
  for (const occurrenceId of input.occurrenceIds) {
    const siblingAnchor = siblingAnchors.get(occurrenceId);
    if (siblingAnchor) {
      result.set(occurrenceId, siblingAnchor);
      continue;
    }
    const queue = [{ id: occurrenceId, distance: 0 }];
    const visited = new Set<string>([occurrenceId]);
    let selected = "";
    for (let index = 0; index < queue.length && !selected; index += 1) {
      const current = queue[index];
      const neighbors = [...(input.adjacency.get(current.id) ?? [])].sort((left, right) => {
        const leftItem = input.itemByOccurrence.get(left);
        const rightItem = input.itemByOccurrence.get(right);
        return (leftItem?.occurrence.depth ?? 999) - (rightItem?.occurrence.depth ?? 999) || left.localeCompare(right, "uk");
      });
      for (const neighbor of neighbors) {
        if (input.directIds.has(neighbor)) {
          selected = neighbor;
          break;
        }
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ id: neighbor, distance: current.distance + 1 });
      }
    }
    if (selected) result.set(occurrenceId, selected);
  }
  return result;
}

function siblingAnchorByOccurrence(
  parentChildEdges: FamilyTreeEdgeDto[],
  directIds: Set<string>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): Map<string, string> {
  const parentsByChild = new Map<string, Set<string>>();
  for (const edge of parentChildEdges) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const row = parentsByChild.get(edge.toOccurrenceId) ?? new Set<string>();
    row.add(edge.fromOccurrenceId);
    parentsByChild.set(edge.toOccurrenceId, row);
  }
  const result = new Map<string, string>();
  for (const [childId, parents] of parentsByChild.entries()) {
    if (directIds.has(childId)) continue;
    const childItem = itemByOccurrence.get(childId);
    if (!childItem) continue;
    const candidates = [...parentsByChild.entries()]
      .filter(([candidateId, candidateParents]) =>
        directIds.has(candidateId) &&
        candidateId !== childId &&
        itemByOccurrence.get(candidateId)?.occurrence.generation === childItem.occurrence.generation &&
        [...parents].some((parentId) => candidateParents.has(parentId)),
      )
      .map(([candidateId]) => candidateId)
      .sort((left, right) =>
        (itemByOccurrence.get(left)?.occurrence.depth ?? 999) - (itemByOccurrence.get(right)?.occurrence.depth ?? 999) ||
        left.localeCompare(right, "uk"),
      );
    if (candidates[0]) result.set(childId, candidates[0]);
  }
  return result;
}

function layoutLocalSideComponent(
  anchorId: string,
  occurrenceIds: string[],
  input: {
    graph: FamilyTreeGraphDto;
    itemByOccurrence: Map<string, OccurrenceLayoutItem>;
    positionByOccurrence: Map<string, Point>;
    metrics: PedigreeMetrics;
  },
): { positions: Map<string, Point>; hasAnchorPartner: boolean; hasSharedParentWithAnchor: boolean } {
  const positions = new Map<string, Point>();
  const ids = new Set(occurrenceIds);
  const anchorItem = input.itemByOccurrence.get(anchorId);
  const fixedLocalPositions = new Map<string, Point>();
  if (anchorItem) {
    fixedLocalPositions.set(anchorId, {
      x: 0,
      y: anchorItem.occurrence.generation * input.metrics.verticalSpacing,
    });
  }
  const rowIds = new Map<number, string[]>();
  for (const occurrenceId of occurrenceIds) {
    const item = input.itemByOccurrence.get(occurrenceId);
    if (!item) continue;
    const row = item.occurrence.generation;
    const list = rowIds.get(row) ?? [];
    list.push(occurrenceId);
    rowIds.set(row, list);
  }

  for (const [generation, row] of rowIds.entries()) {
    row.sort((left, right) => compareSideOccurrence(left, right, input.itemByOccurrence));
    const rowWidth = row.length * input.metrics.nodeWidth + Math.max(0, row.length - 1) * compactGap(input.metrics);
    let cursor = -rowWidth / 2;
    for (const occurrenceId of row) {
      positions.set(occurrenceId, {
        x: cursor,
        y: generation * input.metrics.verticalSpacing,
      });
      cursor += input.metrics.nodeWidth + compactGap(input.metrics);
    }
  }

  const scopedEdges = input.graph.edges.filter((edge) =>
    edge.fromOccurrenceId &&
    edge.toOccurrenceId &&
    (ids.has(edge.fromOccurrenceId) || edge.fromOccurrenceId === anchorId) &&
    (ids.has(edge.toOccurrenceId) || edge.toOccurrenceId === anchorId),
  );
  const hasAnchorPartner = scopedEdges.some((edge) =>
    edge.kind === "partner" &&
    (edge.fromOccurrenceId === anchorId || edge.toOccurrenceId === anchorId),
  );
  const hasSharedParentWithAnchor = sharesParentWithAnchor(anchorId, ids, input.graph.edges);

  for (let pass = 0; pass < 6; pass += 1) {
    alignPartners(scopedEdges, positions, fixedLocalPositions, input.itemByOccurrence, input.metrics);
    alignParentsAroundChildren(scopedEdges, positions, fixedLocalPositions, input.itemByOccurrence, input.metrics);
    alignChildrenUnderParents(scopedEdges, positions, fixedLocalPositions, input.metrics);
    resolveLocalRowOverlaps(positions, input.itemByOccurrence, input.metrics);
  }
  alignPartners(scopedEdges, positions, fixedLocalPositions, input.itemByOccurrence, input.metrics, true);
  resolveLocalRowOverlaps(positions, input.itemByOccurrence, input.metrics);
  clearBetweenLocalPartnerPairs(scopedEdges, positions, input.metrics);
  return { positions, hasAnchorPartner, hasSharedParentWithAnchor };
}

function stabilizeLocalParentPairs(
  parentChildEdges: FamilyTreeEdgeDto[],
  directIds: Set<string>,
  positionByOccurrence: Map<string, Point>,
  metrics: PedigreeMetrics,
) {
  const parentsByChild = new Map<string, ParentEntry[]>();
  for (const edge of parentChildEdges) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    if (directIds.has(edge.toOccurrenceId) || directIds.has(edge.fromOccurrenceId)) continue;
    if (!positionByOccurrence.has(edge.fromOccurrenceId) || !positionByOccurrence.has(edge.toOccurrenceId)) continue;
    const row = parentsByChild.get(edge.toOccurrenceId) ?? [];
    row.push({
      edge,
      occurrenceId: edge.fromOccurrenceId,
      personId: edge.fromPersonId,
      side: parentSide(edge),
    });
    parentsByChild.set(edge.toOccurrenceId, row);
  }
  for (const [childId, parents] of parentsByChild.entries()) {
    const child = positionByOccurrence.get(childId);
    if (!child) continue;
    const sorted = sortedParents(parents).slice(0, 2);
    if (sorted.length !== 2) continue;
    const childCenter = child.x + metrics.nodeWidth / 2;
    const centers = parentCentersForUnion(childCenter, sorted, [metrics.nodeWidth, metrics.nodeWidth], metrics);
    sorted.forEach((parent, index) => {
      const point = positionByOccurrence.get(parent.occurrenceId);
      if (!point) return;
      point.x = (centers[index] ?? childCenter) - metrics.nodeWidth / 2;
      point.y = child.y - metrics.verticalSpacing;
    });
  }
}

function clearBetweenLocalPartnerPairs(
  edges: FamilyTreeEdgeDto[],
  localPositions: Map<string, Point>,
  metrics: PedigreeMetrics,
) {
  for (const edge of edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const first = localPositions.get(edge.fromOccurrenceId);
    const second = localPositions.get(edge.toOccurrenceId);
    if (!first || !second || first.y !== second.y) continue;
    const left = first.x <= second.x ? first : second;
    const right = first.x <= second.x ? second : first;
    const minBetween = left.x + metrics.nodeWidth;
    const maxBetween = right.x;
    const blockers = [...localPositions.entries()]
      .filter(([id, point]) =>
        id !== edge.fromOccurrenceId &&
        id !== edge.toOccurrenceId &&
        point.y === left.y &&
        point.x > minBetween &&
        point.x < maxBetween,
      )
      .sort((a, b) => b[1].x - a[1].x);
    let cursor = left.x - compactGap(metrics) - metrics.nodeWidth;
    for (const [, point] of blockers) {
      point.x = cursor;
      cursor -= metrics.nodeWidth + compactGap(metrics);
    }
  }
}

function sharesParentWithAnchor(anchorId: string, localIds: Set<string>, edges: FamilyTreeEdgeDto[]): boolean {
  const anchorParents = new Set(edges
    .filter((edge) => edge.kind === "parent_child" && edge.toOccurrenceId === anchorId && edge.fromOccurrenceId)
    .map((edge) => edge.fromOccurrenceId as string));
  if (!anchorParents.size) return false;
  for (const edge of edges) {
    if (edge.kind !== "parent_child" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    if (!localIds.has(edge.toOccurrenceId)) continue;
    if (anchorParents.has(edge.fromOccurrenceId)) return true;
  }
  return false;
}

function alignParentsAroundChildren(
  edges: FamilyTreeEdgeDto[],
  localPositions: Map<string, Point>,
  fixedPositions: Map<string, Point>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  metrics: PedigreeMetrics,
) {
  const parentsByChild = new Map<string, ParentEntry[]>();
  for (const edge of edges) {
    if (edge.kind !== "parent_child" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    if (!localPositions.has(edge.fromOccurrenceId)) continue;
    const row = parentsByChild.get(edge.toOccurrenceId) ?? [];
    row.push({
      edge,
      occurrenceId: edge.fromOccurrenceId,
      personId: edge.fromPersonId,
      side: parentSide(edge),
    });
    parentsByChild.set(edge.toOccurrenceId, row);
  }
  for (const [childId, parents] of parentsByChild.entries()) {
    const child = localPositions.get(childId) ?? fixedPositions.get(childId);
    if (!child) continue;
    const sorted = sortedParents(parents).slice(0, 2);
    const childCenter = child.x + metrics.nodeWidth / 2;
    const parentCenters = sorted.length === 1
      ? [singleParentCenterForChild(childCenter, sorted[0].side, metrics)]
      : parentCentersForUnion(childCenter, sorted, sorted.map(() => metrics.nodeWidth), metrics);
    sorted.forEach((parent, index) => {
      const point = localPositions.get(parent.occurrenceId);
      if (!point) return;
      point.x = (parentCenters[index] ?? (child.x + metrics.nodeWidth / 2)) - metrics.nodeWidth / 2;
      point.y = child.y - metrics.verticalSpacing;
      const item = itemByOccurrence.get(parent.occurrenceId);
      if (item && item.occurrence.generation * metrics.verticalSpacing !== point.y && Math.abs(item.occurrence.generation) > 0) {
        point.y = child.y - metrics.verticalSpacing;
      }
    });
  }
}

function singleParentCenterForChild(childCenterX: number, side: 0 | 1 | 2, metrics: PedigreeMetrics): number {
  const offset = (metrics.nodeWidth + parentGap(metrics)) / 2;
  if (side === 0) return childCenterX - offset;
  if (side === 1) return childCenterX + offset;
  return childCenterX;
}

function alignChildrenUnderParents(
  edges: FamilyTreeEdgeDto[],
  localPositions: Map<string, Point>,
  fixedPositions: Map<string, Point>,
  metrics: PedigreeMetrics,
) {
  const parentsByChild = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "parent_child" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const row = parentsByChild.get(edge.toOccurrenceId) ?? [];
    row.push(edge.fromOccurrenceId);
    parentsByChild.set(edge.toOccurrenceId, row);
  }
  for (const [childId, parentIds] of parentsByChild.entries()) {
    const child = localPositions.get(childId);
    if (!child) continue;
    const parentCenters = parentIds
      .map((id) => localPositions.get(id) ?? fixedPositions.get(id))
      .filter((point): point is Point => Boolean(point))
      .map((point) => point.x + metrics.nodeWidth / 2);
    if (!parentCenters.length) continue;
    const targetCenter = average(parentCenters);
    child.x = (child.x * 0.35) + ((targetCenter - metrics.nodeWidth / 2) * 0.65);
  }
}

function alignPartners(
  edges: FamilyTreeEdgeDto[],
  localPositions: Map<string, Point>,
  fixedPositions: Map<string, Point>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  metrics: PedigreeMetrics,
  localPairsOnly = false,
) {
  for (const edge of edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const leftLocal = localPositions.get(edge.fromOccurrenceId);
    const rightLocal = localPositions.get(edge.toOccurrenceId);
    const leftFixed = fixedPositions.get(edge.fromOccurrenceId);
    const rightFixed = fixedPositions.get(edge.toOccurrenceId);
    if (localPairsOnly && !(leftLocal && rightLocal)) continue;
    if (leftLocal && rightFixed) {
      leftLocal.y = rightFixed.y;
      leftLocal.x = rightFixed.x - metrics.nodeWidth - partnerGap(metrics);
    } else if (rightLocal && leftFixed) {
      rightLocal.y = leftFixed.y;
      rightLocal.x = leftFixed.x + metrics.nodeWidth + partnerGap(metrics);
    } else if (leftLocal && rightLocal) {
      const y = preferredPartnerRowY(edge.fromOccurrenceId, edge.toOccurrenceId, leftLocal, rightLocal, itemByOccurrence);
      leftLocal.y = y;
      rightLocal.y = y;
      if (Math.abs((rightLocal.x - leftLocal.x) - (metrics.nodeWidth + partnerGap(metrics))) < 1) continue;
      const center = (leftLocal.x + rightLocal.x + metrics.nodeWidth) / 2;
      leftLocal.x = center - metrics.nodeWidth - partnerGap(metrics) / 2;
      rightLocal.x = center + partnerGap(metrics) / 2;
    }
  }
}

function preferredPartnerRowY(
  leftId: string,
  rightId: string,
  left: Point,
  right: Point,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): number {
  const leftGeneration = itemByOccurrence.get(leftId)?.occurrence.generation ?? 0;
  const rightGeneration = itemByOccurrence.get(rightId)?.occurrence.generation ?? 0;
  if (leftGeneration !== 0 && rightGeneration === 0) return left.y;
  if (rightGeneration !== 0 && leftGeneration === 0) return right.y;
  if (Math.abs(leftGeneration) > Math.abs(rightGeneration)) return left.y;
  if (Math.abs(rightGeneration) > Math.abs(leftGeneration)) return right.y;
  return Math.min(left.y, right.y);
}

function resolveLocalRowOverlaps(
  positions: Map<string, Point>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  metrics: PedigreeMetrics,
) {
  const rows = new Map<number, Array<{ id: string; point: Point }>>();
  for (const [id, point] of positions.entries()) {
    const generation = itemByOccurrence.get(id)?.occurrence.generation ?? Math.round(point.y / metrics.verticalSpacing);
    const row = rows.get(generation) ?? [];
    row.push({ id, point });
    rows.set(generation, row);
  }
  for (const row of rows.values()) {
    row.sort((left, right) => left.point.x - right.point.x || left.id.localeCompare(right.id, "uk"));
    let cursor = -Infinity;
    for (const item of row) {
      if (item.point.x < cursor) item.point.x = cursor;
      cursor = item.point.x + metrics.nodeWidth + compactGap(metrics);
    }
  }
}

function compareSideOccurrence(
  leftId: string,
  rightId: string,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): number {
  const left = itemByOccurrence.get(leftId);
  const right = itemByOccurrence.get(rightId);
  if (!left || !right) return leftId.localeCompare(rightId, "uk");
  return left.occurrence.depth - right.occurrence.depth ||
    left.person.displayName.localeCompare(right.person.displayName, "uk") ||
    left.occurrence.id.localeCompare(right.occurrence.id, "uk");
}

function directNodeBounds(
  positions: Map<string, Point>,
  metrics: PedigreeMetrics,
): Array<{ minX: number; minY: number; maxX: number; maxY: number }> {
  return [...positions.values()].map((point) => ({
    minX: point.x,
    minY: point.y,
    maxX: point.x + metrics.nodeWidth,
    maxY: point.y + metrics.nodeHeight,
  }));
}

function boundsForPoints(
  positions: Map<string, Point>,
  metrics: PedigreeMetrics,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const values = [...positions.values()];
  if (!values.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...values.map((point) => point.x)),
    minY: Math.min(...values.map((point) => point.y)),
    maxX: Math.max(...values.map((point) => point.x + metrics.nodeWidth)),
    maxY: Math.max(...values.map((point) => point.y + metrics.nodeHeight)),
  };
}

function shiftBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: bounds.minX + x,
    minY: bounds.minY + y,
    maxX: bounds.maxX + x,
    maxY: bounds.maxY + y,
  };
}

function boundsOverlap(
  left: { minX: number; minY: number; maxX: number; maxY: number },
  right: { minX: number; minY: number; maxX: number; maxY: number },
  padding: number,
): boolean {
  return left.minX - padding < right.maxX &&
    left.maxX + padding > right.minX &&
    left.minY - padding < right.maxY &&
    left.maxY + padding > right.minY;
}

function layoutFromPositions(input: {
  graph: FamilyTreeGraphDto;
  occurrenceNodes: OccurrenceLayoutItem[];
  rootOccurrenceId: string;
  positionByOccurrence: Map<string, Point>;
  clippedHiddenParents: Map<string, number>;
  resolveNodeBadges: (
    graph: FamilyTreeGraphDto,
    node: FamilyTreeNodeDto,
    occurrence: FamilyTreeOccurrenceDto,
  ) => FamilyTreeNodeBadge[];
  metrics: PedigreeMetrics;
}): FamilyTreeViewerLayout {
  const nodes = input.occurrenceNodes
    .map((item) => {
      const point = input.positionByOccurrence.get(item.occurrence.id);
      if (!point) return null;
      const hiddenParentsCount = input.clippedHiddenParents.get(item.occurrence.id) ?? item.occurrence.hiddenParentsCount;
      const occurrence = hiddenParentsCount
        ? { ...item.occurrence, hiddenParentsCount }
        : item.occurrence;
      return {
        occurrence,
        person: item.person,
        x: point.x,
        y: point.y,
        width: input.metrics.nodeWidth,
        height: input.metrics.nodeHeight,
        badges: input.resolveNodeBadges(input.graph, item.person, occurrence),
      };
    })
    .filter((node): node is FamilyTreeLayoutNode => Boolean(node))
    .sort((left, right) => left.y - right.y || left.x - right.x || left.occurrence.id.localeCompare(right.occurrence.id, "uk"));

  const nodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  const edges = input.graph.edges
    .map((edge) => {
      if (!edge.fromOccurrenceId || !edge.toOccurrenceId) return null;
      const from = nodeByOccurrence.get(edge.fromOccurrenceId);
      const to = nodeByOccurrence.get(edge.toOccurrenceId);
      if (!from || !to) return null;
      return {
        edge,
        from,
        to,
        path: edgePath(edge, from, to),
        dashArray: edgeDashArray(edge),
        opacity: edge.style.visibility === "faded" ? 0.32 : 1,
      };
    })
    .filter((edge): edge is FamilyTreeLayoutEdge => Boolean(edge));
  const familyUnits = buildFamilyUnits(edges);
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    nodes,
    edges,
    familyUnits,
    width: Math.max(720, maxX - minX + input.metrics.padding * 2),
    height: Math.max(420, maxY - minY + input.metrics.padding * 2),
    minX: minX - input.metrics.padding,
    minY: minY - input.metrics.padding,
    maxX: maxX + input.metrics.padding,
    maxY: maxY + input.metrics.padding,
    rootOccurrenceId: input.rootOccurrenceId,
  };
}

function buildFamilyUnits(edges: FamilyTreeLayoutEdge[]): FamilyTreeLayoutFamilyUnit[] {
  const childGroups = new Map<string, {
    key: string;
    parents: FamilyTreeLayoutNode[];
    children: FamilyTreeLayoutNode[];
    edges: FamilyTreeLayoutEdge[];
  }>();
  for (const edge of edges) {
    if (edge.edge.kind !== "parent_child") continue;
    const key = [
      edge.to.occurrence.id,
      edge.edge.parentSetId ?? edge.edge.familyGroupId ?? "single",
    ].join(":");
    const row = childGroups.get(key) ?? { key, parents: [], children: [edge.to], edges: [] };
    if (!row.parents.some((node) => node.occurrence.id === edge.from.occurrence.id)) row.parents.push(edge.from);
    row.edges.push(edge);
    childGroups.set(key, row);
  }

  const byUnion = new Map<string, {
    key: string;
    parents: FamilyTreeLayoutNode[];
    children: FamilyTreeLayoutNode[];
    edges: FamilyTreeLayoutEdge[];
  }>();
  for (const childGroup of childGroups.values()) {
    const representative = childGroup.edges[0]?.edge;
    if (!representative) continue;
    const parentSignature = childGroup.parents
      .map((parent) => parent.occurrence.id)
      .sort()
      .join("|");
    const childGeneration = childGroup.children[0]?.occurrence.generation ?? 0;
    const parentKey = childGroup.parents.length > 1 && parentSignature
      ? `parents:${parentSignature}`
      : representative.parentSetId
        ? `parent-set:${representative.parentSetId}`
        : representative.familyGroupId
          ? `family:${representative.familyGroupId}`
          : `child:${representative.toOccurrenceId ?? childGroup.key}`;
    const key = `${parentKey}:generation:${childGeneration}`;
    const row = byUnion.get(key) ?? { key, parents: [], children: [], edges: [] };
    for (const parent of childGroup.parents) {
      if (!row.parents.some((node) => node.occurrence.id === parent.occurrence.id)) row.parents.push(parent);
    }
    for (const child of childGroup.children) {
      if (!row.children.some((node) => node.occurrence.id === child.occurrence.id)) row.children.push(child);
    }
    row.edges.push(...childGroup.edges);
    byUnion.set(key, row);
  }
  return [...byUnion.values()]
    .map((row) => layoutFamilyUnit(row))
    .filter((unit): unit is FamilyTreeLayoutFamilyUnit => Boolean(unit))
    .sort((left, right) => left.parentBusY - right.parentBusY || left.unitX - right.unitX || left.key.localeCompare(right.key, "uk"));
}

function layoutFamilyUnit(input: {
  key: string;
  parents: FamilyTreeLayoutNode[];
  children: FamilyTreeLayoutNode[];
  edges: FamilyTreeLayoutEdge[];
}): FamilyTreeLayoutFamilyUnit | null {
  if (!input.parents.length || !input.children.length) return null;
  const parents = sortedParentNodes(input.parents, input.edges);
  const children = [...input.children].sort((left, right) => nodeCenterX(left) - nodeCenterX(right));
  const unitX = average(children.map((child) => nodeCenterX(child)));
  const parentBottom = Math.max(...parents.map((node) => node.y + node.height));
  const childTop = Math.min(...children.map((node) => node.y));
  const parentBusY = parentBottom + Math.max(22, Math.min(44, (childTop - parentBottom) * 0.28));
  const childBusY = children.length > 1
    ? Math.max(parentBusY + 18, Math.min(childTop - 26, parentBusY + (childTop - parentBusY) * 0.55))
    : childTop;
  const representative = input.edges[0];
  return {
    key: input.key,
    parentOccurrenceIds: parents.map((node) => node.occurrence.id),
    childOccurrenceIds: children.map((node) => node.occurrence.id),
    parents,
    children,
    edges: input.edges,
    unitX,
    parentBusY,
    childBusY,
    path: familyUnitPath({ parents, children, unitX, parentBusY, childBusY }),
    dashArray: representative?.dashArray ?? "",
    opacity: Math.min(...input.edges.map((edge) => edge.opacity)),
  };
}

function sortedParentNodes(
  parents: FamilyTreeLayoutNode[],
  edges: FamilyTreeLayoutEdge[],
): FamilyTreeLayoutNode[] {
  const sideByOccurrence = new Map<string, number>();
  for (const edge of edges) {
    if (edge.edge.kind !== "parent_child") continue;
    sideByOccurrence.set(edge.from.occurrence.id, parentSide(edge.edge));
  }
  return [...parents].sort((left, right) => {
    const sideDiff = (sideByOccurrence.get(left.occurrence.id) ?? 2) - (sideByOccurrence.get(right.occurrence.id) ?? 2);
    return sideDiff || nodeCenterX(left) - nodeCenterX(right);
  });
}

function familyUnitPath(input: {
  parents: FamilyTreeLayoutNode[];
  children: FamilyTreeLayoutNode[];
  unitX: number;
  parentBusY: number;
  childBusY: number;
}): string {
  const paths: string[] = [];
  for (const parent of input.parents) {
    paths.push(`M ${nodeCenterX(parent)} ${parent.y + parent.height} V ${input.parentBusY}`);
  }
  if (input.parents.length > 1) {
    paths.push(`M ${nodeCenterX(input.parents[0])} ${input.parentBusY} H ${nodeCenterX(input.parents[input.parents.length - 1])}`);
  }
  if (input.children.length === 1) {
    const child = input.children[0];
    paths.push(`M ${input.unitX} ${input.parentBusY} V ${(input.parentBusY + child.y) / 2} H ${nodeCenterX(child)} V ${child.y}`);
    return paths.join(" ");
  }
  paths.push(`M ${input.unitX} ${input.parentBusY} V ${input.childBusY}`);
  paths.push(`M ${Math.min(input.unitX, nodeCenterX(input.children[0]))} ${input.childBusY} H ${Math.max(input.unitX, nodeCenterX(input.children[input.children.length - 1]))}`);
  for (const child of input.children) {
    paths.push(`M ${nodeCenterX(child)} ${input.childBusY} V ${child.y}`);
  }
  return paths.join(" ");
}

function edgePath(edge: FamilyTreeEdgeDto, from: FamilyTreeLayoutNode, to: FamilyTreeLayoutNode): string {
  if (edge.kind === "partner") {
    const fromLeft = nodeCenterX(from) <= nodeCenterX(to);
    const startX = fromLeft ? from.x + from.width : from.x;
    const endX = fromLeft ? to.x : to.x + to.width;
    const midY = (nodeCenterY(from) + nodeCenterY(to)) / 2;
    return nodeCenterY(from) === nodeCenterY(to)
      ? `M ${startX} ${nodeCenterY(from)} H ${endX}`
      : `M ${startX} ${nodeCenterY(from)} V ${midY} H ${endX} V ${nodeCenterY(to)}`;
  }
  if (edge.kind === "association") {
    const controlY = Math.min(nodeCenterY(from), nodeCenterY(to)) - 55;
    return `M ${nodeCenterX(from)} ${nodeCenterY(from)} Q ${(nodeCenterX(from) + nodeCenterX(to)) / 2} ${controlY} ${nodeCenterX(to)} ${nodeCenterY(to)}`;
  }
  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${nodeCenterX(from)} ${startY} V ${midY} H ${nodeCenterX(to)} V ${endY}`;
}

function edgeDashArray(edge: FamilyTreeEdgeDto): string {
  const relationshipType = String(edge.relationshipType ?? "").toLocaleLowerCase("uk");
  if (edge.kind === "partner" && ["divorced", "separated", "annulled"].includes(relationshipType)) return "14 8 2 8";
  if (["step", "stepfather", "stepmother"].includes(relationshipType)) return "10 5 2 5";
  if (relationshipType === "foster") return "2 8";
  if (["unknown", "presumed"].includes(relationshipType)) return "6 8";
  if (edge.style.lineStyle === "dashed") return "10 8";
  if (edge.style.lineStyle === "dotted") return "2 8";
  return "";
}

function nodeCenterX(node: FamilyTreeLayoutNode): number {
  return node.x + node.width / 2;
}

function nodeCenterY(node: FamilyTreeLayoutNode): number {
  return node.y + node.height / 2;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function parentGap(metrics: PedigreeMetrics): number {
  return Math.max(46, metrics.horizontalSpacing * 0.2);
}

function partnerGap(metrics: PedigreeMetrics): number {
  return Math.max(22, metrics.horizontalSpacing * 0.08);
}

function compactGap(metrics: PedigreeMetrics): number {
  return Math.max(24, metrics.horizontalSpacing * 0.1);
}

function siblingBranchGap(metrics: PedigreeMetrics): number {
  return Math.max(16, metrics.horizontalSpacing * 0.05);
}

function branchGap(metrics: PedigreeMetrics): number {
  return Math.max(58, metrics.horizontalSpacing * 0.22);
}

function sideFromX(x: number): "left" | "right" {
  return x < 0 ? "left" : "right";
}
