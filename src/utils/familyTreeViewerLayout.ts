import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeIssueDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../types/familyTree";
import type { FamilyTreeBuilderAction } from "../services/familyTreeMutationService";
import { buildFamilyGridViewerLayout } from "./familyTreeGridLayout.ts";

export type FamilyTreeNodeBadge =
  | "root"
  | "directAncestor"
  | "directDescendant"
  | "sideBranch"
  | "multipleOccurrences"
  | "multipleParentSets"
  | "private"
  | "hasSources"
  | "needsReview"
  | "potentialDuplicate"
  | "importedFromGedcom";

export interface FamilyTreeLayoutNode {
  occurrence: FamilyTreeOccurrenceDto;
  person: FamilyTreeNodeDto;
  x: number;
  y: number;
  width: number;
  height: number;
  badges: FamilyTreeNodeBadge[];
}

export interface FamilyTreeLayoutEdge {
  edge: FamilyTreeEdgeDto;
  from: FamilyTreeLayoutNode;
  to: FamilyTreeLayoutNode;
  path: string;
  dashArray: string;
  opacity: number;
}

export interface FamilyTreeLayoutFamilyUnit {
  key: string;
  parentOccurrenceIds: string[];
  childOccurrenceIds: string[];
  parents: FamilyTreeLayoutNode[];
  children: FamilyTreeLayoutNode[];
  edges: FamilyTreeLayoutEdge[];
  unitX: number;
  parentBusY: number;
  childBusY: number;
  parentLane?: number;
  childLane?: number;
  path: string;
  dashArray: string;
  opacity: number;
}

export interface FamilyTreeLayoutPlaceholder {
  id: string;
  action: FamilyTreeBuilderAction | "open_menu";
  label: string;
  targetOccurrenceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
  column: number;
  connectionPath?: string;
  dashArray?: string;
}

export interface FamilyTreeViewerLayout {
  nodes: FamilyTreeLayoutNode[];
  edges: FamilyTreeLayoutEdge[];
  familyUnits: FamilyTreeLayoutFamilyUnit[];
  placeholders?: FamilyTreeLayoutPlaceholder[];
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  rootOccurrenceId: string | null;
}

export interface FamilyTreeViewerLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalSpacing?: number;
  verticalSpacing?: number;
  padding?: number;
}

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 88;
const DEFAULT_HORIZONTAL_SPACING = 150;
const DEFAULT_VERTICAL_SPACING = 132;
const DEFAULT_PADDING = 52;

export function buildFamilyTreeViewerLayout(
  graph: FamilyTreeGraphDto,
  options: FamilyTreeViewerLayoutOptions = {},
): FamilyTreeViewerLayout {
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT;
  const horizontalSpacing = options.horizontalSpacing ?? DEFAULT_HORIZONTAL_SPACING;
  const verticalSpacing = options.verticalSpacing ?? DEFAULT_VERTICAL_SPACING;
  const padding = options.padding ?? DEFAULT_PADDING;
  const nodeByPerson = new Map(graph.nodes.map((node) => [node.personId, node]));
  const occurrenceNodes = graph.occurrences
    .map((occurrence) => {
      const person = nodeByPerson.get(occurrence.personId);
      return person ? { occurrence, person } : null;
    })
    .filter((item): item is { occurrence: FamilyTreeOccurrenceDto; person: FamilyTreeNodeDto } => Boolean(item));

  if (!occurrenceNodes.length) {
    return {
      nodes: [],
      edges: [],
      familyUnits: [],
      width: 0,
      height: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      rootOccurrenceId: null,
    };
  }

  const rootItem = occurrenceNodes.find((item) => item.person.personId === graph.rootPersonId && item.occurrence.generation === 0) ??
    occurrenceNodes.find((item) => item.person.personId === graph.rootPersonId) ??
    occurrenceNodes.find((item) => item.occurrence.generation === 0) ??
    occurrenceNodes[0];
  if (shouldUseDeterministicPedigreeLayout(graph, rootItem, occurrenceNodes)) {
    return buildFamilyGridViewerLayout(graph, occurrenceNodes, rootItem, {
      nodeWidth,
      nodeHeight,
      horizontalSpacing,
      verticalSpacing,
      padding,
      resolveNodeBadges,
    });
  }
  const positioned = positionOccurrenceNodes(graph, occurrenceNodes, rootItem, {
    nodeWidth,
    horizontalSpacing,
    verticalSpacing,
  });
  const roughNodes = occurrenceNodes
    .map((item) => {
      const position = positioned.get(item.occurrence.id) ?? fallbackPosition(item, occurrenceNodes, horizontalSpacing, verticalSpacing);
      return {
        occurrence: item.occurrence,
        person: item.person,
        x: position.x,
        y: position.y,
        width: nodeWidth,
        height: nodeHeight,
        badges: resolveNodeBadges(graph, item.person, item.occurrence),
      };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x || left.person.displayName.localeCompare(right.person.displayName, "uk"));

  const rootNode = roughNodes.find((node) => node.occurrence.id === rootItem?.occurrence.id) ??
    roughNodes.find((node) => node.person.personId === graph.rootPersonId) ??
    roughNodes.find((node) => node.occurrence.generation === 0) ??
    roughNodes[0];
  const rootOffsetX = rootNode?.x ?? 0;
  const rootOffsetY = rootNode?.y ?? 0;
  const nodes = roughNodes.map((node) => ({
    ...node,
    x: node.x - rootOffsetX,
    y: node.y - rootOffsetY,
  }));
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const nodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  const edges = graph.edges
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
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);

  return {
    nodes,
    edges,
    familyUnits,
    width: Math.max(720, maxX - minX + padding * 2),
    height: Math.max(420, maxY - minY + padding * 2),
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    rootOccurrenceId: rootNode?.occurrence.id ?? null,
  };
}

type OccurrenceLayoutItem = {
  occurrence: FamilyTreeOccurrenceDto;
  person: FamilyTreeNodeDto;
};

type OccurrencePosition = {
  x: number;
  y: number;
};

type DeterministicLayoutMetrics = LayoutMetrics & {
  nodeHeight: number;
  padding: number;
};

type LayoutMetrics = {
  nodeWidth: number;
  horizontalSpacing: number;
  verticalSpacing: number;
};

function shouldUseDeterministicPedigreeLayout(
  graph: FamilyTreeGraphDto,
  rootItem: OccurrenceLayoutItem | undefined,
  items: OccurrenceLayoutItem[],
): boolean {
  return graph.mode === "family" && Boolean(rootItem);
}

function buildDeterministicPedigreeViewerLayout(
  graph: FamilyTreeGraphDto,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  metrics: DeterministicLayoutMetrics,
): FamilyTreeViewerLayout {
  const itemByOccurrence = new Map(occurrenceNodes.map((item) => [item.occurrence.id, item]));
  const positionByOccurrence = new Map<string, OccurrencePosition>();
  const parentChildEdges = graph.edges.filter((edge) =>
    edge.kind === "parent_child" && edge.fromOccurrenceId && edge.toOccurrenceId,
  );
  const preferredParentUnions = preferredParentUnionGroupsByChild(graph, parentChildEdges, itemByOccurrence);
  const directParentEdges = preferredDirectParentEdges(rootItem.occurrence.id, preferredParentUnions);
  const directAncestorIds = directAncestorOccurrenceIds(directParentEdges, rootItem.occurrence.id);
  const parentsByChild = parentEntriesByChild(directParentEdges, itemByOccurrence);
  const directAncestorSides = directAncestorSideByOccurrence(rootItem.occurrence.id, parentsByChild);
  const measured = new Map<string, number>();

  placeDeterministicAncestorSubtree(
    rootItem.occurrence.id,
    0,
    parentsByChild,
    itemByOccurrence,
    positionByOccurrence,
    measured,
    metrics,
    new Set(),
  );
  centerRootUnderImmediateParents(parentChildEdges, parentsByChild, itemByOccurrence, positionByOccurrence, rootItem.occurrence.id, metrics);
  placeAnchoredSideBranches(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, rootItem.occurrence.id, metrics);
  const branchSides = propagatedBranchSideByOccurrence(
    graph,
    parentChildEdges,
    itemByOccurrence,
    positionByOccurrence,
    directAncestorSides,
    rootItem.occurrence.id,
    metrics,
  );
  resolveDeterministicRowOverlaps(itemByOccurrence, positionByOccurrence, directAncestorIds, rootItem.occurrence.id, metrics, branchSides);
  restoreAnchoredSideParentGeometry(parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, metrics);
  packDeterministicSideComponents(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, rootItem.occurrence.id, metrics, branchSides);

  return layoutFromPositionMap(graph, occurrenceNodes, rootItem, positionByOccurrence, metrics);
}

function measureDeterministicAncestorSubtree(
  occurrenceId: string,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  measured: Map<string, number>,
  metrics: LayoutMetrics,
  visiting: Set<string>,
): number {
  const cached = measured.get(occurrenceId);
  if (cached !== undefined) return cached;
  if (visiting.has(occurrenceId)) return metrics.nodeWidth;
  visiting.add(occurrenceId);
  const parents = parentsByChild.get(occurrenceId) ?? [];
  if (!parents.length) {
    measured.set(occurrenceId, metrics.nodeWidth);
    visiting.delete(occurrenceId);
    return metrics.nodeWidth;
  }

  const gap = deterministicSubtreeGap(metrics);
  const width = parents.reduce((sum, parent, index) => {
    const parentWidth = measureDeterministicAncestorSubtree(
      parent.parentOccurrenceId,
      parentsByChild,
      measured,
      metrics,
      visiting,
    );
    return sum + parentWidth + (index === 0 ? 0 : gap);
  }, 0);
  const result = Math.max(metrics.nodeWidth, width);
  measured.set(occurrenceId, result);
  visiting.delete(occurrenceId);
  return result;
}

function placeDeterministicAncestorSubtree(
  occurrenceId: string,
  centerX: number,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  measured: Map<string, number>,
  metrics: LayoutMetrics,
  visiting: Set<string>,
) {
  const item = itemByOccurrence.get(occurrenceId);
  if (!item || visiting.has(occurrenceId)) return;
  visiting.add(occurrenceId);
  positionByOccurrence.set(occurrenceId, {
    x: centerX - metrics.nodeWidth / 2,
    y: item.occurrence.generation * metrics.verticalSpacing,
  });

  const parents = parentsByChild.get(occurrenceId) ?? [];
  if (parents.length) {
    const gap = deterministicSubtreeGap(metrics);
    const parentWidths = parents.map((parent) =>
      measureDeterministicAncestorSubtree(parent.parentOccurrenceId, parentsByChild, measured, metrics, new Set(visiting)),
    );
    const totalWidth = parentWidths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, parentWidths.length - 1);
    let cursor = centerX - totalWidth / 2;
    parents.forEach((parent, index) => {
      const parentWidth = parentWidths[index] ?? metrics.nodeWidth;
      const parentCenterX = cursor + parentWidth / 2;
      placeDeterministicAncestorSubtree(
        parent.parentOccurrenceId,
        parentCenterX,
        parentsByChild,
        itemByOccurrence,
        positionByOccurrence,
        measured,
        metrics,
        visiting,
      );
      cursor += parentWidth + gap;
    });
  }

  visiting.delete(occurrenceId);
}

function deterministicSubtreeGap(metrics: LayoutMetrics): number {
  return Math.max(72, metrics.horizontalSpacing * 0.28);
}

function deterministicNodeGap(metrics: LayoutMetrics): number {
  return Math.max(44, metrics.horizontalSpacing * 0.18);
}

function centerRootUnderImmediateParents(
  parentChildEdges: FamilyTreeEdgeDto[],
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const rootCenter = occurrenceCenterX(rootOccurrenceId, positionByOccurrence, metrics);
  if (rootCenter === null) return;
  const parents = parentsByChild.get(rootOccurrenceId) ?? [];
  if (parents.length < 2) return;
  const parentPositions = parents
    .map((parent) => ({ id: parent.parentOccurrenceId, position: positionByOccurrence.get(parent.parentOccurrenceId) }))
    .filter((entry): entry is { id: string; position: OccurrencePosition } => Boolean(entry.position));
  if (parentPositions.length < 2) return;

  const parentUnionCenter = average(parentPositions.map((entry) => entry.position.x + metrics.nodeWidth / 2));
  const deltaX = rootCenter - parentUnionCenter;
  if (Math.abs(deltaX) < 0.001) return;
  for (const parent of parentPositions) {
    positionByOccurrence.set(parent.id, {
      x: parent.position.x + deltaX,
      y: parent.position.y,
    });
    shiftAncestorBranch(
      parentChildEdges,
      itemByOccurrence,
      positionByOccurrence,
      parent.id,
      deltaX,
      new Set([parent.id]),
    );
  }
}

function placeAnchoredSideBranches(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const rootCenterX = occurrenceCenterX(rootOccurrenceId, positionByOccurrence, metrics) ?? 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const changedParents = placeAnchoredParentGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, metrics);
    const changedChildren = placeAnchoredChildGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, rootCenterX, metrics);
    const changedPartners = placeAnchoredPartnerNodes(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, rootCenterX, metrics);
    if (!changedParents && !changedChildren && !changedPartners) break;
  }
}

function placeAnchoredParentGroups(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): boolean {
  let changed = false;
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const spacing = metrics.nodeWidth + deterministicNodeGap(metrics);

  for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
    const children = group.childOccurrenceIds
      .map((id) => ({ id, item: itemByOccurrence.get(id), position: positionByOccurrence.get(id) }))
      .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.item && entry.position));
    if (!children.length) continue;

    const orderedParentIds = orderedParentIdsForChildGroup(group.parentOccurrenceIds, group.childOccurrenceIds, parentsByChild);
    const unplacedParents = orderedParentIds
      .map((id) => ({ id, item: itemByOccurrence.get(id) }))
      .filter((entry): entry is { id: string; item: OccurrenceLayoutItem } => Boolean(entry.item && !positionByOccurrence.has(entry.id)));
    if (!unplacedParents.length) continue;

    const anchorCenterX = average(children.map((child) => child.position.x + metrics.nodeWidth / 2));
    const parentCount = orderedParentIds.length;
    const rowWidth = Math.max(0, (parentCount - 1) * spacing);

    orderedParentIds.forEach((parentId, index) => {
      if (positionByOccurrence.has(parentId)) return;
      const parentItem = itemByOccurrence.get(parentId);
      if (!parentItem) return;
      const parentEntry = parentsByChild
        .get(group.childOccurrenceIds[0] ?? "")
        ?.find((entry) => entry.parentOccurrenceId === parentId);
      const fallbackCenterX = parentCount === 1
        ? anchorCenterX + ((parentEntry?.side ?? 0) === 0 ? -spacing / 2 : spacing / 2)
        : anchorCenterX - rowWidth / 2 + index * spacing;
      positionByOccurrence.set(parentId, {
        x: fallbackCenterX - metrics.nodeWidth / 2,
        y: parentItem.occurrence.generation * metrics.verticalSpacing,
      });
      changed = true;
    });
  }

  return changed;
}

function placeAnchoredChildGroups(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootCenterX: number,
  metrics: LayoutMetrics,
): boolean {
  let changed = false;
  const spacing = metrics.nodeWidth + deterministicNodeGap(metrics);
  for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
    const parentPositions = group.parentOccurrenceIds
      .map((id) => ({ id, item: itemByOccurrence.get(id), position: positionByOccurrence.get(id) }))
      .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.item && entry.position));
    if (!parentPositions.length) continue;

    const children = group.childOccurrenceIds
      .map((id) => itemByOccurrence.get(id))
      .filter((item): item is OccurrenceLayoutItem => Boolean(item))
      .sort(compareOccurrenceNodes);
    const unplacedChildren = children.filter((child) =>
      !directAncestorIds.has(child.occurrence.id) && !positionByOccurrence.has(child.occurrence.id),
    );
    if (!unplacedChildren.length) continue;

    const directChildren = children
      .filter((child) => directAncestorIds.has(child.occurrence.id))
      .map((child) => ({ item: child, position: positionByOccurrence.get(child.occurrence.id) }))
      .filter((entry): entry is { item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.position));
    const parentCenterX = average(parentPositions.map((parent) => parent.position.x + metrics.nodeWidth / 2));

    if (directChildren.length) {
      const anchor = directChildren.sort((left, right) => Math.abs(left.position.x + metrics.nodeWidth / 2 - parentCenterX) - Math.abs(right.position.x + metrics.nodeWidth / 2 - parentCenterX))[0];
      const anchorCenter = anchor.position.x + metrics.nodeWidth / 2;
      const direction = anchorCenter < rootCenterX ? -1 : 1;
      unplacedChildren.forEach((child, index) => {
        const targetCenter = anchorCenter + direction * spacing * (index + 1);
        positionByOccurrence.set(child.occurrence.id, {
          x: targetCenter - metrics.nodeWidth / 2,
          y: child.occurrence.generation * metrics.verticalSpacing,
        });
        changed = true;
      });
      continue;
    }

    const rowWidth = Math.max(0, (unplacedChildren.length - 1) * spacing);
    unplacedChildren.forEach((child, index) => {
      positionByOccurrence.set(child.occurrence.id, {
        x: parentCenterX + index * spacing - rowWidth / 2 - metrics.nodeWidth / 2,
        y: child.occurrence.generation * metrics.verticalSpacing,
      });
      changed = true;
    });
  }
  return changed;
}

function placeAnchoredPartnerNodes(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootCenterX: number,
  metrics: LayoutMetrics,
): boolean {
  let changed = false;
  const spacing = metrics.nodeWidth + deterministicNodeGap(metrics);
  for (const edge of graph.edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const fromPosition = positionByOccurrence.get(edge.fromOccurrenceId);
    const toPosition = positionByOccurrence.get(edge.toOccurrenceId);
    if (fromPosition && toPosition) continue;

    const anchorId = fromPosition ? edge.fromOccurrenceId : toPosition ? edge.toOccurrenceId : "";
    const partnerId = fromPosition ? edge.toOccurrenceId : toPosition ? edge.fromOccurrenceId : "";
    if (!anchorId || !partnerId || directAncestorIds.has(partnerId) || positionByOccurrence.has(partnerId)) continue;
    const anchorPosition = positionByOccurrence.get(anchorId);
    const anchorItem = itemByOccurrence.get(anchorId);
    const partnerItem = itemByOccurrence.get(partnerId);
    if (!anchorPosition || !anchorItem || !partnerItem) continue;

    const anchorCenterX = anchorPosition.x + metrics.nodeWidth / 2;
    const direction = deterministicPartnerDirection(anchorItem, partnerItem, anchorCenterX, rootCenterX);
    positionByOccurrence.set(partnerId, {
      x: deterministicPartnerX(anchorId, partnerId, anchorPosition, direction, spacing, parentChildEdges, itemByOccurrence, positionByOccurrence, metrics),
      y: anchorPosition.y,
    });
    changed = true;
  }
  return changed;
}

function deterministicPartnerX(
  anchorOccurrenceId: string,
  partnerOccurrenceId: string,
  anchorPosition: OccurrencePosition,
  direction: -1 | 1,
  spacing: number,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): number {
  const branchBounds = positionedAncestorBranchBounds(
    anchorOccurrenceId,
    parentChildEdges,
    itemByOccurrence,
    positionByOccurrence,
    metrics,
    new Set(),
  );
  const gap = deterministicNodeGap(metrics);
  const partnerParentExtension = anchoredParentSideExtension(partnerOccurrenceId, parentChildEdges, itemByOccurrence, spacing);
  return direction > 0
    ? Math.max(anchorPosition.x + spacing, branchBounds.maxX + gap + partnerParentExtension)
    : Math.min(anchorPosition.x - spacing, branchBounds.minX - gap - metrics.nodeWidth - partnerParentExtension);
}

function anchoredParentSideExtension(
  childOccurrenceId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  spacing: number,
): number {
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const parents = parentsByChild.get(childOccurrenceId) ?? [];
  if (!parents.length) return 0;
  return Math.max(spacing / 2, ((parents.length - 1) * spacing) / 2);
}

function positionedAncestorBranchBounds(
  occurrenceId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
  visited: Set<string>,
): { minX: number; maxX: number } {
  const position = positionByOccurrence.get(occurrenceId);
  const base = position
    ? { minX: position.x, maxX: position.x + metrics.nodeWidth }
    : { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY };
  if (visited.has(occurrenceId)) return base;
  visited.add(occurrenceId);
  const childGeneration = itemByOccurrence.get(occurrenceId)?.occurrence.generation;
  for (const edge of parentChildEdges) {
    const parentOccurrenceId = edge.fromOccurrenceId;
    if (!parentOccurrenceId || edge.toOccurrenceId !== occurrenceId) continue;
    const parentItem = itemByOccurrence.get(parentOccurrenceId);
    if (!parentItem || childGeneration !== undefined && parentItem.occurrence.generation >= childGeneration) continue;
    const parentBounds = positionedAncestorBranchBounds(
      parentOccurrenceId,
      parentChildEdges,
      itemByOccurrence,
      positionByOccurrence,
      metrics,
      visited,
    );
    base.minX = Math.min(base.minX, parentBounds.minX);
    base.maxX = Math.max(base.maxX, parentBounds.maxX);
  }
  if (!Number.isFinite(base.minX) || !Number.isFinite(base.maxX)) {
    return { minX: 0, maxX: metrics.nodeWidth };
  }
  return base;
}

function deterministicPartnerDirection(
  anchorItem: OccurrenceLayoutItem,
  partnerItem: OccurrenceLayoutItem,
  anchorCenterX: number,
  rootCenterX: number,
): -1 | 1 {
  if (isMaleGender(anchorItem.person.gender) || isFemaleGender(partnerItem.person.gender)) return 1;
  if (isFemaleGender(anchorItem.person.gender) || isMaleGender(partnerItem.person.gender)) return -1;
  return anchorCenterX < rootCenterX ? -1 : 1;
}

function directAncestorSideByOccurrence(
  rootOccurrenceId: string,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
): Map<string, -1 | 0 | 1> {
  const result = new Map<string, -1 | 0 | 1>([[rootOccurrenceId, 0]]);
  const queue = [rootOccurrenceId];
  while (queue.length) {
    const childOccurrenceId = queue.shift();
    if (!childOccurrenceId) continue;
    const childSide = result.get(childOccurrenceId) ?? 0;
    const parents = parentsByChild.get(childOccurrenceId) ?? [];
    for (const parent of parents) {
      const parentSide: -1 | 1 = childSide === 0
        ? parent.side === 0 ? -1 : 1
        : childSide;
      if (result.has(parent.parentOccurrenceId)) continue;
      result.set(parent.parentOccurrenceId, parentSide);
      queue.push(parent.parentOccurrenceId);
    }
  }
  return result;
}

function propagatedBranchSideByOccurrence(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorSides: Map<string, -1 | 0 | 1>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
): Map<string, -1 | 0 | 1> {
  const rootCenterX = occurrenceCenterX(rootOccurrenceId, positionByOccurrence, metrics) ?? 0;
  const result = new Map<string, -1 | 0 | 1>(directAncestorSides);
  const adjacency = new Map<string, Set<string>>();
  const connect = (left?: string | null, right?: string | null) => {
    if (!left || !right || !positionByOccurrence.has(left) || !positionByOccurrence.has(right)) return;
    const leftSet = adjacency.get(left) ?? new Set<string>();
    leftSet.add(right);
    adjacency.set(left, leftSet);
    const rightSet = adjacency.get(right) ?? new Set<string>();
    rightSet.add(left);
    adjacency.set(right, rightSet);
  };
  for (const edge of parentChildEdges) {
    connect(edge.fromOccurrenceId, edge.toOccurrenceId);
  }
  for (const edge of graph.edges) {
    if (edge.kind === "partner") connect(edge.fromOccurrenceId, edge.toOccurrenceId);
  }

  const queue = Array.from(result.keys());
  while (queue.length) {
    const occurrenceId = queue.shift();
    if (!occurrenceId) continue;
    const side = result.get(occurrenceId);
    if (side === undefined) continue;
    for (const nextId of adjacency.get(occurrenceId) ?? []) {
      if (result.has(nextId)) continue;
      result.set(nextId, side === 0
        ? sideFromPosition(nextId, positionByOccurrence, rootCenterX, metrics)
        : side);
      queue.push(nextId);
    }
  }

  for (const [occurrenceId, position] of positionByOccurrence.entries()) {
    if (result.has(occurrenceId) || !itemByOccurrence.has(occurrenceId)) continue;
    const centerX = position.x + metrics.nodeWidth / 2;
    result.set(occurrenceId, centerX < rootCenterX ? -1 : centerX > rootCenterX ? 1 : 0);
  }
  return result;
}

function sideFromPosition(
  occurrenceId: string,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootCenterX: number,
  metrics: LayoutMetrics,
): -1 | 0 | 1 {
  const position = positionByOccurrence.get(occurrenceId);
  if (!position) return 0;
  const centerX = position.x + metrics.nodeWidth / 2;
  return centerX < rootCenterX ? -1 : centerX > rootCenterX ? 1 : 0;
}

function resolveDeterministicRowOverlaps(
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
  branchSides: Map<string, -1 | 0 | 1> = new Map(),
) {
  const rootCenterX = occurrenceCenterX(rootOccurrenceId, positionByOccurrence, metrics) ?? 0;
  const rows = groupBy(
    Array.from(positionByOccurrence.entries())
      .map(([id, position]) => ({ id, item: itemByOccurrence.get(id), position }))
      .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.item)),
    (entry) => entry.item.occurrence.generation,
  );
  const gap = deterministicNodeGap(metrics);

  for (const entries of rows.values()) {
    const directEntries = entries.filter((entry) => directAncestorIds.has(entry.id));
    const sideEntries = entries.filter((entry) => !directAncestorIds.has(entry.id));
    if (!sideEntries.length) continue;

    if (!directEntries.length) {
      packRowEntries(sideEntries, metrics, gap);
      continue;
    }

    const directMinX = Math.min(...directEntries.map((entry) => entry.position.x));
    const directMaxX = Math.max(...directEntries.map((entry) => entry.position.x + metrics.nodeWidth));
    const leftEntries = sideEntries.filter((entry) => deterministicSideForEntry(entry, branchSides, rootCenterX, metrics) < 0);
    const rightEntries = sideEntries.filter((entry) => deterministicSideForEntry(entry, branchSides, rootCenterX, metrics) >= 0);

    let leftCursor = directMinX - gap;
    for (const entry of leftEntries.sort((left, right) => right.position.x - left.position.x)) {
      const nextX = Math.min(entry.position.x, leftCursor - metrics.nodeWidth);
      positionByOccurrence.set(entry.id, { x: nextX, y: entry.position.y });
      entry.position.x = nextX;
      leftCursor = nextX - gap;
    }

    let rightCursor = directMaxX + gap;
    for (const entry of rightEntries.sort((left, right) => left.position.x - right.position.x)) {
      const nextX = Math.max(entry.position.x, rightCursor);
      positionByOccurrence.set(entry.id, { x: nextX, y: entry.position.y });
      entry.position.x = nextX;
      rightCursor = nextX + metrics.nodeWidth + gap;
    }
  }
}

function restoreAnchoredSideParentGeometry(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  metrics: LayoutMetrics,
) {
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
    const spacing = metrics.nodeWidth + deterministicNodeGap(metrics);

    for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
      if (group.parentOccurrenceIds.some((id) => directAncestorIds.has(id))) continue;
      const children = group.childOccurrenceIds
        .map((id) => ({ id, position: positionByOccurrence.get(id) }))
        .filter((entry): entry is { id: string; position: OccurrencePosition } => Boolean(entry.position));
      if (!children.length) continue;

      const orderedParentIds = orderedParentIdsForChildGroup(group.parentOccurrenceIds, group.childOccurrenceIds, parentsByChild)
        .filter((id) => positionByOccurrence.has(id));
      if (!orderedParentIds.length) continue;

      const anchorCenterX = average(children.map((child) => child.position.x + metrics.nodeWidth / 2));
      const rowWidth = Math.max(0, (orderedParentIds.length - 1) * spacing);
      for (const [index, parentId] of orderedParentIds.entries()) {
        const parentItem = itemByOccurrence.get(parentId);
        const current = positionByOccurrence.get(parentId);
        if (!parentItem || !current) continue;
        const parentEntry = parentsByChild
          .get(group.childOccurrenceIds[0] ?? "")
          ?.find((entry) => entry.parentOccurrenceId === parentId);
        const centerX = orderedParentIds.length === 1
          ? anchorCenterX + ((parentEntry?.side ?? 0) === 0 ? -spacing / 2 : spacing / 2)
          : anchorCenterX - rowWidth / 2 + index * spacing;
        const next = {
          x: centerX - metrics.nodeWidth / 2,
          y: parentItem.occurrence.generation * metrics.verticalSpacing,
        };
        if (Math.abs(next.x - current.x) > 0.001 || Math.abs(next.y - current.y) > 0.001) {
          positionByOccurrence.set(parentId, next);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }
}

type DeterministicSideComponent = {
  ids: string[];
  side: -1 | 1;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
};

function packDeterministicSideComponents(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
  branchSides: Map<string, -1 | 0 | 1>,
) {
  const directPositions = Array.from(directAncestorIds)
    .map((id) => positionByOccurrence.get(id))
    .filter((position): position is OccurrencePosition => Boolean(position));
  if (!directPositions.length) return;

  const directMinX = Math.min(...directPositions.map((position) => position.x));
  const directMaxX = Math.max(...directPositions.map((position) => position.x + metrics.nodeWidth));
  const components = deterministicSideComponents(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, directAncestorIds, rootOccurrenceId, metrics, branchSides);
  const gap = Math.max(deterministicNodeGap(metrics), metrics.horizontalSpacing * 0.22);
  const left = components.filter((component) => component.side < 0)
    .sort((a, b) => b.maxX - a.maxX || a.minY - b.minY || a.ids.join("|").localeCompare(b.ids.join("|"), "uk"));
  const right = components.filter((component) => component.side > 0)
    .sort((a, b) => a.minX - b.minX || a.minY - b.minY || a.ids.join("|").localeCompare(b.ids.join("|"), "uk"));

  let leftCursor = directMinX - gap;
  for (const component of left) {
    const targetMaxX = Math.min(component.maxX, leftCursor);
    const deltaX = targetMaxX - component.maxX;
    shiftDeterministicComponent(component, deltaX, positionByOccurrence);
    leftCursor = component.minX + deltaX - gap;
  }

  let rightCursor = directMaxX + gap;
  for (const component of right) {
    const targetMinX = Math.max(component.minX, rightCursor);
    const deltaX = targetMinX - component.minX;
    shiftDeterministicComponent(component, deltaX, positionByOccurrence);
    rightCursor = component.maxX + deltaX + gap;
  }
}

function deterministicSideComponents(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  directAncestorIds: Set<string>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
  branchSides: Map<string, -1 | 0 | 1>,
): DeterministicSideComponent[] {
  const sideNodeIds = Array.from(positionByOccurrence.keys())
    .filter((id) => itemByOccurrence.has(id) && !directAncestorIds.has(id));
  const sideNodeSet = new Set(sideNodeIds);
  if (!sideNodeIds.length) return [];

  const adjacency = new Map<string, Set<string>>();
  const connect = (left?: string | null, right?: string | null) => {
    if (!left || !right || !sideNodeSet.has(left) || !sideNodeSet.has(right)) return;
    const leftSet = adjacency.get(left) ?? new Set<string>();
    leftSet.add(right);
    adjacency.set(left, leftSet);
    const rightSet = adjacency.get(right) ?? new Set<string>();
    rightSet.add(left);
    adjacency.set(right, rightSet);
  };
  for (const edge of parentChildEdges) connect(edge.fromOccurrenceId, edge.toOccurrenceId);
  for (const edge of graph.edges) {
    if (edge.kind === "partner") connect(edge.fromOccurrenceId, edge.toOccurrenceId);
  }

  const rootCenterX = occurrenceCenterX(rootOccurrenceId, positionByOccurrence, metrics) ?? 0;
  const compactSiblingIds = directSiblingOccurrenceIds(parentChildEdges, itemByOccurrence, directAncestorIds);
  const visited = new Set<string>();
  const components: DeterministicSideComponent[] = [];
  for (const startId of sideNodeIds) {
    if (visited.has(startId)) continue;
    const ids: string[] = [];
    const queue = [startId];
    visited.add(startId);
    while (queue.length) {
      const id = queue.shift();
      if (!id) continue;
      ids.push(id);
      for (const nextId of adjacency.get(id) ?? []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        queue.push(nextId);
      }
    }
    if (ids.length === 1 && compactSiblingIds.has(ids[0])) continue;
    const component = deterministicSideComponent(ids, positionByOccurrence, branchSides, rootCenterX, metrics);
    if (component) components.push(component);
  }
  return components;
}

function directSiblingOccurrenceIds(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  directAncestorIds: Set<string>,
): Set<string> {
  const result = new Set<string>();
  for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
    const directChildren = group.childOccurrenceIds.filter((id) => directAncestorIds.has(id));
    if (!directChildren.length) continue;
    for (const childId of group.childOccurrenceIds) {
      if (!directAncestorIds.has(childId)) result.add(childId);
    }
  }
  return result;
}

function deterministicSideComponent(
  ids: string[],
  positionByOccurrence: Map<string, OccurrencePosition>,
  branchSides: Map<string, -1 | 0 | 1>,
  rootCenterX: number,
  metrics: LayoutMetrics,
): DeterministicSideComponent | null {
  const positioned = ids
    .map((id) => ({ id, position: positionByOccurrence.get(id) }))
    .filter((entry): entry is { id: string; position: OccurrencePosition } => Boolean(entry.position));
  if (!positioned.length) return null;
  const minX = Math.min(...positioned.map((entry) => entry.position.x));
  const maxX = Math.max(...positioned.map((entry) => entry.position.x + metrics.nodeWidth));
  const minY = Math.min(...positioned.map((entry) => entry.position.y));
  const maxY = Math.max(...positioned.map((entry) => entry.position.y + metrics.verticalSpacing));
  const sideScore = positioned.reduce((sum, entry) => {
    const side = branchSides.get(entry.id);
    if (side === -1 || side === 1) return sum + side;
    return sum + sideFromPosition(entry.id, positionByOccurrence, rootCenterX, metrics);
  }, 0);
  const centerX = (minX + maxX) / 2;
  const side: -1 | 1 = sideScore < 0 ? -1 : sideScore > 0 ? 1 : centerX < rootCenterX ? -1 : 1;
  return {
    ids: positioned.map((entry) => entry.id),
    side,
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
  };
}

function shiftDeterministicComponent(
  component: DeterministicSideComponent,
  deltaX: number,
  positionByOccurrence: Map<string, OccurrencePosition>,
) {
  if (Math.abs(deltaX) < 0.001) return;
  for (const id of component.ids) {
    const position = positionByOccurrence.get(id);
    if (!position) continue;
    positionByOccurrence.set(id, {
      x: position.x + deltaX,
      y: position.y,
    });
  }
}

function deterministicSideForEntry(
  entry: { id: string; position: OccurrencePosition },
  branchSides: Map<string, -1 | 0 | 1>,
  rootCenterX: number,
  metrics: LayoutMetrics,
): -1 | 0 | 1 {
  const side = branchSides.get(entry.id);
  if (side !== undefined) return side;
  const centerX = entry.position.x + metrics.nodeWidth / 2;
  return centerX < rootCenterX ? -1 : centerX > rootCenterX ? 1 : 0;
}

function packRowEntries(
  entries: Array<{ id: string; item: OccurrenceLayoutItem; position: OccurrencePosition }>,
  metrics: LayoutMetrics,
  gap: number,
) {
  let cursor = Number.NEGATIVE_INFINITY;
  for (const entry of entries.sort((left, right) => left.position.x - right.position.x || compareOccurrenceNodes(left.item, right.item))) {
    const nextX = Number.isFinite(cursor) ? Math.max(entry.position.x, cursor) : entry.position.x;
    entry.position.x = nextX;
    cursor = nextX + metrics.nodeWidth + gap;
  }
}

function occurrenceCenterX(
  occurrenceId: string,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): number | null {
  const position = positionByOccurrence.get(occurrenceId);
  return position ? position.x + metrics.nodeWidth / 2 : null;
}

function layoutFromPositionMap(
  graph: FamilyTreeGraphDto,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: DeterministicLayoutMetrics,
): FamilyTreeViewerLayout {
  placeFallbackGenerationRows(occurrenceNodes, positionByOccurrence, metrics);
  const roughNodes = occurrenceNodes
    .map((item) => {
      const position = positionByOccurrence.get(item.occurrence.id) ?? fallbackPosition(item, occurrenceNodes, metrics.horizontalSpacing, metrics.verticalSpacing);
      return {
        occurrence: item.occurrence,
        person: item.person,
        x: position.x,
        y: position.y,
        width: metrics.nodeWidth,
        height: metrics.nodeHeight,
        badges: resolveNodeBadges(graph, item.person, item.occurrence),
      };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x || left.person.displayName.localeCompare(right.person.displayName, "uk"));
  const rootNode = roughNodes.find((node) => node.occurrence.id === rootItem.occurrence.id) ??
    roughNodes.find((node) => node.person.personId === graph.rootPersonId) ??
    roughNodes.find((node) => node.occurrence.generation === 0) ??
    roughNodes[0];
  const rootOffsetX = rootNode?.x ?? 0;
  const rootOffsetY = rootNode?.y ?? 0;
  const nodes = roughNodes.map((node) => ({
    ...node,
    x: node.x - rootOffsetX,
    y: node.y - rootOffsetY,
  }));
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const nodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  const edges = graph.edges
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
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);

  return {
    nodes,
    edges,
    familyUnits,
    width: Math.max(720, maxX - minX + metrics.padding * 2),
    height: Math.max(420, maxY - minY + metrics.padding * 2),
    minX: minX - metrics.padding,
    minY: minY - metrics.padding,
    maxX: maxX + metrics.padding,
    maxY: maxY + metrics.padding,
    rootOccurrenceId: rootNode?.occurrence.id ?? null,
  };
}

function positionOccurrenceNodes(
  graph: FamilyTreeGraphDto,
  items: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem | undefined,
  metrics: LayoutMetrics,
): Map<string, OccurrencePosition> {
  const itemByOccurrence = new Map(items.map((item) => [item.occurrence.id, item]));
  const positionByOccurrence = new Map<string, OccurrencePosition>();
  const parentChildEdges = graph.edges.filter((edge) =>
    edge.kind === "parent_child" && edge.fromOccurrenceId && edge.toOccurrenceId,
  );

  if (rootItem) {
    positionByOccurrence.set(rootItem.occurrence.id, { x: 0, y: 0 });
  }

  const ancestorPlaced = new Set<string>();
  placeLocalAncestorBranches(
    parentChildEdges,
    itemByOccurrence,
    positionByOccurrence,
    rootItem ? [rootItem.occurrence.id] : [],
    ancestorPlaced,
    metrics,
  );
  placePartnerOnlyNodes(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, metrics);
  placeLocalAncestorBranches(
    parentChildEdges,
    itemByOccurrence,
    positionByOccurrence,
    positionedAncestorSeedIds(positionByOccurrence, itemByOccurrence),
    ancestorPlaced,
    metrics,
  );
  placeChildGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  placePartnerOnlyNodes(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, metrics);
  placeChildGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  placeLocalAncestorBranches(
    parentChildEdges,
    itemByOccurrence,
    positionByOccurrence,
    positionedNodesWithMissingParents(parentChildEdges, itemByOccurrence, positionByOccurrence),
    new Set<string>(),
    metrics,
  );
  placeFallbackGenerationRows(items, positionByOccurrence, metrics);
  resolveGenerationRowOverlaps(items, positionByOccurrence, metrics);
  placeChildGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  compactRootParentGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  resolveGenerationRowOverlaps(items, positionByOccurrence, metrics);
  compactRootParentSiblingGroups(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  compactRootParentSiblingPartnerPairs(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  compactFamilyParentPairs(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  compactPartnerPairs(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  compactVisualFamilyBlocks(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, metrics);
  lockDirectAncestorBackbone(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  pushNonDirectNodesOutsideAncestorBackbone(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);
  centerRootAxisUnderParents(parentChildEdges, itemByOccurrence, positionByOccurrence, rootItem?.occurrence.id ?? "", metrics);

  return positionByOccurrence;
}

type ParentLayoutEntry = {
  edge: FamilyTreeEdgeDto;
  parentOccurrenceId: string;
  childOccurrenceId: string;
  item: OccurrenceLayoutItem;
  side: 0 | 1;
};

type ParentUnionLayoutGroup = {
  key: string;
  childOccurrenceId: string;
  parentOccurrenceIds: string[];
  parents: ParentLayoutEntry[];
  edges: FamilyTreeEdgeDto[];
  score: number;
};

function preferredParentUnionGroupsByChild(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): Map<string, ParentUnionLayoutGroup> {
  const groupMetadataById = new Map(graph.groups.map((group) => [group.id, group]));
  const groupsByChild = parentUnionGroupsByChild(parentChildEdges, itemByOccurrence, groupMetadataById);
  const result = new Map<string, ParentUnionLayoutGroup>();
  for (const [childOccurrenceId, groups] of groupsByChild.entries()) {
    const preferred = [...groups].sort(compareParentUnionLayoutGroups)[0];
    if (preferred) result.set(childOccurrenceId, preferred);
  }
  return result;
}

function preferredDirectParentEdges(
  rootOccurrenceId: string,
  preferredParentUnions: Map<string, ParentUnionLayoutGroup>,
): FamilyTreeEdgeDto[] {
  const result: FamilyTreeEdgeDto[] = [];
  const visitedChildren = new Set<string>();
  const queue = [rootOccurrenceId];
  while (queue.length) {
    const childOccurrenceId = queue.shift();
    if (!childOccurrenceId || visitedChildren.has(childOccurrenceId)) continue;
    visitedChildren.add(childOccurrenceId);
    const union = preferredParentUnions.get(childOccurrenceId);
    if (!union) continue;
    result.push(...union.edges);
    for (const parentOccurrenceId of union.parentOccurrenceIds) {
      queue.push(parentOccurrenceId);
    }
  }
  return result;
}

function parentUnionGroupsByChild(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  groupMetadataById: Map<string, FamilyTreeGraphDto["groups"][number]>,
): Map<string, ParentUnionLayoutGroup[]> {
  const pending = new Map<
    string,
    {
      key: string;
      childOccurrenceId: string;
      parents: Map<string, ParentLayoutEntry>;
      edges: FamilyTreeEdgeDto[];
    }
  >();

  for (const edge of parentChildEdges) {
    const parentOccurrenceId = edge.fromOccurrenceId;
    const childOccurrenceId = edge.toOccurrenceId;
    if (!parentOccurrenceId || !childOccurrenceId) continue;
    const parentItem = itemByOccurrence.get(parentOccurrenceId);
    const childItem = itemByOccurrence.get(childOccurrenceId);
    if (!parentItem || !childItem) continue;
    if (parentItem.occurrence.generation >= childItem.occurrence.generation) continue;
    const key = [
      childOccurrenceId,
      edge.parentSetId ? `parent-set:${edge.parentSetId}` : edge.familyGroupId ? `family:${edge.familyGroupId}` : "single",
    ].join(":");
    const group = pending.get(key) ?? {
      key,
      childOccurrenceId,
      parents: new Map<string, ParentLayoutEntry>(),
      edges: [],
    };
    group.parents.set(parentOccurrenceId, {
      edge,
      parentOccurrenceId,
      childOccurrenceId,
      item: parentItem,
      side: parentSideIndex(edge, parentItem.person),
    });
    group.edges.push(edge);
    pending.set(key, group);
  }

  const result = new Map<string, ParentUnionLayoutGroup[]>();
  for (const group of pending.values()) {
    const parents = Array.from(group.parents.values()).sort(compareParentLayoutEntries);
    const parentOccurrenceIds = parents.map((parent) => parent.parentOccurrenceId);
    const scored: ParentUnionLayoutGroup = {
      key: group.key,
      childOccurrenceId: group.childOccurrenceId,
      parentOccurrenceIds,
      parents,
      edges: group.edges,
      score: parentUnionScore(group.edges, groupMetadataById, parentOccurrenceIds.length),
    };
    const groups = result.get(group.childOccurrenceId) ?? [];
    groups.push(scored);
    result.set(group.childOccurrenceId, groups);
  }
  return result;
}

function compareParentUnionLayoutGroups(left: ParentUnionLayoutGroup, right: ParentUnionLayoutGroup): number {
  return right.score - left.score ||
    right.parentOccurrenceIds.length - left.parentOccurrenceIds.length ||
    left.parentOccurrenceIds.join("|").localeCompare(right.parentOccurrenceIds.join("|"), "uk") ||
    left.key.localeCompare(right.key, "uk");
}

function parentUnionScore(
  edges: FamilyTreeEdgeDto[],
  groupMetadataById: Map<string, FamilyTreeGraphDto["groups"][number]>,
  parentCount: number,
): number {
  let score = parentCount >= 2 ? 80 : 0;
  const groupIds = new Set(edges.flatMap((edge) => [edge.parentSetId, edge.familyGroupId]).filter((id): id is string => Boolean(id)));
  for (const edge of edges) {
    const relationshipType = String(edge.relationshipType ?? "").toLocaleLowerCase("uk");
    if (edge.isBloodline) score += 260;
    if (isBiologicalParentType(relationshipType)) score += 220;
    if (isAdoptiveOrSocialParentType(relationshipType)) score -= 80;
    if (edge.evidenceStatus === "proven") score += 32;
    if (edge.evidenceStatus === "likely") score += 16;
    if (edge.style.visibility === "faded" || edge.style.visibility === "hidden") score -= 120;
  }
  for (const id of groupIds) {
    const group = groupMetadataById.get(id);
    if (!group) continue;
    const groupType = String(group.groupType ?? "").toLocaleLowerCase("uk");
    if (isBiologicalParentType(groupType)) score += 240;
    if (isAdoptiveOrSocialParentType(groupType)) score -= 70;
    if (truthyMetadata(group.metadata, "isDefaultForPedigree") || truthyMetadata(group.metadata, "is_default_for_pedigree")) score += 420;
    if (truthyMetadata(group.metadata, "isPreferredForDisplay") || truthyMetadata(group.metadata, "is_preferred_for_display")) score += 180;
  }
  return score;
}

function isBiologicalParentType(value: string): boolean {
  return [
    "biological",
    "genetic",
    "genetic_father",
    "genetic_mother",
    "birth_parent",
    "birth_or_gestational",
    "gestational_parent",
  ].includes(value);
}

function isAdoptiveOrSocialParentType(value: string): boolean {
  return [
    "adoptive",
    "adoption_family",
    "foster",
    "foster_family",
    "step",
    "guardian",
    "guardian_family",
    "social",
    "social_parent",
    "legal",
    "legal_parent",
  ].includes(value);
}

function truthyMetadata(metadata: Record<string, unknown>, key: string): boolean {
  const value = metadata[key];
  return value === true || value === "true" || value === 1 || value === "1";
}

function placeLocalAncestorBranches(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  seedOccurrenceIds: string[],
  placed: Set<string>,
  metrics: LayoutMetrics,
) {
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const measuredBounds = new Map<string, AncestorSubtreeBounds>();

  for (const childOccurrenceId of seedOccurrenceIds) {
    const childPosition = positionByOccurrence.get(childOccurrenceId);
    if (!childPosition) continue;
    placeAncestorSubtree(
      childOccurrenceId,
      childPosition.x,
      childPosition.y,
      parentsByChild,
      itemByOccurrence,
      positionByOccurrence,
      measuredBounds,
      placed,
      metrics,
    );
  }
}

function positionedAncestorSeedIds(
  positionByOccurrence: Map<string, OccurrencePosition>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): string[] {
  return Array.from(positionByOccurrence.keys())
    .filter((occurrenceId) => (itemByOccurrence.get(occurrenceId)?.occurrence.generation ?? 1) <= 0)
    .sort((left, right) => compareOccurrenceIds(left, right, itemByOccurrence));
}

function positionedNodesWithMissingParents(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
): string[] {
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  return Array.from(positionByOccurrence.keys())
    .filter((occurrenceId) => {
      const parents = parentsByChild.get(occurrenceId) ?? [];
      return parents.some((parent) => !positionByOccurrence.has(parent.parentOccurrenceId));
    })
    .sort((left, right) => {
      const leftPosition = positionByOccurrence.get(left);
      const rightPosition = positionByOccurrence.get(right);
      if (leftPosition && rightPosition && leftPosition.y !== rightPosition.y) {
        return rightPosition.y - leftPosition.y;
      }
      return compareOccurrenceIds(left, right, itemByOccurrence);
    });
}

function parentEntriesByChild(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): Map<string, ParentLayoutEntry[]> {
  const result = new Map<string, ParentLayoutEntry[]>();
  for (const edge of parentChildEdges) {
    const parentOccurrenceId = edge.fromOccurrenceId;
    const childOccurrenceId = edge.toOccurrenceId;
    if (!parentOccurrenceId || !childOccurrenceId) continue;
    const parentItem = itemByOccurrence.get(parentOccurrenceId);
    const childItem = itemByOccurrence.get(childOccurrenceId);
    if (!parentItem || !childItem) continue;
    if (parentItem.occurrence.generation >= childItem.occurrence.generation) continue;

    const entries = result.get(childOccurrenceId) ?? [];
    entries.push({
      edge,
      parentOccurrenceId,
      childOccurrenceId,
      item: parentItem,
      side: parentSideIndex(edge, parentItem.person),
    });
    result.set(childOccurrenceId, entries);
  }

  for (const [childOccurrenceId, entries] of result.entries()) {
    result.set(childOccurrenceId, entries.sort(compareParentLayoutEntries));
  }
  return result;
}

function placeAncestorSubtree(
  childOccurrenceId: string,
  childX: number,
  childY: number,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  measuredBounds: Map<string, AncestorSubtreeBounds>,
  placed: Set<string>,
  metrics: LayoutMetrics,
) {
  if (placed.has(childOccurrenceId)) return;
  placed.add(childOccurrenceId);
  const parents = parentsByChild.get(childOccurrenceId) ?? [];
  if (!parents.length) return;

  const placements = ancestorParentPlacements(
    parents,
    parents.map((parent) =>
      measureAncestorSubtree(parent.parentOccurrenceId, parentsByChild, measuredBounds, metrics, new Set([childOccurrenceId])),
    ),
    metrics,
  );

  for (const placement of placements) {
    placeParentEntry(
      placement.parent,
      childX + placement.relativeX,
      childY - metrics.verticalSpacing,
      itemByOccurrence,
      positionByOccurrence,
      parentsByChild,
      measuredBounds,
      placed,
      metrics,
    );
  }
}

function placeParentEntry(
  parent: ParentLayoutEntry,
  x: number,
  y: number,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  measuredBounds: Map<string, AncestorSubtreeBounds>,
  placed: Set<string>,
  metrics: LayoutMetrics,
) {
  const parentItem = itemByOccurrence.get(parent.parentOccurrenceId);
  if (!parentItem) return;
  positionByOccurrence.set(parent.parentOccurrenceId, {
    x,
    y,
  });
  placeAncestorSubtree(
    parent.parentOccurrenceId,
    x,
    y,
    parentsByChild,
    itemByOccurrence,
    positionByOccurrence,
    measuredBounds,
    placed,
    metrics,
  );
}

type AncestorSubtreeBounds = {
  minX: number;
  maxX: number;
};

type AncestorParentPlacement = {
  parent: ParentLayoutEntry;
  bounds: AncestorSubtreeBounds;
  relativeX: number;
};

function measureAncestorSubtree(
  occurrenceId: string,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  measuredBounds: Map<string, AncestorSubtreeBounds>,
  metrics: LayoutMetrics,
  visiting: Set<string>,
): AncestorSubtreeBounds {
  const cached = measuredBounds.get(occurrenceId);
  if (cached !== undefined) return cached;
  if (visiting.has(occurrenceId)) return { minX: 0, maxX: metrics.nodeWidth };
  visiting.add(occurrenceId);

  const parents = parentsByChild.get(occurrenceId) ?? [];
  if (!parents.length) {
    const leafBounds = { minX: 0, maxX: metrics.nodeWidth };
    measuredBounds.set(occurrenceId, leafBounds);
    visiting.delete(occurrenceId);
    return leafBounds;
  }

  const placements = ancestorParentPlacements(
    parents,
    parents.map((parent) =>
      measureAncestorSubtree(parent.parentOccurrenceId, parentsByChild, measuredBounds, metrics, visiting),
    ),
    metrics,
  );
  const bounds = placements.reduce<AncestorSubtreeBounds>((current, placement) => ({
    minX: Math.min(current.minX, placement.relativeX + placement.bounds.minX),
    maxX: Math.max(current.maxX, placement.relativeX + placement.bounds.maxX),
  }), { minX: 0, maxX: metrics.nodeWidth });
  measuredBounds.set(occurrenceId, bounds);
  visiting.delete(occurrenceId);
  return bounds;
}

function ancestorParentPlacements(
  parents: ParentLayoutEntry[],
  bounds: AncestorSubtreeBounds[],
  metrics: LayoutMetrics,
): AncestorParentPlacement[] {
  if (!parents.length) return [];
  const parentGap = ancestorParentGap(metrics);
  const paired = parents.map((parent, index) => ({ parent, bounds: bounds[index] ?? { minX: 0, maxX: metrics.nodeWidth } }));
  const leftParents = paired.filter((entry) => entry.parent.side === 0);
  const rightParents = paired.filter((entry) => entry.parent.side === 1);

  const placements: AncestorParentPlacement[] = [];
  let leftCursor = -parentGap;
  for (const entry of [...leftParents].reverse()) {
    const relativeX = leftCursor - entry.bounds.maxX;
    placements.push({ ...entry, relativeX });
    leftCursor = relativeX + entry.bounds.minX - parentGap;
  }

  let rightCursor = metrics.nodeWidth + parentGap;
  for (const entry of rightParents) {
    const relativeX = rightCursor - entry.bounds.minX;
    placements.push({ ...entry, relativeX });
    rightCursor = relativeX + entry.bounds.maxX + parentGap;
  }

  return placements.sort((left, right) => compareParentLayoutEntries(left.parent, right.parent));
}

function ancestorParentGap(metrics: LayoutMetrics): number {
  return Math.max(92, metrics.horizontalSpacing * 0.34);
}

function placeChildGroups(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence);
  const ownerGroupByChild = new Map<string, string>();
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const group of groups) {
      const parents = group.parentOccurrenceIds
        .map((id) => ({ id, item: itemByOccurrence.get(id), position: positionByOccurrence.get(id) }))
        .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.item && entry.position));
      if (!parents.length) continue;

      const parentCenterX = average(parents.map((parent) => parent.position.x));
      const childGeneration = Math.max(...parents.map((parent) => parent.item.occurrence.generation)) + 1;
      const children = group.childOccurrenceIds
        .map((id) => itemByOccurrence.get(id))
        .filter((item): item is OccurrenceLayoutItem => Boolean(item))
        .filter((item) => item.occurrence.generation >= childGeneration - 1)
        .sort(compareOccurrenceNodes);
      if (!children.length) continue;

      const childPositions = positionsAroundAnchor(
        children.map((child) => child.occurrence.id),
        rootOccurrenceId,
        parentCenterX,
        metrics.horizontalSpacing * 0.76,
      );

      for (const child of children) {
        const current = positionByOccurrence.get(child.occurrence.id);
        if (current && child.occurrence.generation <= 0) continue;
        const owner = ownerGroupByChild.get(child.occurrence.id);
        if (owner !== undefined && owner !== group.key) continue;
        ownerGroupByChild.set(child.occurrence.id, group.key);
        const nextPosition = {
          x: childPositions.get(child.occurrence.id) ?? parentCenterX,
          y: child.occurrence.generation * metrics.verticalSpacing,
        };
        if (!current || current.x !== nextPosition.x || current.y !== nextPosition.y) {
          positionByOccurrence.set(child.occurrence.id, nextPosition);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

function compactRootParentGroups(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  if (!rootOccurrenceId) return;
  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence);
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);

  for (const group of groups) {
    if (!group.childOccurrenceIds.includes(rootOccurrenceId) || group.parentOccurrenceIds.length !== 2) continue;
    if (!group.parentOccurrenceIds.some((parentId) => hasSiblingInOtherChildGroup(parentId, rootOccurrenceId, groups))) continue;
    const childPositions = group.childOccurrenceIds
      .map((id) => positionByOccurrence.get(id))
      .filter((position): position is OccurrencePosition => Boolean(position));
    if (!childPositions.length) continue;

    const orderedParentIds = orderedParentIdsForChildGroup(group.parentOccurrenceIds, group.childOccurrenceIds, parentsByChild);
    const leftParentPosition = positionByOccurrence.get(orderedParentIds[0]);
    const rightParentPosition = positionByOccurrence.get(orderedParentIds[1]);
    if (!leftParentPosition || !rightParentPosition) continue;

    const currentCenterGap = Math.abs((rightParentPosition.x + metrics.nodeWidth / 2) - (leftParentPosition.x + metrics.nodeWidth / 2));
    if (currentCenterGap <= spacing * 1.35) continue;

    const childCenterX = average(childPositions.map((position) => position.x + metrics.nodeWidth / 2));
    positionByOccurrence.set(orderedParentIds[0], {
      x: childCenterX - spacing / 2 - metrics.nodeWidth / 2,
      y: leftParentPosition.y,
    });
    positionByOccurrence.set(orderedParentIds[1], {
      x: childCenterX + spacing / 2 - metrics.nodeWidth / 2,
      y: rightParentPosition.y,
    });
  }
}

function compactRootParentSiblingGroups(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  if (!rootOccurrenceId) return;
  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence);
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const rootGroup = groups.find((group) =>
    group.childOccurrenceIds.includes(rootOccurrenceId) && group.parentOccurrenceIds.length === 2,
  );
  if (!rootGroup) return;

  const rootParentIds = orderedParentIdsForChildGroup(rootGroup.parentOccurrenceIds, rootGroup.childOccurrenceIds, parentsByChild);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);
  const rootParentSide = new Map(rootParentIds.map((id, index) => [id, index === 0 ? -1 : 1]));

  for (const [parentId, side] of rootParentSide.entries()) {
    const parentPosition = positionByOccurrence.get(parentId);
    if (!parentPosition) continue;
    const siblingGroup = groups.find((group) =>
      !group.childOccurrenceIds.includes(rootOccurrenceId) &&
      group.childOccurrenceIds.includes(parentId) &&
      group.childOccurrenceIds.some((childId) => childId !== parentId),
    );
    if (!siblingGroup) continue;

    const siblings = siblingGroup.childOccurrenceIds
      .filter((childId) => childId !== parentId)
      .filter((childId) => positionByOccurrence.has(childId))
      .sort((left, right) => {
        const leftPosition = positionByOccurrence.get(left);
        const rightPosition = positionByOccurrence.get(right);
        if (leftPosition && rightPosition && leftPosition.x !== rightPosition.x) {
          return leftPosition.x - rightPosition.x;
        }
        return compareOccurrenceIds(left, right, itemByOccurrence);
      });
    if (!siblings.length) continue;

    const orderedSiblings = side < 0 ? siblings : [...siblings].reverse();
    orderedSiblings.forEach((siblingId, index) => {
      const current = positionByOccurrence.get(siblingId);
      if (!current) return;
      const targetX = parentPosition.x + side * spacing * (orderedSiblings.length - index);
      positionByOccurrence.set(siblingId, {
        x: nearestFreeSiblingX(siblingId, current.y, targetX, side, itemByOccurrence, positionByOccurrence, metrics),
        y: current.y,
      });
    });
  }
}

function compactRootParentSiblingPartnerPairs(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  if (!rootOccurrenceId) return;
  const siblingIds = rootParentSiblingOccurrenceIds(parentChildEdges, itemByOccurrence, rootOccurrenceId);
  if (!siblingIds.size) return;

  const parentPairsWithChildren = parentPairKeysWithChildren(parentChildEdges, itemByOccurrence);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);

  for (const edge of graph.edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const pairKey = occurrencePairKey(edge.fromOccurrenceId, edge.toOccurrenceId);
    if (!pairKey || !parentPairsWithChildren.has(pairKey)) continue;

    const fromIsSibling = siblingIds.has(edge.fromOccurrenceId);
    const toIsSibling = siblingIds.has(edge.toOccurrenceId);
    if (fromIsSibling === toIsSibling) continue;

    const siblingId = fromIsSibling ? edge.fromOccurrenceId : edge.toOccurrenceId;
    const partnerId = fromIsSibling ? edge.toOccurrenceId : edge.fromOccurrenceId;
    const siblingItem = itemByOccurrence.get(siblingId);
    const partnerItem = itemByOccurrence.get(partnerId);
    const siblingPosition = positionByOccurrence.get(siblingId);
    const partnerPosition = positionByOccurrence.get(partnerId);
    if (!siblingItem || !partnerItem || !siblingPosition || !partnerPosition) continue;
    if (siblingItem.occurrence.generation !== partnerItem.occurrence.generation) continue;

    const direction = partnerDirection(siblingItem, partnerItem);
    const targetX = siblingPosition.x + direction * spacing;
    clearPartnerSlot(
      partnerId,
      siblingId,
      siblingPosition.y,
      targetX,
      direction,
      itemByOccurrence,
      positionByOccurrence,
      metrics,
    );
    positionByOccurrence.set(partnerId, {
      x: targetX,
      y: siblingPosition.y,
    });
  }
}

function compactPartnerPairs(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const rootParentPairKey = rootParentPairOccurrenceKey(parentChildEdges, itemByOccurrence, rootOccurrenceId);
  const parentPairsWithChildren = parentPairKeysWithChildren(parentChildEdges, itemByOccurrence);
  const parentChildConnectedOccurrenceIds = parentChildConnectedIds(parentChildEdges);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);
  const usedSlotsByAnchorSide = new Map<string, number>();

  for (const edge of graph.edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const pairKey = occurrencePairKey(edge.fromOccurrenceId, edge.toOccurrenceId);
    if (pairKey && (pairKey === rootParentPairKey || parentPairsWithChildren.has(pairKey))) continue;

    const fromItem = itemByOccurrence.get(edge.fromOccurrenceId);
    const toItem = itemByOccurrence.get(edge.toOccurrenceId);
    const fromPosition = positionByOccurrence.get(edge.fromOccurrenceId);
    const toPosition = positionByOccurrence.get(edge.toOccurrenceId);
    if (!fromItem || !toItem || !fromPosition || !toPosition) continue;

    const anchored = partnerPairAnchor(
      edge.fromOccurrenceId,
      fromItem,
      fromPosition,
      edge.toOccurrenceId,
      toItem,
      toPosition,
      parentChildConnectedOccurrenceIds,
    );
    const direction = partnerDirection(anchored.anchorItem, anchored.partnerItem);
    const slotKey = `${anchored.anchorId}:${direction}`;
    const slot = (usedSlotsByAnchorSide.get(slotKey) ?? 0) + 1;
    usedSlotsByAnchorSide.set(slotKey, slot);
    const anchorPosition = positionByOccurrence.get(anchored.anchorId) ?? anchored.anchorPosition;
    const targetX = anchorPosition.x + direction * spacing * slot;

    clearPartnerSlot(
      anchored.partnerId,
      anchored.anchorId,
      anchorPosition.y,
      targetX,
      direction,
      itemByOccurrence,
      positionByOccurrence,
      metrics,
    );
    positionByOccurrence.set(anchored.partnerId, {
      x: targetX,
      y: anchorPosition.y,
    });
  }
}

function compactFamilyParentPairs(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence)
    .filter((group) => group.parentOccurrenceIds.length === 2 && group.childOccurrenceIds.length > 0);
  if (!groups.length) return;

  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);
  const sortedGroups = [...groups].sort((left, right) => {
    const leftTouchesRoot = left.childOccurrenceIds.includes(rootOccurrenceId) ? 0 : 1;
    const rightTouchesRoot = right.childOccurrenceIds.includes(rootOccurrenceId) ? 0 : 1;
    if (leftTouchesRoot !== rightTouchesRoot) return leftTouchesRoot - rightTouchesRoot;
    return left.key.localeCompare(right.key, "uk");
  });

  for (const group of sortedGroups) {
    const orderedParentIds = orderedParentIdsForChildGroup(group.parentOccurrenceIds, group.childOccurrenceIds, parentsByChild);
    const leftParentId = orderedParentIds[0];
    const rightParentId = orderedParentIds[1];
    const leftPosition = positionByOccurrence.get(leftParentId);
    const rightPosition = positionByOccurrence.get(rightParentId);
    if (!leftPosition || !rightPosition || leftPosition.y !== rightPosition.y) continue;

    const childPositions = group.childOccurrenceIds
      .map((childId) => positionByOccurrence.get(childId))
      .filter((position): position is OccurrencePosition => Boolean(position));
    const familyCenterX = childPositions.length
      ? average(childPositions.map((position) => position.x + metrics.nodeWidth / 2))
      : average([leftPosition.x + metrics.nodeWidth / 2, rightPosition.x + metrics.nodeWidth / 2]);
    const targetLeftX = familyCenterX - spacing / 2 - metrics.nodeWidth / 2;
    const targetRightX = familyCenterX + spacing / 2 - metrics.nodeWidth / 2;
    const currentGap = Math.abs((rightPosition.x + metrics.nodeWidth / 2) - (leftPosition.x + metrics.nodeWidth / 2));
    const hasIntruder = rowHasIntruderBetween(
      leftPosition.y,
      Math.min(leftPosition.x, rightPosition.x),
      Math.max(leftPosition.x, rightPosition.x),
      new Set(orderedParentIds),
      itemByOccurrence,
      positionByOccurrence,
      metrics,
    );
    if (!hasIntruder) continue;
    if (currentGap <= spacing * 1.15 && leftPosition.x <= rightPosition.x) continue;

    clearFamilyPairSlot(leftParentId, rightParentId, leftPosition.y, targetLeftX, -1, itemByOccurrence, positionByOccurrence, metrics);
    positionByOccurrence.set(leftParentId, { x: targetLeftX, y: leftPosition.y });
    clearFamilyPairSlot(rightParentId, leftParentId, rightPosition.y, targetRightX, 1, itemByOccurrence, positionByOccurrence, metrics);
    positionByOccurrence.set(rightParentId, { x: targetRightX, y: rightPosition.y });
  }
}

function clearFamilyPairSlot(
  movingOccurrenceId: string,
  pairedOccurrenceId: string,
  y: number,
  targetX: number,
  direction: number,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const ignored = new Set([movingOccurrenceId, pairedOccurrenceId]);
  const blocker = rowBlockerAtX(targetX, y, ignored, itemByOccurrence, positionByOccurrence, metrics);
  if (!blocker) return;
  pushOccurrenceToFreeSlot(
    blocker.occurrenceId,
    y,
    targetX + direction * (metrics.nodeWidth + 24),
    direction,
    ignored,
    itemByOccurrence,
    positionByOccurrence,
    metrics,
  );
}

function rowHasIntruderBetween(
  y: number,
  leftX: number,
  rightX: number,
  protectedOccurrenceIds: Set<string>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): boolean {
  return Array.from(positionByOccurrence.entries()).some(([occurrenceId, position]) =>
    !protectedOccurrenceIds.has(occurrenceId) &&
    itemByOccurrence.has(occurrenceId) &&
    position.y === y &&
    position.x + metrics.nodeWidth > leftX &&
    position.x < rightX + metrics.nodeWidth,
  );
}

type VisualRowBlock = {
  generation: number;
  occurrenceIds: string[];
  anchorCenterX: number | null;
  shiftAncestorBranches: boolean;
};

function compactVisualFamilyBlocks(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const rawBlocks = visualRowBlocks(graph, parentChildEdges, itemByOccurrence, positionByOccurrence, metrics);
  if (!rawBlocks.length) return;
  const blocksByGeneration = groupBy(mergeVisualRowBlocks(rawBlocks), (block) => block.generation);
  const spacing = Math.max(metrics.nodeWidth + 24, metrics.horizontalSpacing * 0.76);
  const rowGap = Math.max(24, spacing - metrics.nodeWidth);

  for (const [generation, blocks] of blocksByGeneration.entries()) {
    const rowIds = Array.from(itemByOccurrence.values())
      .filter((item) => item.occurrence.generation === generation && positionByOccurrence.has(item.occurrence.id))
      .map((item) => item.occurrence.id);
    if (!rowIds.length) continue;

    const blockIds = new Set(blocks.flatMap((block) => block.occurrenceIds));
    const entries = [
      ...blocks.map((block) => visualRowEntry(block, itemByOccurrence, positionByOccurrence, metrics, spacing)),
      ...rowIds
        .filter((id) => !blockIds.has(id))
        .map((id) => visualRowEntry({
          generation,
          occurrenceIds: [id],
          anchorCenterX: null,
          shiftAncestorBranches: false,
        }, itemByOccurrence, positionByOccurrence, metrics, spacing)),
    ].filter((entry): entry is VisualRowEntry => Boolean(entry));

    const sorted = entries.sort((left, right) =>
      left.desiredX - right.desiredX ||
      left.firstCurrentX - right.firstCurrentX ||
      left.occurrenceIds.join("|").localeCompare(right.occurrenceIds.join("|"), "uk"),
    );

    let cursor = Number.NEGATIVE_INFINITY;
    for (const entry of sorted) {
      const startX = Number.isFinite(cursor) ? Math.max(entry.desiredX, cursor) : entry.desiredX;
      entry.occurrenceIds.forEach((occurrenceId, index) => {
        const current = positionByOccurrence.get(occurrenceId);
        if (!current) return;
        const nextX = startX + index * spacing;
        const deltaX = nextX - current.x;
        positionByOccurrence.set(occurrenceId, {
          x: nextX,
          y: current.y,
        });
        if (entry.shiftAncestorBranches && Math.abs(deltaX) > 0.001) {
          shiftAncestorBranch(
            parentChildEdges,
            itemByOccurrence,
            positionByOccurrence,
            occurrenceId,
            deltaX,
            new Set([occurrenceId]),
          );
        }
      });
      cursor = startX + entry.width + rowGap;
    }
  }
}

function visualRowBlocks(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): VisualRowBlock[] {
  const blocks: VisualRowBlock[] = [];
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);

  for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
    const parents = orderedParentIdsForChildGroup(group.parentOccurrenceIds, group.childOccurrenceIds, parentsByChild)
      .filter((id) => positionByOccurrence.has(id));
    const children = group.childOccurrenceIds
      .filter((id) => positionByOccurrence.has(id))
      .sort((left, right) => compareOccurrenceIds(left, right, itemByOccurrence));
    const parentGeneration = sharedGeneration(parents, itemByOccurrence);
    const childGeneration = sharedGeneration(children, itemByOccurrence);
    const childAnchor = averageOccurrenceCenterX(children, positionByOccurrence, metrics);
    const parentAnchor = averageOccurrenceCenterX(parents, positionByOccurrence, metrics);

    if (
      parents.length > 1 &&
      parentGeneration !== null &&
      rowHasIntruderBetweenOccurrences(parents, itemByOccurrence, positionByOccurrence, metrics)
    ) {
      blocks.push({
        generation: parentGeneration,
        occurrenceIds: parents,
        anchorCenterX: childAnchor,
        shiftAncestorBranches: false,
      });
    }
    if (
      children.length > 1 &&
      childGeneration !== null &&
      rowHasIntruderBetweenOccurrences(children, itemByOccurrence, positionByOccurrence, metrics)
    ) {
      blocks.push({
        generation: childGeneration,
        occurrenceIds: children,
        anchorCenterX: parentAnchor,
        shiftAncestorBranches: false,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const generation = sharedGeneration([edge.fromOccurrenceId, edge.toOccurrenceId], itemByOccurrence);
    if (generation === null) continue;
    if (!positionByOccurrence.has(edge.fromOccurrenceId) || !positionByOccurrence.has(edge.toOccurrenceId)) continue;
    if (
      hasVisibleAncestorBranch(edge.fromOccurrenceId, parentChildEdges, positionByOccurrence) &&
      hasVisibleAncestorBranch(edge.toOccurrenceId, parentChildEdges, positionByOccurrence)
    ) {
      continue;
    }
    blocks.push({
      generation,
      occurrenceIds: [edge.fromOccurrenceId, edge.toOccurrenceId]
        .sort((left, right) => compareOccurrencePosition(left, right, itemByOccurrence, positionByOccurrence)),
      anchorCenterX: averageOccurrenceCenterX([edge.fromOccurrenceId, edge.toOccurrenceId], positionByOccurrence, metrics),
      shiftAncestorBranches: true,
    });
  }

  return blocks;
}

function hasVisibleAncestorBranch(
  occurrenceId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
  positionByOccurrence: Map<string, OccurrencePosition>,
): boolean {
  return parentChildEdges.some((edge) =>
    edge.toOccurrenceId === occurrenceId &&
    Boolean(edge.fromOccurrenceId && positionByOccurrence.has(edge.fromOccurrenceId)),
  );
}

function rowHasIntruderBetweenOccurrences(
  occurrenceIds: string[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): boolean {
  const positions = occurrenceIds
    .map((id) => positionByOccurrence.get(id))
    .filter((position): position is OccurrencePosition => Boolean(position));
  if (positions.length < 2) return false;
  const y = positions[0].y;
  if (positions.some((position) => position.y !== y)) return false;
  const leftX = Math.min(...positions.map((position) => position.x));
  const rightX = Math.max(...positions.map((position) => position.x));
  return rowHasIntruderBetween(
    y,
    leftX,
    rightX,
    new Set(occurrenceIds),
    itemByOccurrence,
    positionByOccurrence,
    metrics,
  );
}

function mergeVisualRowBlocks(blocks: VisualRowBlock[]): VisualRowBlock[] {
  const pending = blocks
    .filter((block) => block.occurrenceIds.length > 1)
    .map((block) => ({
      generation: block.generation,
      occurrenceIds: new Set(block.occurrenceIds),
      anchorValues: block.anchorCenterX === null ? [] : [block.anchorCenterX],
      shiftAncestorBranches: block.shiftAncestorBranches,
    }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let left = 0; left < pending.length; left += 1) {
      for (let right = left + 1; right < pending.length; right += 1) {
        if (pending[left].generation !== pending[right].generation) continue;
        if (!setsIntersect(pending[left].occurrenceIds, pending[right].occurrenceIds)) continue;
        for (const id of pending[right].occurrenceIds) pending[left].occurrenceIds.add(id);
        pending[left].anchorValues.push(...pending[right].anchorValues);
        pending[left].shiftAncestorBranches = pending[left].shiftAncestorBranches || pending[right].shiftAncestorBranches;
        pending.splice(right, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return pending.map((block) => ({
    generation: block.generation,
    occurrenceIds: Array.from(block.occurrenceIds),
    anchorCenterX: block.anchorValues.length ? average(block.anchorValues) : null,
    shiftAncestorBranches: block.shiftAncestorBranches,
  }));
}

type VisualRowEntry = {
  occurrenceIds: string[];
  desiredX: number;
  firstCurrentX: number;
  width: number;
  shiftAncestorBranches: boolean;
};

function visualRowEntry(
  block: VisualRowBlock,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
  spacing: number,
): VisualRowEntry | null {
  const occurrenceIds = [...block.occurrenceIds]
    .filter((id) => positionByOccurrence.has(id))
    .sort((left, right) => compareOccurrencePosition(left, right, itemByOccurrence, positionByOccurrence));
  if (!occurrenceIds.length) return null;
  const positions = occurrenceIds
    .map((id) => positionByOccurrence.get(id))
    .filter((position): position is OccurrencePosition => Boolean(position));
  const firstCurrentX = Math.min(...positions.map((position) => position.x));
  const width = metricsWidth(occurrenceIds.length, metrics.nodeWidth, spacing);
  return {
    occurrenceIds,
    desiredX: block.anchorCenterX === null ? firstCurrentX : block.anchorCenterX - width / 2,
    firstCurrentX,
    width,
    shiftAncestorBranches: block.shiftAncestorBranches,
  };
}

function shiftAncestorBranch(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  childOccurrenceId: string,
  deltaX: number,
  visited: Set<string>,
) {
  const childGeneration = itemByOccurrence.get(childOccurrenceId)?.occurrence.generation;
  for (const edge of parentChildEdges) {
    const parentOccurrenceId = edge.fromOccurrenceId;
    if (!parentOccurrenceId || edge.toOccurrenceId !== childOccurrenceId || visited.has(parentOccurrenceId)) continue;
    const parentItem = itemByOccurrence.get(parentOccurrenceId);
    const parentPosition = positionByOccurrence.get(parentOccurrenceId);
    if (!parentItem || !parentPosition) continue;
    if (childGeneration !== undefined && parentItem.occurrence.generation >= childGeneration) continue;
    visited.add(parentOccurrenceId);
    positionByOccurrence.set(parentOccurrenceId, {
      x: parentPosition.x + deltaX,
      y: parentPosition.y,
    });
    shiftAncestorBranch(parentChildEdges, itemByOccurrence, positionByOccurrence, parentOccurrenceId, deltaX, visited);
  }
}

function metricsWidth(count: number, nodeWidth: number, spacing: number): number {
  return count <= 0 ? 0 : (count - 1) * spacing + nodeWidth;
}

function sharedGeneration(
  occurrenceIds: string[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): number | null {
  const generations = new Set(occurrenceIds
    .map((id) => itemByOccurrence.get(id)?.occurrence.generation)
    .filter((generation): generation is number => generation !== undefined));
  return generations.size === 1 ? Array.from(generations)[0] : null;
}

function averageOccurrenceCenterX(
  occurrenceIds: string[],
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): number | null {
  const centers = occurrenceIds
    .map((id) => positionByOccurrence.get(id))
    .filter((position): position is OccurrencePosition => Boolean(position))
    .map((position) => position.x + metrics.nodeWidth / 2);
  return centers.length ? average(centers) : null;
}

function compareOccurrencePosition(
  leftId: string,
  rightId: string,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
): number {
  const leftPosition = positionByOccurrence.get(leftId);
  const rightPosition = positionByOccurrence.get(rightId);
  if (leftPosition && rightPosition && leftPosition.x !== rightPosition.x) {
    return leftPosition.x - rightPosition.x;
  }
  return compareOccurrenceIds(leftId, rightId, itemByOccurrence);
}

function setsIntersect<T>(left: Set<T>, right: Set<T>): boolean {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
}

function centerRootAxisUnderParents(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const rootItem = itemByOccurrence.get(rootOccurrenceId);
  const rootPosition = positionByOccurrence.get(rootOccurrenceId);
  if (!rootItem || !rootPosition) return;

  const rootParentGroup = childLayoutGroups(parentChildEdges, itemByOccurrence).find((group) =>
    group.childOccurrenceIds.includes(rootOccurrenceId) && group.parentOccurrenceIds.length > 0,
  );
  if (!rootParentGroup) return;

  const parentPositions = rootParentGroup.parentOccurrenceIds
    .map((parentId) => positionByOccurrence.get(parentId))
    .filter((position): position is OccurrencePosition => Boolean(position));
  if (!parentPositions.length) return;

  const parentCenterX = average(parentPositions.map((position) => position.x + metrics.nodeWidth / 2));
  const rootCenterX = rootPosition.x + metrics.nodeWidth / 2;
  const deltaX = parentCenterX - rootCenterX;
  if (Math.abs(deltaX) < 0.001) return;

  for (const [occurrenceId, position] of positionByOccurrence.entries()) {
    const item = itemByOccurrence.get(occurrenceId);
    if (!item || item.occurrence.generation < rootItem.occurrence.generation) continue;
    positionByOccurrence.set(occurrenceId, {
      x: position.x + deltaX,
      y: position.y,
    });
  }
}

function lockDirectAncestorBackbone(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  const rootPosition = positionByOccurrence.get(rootOccurrenceId);
  if (!rootOccurrenceId || !rootPosition) return;
  const directAncestorIds = directAncestorOccurrenceIds(parentChildEdges, rootOccurrenceId);
  if (directAncestorIds.size <= 1) return;

  const directEdges = parentChildEdges.filter((edge) =>
    Boolean(
      edge.fromOccurrenceId &&
      edge.toOccurrenceId &&
      directAncestorIds.has(edge.fromOccurrenceId) &&
      directAncestorIds.has(edge.toOccurrenceId),
    ),
  );
  const directParentsByChild = parentEntriesByChild(directEdges, itemByOccurrence);
  const measuredBounds = new Map<string, AncestorSubtreeBounds>();
  const rootParents = directParentsByChild.get(rootOccurrenceId) ?? [];
  const seedOccurrenceIds = rootParents.length
    ? rootParents.map((parent) => parent.parentOccurrenceId)
    : [rootOccurrenceId];
  const placed = new Set<string>([rootOccurrenceId]);
  for (const seedOccurrenceId of seedOccurrenceIds) {
    const seedPosition = positionByOccurrence.get(seedOccurrenceId);
    if (!seedPosition) continue;
    placeAncestorSubtree(
      seedOccurrenceId,
      seedPosition.x,
      seedPosition.y,
      directParentsByChild,
      itemByOccurrence,
      positionByOccurrence,
      measuredBounds,
      placed,
      metrics,
    );
  }
}

function directAncestorOccurrenceIds(
  parentChildEdges: FamilyTreeEdgeDto[],
  rootOccurrenceId: string,
): Set<string> {
  const result = new Set<string>([rootOccurrenceId]);
  const queue = [rootOccurrenceId];
  while (queue.length) {
    const childOccurrenceId = queue.shift();
    if (!childOccurrenceId) continue;
    for (const edge of parentChildEdges) {
      const parentOccurrenceId = edge.fromOccurrenceId;
      if (!parentOccurrenceId || edge.toOccurrenceId !== childOccurrenceId || result.has(parentOccurrenceId)) continue;
      result.add(parentOccurrenceId);
      queue.push(parentOccurrenceId);
    }
  }
  return result;
}

function pushNonDirectNodesOutsideAncestorBackbone(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  rootOccurrenceId: string,
  metrics: LayoutMetrics,
) {
  if (!rootOccurrenceId) return;
  const directAncestorIds = directAncestorOccurrenceIds(parentChildEdges, rootOccurrenceId);
  const directEntries = Array.from(directAncestorIds)
    .map((id) => ({ id, item: itemByOccurrence.get(id), position: positionByOccurrence.get(id) }))
    .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry.item && entry.position));
  if (!directEntries.length) return;

  const boundsByGeneration = new Map<number, { minX: number; maxX: number }>();
  for (const entry of directEntries) {
    const generation = entry.item.occurrence.generation;
    const bounds = boundsByGeneration.get(generation) ?? {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
    };
    bounds.minX = Math.min(bounds.minX, entry.position.x);
    bounds.maxX = Math.max(bounds.maxX, entry.position.x + metrics.nodeWidth);
    boundsByGeneration.set(generation, bounds);
  }

  const safetyGap = Math.max(48, metrics.horizontalSpacing * 0.18);
  const grouped = groupBy(
    Array.from(positionByOccurrence.entries())
      .map(([id, position]) => ({ id, item: itemByOccurrence.get(id), position }))
      .filter((entry): entry is { id: string; item: OccurrenceLayoutItem; position: OccurrencePosition } =>
        Boolean(entry.item) && !directAncestorIds.has(entry.id),
      ),
    (entry) => entry.item.occurrence.generation,
  );

  for (const [generation, entries] of grouped.entries()) {
    const directBounds = boundsByGeneration.get(generation);
    if (!directBounds) continue;
    const left: typeof entries = [];
    const right: typeof entries = [];
    for (const entry of entries) {
      const centerX = entry.position.x + metrics.nodeWidth / 2;
      const directCenterX = (directBounds.minX + directBounds.maxX) / 2;
      if (centerX < directCenterX) {
        left.push(entry);
      } else {
        right.push(entry);
      }
    }

    let leftCursor = directBounds.minX - safetyGap;
    for (const entry of left.sort((a, b) => b.position.x - a.position.x)) {
      const nextX = Math.min(entry.position.x, leftCursor - metrics.nodeWidth);
      positionByOccurrence.set(entry.id, { x: nextX, y: entry.position.y });
      leftCursor = nextX - safetyGap;
    }

    let rightCursor = directBounds.maxX + safetyGap;
    for (const entry of right.sort((a, b) => a.position.x - b.position.x)) {
      const nextX = Math.max(entry.position.x, rightCursor);
      positionByOccurrence.set(entry.id, { x: nextX, y: entry.position.y });
      rightCursor = nextX + metrics.nodeWidth + safetyGap;
    }
  }
}

function partnerPairAnchor(
  fromId: string,
  fromItem: OccurrenceLayoutItem,
  fromPosition: OccurrencePosition,
  toId: string,
  toItem: OccurrenceLayoutItem,
  toPosition: OccurrencePosition,
  parentChildConnectedOccurrenceIds: Set<string>,
): {
  anchorId: string;
  anchorItem: OccurrenceLayoutItem;
  anchorPosition: OccurrencePosition;
  partnerId: string;
  partnerItem: OccurrenceLayoutItem;
  partnerPosition: OccurrencePosition;
} {
  const fromConnected = parentChildConnectedOccurrenceIds.has(fromId);
  const toConnected = parentChildConnectedOccurrenceIds.has(toId);
  if (fromConnected && !toConnected) {
    return {
      anchorId: fromId,
      anchorItem: fromItem,
      anchorPosition: fromPosition,
      partnerId: toId,
      partnerItem: toItem,
      partnerPosition: toPosition,
    };
  }

  if (toConnected && !fromConnected) {
    return {
      anchorId: toId,
      anchorItem: toItem,
      anchorPosition: toPosition,
      partnerId: fromId,
      partnerItem: fromItem,
      partnerPosition: fromPosition,
    };
  }

  return {
    anchorId: fromId,
    anchorItem: fromItem,
    anchorPosition: fromPosition,
    partnerId: toId,
    partnerItem: toItem,
    partnerPosition: toPosition,
  };
}

function clearPartnerSlot(
  movingOccurrenceId: string,
  anchorOccurrenceId: string,
  y: number,
  targetX: number,
  direction: number,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const blocker = rowBlockerAtX(
    targetX,
    y,
    new Set([movingOccurrenceId, anchorOccurrenceId]),
    itemByOccurrence,
    positionByOccurrence,
    metrics,
  );
  if (!blocker) return;
  pushOccurrenceToFreeSlot(
    blocker.occurrenceId,
    y,
    targetX + direction * (metrics.nodeWidth + 24),
    direction,
    new Set([movingOccurrenceId, anchorOccurrenceId]),
    itemByOccurrence,
    positionByOccurrence,
    metrics,
  );
}

function pushOccurrenceToFreeSlot(
  occurrenceId: string,
  y: number,
  targetX: number,
  direction: number,
  protectedOccurrenceIds: Set<string>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
  depth = 0,
) {
  if (depth > 64) return;
  const current = positionByOccurrence.get(occurrenceId);
  if (!current) return;
  const nextX = direction < 0 ? Math.min(current.x, targetX) : Math.max(current.x, targetX);
  const blocker = rowBlockerAtX(
    nextX,
    y,
    new Set([...protectedOccurrenceIds, occurrenceId]),
    itemByOccurrence,
    positionByOccurrence,
    metrics,
  );
  if (blocker) {
    pushOccurrenceToFreeSlot(
      blocker.occurrenceId,
      y,
      nextX + direction * (metrics.nodeWidth + 24),
      direction,
      new Set([...protectedOccurrenceIds, occurrenceId]),
      itemByOccurrence,
      positionByOccurrence,
      metrics,
      depth + 1,
    );
  }
  positionByOccurrence.set(occurrenceId, { x: nextX, y });
}

function rowBlockerAtX(
  x: number,
  y: number,
  ignoredOccurrenceIds: Set<string>,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): { occurrenceId: string; position: OccurrencePosition } | null {
  const minSeparation = metrics.nodeWidth + 24;
  const blocker = Array.from(positionByOccurrence.entries())
    .filter(([occurrenceId, position]) =>
      !ignoredOccurrenceIds.has(occurrenceId) &&
      itemByOccurrence.has(occurrenceId) &&
      position.y === y &&
      rangesOverlapWithGap(x, position.x, minSeparation),
    )
    .sort((left, right) => Math.abs(left[1].x - x) - Math.abs(right[1].x - x))[0];
  return blocker ? { occurrenceId: blocker[0], position: blocker[1] } : null;
}

function partnerDirection(knownItem: OccurrenceLayoutItem, partnerItem: OccurrenceLayoutItem): number {
  const knownGender = knownItem.person.gender.toLocaleLowerCase("uk");
  const partnerGender = partnerItem.person.gender.toLocaleLowerCase("uk");
  const partnerShouldBeRight =
    isMaleGender(knownItem.person.gender) ||
    isFemaleGender(partnerItem.person.gender) ||
    ["чоловік", "male", "m", "man"].includes(knownGender) ||
    ["жінка", "female", "f", "woman"].includes(partnerGender);
  return partnerShouldBeRight ? 1 : -1;
}

function rootParentPairOccurrenceKey(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  rootOccurrenceId: string,
): string {
  if (!rootOccurrenceId) return "";
  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence);
  const rootGroup = groups.find((group) =>
    group.childOccurrenceIds.includes(rootOccurrenceId) && group.parentOccurrenceIds.length === 2,
  );
  return rootGroup ? occurrencePairKey(rootGroup.parentOccurrenceIds[0], rootGroup.parentOccurrenceIds[1]) : "";
}

function rootParentSiblingOccurrenceIds(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  rootOccurrenceId: string,
): Set<string> {
  const result = new Set<string>();
  if (!rootOccurrenceId) return result;

  const groups = childLayoutGroups(parentChildEdges, itemByOccurrence);
  const rootGroup = groups.find((group) =>
    group.childOccurrenceIds.includes(rootOccurrenceId) && group.parentOccurrenceIds.length === 2,
  );
  if (!rootGroup) return result;

  for (const parentId of rootGroup.parentOccurrenceIds) {
    const parentItem = itemByOccurrence.get(parentId);
    if (!parentItem) continue;

    for (const group of groups) {
      if (group.childOccurrenceIds.includes(rootOccurrenceId)) continue;
      if (!group.childOccurrenceIds.includes(parentId)) continue;
      for (const childId of group.childOccurrenceIds) {
        if (childId === parentId) continue;
        const childItem = itemByOccurrence.get(childId);
        if (!childItem || childItem.occurrence.generation !== parentItem.occurrence.generation) continue;
        result.add(childId);
      }
    }
  }

  return result;
}

function parentPairKeysWithChildren(
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): Set<string> {
  const result = new Set<string>();
  for (const group of childLayoutGroups(parentChildEdges, itemByOccurrence)) {
    const parents = group.parentOccurrenceIds;
    for (let left = 0; left < parents.length; left += 1) {
      for (let right = left + 1; right < parents.length; right += 1) {
        const pairKey = occurrencePairKey(parents[left], parents[right]);
        if (pairKey) result.add(pairKey);
      }
    }
  }
  return result;
}

function parentChildConnectedIds(parentChildEdges: FamilyTreeEdgeDto[]): Set<string> {
  const result = new Set<string>();
  for (const edge of parentChildEdges) {
    if (edge.fromOccurrenceId) result.add(edge.fromOccurrenceId);
    if (edge.toOccurrenceId) result.add(edge.toOccurrenceId);
  }
  return result;
}

function nearestFreeSiblingX(
  movingOccurrenceId: string,
  y: number,
  targetX: number,
  direction: number,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
): number {
  const minSeparation = metrics.nodeWidth + 24;
  let x = targetX;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const blocker = Array.from(positionByOccurrence.entries())
      .filter(([occurrenceId, position]) =>
        occurrenceId !== movingOccurrenceId &&
        itemByOccurrence.has(occurrenceId) &&
        position.y === y &&
        rangesOverlapWithGap(x, position.x, minSeparation),
      )
      .sort((left, right) => Math.abs(left[1].x - x) - Math.abs(right[1].x - x))[0];
    if (!blocker) return x;
    x = direction < 0
      ? Math.min(x, blocker[1].x - minSeparation)
      : Math.max(x, blocker[1].x + minSeparation);
  }
  return x;
}

function rangesOverlapWithGap(leftX: number, rightX: number, minSeparation: number): boolean {
  return leftX < rightX + minSeparation && rightX < leftX + minSeparation;
}

function hasSiblingInOtherChildGroup(
  occurrenceId: string,
  rootOccurrenceId: string,
  groups: Array<{ childOccurrenceIds: string[] }>,
): boolean {
  return groups.some((group) =>
    !group.childOccurrenceIds.includes(rootOccurrenceId) &&
    group.childOccurrenceIds.includes(occurrenceId) &&
    group.childOccurrenceIds.some((childId) => childId !== occurrenceId),
  );
}

function orderedParentIdsForChildGroup(
  parentOccurrenceIds: string[],
  childOccurrenceIds: string[],
  parentsByChild: Map<string, ParentLayoutEntry[]>,
): string[] {
  const parentIdSet = new Set(parentOccurrenceIds);
  const ordered = childOccurrenceIds
    .flatMap((childId) => parentsByChild.get(childId) ?? [])
    .filter((entry) => parentIdSet.has(entry.parentOccurrenceId))
    .sort(compareParentLayoutEntries)
    .map((entry) => entry.parentOccurrenceId);
  const uniqueOrdered = Array.from(new Set(ordered));
  return uniqueOrdered.length === parentOccurrenceIds.length ? uniqueOrdered : [...parentOccurrenceIds].sort();
}

function placePartnerOnlyNodes(
  graph: FamilyTreeGraphDto,
  parentChildEdges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const parentsByChild = parentEntriesByChild(parentChildEdges, itemByOccurrence);
  const measuredBounds = new Map<string, AncestorSubtreeBounds>();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      if (edge.kind !== "partner" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
      const fromItem = itemByOccurrence.get(edge.fromOccurrenceId);
      const toItem = itemByOccurrence.get(edge.toOccurrenceId);
      if (!fromItem || !toItem) continue;
      const fromPosition = positionByOccurrence.get(edge.fromOccurrenceId);
      const toPosition = positionByOccurrence.get(edge.toOccurrenceId);
      if (fromPosition && !toPosition) {
        positionByOccurrence.set(
          edge.toOccurrenceId,
          partnerPosition(fromItem, toItem, fromPosition, parentsByChild, measuredBounds, metrics),
        );
        changed = true;
      } else if (toPosition && !fromPosition) {
        positionByOccurrence.set(
          edge.fromOccurrenceId,
          partnerPosition(toItem, fromItem, toPosition, parentsByChild, measuredBounds, metrics),
        );
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function placeFallbackGenerationRows(
  items: OccurrenceLayoutItem[],
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const missing = items.filter((item) => !positionByOccurrence.has(item.occurrence.id));
  if (!missing.length) return;
  const positionedXs = Array.from(positionByOccurrence.values()).map((position) => position.x);
  const baseX = positionedXs.length
    ? Math.max(...positionedXs) + metrics.nodeWidth + metrics.horizontalSpacing
    : 0;
  const grouped = groupBy(missing, (item) => item.occurrence.generation);
  for (const [generation, row] of grouped.entries()) {
    const sorted = [...row].sort(compareOccurrenceNodes);
    sorted.forEach((item, index) => {
      positionByOccurrence.set(item.occurrence.id, {
        x: baseX + index * metrics.horizontalSpacing,
        y: generation * metrics.verticalSpacing,
      });
    });
  }
}

function resolveGenerationRowOverlaps(
  items: OccurrenceLayoutItem[],
  positionByOccurrence: Map<string, OccurrencePosition>,
  metrics: LayoutMetrics,
) {
  const minSeparation = metrics.nodeWidth + 24;
  const positioned = items
    .map((item) => {
      const position = positionByOccurrence.get(item.occurrence.id);
      return position ? { item, position } : null;
    })
    .filter((entry): entry is { item: OccurrenceLayoutItem; position: OccurrencePosition } => Boolean(entry));
  const rows = groupBy(positioned, (entry) => entry.item.occurrence.generation);
  for (const row of rows.values()) {
    const sorted = [...row].sort((left, right) =>
      left.position.x - right.position.x || compareOccurrenceNodes(left.item, right.item),
    );
    let cursor = Number.NEGATIVE_INFINITY;
    for (const entry of sorted) {
      const x = Math.max(entry.position.x, cursor);
      if (x !== entry.position.x) {
        positionByOccurrence.set(entry.item.occurrence.id, { x, y: entry.position.y });
      }
      cursor = x + minSeparation;
    }
  }
}

function childLayoutGroups(
  edges: FamilyTreeEdgeDto[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): Array<{
  key: string;
  parentOccurrenceIds: string[];
  childOccurrenceIds: string[];
}> {
  const childGroups = new Map<
    string,
    {
      childGeneration: number;
      scopeKey: string;
      parentOccurrenceIds: Set<string>;
      childOccurrenceIds: Set<string>;
    }
  >();
  for (const edge of edges) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const childGeneration = itemByOccurrence.get(edge.toOccurrenceId)?.occurrence.generation ?? 0;
    const childKey = [
      edge.toOccurrenceId,
      edge.parentSetId ?? edge.familyGroupId ?? "single",
    ].join(":");
    const childGroup = childGroups.get(childKey) ?? {
      childGeneration,
      scopeKey: edge.familyGroupId
        ? `family:${edge.familyGroupId}`
        : edge.parentSetId
          ? `parent-set:${edge.parentSetId}`
          : `child:${edge.toOccurrenceId}`,
      parentOccurrenceIds: new Set<string>(),
      childOccurrenceIds: new Set<string>(),
    };
    childGroup.parentOccurrenceIds.add(edge.fromOccurrenceId);
    childGroup.childOccurrenceIds.add(edge.toOccurrenceId);
    childGroups.set(childKey, childGroup);
  }

  const groups = new Map<string, { key: string; parentOccurrenceIds: Set<string>; childOccurrenceIds: Set<string> }>();
  for (const childGroup of childGroups.values()) {
    const parentSignature = Array.from(childGroup.parentOccurrenceIds).sort().join("|");
    const scopeKey = childGroup.parentOccurrenceIds.size > 1 && parentSignature
      ? `parents:${parentSignature}`
      : childGroup.scopeKey;
    const key = [
      scopeKey,
      `generation:${childGroup.childGeneration}`,
    ].join(":");
    const group = groups.get(key) ?? {
      key,
      parentOccurrenceIds: new Set<string>(),
      childOccurrenceIds: new Set<string>(),
    };
    for (const parentId of childGroup.parentOccurrenceIds) {
      group.parentOccurrenceIds.add(parentId);
    }
    for (const childId of childGroup.childOccurrenceIds) {
      group.childOccurrenceIds.add(childId);
    }
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => ({
    key: group.key,
    parentOccurrenceIds: Array.from(group.parentOccurrenceIds),
    childOccurrenceIds: Array.from(group.childOccurrenceIds),
  }));
}

function parentSideIndex(edge: FamilyTreeEdgeDto, parent: FamilyTreeNodeDto): 0 | 1 {
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? edge.metadata?.parent_role_label ?? "").toLocaleLowerCase("uk");
  if (isFatherRole(role)) return 0;
  if (isMotherRole(role)) return 1;
  if (isMaleGender(parent.gender)) return 0;
  if (isFemaleGender(parent.gender)) return 1;
  if (["father", "stepfather", "adoptive_father"].includes(role)) return 0;
  if (["mother", "stepmother", "adoptive_mother"].includes(role)) return 1;
  const gender = parent.gender.toLocaleLowerCase("uk");
  if (["чоловік", "male", "m", "man"].includes(gender)) return 0;
  if (["жінка", "female", "f", "woman"].includes(gender)) return 1;
  return parent.displayName.localeCompare("м", "uk") < 0 ? 0 : 1;
}

function compareParentLayoutEntries(left: ParentLayoutEntry, right: ParentLayoutEntry): number {
  if (left.side !== right.side) return left.side - right.side;
  return compareOccurrenceNodes(left.item, right.item);
}

function compareOccurrenceIds(
  leftId: string,
  rightId: string,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
): number {
  const left = itemByOccurrence.get(leftId);
  const right = itemByOccurrence.get(rightId);
  if (left && right) return compareOccurrenceNodes(left, right);
  return leftId.localeCompare(rightId, "uk");
}

function partnerPosition(
  knownItem: OccurrenceLayoutItem,
  partnerItem: OccurrenceLayoutItem,
  knownPosition: OccurrencePosition,
  parentsByChild: Map<string, ParentLayoutEntry[]>,
  measuredBounds: Map<string, AncestorSubtreeBounds>,
  metrics: LayoutMetrics,
): OccurrencePosition {
  const gap = Math.max(metrics.nodeWidth + 105, metrics.horizontalSpacing * 0.72);
  const branchGap = ancestorParentGap(metrics);
  const knownGender = knownItem.person.gender.toLocaleLowerCase("uk");
  const partnerGender = partnerItem.person.gender.toLocaleLowerCase("uk");
  const partnerShouldBeRight =
    isMaleGender(knownItem.person.gender) ||
    isFemaleGender(partnerItem.person.gender) ||
    ["чоловік", "male", "m", "man"].includes(knownGender) ||
    ["жінка", "female", "f", "woman"].includes(partnerGender);
  const knownBounds = measureAncestorSubtree(
    knownItem.occurrence.id,
    parentsByChild,
    measuredBounds,
    metrics,
    new Set(),
  );
  const partnerBounds = measureAncestorSubtree(
    partnerItem.occurrence.id,
    parentsByChild,
    measuredBounds,
    metrics,
    new Set(),
  );
  const compactX = knownPosition.x + (partnerShouldBeRight ? gap : -gap);
  const branchAwareX = partnerShouldBeRight
    ? knownPosition.x + knownBounds.maxX + branchGap - partnerBounds.minX
    : knownPosition.x + knownBounds.minX - branchGap - partnerBounds.maxX;
  return {
    x: partnerShouldBeRight ? Math.max(compactX, branchAwareX) : Math.min(compactX, branchAwareX),
    y: knownPosition.y,
  };
}

function positionsAroundAnchor(
  occurrenceIds: string[],
  anchorOccurrenceId: string,
  centerX: number,
  spacing: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const anchorIndex = anchorOccurrenceId ? occurrenceIds.indexOf(anchorOccurrenceId) : -1;
  if (anchorIndex >= 0) {
    result.set(anchorOccurrenceId, centerX);
    const others = occurrenceIds.filter((id) => id !== anchorOccurrenceId);
    others.forEach((id, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const step = Math.floor(index / 2) + 1;
      result.set(id, centerX + side * step * spacing);
    });
    return result;
  }

  const rowWidth = Math.max(0, (occurrenceIds.length - 1) * spacing);
  occurrenceIds.forEach((id, index) => {
    result.set(id, centerX + index * spacing - rowWidth / 2);
  });
  return result;
}

function fallbackPosition(
  item: OccurrenceLayoutItem,
  items: OccurrenceLayoutItem[],
  horizontalSpacing: number,
  verticalSpacing: number,
): OccurrencePosition {
  const row = items
    .filter((candidate) => candidate.occurrence.generation === item.occurrence.generation)
    .sort(compareOccurrenceNodes);
  const index = Math.max(0, row.findIndex((candidate) => candidate.occurrence.id === item.occurrence.id));
  const rowWidth = Math.max(0, (row.length - 1) * horizontalSpacing);
  return {
    x: index * horizontalSpacing - rowWidth / 2,
    y: item.occurrence.generation * verticalSpacing,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isFatherRole(role: string): boolean {
  return [
    "father",
    "stepfather",
    "adoptive_father",
    "батько",
    "вітчим",
    "прийомний батько",
  ].includes(role);
}

function isMotherRole(role: string): boolean {
  return [
    "mother",
    "stepmother",
    "adoptive_mother",
    "мати",
    "матір",
    "мачуха",
    "прийомна мати",
  ].includes(role);
}

function isMaleGender(value: string | undefined): boolean {
  const gender = (value ?? "").trim().toLocaleLowerCase("uk");
  return ["чоловік", "чоловіча", "male", "m", "man"].includes(gender);
}

function isFemaleGender(value: string | undefined): boolean {
  const gender = (value ?? "").trim().toLocaleLowerCase("uk");
  return ["жінка", "жіноча", "female", "f", "woman"].includes(gender);
}

export function edgeDashArray(edge: FamilyTreeEdgeDto): string {
  const relationshipType = String(edge.relationshipType ?? "").toLocaleLowerCase("uk");
  if (edge.kind === "partner" && ["divorced", "separated", "annulled"].includes(relationshipType)) return "14 8 2 8";
  if (["step", "stepfather", "stepmother"].includes(relationshipType)) return "10 5 2 5";
  if (["foster"].includes(relationshipType)) return "2 8";
  if (["unknown", "presumed"].includes(relationshipType)) return "6 8";
  if (edge.style.lineStyle === "dashed") return "10 8";
  if (edge.style.lineStyle === "dotted") return "2 8";
  return "";
}

export function edgeCssClass(edge: FamilyTreeEdgeDto): string {
  return [
    "family-tree-edge",
    `family-tree-edge-${edge.kind}`,
    `family-tree-edge-${edge.style.lineStyle}`,
    edge.style.marker ? `family-tree-edge-${edge.style.marker}` : "",
    edge.style.visibility === "faded" ? "family-tree-edge-faded" : "",
  ].filter(Boolean).join(" ");
}

export function buildFamilyTreeLayoutFamilyUnits(edges: FamilyTreeLayoutEdge[]): FamilyTreeLayoutFamilyUnit[] {
  const childGroups = new Map<
    string,
    {
      key: string;
      children: FamilyTreeLayoutNode[];
      parents: FamilyTreeLayoutNode[];
      edges: FamilyTreeLayoutEdge[];
    }
  >();

  for (const edge of edges) {
    if (edge.edge.kind !== "parent_child") continue;
    const key = [
      edge.edge.toOccurrenceId ?? edge.to.occurrence.id,
      edge.edge.parentSetId ?? edge.edge.familyGroupId ?? "single",
    ].join(":");
    const group = childGroups.get(key) ?? {
      key,
      children: [edge.to],
      parents: [],
      edges: [],
    };
    if (!group.parents.some((parent) => parent.occurrence.id === edge.from.occurrence.id)) {
      group.parents.push(edge.from);
    }
    group.edges.push(edge);
    childGroups.set(key, group);
  }

  const familyGroups = new Map<
    string,
    {
      key: string;
      children: FamilyTreeLayoutNode[];
      parents: FamilyTreeLayoutNode[];
      edges: FamilyTreeLayoutEdge[];
    }
  >();
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
    const familyKey = [
      parentKey,
      `generation:${childGeneration}`,
    ].join(":");
    const group = familyGroups.get(familyKey) ?? {
      key: familyKey,
      children: [],
      parents: [],
      edges: [],
    };
    for (const parent of childGroup.parents) {
      if (!group.parents.some((current) => current.occurrence.id === parent.occurrence.id)) {
        group.parents.push(parent);
      }
    }
    for (const child of childGroup.children) {
      if (!group.children.some((current) => current.occurrence.id === child.occurrence.id)) {
        group.children.push(child);
      }
    }
    group.edges.push(...childGroup.edges);
    familyGroups.set(familyKey, group);
  }

  const units = Array.from(familyGroups.values())
    .map((group) => layoutFamilyUnit(group))
    .filter((unit): unit is FamilyTreeLayoutFamilyUnit => Boolean(unit));

  return assignFamilyUnitRouteLanes(units)
    .sort((left, right) =>
      Math.min(...left.parents.map((parent) => parent.y), ...left.children.map((child) => child.y)) -
        Math.min(...right.parents.map((parent) => parent.y), ...right.children.map((child) => child.y)) ||
      left.unitX - right.unitX ||
      left.key.localeCompare(right.key, "uk"),
    );
}

type FamilyUnitRouteEntry = {
  unit: FamilyTreeLayoutFamilyUnit;
  parentBottomY: number;
  childTopY: number;
  parentInterval: [number, number];
  childInterval: [number, number];
};

function assignFamilyUnitRouteLanes(
  units: FamilyTreeLayoutFamilyUnit[],
): FamilyTreeLayoutFamilyUnit[] {
  const entriesByGap = new Map<string, FamilyUnitRouteEntry[]>();
  for (const unit of units) {
    const parentBottomY = Math.max(...unit.parents.map((parent) => parent.y + parent.height));
    const childTopY = Math.min(...unit.children.map((child) => child.y));
    const entry = {
      unit,
      parentBottomY,
      childTopY,
      parentInterval: familyUnitParentInterval(unit),
      childInterval: familyUnitChildInterval(unit),
    };
    const gapKey = `${Math.round(parentBottomY)}:${Math.round(childTopY)}`;
    const row = entriesByGap.get(gapKey) ?? [];
    row.push(entry);
    entriesByGap.set(gapKey, row);
  }

  const routedUnits: FamilyTreeLayoutFamilyUnit[] = [];
  for (const entries of entriesByGap.values()) {
    const parentLaneIntervals: Array<Array<[number, number]>> = [];
    const childLaneIntervals: Array<Array<[number, number]>> = [];
    const sortedEntries = [...entries].sort((left, right) =>
      left.parentInterval[0] - right.parentInterval[0] ||
      left.childInterval[0] - right.childInterval[0] ||
      left.unit.key.localeCompare(right.unit.key, "uk"),
    );

    for (const entry of sortedEntries) {
      const parentLane = reserveRouteLane(parentLaneIntervals, entry.parentInterval);
      const childLane = reserveRouteLane(childLaneIntervals, entry.childInterval);
      let parentBusY = entry.unit.parents.length > 1
        ? entry.unit.parentBusY
        : routeLaneY(entry.parentBottomY, entry.childTopY, parentLane, "parent");
      let childBusY = routeLaneY(entry.parentBottomY, entry.childTopY, childLane, "child");
      if (childBusY <= parentBusY + 8) {
        const middleY = (entry.parentBottomY + entry.childTopY) / 2;
        if (entry.unit.parents.length <= 1) {
          parentBusY = Math.min(parentBusY, middleY - 5);
        }
        childBusY = Math.max(childBusY, middleY + 5);
      }
      routedUnits.push({
        ...entry.unit,
        parentBusY,
        childBusY,
        parentLane,
        childLane,
        path: familyUnitPath({
          parents: entry.unit.parents,
          children: entry.unit.children,
          unitX: entry.unit.unitX,
          parentBusY,
          childBusY,
        }),
      });
    }
  }

  return routedUnits;
}

function familyUnitParentInterval(unit: FamilyTreeLayoutFamilyUnit): [number, number] {
  const centers = unit.parents.map(nodeCenterX);
  const minX = Math.min(unit.unitX, ...centers);
  const maxX = Math.max(unit.unitX, ...centers);
  return normalizeRouteInterval(minX, maxX);
}

function familyUnitChildInterval(unit: FamilyTreeLayoutFamilyUnit): [number, number] {
  const centers = unit.children.map(nodeCenterX);
  const minX = Math.min(unit.unitX, ...centers);
  const maxX = Math.max(unit.unitX, ...centers);
  return normalizeRouteInterval(minX, maxX);
}

function normalizeRouteInterval(minX: number, maxX: number): [number, number] {
  const padding = 10;
  return [minX - padding, maxX + padding];
}

function reserveRouteLane(
  lanes: Array<Array<[number, number]>>,
  interval: [number, number],
): number {
  const margin = 12;
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
    if (lanes[laneIndex].every((taken) => interval[1] + margin <= taken[0] || taken[1] + margin <= interval[0])) {
      lanes[laneIndex].push(interval);
      return laneIndex;
    }
  }
  lanes.push([interval]);
  return lanes.length - 1;
}

function routeLaneY(
  parentBottomY: number,
  childTopY: number,
  lane: number,
  side: "parent" | "child",
): number {
  const gap = childTopY - parentBottomY;
  if (gap <= 0) return side === "parent" ? parentBottomY + lane * 10 : childTopY - lane * 10;
  const edgePadding = Math.min(22, Math.max(10, gap * 0.22));
  const laneStep = Math.max(8, Math.min(16, gap * 0.16));
  const top = parentBottomY + edgePadding;
  const bottom = childTopY - edgePadding;
  return side === "parent"
    ? Math.min(top + lane * laneStep, bottom)
    : Math.max(bottom - lane * laneStep, top);
}

function layoutFamilyUnit(group: {
  key: string;
  children: FamilyTreeLayoutNode[];
  parents: FamilyTreeLayoutNode[];
  edges: FamilyTreeLayoutEdge[];
}): FamilyTreeLayoutFamilyUnit | null {
  const children = [...group.children].sort((left, right) => nodeCenterX(left) - nodeCenterX(right));
  const parents = sortFamilyUnitParents(group.parents, group.edges);
  if (!parents.length || !children.length) return null;

  const childTop = Math.min(...children.map((child) => child.y));
  const parentLineY = parents.length > 1
    ? average(parents.map((parent) => parent.y + parent.height / 2))
    : Math.max(...parents.map((parent) => parent.y + parent.height));
  const rawGap = childTop - parentLineY;
  const gap = Math.max(64, rawGap);
  const parentBusY = parents.length > 1
    ? parentLineY
    : parentLineY + Math.min(42, Math.max(22, gap * 0.28));
  const childBusY = children.length > 1
    ? Math.max(parentBusY + 18, Math.min(childTop - 28, parentLineY + gap * 0.68))
    : childTop;
  const firstParent = parents[0];
  const lastParent = parents[parents.length - 1];
  const unitX = parents.length > 1
    ? (nodeCenterX(firstParent) + nodeCenterX(lastParent)) / 2
    : nodeCenterX(firstParent);
  const representative = group.edges[0];

  return {
    key: group.key,
    parentOccurrenceIds: parents.map((parent) => parent.occurrence.id),
    childOccurrenceIds: children.map((child) => child.occurrence.id),
    parents,
    children,
    edges: group.edges,
    unitX,
    parentBusY,
    childBusY,
    path: familyUnitPath({ parents, children, unitX, parentBusY, childBusY }),
    dashArray: representative?.dashArray ?? "",
    opacity: Math.min(...group.edges.map((edge) => edge.opacity)),
  };
}

function familyUnitPath(input: {
  parents: FamilyTreeLayoutNode[];
  children: FamilyTreeLayoutNode[];
  unitX: number;
  parentBusY: number;
  childBusY: number;
}): string {
  const paths: string[] = [];
  if (input.parents.length > 1) {
    const first = input.parents[0];
    const last = input.parents[input.parents.length - 1];
    const fromX = first.x + first.width;
    const toX = last.x;
    if (fromX <= toX) {
      paths.push(`M ${fromX} ${input.parentBusY} H ${toX}`);
    } else {
      paths.push(`M ${nodeCenterX(first)} ${input.parentBusY} H ${nodeCenterX(last)}`);
    }
  } else if (input.parents[0]) {
    const parent = input.parents[0];
    paths.push(`M ${nodeCenterX(parent)} ${parent.y + parent.height} V ${input.parentBusY}`);
  }

  if (input.children.length === 1) {
    const child = input.children[0];
    const childX = nodeCenterX(child);
    paths.push(roundedVerticalBranchPath(input.unitX, input.parentBusY, childX, child.y));
    return paths.join(" ");
  }

  paths.push(roundedVerticalBranchPath(input.unitX, input.parentBusY, input.unitX, input.childBusY));
  const childBusStartX = Math.min(input.unitX, nodeCenterX(input.children[0]));
  const childBusEndX = Math.max(input.unitX, nodeCenterX(input.children[input.children.length - 1]));
  paths.push(`M ${childBusStartX} ${input.childBusY} H ${childBusEndX}`);
  for (const child of input.children) {
    paths.push(roundedVerticalBranchPath(nodeCenterX(child), input.childBusY, nodeCenterX(child), child.y));
  }
  return paths.join(" ");
}

function roundedVerticalBranchPath(startX: number, startY: number, endX: number, endY: number): string {
  if (Math.abs(startX - endX) < 0.001) return `M ${startX} ${startY} V ${endY}`;
  const radius = Math.min(18, Math.abs(endX - startX) / 2, Math.abs(endY - startY) / 2);
  if (radius <= 1) return `M ${startX} ${startY} H ${endX} V ${endY}`;
  const directionX = endX > startX ? 1 : -1;
  const directionY = endY > startY ? 1 : -1;
  const beforeTurnY = endY - directionY * radius;
  const beforeTurnX = endX - directionX * radius;
  return [
    `M ${startX} ${startY}`,
    `V ${beforeTurnY}`,
    `Q ${startX} ${endY} ${beforeTurnX} ${endY}`,
    `H ${endX}`,
  ].join(" ");
}

function sortFamilyUnitParents(
  parents: FamilyTreeLayoutNode[],
  edges: FamilyTreeLayoutEdge[],
): FamilyTreeLayoutNode[] {
  const roleSideByOccurrence = new Map<string, number>();
  for (const edge of edges) {
    if (edge.edge.kind !== "parent_child") continue;
    const role = String(edge.edge.parentRoleLabel ?? edge.edge.metadata?.parentRoleLabel ?? edge.edge.metadata?.parent_role_label ?? "")
      .toLocaleLowerCase("uk");
    if (isFatherRole(role)) roleSideByOccurrence.set(edge.from.occurrence.id, 0);
    else if (isMotherRole(role)) roleSideByOccurrence.set(edge.from.occurrence.id, 1);
    else if (isMaleGender(edge.from.person.gender)) roleSideByOccurrence.set(edge.from.occurrence.id, 0);
    else if (isFemaleGender(edge.from.person.gender)) roleSideByOccurrence.set(edge.from.occurrence.id, 1);
  }
  return [...parents].sort((left, right) => {
    const leftSide = roleSideByOccurrence.get(left.occurrence.id);
    const rightSide = roleSideByOccurrence.get(right.occurrence.id);
    if (leftSide !== undefined && rightSide !== undefined && leftSide !== rightSide) return leftSide - rightSide;
    if (leftSide !== undefined && rightSide === undefined) return -1;
    if (leftSide === undefined && rightSide !== undefined) return 1;
    return nodeCenterX(left) - nodeCenterX(right);
  });
}

function nodeCenterX(node: FamilyTreeLayoutNode): number {
  return node.x + node.width / 2;
}

export function visibleStandaloneFamilyTreeEdges(edges: FamilyTreeLayoutEdge[]): FamilyTreeLayoutEdge[] {
  const parentPairsWithChildren = parentOccurrencePairsWithVisibleChildren(edges);
  return edges.filter((edge) => {
    if (edge.edge.kind === "parent_child") return false;
    if (edge.edge.kind !== "partner") return true;
    const pairKey = occurrencePairKey(edge.edge.fromOccurrenceId, edge.edge.toOccurrenceId);
    return !pairKey || !parentPairsWithChildren.has(pairKey);
  });
}

function parentOccurrencePairsWithVisibleChildren(edges: FamilyTreeLayoutEdge[]): Set<string> {
  const parentGroups = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.edge.kind !== "parent_child") continue;
    const childOccurrenceId = edge.edge.toOccurrenceId ?? edge.to.occurrence.id;
    const parentOccurrenceId = edge.edge.fromOccurrenceId ?? edge.from.occurrence.id;
    const groupKey = [
      edge.edge.familyGroupId ? `family:${edge.edge.familyGroupId}` : edge.edge.parentSetId ? `parent-set:${edge.edge.parentSetId}` : `child:${childOccurrenceId}`,
      childOccurrenceId,
    ].join(":");
    const group = parentGroups.get(groupKey) ?? new Set<string>();
    group.add(parentOccurrenceId);
    parentGroups.set(groupKey, group);
  }

  const pairs = new Set<string>();
  for (const group of parentGroups.values()) {
    const parents = Array.from(group).sort();
    for (let left = 0; left < parents.length; left += 1) {
      for (let right = left + 1; right < parents.length; right += 1) {
        const pairKey = occurrencePairKey(parents[left], parents[right]);
        if (pairKey) pairs.add(pairKey);
      }
    }
  }
  return pairs;
}

function occurrencePairKey(first?: string | null, second?: string | null): string {
  if (!first || !second) return "";
  return [first, second].sort().join("|");
}

function edgePath(
  edge: FamilyTreeEdgeDto,
  from: FamilyTreeLayoutNode,
  to: FamilyTreeLayoutNode,
): string {
  const fromCenterX = from.x + from.width / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + to.width / 2;
  const toCenterY = to.y + to.height / 2;

  if (edge.kind === "partner") {
    const fromLeft = fromCenterX <= toCenterX;
    const startX = fromLeft ? from.x + from.width : from.x;
    const endX = fromLeft ? to.x : to.x + to.width;
    return `M ${startX} ${fromCenterY} H ${endX}`;
  }

  if (edge.kind === "association") {
    const controlY = Math.min(fromCenterY, toCenterY) - 55;
    return `M ${fromCenterX} ${fromCenterY} Q ${(fromCenterX + toCenterX) / 2} ${controlY} ${toCenterX} ${toCenterY}`;
  }

  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${fromCenterX} ${startY} V ${midY} H ${toCenterX} V ${endY}`;
}

export function resolveNodeBadges(
  graph: FamilyTreeGraphDto,
  node: FamilyTreeNodeDto,
  occurrence: FamilyTreeOccurrenceDto,
): FamilyTreeNodeBadge[] {
  const badges = new Set<FamilyTreeNodeBadge>();
  const relatedIssues = graph.issues.filter((issue) => issueTargetsNode(issue, node, occurrence));
  if (graph.rootPersonId === node.personId) badges.add("root");
  if (occurrence.generation < 0) badges.add("directAncestor");
  if (occurrence.generation > 0) badges.add("directDescendant");
  if (occurrence.generation === 0 && graph.rootPersonId !== node.personId) badges.add("sideBranch");
  if (node.occurrenceIds.length > 1 || occurrence.isRepeated) badges.add("multipleOccurrences");
  if (hasMultipleParentSets(graph, node.personId)) badges.add("multipleParentSets");
  if (node.redacted || node.isLiving) badges.add("private");
  if (hasSources(node)) badges.add("hasSources");
  if (relatedIssues.length) badges.add("needsReview");
  if (relatedIssues.some((issue) => issue.code === "potentialDuplicatePerson")) badges.add("potentialDuplicate");
  if (isImportedFromGedcom(node)) badges.add("importedFromGedcom");
  return Array.from(badges);
}

function hasMultipleParentSets(graph: FamilyTreeGraphDto, personId: string): boolean {
  const parentSetIds = new Set<string>();
  for (const group of graph.groups) {
    if (!group.childIds.includes(personId)) continue;
    group.parentSetIds.forEach((id) => parentSetIds.add(id));
  }
  return parentSetIds.size > 1;
}

function issueTargetsNode(
  issue: FamilyTreeIssueDto,
  node: FamilyTreeNodeDto,
  occurrence: FamilyTreeOccurrenceDto,
): boolean {
  return issue.personIds.includes(node.personId) || issue.occurrenceIds.includes(occurrence.id);
}

function hasSources(node: FamilyTreeNodeDto): boolean {
  return node.names.some((name) => name.sourceDocumentId || name.sourceFindingId) ||
    node.events.some((event) => event.sourceDocumentId || event.sourceFindingId);
}

function isImportedFromGedcom(node: FamilyTreeNodeDto): boolean {
  const values = [
    node.primaryName?.metadata?.source,
    node.primaryName?.metadata?.importedFrom,
    ...node.events.map((event) => event.metadata?.source),
  ];
  return values.some((value) => String(value ?? "").toLocaleLowerCase("uk").includes("gedcom"));
}

function compareOccurrenceNodes(
  left: { occurrence: FamilyTreeOccurrenceDto; person: FamilyTreeNodeDto },
  right: { occurrence: FamilyTreeOccurrenceDto; person: FamilyTreeNodeDto },
): number {
  const leftPath = left.occurrence.path.join(">");
  const rightPath = right.occurrence.path.join(">");
  if (left.occurrence.depth !== right.occurrence.depth) {
    return left.occurrence.depth - right.occurrence.depth;
  }
  const byPath = leftPath.localeCompare(rightPath, "uk");
  if (byPath !== 0) return byPath;
  return left.person.displayName.localeCompare(right.person.displayName, "uk");
}

function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = result.get(key) ?? [];
    group.push(item);
    result.set(key, group);
  }
  return result;
}
