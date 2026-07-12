import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../types/familyTree";
import type {
  FamilyTreeNodeBadge,
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutNode,
  FamilyTreeLayoutPlaceholder,
  FamilyTreeViewerLayoutOptions,
  FamilyTreeViewerLayout,
} from "./familyTreeViewerLayout";
import {
  buildFamilyTreeLayoutFamilyUnits,
  edgeDashArray,
  resolveNodeBadges,
} from "./familyTreeViewerLayout.ts";
import { buildPedigreeViewerLayout } from "./familyTreePedigreeLayout.ts";
import {
  emptyFamilyTreeRelationFlags,
  familyTreeRelationFlagsByPerson,
} from "./familyTreeActions.ts";

export type FamilyGridBlockKind = "person" | "union" | "placeholder";

export type FamilyGridBlock = {
  id: string;
  kind: FamilyGridBlockKind;
  row: number;
  column: number;
  occurrenceId?: string;
  familyUnitKey?: string;
  placeholderId?: string;
  subtreeWidth: number;
  reservedLeftWidth: number;
  reservedRightWidth: number;
  centerX: number;
  centerY: number;
};

export type NormalizedFamilyUnit = {
  key: string;
  parentOccurrenceIds: string[];
  childOccurrenceIds: string[];
  parentSetId: string | null;
  familyGroupId: string | null;
  edges: FamilyTreeEdgeDto[];
};

export type NormalizedFamilyGridGraph = {
  peopleById: Map<string, FamilyTreeNodeDto>;
  occurrenceById: Map<string, FamilyTreeOccurrenceDto>;
  parentChildRelations: FamilyTreeEdgeDto[];
  partnerRelations: FamilyTreeEdgeDto[];
  familyUnits: NormalizedFamilyUnit[];
  childrenByFamilyUnit: Map<string, string[]>;
  parentFamilyByChild: Map<string, NormalizedFamilyUnit>;
  spouseFamiliesByPerson: Map<string, NormalizedFamilyUnit[]>;
};

export type FamilyGridLayoutModel = {
  graph: NormalizedFamilyGridGraph;
  blocks: FamilyGridBlock[];
};

type OccurrenceLayoutItem = {
  occurrence: FamilyTreeOccurrenceDto;
  person: FamilyTreeNodeDto;
};

type FamilyGridLayoutOptions = {
  nodeWidth: number;
  nodeHeight: number;
  horizontalSpacing: number;
  verticalSpacing: number;
  padding: number;
  strategy?: "block-grid" | "legacy-compatible";
  resolveNodeBadges: (
    graph: FamilyTreeGraphDto,
    node: FamilyTreeNodeDto,
    occurrence: FamilyTreeOccurrenceDto,
  ) => FamilyTreeNodeBadge[];
};

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 88;
const DEFAULT_HORIZONTAL_SPACING = 150;
const DEFAULT_VERTICAL_SPACING = 132;
const DEFAULT_PADDING = 52;

export function buildFamilyTreeBlockGridLayout(
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
    .filter((item): item is OccurrenceLayoutItem => Boolean(item));

  if (!occurrenceNodes.length) return emptyFamilyGridLayout();

  const rootItem = occurrenceNodes.find((item) => item.person.personId === graph.rootPersonId && item.occurrence.generation === 0) ??
    occurrenceNodes.find((item) => item.person.personId === graph.rootPersonId) ??
    occurrenceNodes.find((item) => item.occurrence.generation === 0) ??
    occurrenceNodes[0];

  return buildFamilyGridViewerLayout(graph, occurrenceNodes, rootItem, {
    nodeWidth,
    nodeHeight,
    horizontalSpacing,
    verticalSpacing,
    padding,
    strategy: "block-grid",
    resolveNodeBadges,
  });
}

function emptyFamilyGridLayout(): FamilyTreeViewerLayout {
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

export function buildFamilyGridViewerLayout(
  graph: FamilyTreeGraphDto,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  options: FamilyGridLayoutOptions,
): FamilyTreeViewerLayout {
  const normalized = normalizeFamilyGridGraph(graph);
  const layout = options.strategy === "block-grid"
    ? buildNativeFamilyGridViewerLayout(graph, normalized, occurrenceNodes, rootItem, options)
    : buildLegacyCompatibleGridViewerLayout(graph, normalized, occurrenceNodes, rootItem, options) ??
      buildPedigreeViewerLayout(graph, occurrenceNodes, rootItem, options);
  const placeholders = buildFamilyGridPlaceholders(graph, layout, options);
  const layoutWithPlaceholders = withPlaceholderBounds({
    ...layout,
    placeholders,
  }, placeholders, options.padding);
  buildFamilyGridLayoutModel(normalized, layoutWithPlaceholders);
  return layoutWithPlaceholders;
}

function buildLegacyCompatibleGridViewerLayout(
  graph: FamilyTreeGraphDto,
  normalized: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  options: FamilyGridLayoutOptions,
): FamilyTreeViewerLayout | null {
  if (graph.edges.some((edge) => edge.kind !== "parent_child" && edge.kind !== "partner")) return null;
  if (!supportsNativeFocusGrid(normalized, occurrenceNodes, rootItem)) return null;
  return buildNativeFamilyGridViewerLayout(graph, normalized, occurrenceNodes, rootItem, options);
}

function buildNativeFamilyGridViewerLayout(
  graph: FamilyTreeGraphDto,
  normalized: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  options: FamilyGridLayoutOptions,
): FamilyTreeViewerLayout {
  const positions = nativeFocusGridPositions(normalized, occurrenceNodes, rootItem, options);

  const nodes = occurrenceNodes
    .map((item) => {
      const position = positions.get(item.occurrence.id);
      if (!position) return null;
      return {
        occurrence: item.occurrence,
        person: item.person,
        x: position.x,
        y: position.y,
        width: options.nodeWidth,
        height: options.nodeHeight,
        badges: options.resolveNodeBadges(graph, item.person, item.occurrence),
      };
    })
    .filter((node): node is FamilyTreeLayoutNode => Boolean(node))
    .sort((left, right) => left.y - right.y || left.x - right.x || left.occurrence.id.localeCompare(right.occurrence.id, "uk"));

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
        path: gridEdgePath(edge, from, to),
        dashArray: edgeDashArray(edge),
        opacity: edge.style.visibility === "faded" ? 0.32 : 1,
      };
    })
    .filter((edge): edge is FamilyTreeLayoutEdge => Boolean(edge));
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    nodes,
    edges,
    familyUnits,
    width: Math.max(720, maxX - minX + options.padding * 2),
    height: Math.max(420, maxY - minY + options.padding * 2),
    minX: minX - options.padding,
    minY: minY - options.padding,
    maxX: maxX + options.padding,
    maxY: maxY + options.padding,
    rootOccurrenceId: rootItem.occurrence.id,
  };
}

function supportsNativeFocusGrid(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
): boolean {
  const rootOccurrenceId = rootItem.occurrence.id;
  const supportedOccurrenceIds = new Set<string>([rootOccurrenceId]);
  collectAncestorOccurrenceIds(graph, rootOccurrenceId, supportedOccurrenceIds);

  for (const unit of graph.spouseFamiliesByPerson.get(rootOccurrenceId) ?? []) {
    for (const parentId of unit.parentOccurrenceIds) supportedOccurrenceIds.add(parentId);
    for (const childId of unit.childOccurrenceIds) supportedOccurrenceIds.add(childId);
  }

  for (const edge of graph.partnerRelations) {
    if (edge.fromOccurrenceId === rootOccurrenceId && edge.toOccurrenceId) supportedOccurrenceIds.add(edge.toOccurrenceId);
    if (edge.toOccurrenceId === rootOccurrenceId && edge.fromOccurrenceId) supportedOccurrenceIds.add(edge.fromOccurrenceId);
  }

  collectExpandedSideBranchOccurrenceIds(occurrenceNodes, supportedOccurrenceIds);

  if (occurrenceNodes.some((item) => !supportedOccurrenceIds.has(item.occurrence.id))) return false;
  for (const edge of [...graph.parentChildRelations, ...graph.partnerRelations]) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) return false;
    if (!supportedOccurrenceIds.has(edge.fromOccurrenceId) || !supportedOccurrenceIds.has(edge.toOccurrenceId)) return false;
  }
  return true;
}

function collectExpandedSideBranchOccurrenceIds(
  occurrenceNodes: OccurrenceLayoutItem[],
  supportedOccurrenceIds: Set<string>,
) {
  const expandedAnchors = occurrenceNodes
    .filter((item) => item.occurrence.sideBranchesExpanded && supportedOccurrenceIds.has(item.occurrence.id));
  for (const anchor of expandedAnchors) {
    for (const item of occurrenceNodes) {
      if (supportedOccurrenceIds.has(item.occurrence.id)) continue;
      if (item.occurrence.path.includes(anchor.person.personId)) supportedOccurrenceIds.add(item.occurrence.id);
    }
  }
}

function collectAncestorOccurrenceIds(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  supportedOccurrenceIds: Set<string>,
  visited = new Set<string>(),
) {
  if (visited.has(occurrenceId)) return;
  visited.add(occurrenceId);
  const familyUnit = graph.parentFamilyByChild.get(occurrenceId);
  if (!familyUnit) return;
  for (const parentId of familyUnit.parentOccurrenceIds) {
    supportedOccurrenceIds.add(parentId);
    collectAncestorOccurrenceIds(graph, parentId, supportedOccurrenceIds, visited);
  }
}

function nativeFocusGridPositions(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing" | "horizontalSpacing">,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const rootOccurrenceId = rootItem.occurrence.id;
  positions.set(rootOccurrenceId, { x: 0, y: 0 });

  const rootCenterX = options.nodeWidth / 2;
  const templateGap = familyTreeTemplateGap(options);
  const parentGap = templateGap;
  const partnerGap = templateGap;
  const siblingGap = Math.max(18, options.horizontalSpacing * 0.12);
  const allOccurrenceIds = new Set(occurrenceNodes.map((item) => item.occurrence.id));
  const directAncestorIds = placeDirectAncestorSlots(
    graph,
    rootOccurrenceId,
    positions,
    options,
    parentGap,
  );
  if (directAncestorIds.size <= 1) {
    placeAncestorParents(
      graph,
      rootOccurrenceId,
      rootCenterX,
      0,
      positions,
      options,
      parentGap,
      0,
      new Map(),
      new Set(),
      true,
    );
  }
  const backbonePositions = snapshotBackbonePositions(graph, rootOccurrenceId, positions);

  const descendantBlock = buildFamilyDescendantBlock(
    graph,
    rootOccurrenceId,
    allOccurrenceIds,
    options,
    partnerGap,
    siblingGap,
    true,
    new Set(),
  );
  const rootLocalPosition = descendantBlock.positions.get(rootOccurrenceId);
  if (rootLocalPosition) {
    const deltaX = -rootLocalPosition.x;
    for (const [occurrenceId, point] of descendantBlock.positions.entries()) {
      const existing = positions.get(occurrenceId);
      if (existing && occurrenceId !== rootOccurrenceId) continue;
      positions.set(occurrenceId, { x: point.x + deltaX, y: point.y });
    }
  }
  const placedRootPartnerIds = new Set<string>(
    [...descendantBlock.positions.keys()].filter((occurrenceId) => occurrenceId !== rootOccurrenceId),
  );
  const rootRowBounds = placedRowBounds(positions, 0, options);
  placeStandaloneRootPartners(graph, rootOccurrenceId, positions, placedRootPartnerIds, {
    rightCursor: (rootRowBounds?.maxX ?? options.nodeWidth) + partnerGap,
    leftCursor: (rootRowBounds?.minX ?? 0) - options.nodeWidth - partnerGap,
    nodeWidth: options.nodeWidth,
    partnerGap,
  });
  placeExpandedSideBranches(graph, occurrenceNodes, rootItem, positions, options);
  alignPlacedFamilyUnionsToChildren(graph, occurrenceNodes, positions, options);
  placeUnplacedFamilyChildrenNearParents(graph, occurrenceNodes, positions, options, partnerGap, siblingGap);
  alignPlacedFamilyUnionsToChildren(graph, occurrenceNodes, positions, options);
  placeRemainingGridOccurrences(graph, occurrenceNodes, rootItem, positions, options);
  const flexibleBackboneIds = opposedExpandedBackboneAnchorIds(
    graph,
    occurrenceNodes,
    rootItem,
    positions,
    options,
  );
  restoreBackbonePositions(backbonePositions, positions, flexibleBackboneIds);
  const protectedOccurrenceIds = directBackboneOccurrenceIds(graph, rootOccurrenceId);
  enforceFamilyPartnerRows(graph, rootOccurrenceId, protectedOccurrenceIds, positions, options, partnerGap);
  realignDetachedFamilyChildrenToUnion(graph, rootOccurrenceId, protectedOccurrenceIds, positions, options, siblingGap);
  compactGlobalWhitespaceTowardBackbone(graph, rootOccurrenceId, protectedOccurrenceIds, positions, options, siblingGap);
  restoreBackbonePositions(backbonePositions, positions, flexibleBackboneIds);
  return positions;
}

function familyTreeTemplateGap(
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "horizontalSpacing">,
): number {
  return Math.max(28, Math.round(Math.min(options.nodeWidth * 0.16, options.horizontalSpacing * 0.18)));
}

type DirectAncestorSlot = {
  occurrenceId: string;
  depth: number;
  index: number;
};

const DIRECT_ANCESTOR_TEMPLATE_NODE_WIDTH = 180;
const DIRECT_ANCESTOR_TEMPLATE_PAIR_GAP = 28;
const DIRECT_ANCESTOR_TEMPLATE_STEP = DIRECT_ANCESTOR_TEMPLATE_NODE_WIDTH + DIRECT_ANCESTOR_TEMPLATE_PAIR_GAP;
const DIRECT_ANCESTOR_TEMPLATE_X: Record<number, number[]> = {
  2: [-1768.5, -1560.5, 906.3, 1114.3],
  3: [-2773.3, -2565.3, -940.9, -732.9, 592.7, 800.7, 1634.9, 1842.9],
  4: [
    -3015.6,
    -2807.6,
    -2185.7,
    -1977.7,
    -1350.5,
    -1142.5,
    -522.1,
    -314.1,
    310,
    518,
    805.4,
    1013.4,
    1329.4,
    1537.4,
    2051.9,
    2259.9,
  ],
};

function placeDirectAncestorSlots(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "verticalSpacing">,
  partnerGap: number,
): Set<string> {
  const slots: DirectAncestorSlot[] = [{ occurrenceId: rootOccurrenceId, depth: 0, index: 0 }];
  const visited = new Set<string>();
  for (let cursor = 0; cursor < slots.length; cursor += 1) {
    const slot = slots[cursor];
    if (visited.has(slot.occurrenceId)) continue;
    visited.add(slot.occurrenceId);
    const familyUnit = graph.parentFamilyByChild.get(slot.occurrenceId);
    if (!familyUnit) continue;
    for (const parentId of orderedParentOccurrenceIds(familyUnit)) {
      const parentSide = parentSideForOccurrenceInGraph(parentId, familyUnit, graph);
      const parentIndex = slot.index * 2 + (parentSide === 1 ? 1 : 0);
      slots.push({
        occurrenceId: parentId,
        depth: slot.depth + 1,
        index: parentIndex,
      });
    }
  }

  const rootCenterX = options.nodeWidth / 2;
  const slotStep = options.nodeWidth + partnerGap;
  const placed = new Set<string>();
  const positionByDepthIndex = directAncestorTemplatePositions(slots, options, partnerGap);
  for (const slot of slots) {
    const templateX = positionByDepthIndex.get(directAncestorSlotKey(slot.depth, slot.index));
    const slotsInRow = 2 ** slot.depth;
    const centerX = templateX === undefined
      ? rootCenterX + (slot.index - (slotsInRow - 1) / 2) * slotStep
      : templateX + options.nodeWidth / 2;
    positions.set(slot.occurrenceId, {
      x: normalizeZero(centerX - options.nodeWidth / 2),
      y: normalizeZero(-slot.depth * options.verticalSpacing),
    });
    placed.add(slot.occurrenceId);
  }
  return placed;
}

function directAncestorTemplatePositions(
  slots: DirectAncestorSlot[],
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
  partnerGap: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const rows = new Map<number, DirectAncestorSlot[]>();
  for (const slot of slots) {
    const row = rows.get(slot.depth) ?? [];
    row.push(slot);
    rows.set(slot.depth, row);
  }
  const maxDepth = Math.max(...slots.map((slot) => slot.depth));
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const row = [...(rows.get(depth) ?? [])].sort((left, right) => left.index - right.index);
    if (!row.length) continue;
    if (depth <= 4) {
      for (const slot of row) {
        result.set(directAncestorSlotKey(slot.depth, slot.index), directAncestorTemplateX(slot.depth, slot.index, options, partnerGap));
      }
      continue;
    }
    const expanded = expandDirectAncestorTemplateRow(row, result, options.nodeWidth + partnerGap);
    for (const [index, x] of expanded.entries()) result.set(directAncestorSlotKey(depth, index), x);
  }
  return result;
}

function expandDirectAncestorTemplateRow(
  row: DirectAncestorSlot[],
  previousPositions: Map<string, number>,
  slotStep: number,
): Map<number, number> {
  const rowCount = 2 ** row[0].depth;
  const sideCount = rowCount / 2;
  const raw = row.map((slot) => {
    const childIndex = Math.floor(slot.index / 2);
    const childX = previousPositions.get(directAncestorSlotKey(slot.depth - 1, childIndex));
    const childIsLeftSpouse = childIndex % 2 === 0;
    const parentIsFather = slot.index % 2 === 0;
    const fallbackSide = slot.index < sideCount ? -1 : 1;
    const x = childX === undefined
      ? fallbackSide * (Math.abs(slot.index - sideCount + 0.5) + 1) * slotStep
      : childIsLeftSpouse
        ? childX + (parentIsFather ? -slotStep : 0)
        : childX + (parentIsFather ? 0 : slotStep);
    return { index: slot.index, x };
  });
  const packed = new Map<number, number>();
  packDirectAncestorSide(
    raw.filter((slot) => slot.index < sideCount),
    -slotStep,
    -1,
    slotStep,
    packed,
  );
  packDirectAncestorSide(
    raw.filter((slot) => slot.index >= sideCount),
    slotStep,
    1,
    slotStep,
    packed,
  );
  return packed;
}

function packDirectAncestorSide(
  row: Array<{ index: number; x: number }>,
  startCursor: number,
  direction: -1 | 1,
  slotStep: number,
  result: Map<number, number>,
) {
  const sorted = [...row].sort((left, right) => direction === -1 ? right.index - left.index : left.index - right.index);
  let cursor = startCursor;
  for (const slot of sorted) {
    const x = direction === -1 ? Math.min(slot.x, cursor) : Math.max(slot.x, cursor);
    result.set(slot.index, roundLayout(x));
    cursor = x + direction * slotStep;
  }
}

function directAncestorSlotKey(depth: number, index: number): string {
  return `${depth}:${index}`;
}

function directAncestorTemplateX(
  depth: number,
  index: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
  partnerGap: number,
): number {
  if (depth <= 0) return 0;
  if (depth === 1) {
    const pairWidth = options.nodeWidth * 2 + partnerGap;
    const rootCenterX = options.nodeWidth / 2;
    return index === 0 ? rootCenterX - pairWidth / 2 : rootCenterX + partnerGap / 2;
  }

  const templateRow = DIRECT_ANCESTOR_TEMPLATE_X[depth];
  const scale = (options.nodeWidth + partnerGap) / DIRECT_ANCESTOR_TEMPLATE_STEP;
  if (templateRow && Number.isFinite(templateRow[index])) return roundLayout(templateRow[index] * scale);

  const sideCount = 2 ** (depth - 1);
  const sideIndex = index % sideCount;
  const slotStep = options.nodeWidth + partnerGap;
  if (index < sideCount) return roundLayout(-(sideCount - sideIndex) * slotStep);
  return roundLayout((sideIndex + 1) * slotStep);
}

function parentSideForOccurrenceInGraph(
  occurrenceId: string,
  familyUnit: NormalizedFamilyUnit,
  graph: NormalizedFamilyGridGraph,
): number {
  const roleSide = parentSideForOccurrence(occurrenceId, familyUnit.edges);
  if (roleSide < 2) return roleSide;
  const occurrence = graph.occurrenceById.get(occurrenceId);
  const gender = occurrence ? graph.peopleById.get(occurrence.personId)?.gender : undefined;
  const side = genderSideOrNull(gender);
  if (side === -1) return 0;
  if (side === 1) return 1;
  return roleSide;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function roundLayout(value: number): number {
  return Math.round(value * 10) / 10;
}

type FamilyDescendantBlock = {
  width: number;
  positions: Map<string, { x: number; y: number }>;
};

function buildFamilyDescendantBlock(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  allowedOccurrenceIds: Set<string>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "verticalSpacing">,
  partnerGap: number,
  siblingGap: number,
  anchorFirst: boolean,
  visiting: Set<string>,
): FamilyDescendantBlock {
  if (visiting.has(occurrenceId)) {
    return {
      width: options.nodeWidth,
      positions: new Map([[occurrenceId, { x: 0, y: 0 }]]),
    };
  }
  visiting.add(occurrenceId);

  const unit = primaryDescendantFamilyForBlock(graph, occurrenceId, allowedOccurrenceIds);
  if (!unit) {
    visiting.delete(occurrenceId);
    return {
      width: options.nodeWidth,
      positions: new Map([[occurrenceId, { x: 0, y: 0 }]]),
    };
  }

  const parentIds = orderedFamilyBlockParents(unit, occurrenceId, anchorFirst)
    .filter((parentId) => allowedOccurrenceIds.has(parentId));
  const childIds = unit.childOccurrenceIds
    .filter((childId) => allowedOccurrenceIds.has(childId) && isDescendantOccurrence(graph, occurrenceId, childId));
  const childBlocks = childIds.map((childId) => ({
    occurrenceId: childId,
    block: buildFamilyDescendantBlock(
      graph,
      childId,
      allowedOccurrenceIds,
      options,
      partnerGap,
      siblingGap,
      false,
      new Set(visiting),
    ),
  }));

  const parentRowWidth = Math.max(
    options.nodeWidth,
    parentIds.length * options.nodeWidth + Math.max(0, parentIds.length - 1) * partnerGap,
  );
  const childRowWidth = childBlocks.length
    ? childBlocks.reduce((sum, item) => sum + item.block.width, 0) + Math.max(0, childBlocks.length - 1) * siblingGap
    : 0;
  const width = Math.max(parentRowWidth, childRowWidth, options.nodeWidth);
  const positions = new Map<string, { x: number; y: number }>();
  const rootOccurrence = graph.occurrenceById.get(occurrenceId);
  const rootGeneration = rootOccurrence?.generation ?? 0;

  let parentCursor = (width - parentRowWidth) / 2;
  for (const parentId of parentIds) {
    const parentOccurrence = graph.occurrenceById.get(parentId);
    positions.set(parentId, {
      x: parentCursor,
      y: ((parentOccurrence?.generation ?? rootGeneration) - rootGeneration) * options.verticalSpacing,
    });
    parentCursor += options.nodeWidth + partnerGap;
  }

  let childCursor = (width - childRowWidth) / 2;
  for (const { occurrenceId: childId, block } of childBlocks) {
    const childOccurrence = graph.occurrenceById.get(childId);
    const childY = ((childOccurrence?.generation ?? rootGeneration + 1) - rootGeneration) * options.verticalSpacing;
    for (const [localOccurrenceId, point] of block.positions.entries()) {
      if (positions.has(localOccurrenceId)) continue;
      positions.set(localOccurrenceId, {
        x: childCursor + point.x,
        y: childY + point.y,
      });
    }
    childCursor += block.width + siblingGap;
  }

  if (!positions.has(occurrenceId)) positions.set(occurrenceId, { x: (width - options.nodeWidth) / 2, y: 0 });
  visiting.delete(occurrenceId);
  return { width, positions };
}

function primaryDescendantFamilyForBlock(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  allowedOccurrenceIds: Set<string>,
): NormalizedFamilyUnit | null {
  return descendantFamiliesForOccurrence(graph, occurrenceId)
    .filter((unit) => unit.parentOccurrenceIds.includes(occurrenceId))
    .filter((unit) => unit.childOccurrenceIds.some((childId) =>
      allowedOccurrenceIds.has(childId) && isDescendantOccurrence(graph, occurrenceId, childId),
    ))
    .sort((left, right) =>
      right.parentOccurrenceIds.filter((id) => allowedOccurrenceIds.has(id)).length -
        left.parentOccurrenceIds.filter((id) => allowedOccurrenceIds.has(id)).length ||
      right.childOccurrenceIds.filter((id) => allowedOccurrenceIds.has(id)).length -
        left.childOccurrenceIds.filter((id) => allowedOccurrenceIds.has(id)).length ||
      left.childOccurrenceIds.join("|").localeCompare(right.childOccurrenceIds.join("|"), "uk") ||
      left.key.localeCompare(right.key, "uk"),
    )[0] ?? null;
}

function orderedFamilyBlockParents(
  unit: NormalizedFamilyUnit,
  anchorOccurrenceId: string,
  anchorFirst: boolean,
): string[] {
  const ordered = orderedParentOccurrenceIds(unit);
  if (!anchorFirst || hasDirectionalParentOrder(unit)) return ordered;
  return [
    anchorOccurrenceId,
    ...ordered.filter((occurrenceId) => occurrenceId !== anchorOccurrenceId),
  ];
}

function hasDirectionalParentOrder(unit: NormalizedFamilyUnit): boolean {
  return unit.parentOccurrenceIds.some((occurrenceId) => parentSideForOccurrence(occurrenceId, unit.edges) < 2);
}

function enforceFamilyPartnerRows(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  protectedOccurrenceIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  partnerGap: number,
) {
  for (const unit of graph.familyUnits) {
    const parents = orderedParentOccurrenceIds(unit).filter((occurrenceId) => positions.has(occurrenceId));
    if (parents.length < 2) continue;
    for (let index = 1; index < parents.length; index += 1) {
      const leftId = parents[index - 1];
      const rightId = parents[index];
      const left = positions.get(leftId);
      const right = positions.get(rightId);
      if (!left || !right) continue;
      if (Math.abs(left.y - right.y) >= options.nodeHeight) continue;
      const minRightX = left.x + options.nodeWidth + partnerGap;
      if (right.x >= minRightX) continue;
      const beforeCenterX = averageOccurrenceCenterX(parents, positions, options.nodeWidth);
      const delta = minRightX - right.x;
      if (rightId === rootOccurrenceId || protectedOccurrenceIds.has(rightId)) {
        positions.set(leftId, { ...left, x: left.x - delta });
      } else if (leftId === rootOccurrenceId || protectedOccurrenceIds.has(leftId)) {
        positions.set(rightId, { ...right, x: right.x + delta });
      } else {
        positions.set(leftId, { ...left, x: left.x - delta / 2 });
        positions.set(rightId, { ...right, x: right.x + delta / 2 });
      }
      const afterCenterX = averageOccurrenceCenterX(parents, positions, options.nodeWidth);
      shiftFamilyUnitDescendantsAfterParentSpacing(
        graph,
        unit,
        positions,
        afterCenterX - beforeCenterX,
        rootOccurrenceId,
        protectedOccurrenceIds,
      );
    }
  }
}

function shiftFamilyUnitDescendantsAfterParentSpacing(
  graph: NormalizedFamilyGridGraph,
  unit: NormalizedFamilyUnit,
  positions: Map<string, { x: number; y: number }>,
  deltaX: number,
  rootOccurrenceId: string,
  protectedOccurrenceIds: Set<string>,
) {
  if (Math.abs(deltaX) < 1) return;
  if (unit.childOccurrenceIds.includes(rootOccurrenceId)) return;
  if (unit.childOccurrenceIds.some((occurrenceId) => protectedOccurrenceIds.has(occurrenceId))) return;
  const occurrenceIds = new Set<string>();
  for (const childId of unit.childOccurrenceIds) {
    collectVisibleDescendantFamilyOccurrenceIds(graph, childId, positions, occurrenceIds, new Set());
  }
  for (const occurrenceId of occurrenceIds) {
    if (occurrenceId === rootOccurrenceId || protectedOccurrenceIds.has(occurrenceId)) continue;
    const point = positions.get(occurrenceId);
    if (point) positions.set(occurrenceId, { ...point, x: point.x + deltaX });
  }
}

function collectVisibleDescendantFamilyOccurrenceIds(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  positions: Map<string, { x: number; y: number }>,
  result: Set<string>,
  visiting: Set<string>,
) {
  if (visiting.has(occurrenceId)) return;
  visiting.add(occurrenceId);
  if (positions.has(occurrenceId)) result.add(occurrenceId);
  for (const unit of graph.spouseFamiliesByPerson.get(occurrenceId) ?? []) {
    for (const parentId of unit.parentOccurrenceIds) {
      if (positions.has(parentId)) result.add(parentId);
    }
    for (const childId of unit.childOccurrenceIds) {
      collectVisibleDescendantFamilyOccurrenceIds(graph, childId, positions, result, visiting);
    }
  }
}

function realignDetachedFamilyChildrenToUnion(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  protectedOccurrenceIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  siblingGap: number,
) {
  const step = options.nodeWidth + siblingGap;
  for (const unit of graph.familyUnits) {
    if (unit.childOccurrenceIds.includes(rootOccurrenceId)) continue;
    if (unit.childOccurrenceIds.some((occurrenceId) => protectedOccurrenceIds.has(occurrenceId))) continue;
    const parents = orderedParentOccurrenceIds(unit).filter((occurrenceId) => positions.has(occurrenceId));
    const children = unit.childOccurrenceIds.filter((occurrenceId) =>
      occurrenceId !== rootOccurrenceId && positions.has(occurrenceId),
    );
    if (parents.length < 2 || !children.length) continue;

    const unionCenterX = averageOccurrenceCenterX(parents, positions, options.nodeWidth);
    const childrenCenterX = averageOccurrenceCenterX(children, positions, options.nodeWidth);
    if (Math.abs(childrenCenterX - unionCenterX) <= step) continue;

    const movableParents = parents.filter((parentId) =>
      parentId !== rootOccurrenceId &&
      !protectedOccurrenceIds.has(parentId) &&
      !isLockedInAnotherPlacedFamily(graph, unit, parentId, positions, false),
    );
    const shiftIds = new Set<string>();
    for (const childId of children) {
      collectVisibleDescendantFamilyOccurrenceIds(graph, childId, positions, shiftIds, new Set());
    }
    for (const occurrenceId of [...shiftIds]) {
      if (protectedOccurrenceIds.has(occurrenceId)) shiftIds.delete(occurrenceId);
    }
    for (const parentId of movableParents) shiftIds.add(parentId);

    const collisionPositions = new Map(
      [...positions].filter(([occurrenceId]) => !shiftIds.has(occurrenceId)),
    );
    const direction: -1 | 1 = childrenCenterX < unionCenterX ? 1 : -1;
    for (let distance = 0; distance <= 100; distance += 1) {
      const targetChildrenCenterX = unionCenterX + direction * step * distance;
      const childDeltaX = targetChildrenCenterX - childrenCenterX;
      const parentDeltaX = movableParents.length
        ? (targetChildrenCenterX - unionCenterX) * (parents.length / movableParents.length)
        : 0;
      const candidate = new Map<string, { x: number; y: number }>();
      for (const occurrenceId of shiftIds) {
        const point = positions.get(occurrenceId);
        if (!point) continue;
        const deltaX = movableParents.includes(occurrenceId) ? parentDeltaX : childDeltaX;
        candidate.set(occurrenceId, { ...point, x: point.x + deltaX });
      }
      if (sideBranchBlockCollides(candidate, collisionPositions, options)) continue;
      for (const [occurrenceId, point] of candidate.entries()) positions.set(occurrenceId, point);
      break;
    }
  }
}

function snapshotBackbonePositions(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const snapshot = new Map<string, { x: number; y: number }>();
  for (const occurrenceId of directBackboneOccurrenceIds(graph, rootOccurrenceId)) {
    const position = positions.get(occurrenceId);
    if (position) snapshot.set(occurrenceId, { ...position });
  }
  return snapshot;
}

function restoreBackbonePositions(
  snapshot: Map<string, { x: number; y: number }>,
  positions: Map<string, { x: number; y: number }>,
  skipOccurrenceIds = new Set<string>(),
) {
  for (const [occurrenceId, position] of snapshot) {
    if (skipOccurrenceIds.has(occurrenceId)) continue;
    positions.set(occurrenceId, { ...position });
  }
}

function opposedExpandedBackboneAnchorIds(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
): Set<string> {
  const result = new Set<string>();
  const rootPosition = positions.get(rootItem.occurrence.id);
  if (!rootPosition) return result;
  const rootCenterX = rootPosition.x + options.nodeWidth / 2;
  const rootBranchDirectionByPerson = rootBranchDirectionByPersonId(graph, rootItem);
  const opposedSides = new Set<-1 | 1>();
  for (const item of occurrenceNodes) {
    if (!item.occurrence.sideBranchesExpanded || item.occurrence.id === rootItem.occurrence.id) continue;
    const position = positions.get(item.occurrence.id);
    if (!position) continue;
    const anchorCenterX = position.x + options.nodeWidth / 2;
    const direction = sideBranchDirection(item, rootBranchDirectionByPerson, rootCenterX, anchorCenterX);
    const globalDirection = globalSideBranchDirection(item, rootBranchDirectionByPerson, rootCenterX, anchorCenterX);
    if (direction !== globalDirection) opposedSides.add(globalDirection);
  }
  if (!opposedSides.size) return result;

  const backboneIds = directBackboneOccurrenceIds(graph, rootItem.occurrence.id);
  for (const item of occurrenceNodes) {
    if (!backboneIds.has(item.occurrence.id) || item.occurrence.id === rootItem.occurrence.id) continue;
    const position = positions.get(item.occurrence.id);
    if (!position) continue;
    const itemCenterX = position.x + options.nodeWidth / 2;
    const globalDirection = globalSideBranchDirection(item, rootBranchDirectionByPerson, rootCenterX, itemCenterX);
    if (opposedSides.has(globalDirection)) result.add(item.occurrence.id);
  }
  return result;
}

function directBackboneOccurrenceIds(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [rootOccurrenceId];
  const visited = new Set<string>();

  while (queue.length) {
    const occurrenceId = queue.shift();
    if (!occurrenceId || visited.has(occurrenceId)) continue;
    visited.add(occurrenceId);
    result.add(occurrenceId);

    const parentFamily = graph.parentFamilyByChild.get(occurrenceId);
    if (!parentFamily) continue;
    for (const parentId of orderedParentOccurrenceIds(parentFamily)) {
      if (!visited.has(parentId)) queue.push(parentId);
    }
  }

  return result;
}

function placeRemainingGridOccurrences(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing" | "horizontalSpacing">,
) {
  const rowGap = Math.max(18, options.horizontalSpacing * 0.12);
  const rootPosition = positions.get(rootItem.occurrence.id) ?? { x: 0, y: 0 };
  const rootCenterX = rootPosition.x + options.nodeWidth / 2;
  const rootBranchDirectionByPerson = rootBranchDirectionByPersonId(graph, rootItem);
  const unplaced = occurrenceNodes
    .filter((item) => !positions.has(item.occurrence.id))
    .sort((left, right) =>
      left.occurrence.generation - right.occurrence.generation ||
      left.occurrence.path.length - right.occurrence.path.length ||
      left.occurrence.id.localeCompare(right.occurrence.id, "uk"),
    );

  for (const item of unplaced) {
    const y = item.occurrence.generation * options.verticalSpacing;
    const direction = sideBranchDirection(
      item,
      rootBranchDirectionByPerson,
      rootCenterX,
      rootCenterX,
    );
    const rowBounds = placedRowBounds(positions, y, options);
    const candidateX = direction < 0
      ? (rowBounds?.minX ?? rootPosition.x) - rowGap - options.nodeWidth
      : (rowBounds?.maxX ?? rootPosition.x + options.nodeWidth) + rowGap;
    const x = nearestFreeSideBranchX(candidateX, y, direction, positions, options, rowGap);
    positions.set(item.occurrence.id, { x, y });
  }
}

function placeUnplacedFamilyChildrenNearParents(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing" | "horizontalSpacing">,
  partnerGap: number,
  siblingGap: number,
) {
  const allowedOccurrenceIds = new Set(occurrenceNodes.map((item) => item.occurrence.id));
  let changed = true;
  let guard = 0;

  while (changed && guard < 100) {
    changed = false;
    guard += 1;

    for (const unit of graph.familyUnits) {
      const visibleParents = orderedParentOccurrenceIds(unit).filter((occurrenceId) =>
        allowedOccurrenceIds.has(occurrenceId),
      );
      const visibleChildren = unit.childOccurrenceIds.filter((occurrenceId) =>
        allowedOccurrenceIds.has(occurrenceId),
      );
      if (!visibleParents.length || !visibleChildren.length) continue;

      const placedParents = visibleParents.filter((occurrenceId) => positions.has(occurrenceId));
      if (!placedParents.length) continue;
      if (placeMissingFamilyUnitParents(visibleParents, placedParents, positions, options, partnerGap)) {
        changed = true;
      }

      const unplacedChildren = visibleChildren.filter((occurrenceId) => !positions.has(occurrenceId));
      if (!unplacedChildren.length) continue;

      const parentCenters = visibleParents
        .map((occurrenceId) => positions.get(occurrenceId))
        .filter((point): point is { x: number; y: number } => Boolean(point))
        .map((point) => point.x + options.nodeWidth / 2);
      if (!parentCenters.length) continue;

      const unionCenterX = parentCenters.reduce((sum, value) => sum + value, 0) / parentCenters.length;
      const childBlocks = new Map<string, FamilyDescendantBlock>();
      for (const childId of unplacedChildren) {
        childBlocks.set(
          childId,
          buildFamilyDescendantBlock(
            graph,
            childId,
            allowedOccurrenceIds,
            options,
            partnerGap,
            siblingGap,
            false,
            new Set(),
          ),
        );
      }

      const rowItems = visibleChildren.map((childId) => ({
        childId,
        width: positions.has(childId) ? options.nodeWidth : childBlocks.get(childId)?.width ?? options.nodeWidth,
      }));
      const rowWidth = rowItems.reduce((sum, item) => sum + item.width, 0) +
        Math.max(0, rowItems.length - 1) * siblingGap;
      let cursor = childRowStartX(rowItems, positions, options.nodeWidth, siblingGap, unionCenterX, rowWidth);
      const localPositions = new Map<string, { x: number; y: number }>();

      for (const item of rowItems) {
        const existing = positions.get(item.childId);
        if (existing) {
          cursor += item.width + siblingGap;
          continue;
        }

        const block = childBlocks.get(item.childId);
        if (!block) {
          cursor += item.width + siblingGap;
          continue;
        }
        const rootPosition = block.positions.get(item.childId) ?? { x: 0, y: 0 };
        const childOccurrence = graph.occurrenceById.get(item.childId);
        const childY = (childOccurrence?.generation ?? 0) * options.verticalSpacing;
        const dx = cursor - rootPosition.x;
        const dy = childY - rootPosition.y;
        for (const [occurrenceId, point] of block.positions.entries()) {
          if (!allowedOccurrenceIds.has(occurrenceId) || positions.has(occurrenceId) || localPositions.has(occurrenceId)) {
            continue;
          }
          localPositions.set(occurrenceId, { x: point.x + dx, y: point.y + dy });
        }
        cursor += item.width + siblingGap;
      }

      if (!localPositions.size) continue;
      shiftFamilyUnitBlockWithMovableParentsOutOfCollisions(
        graph,
        unit,
        visibleParents,
        localPositions,
        positions,
        unionCenterX,
        options,
        siblingGap,
      );
      for (const [occurrenceId, point] of localPositions.entries()) {
        positions.set(occurrenceId, point);
        changed = true;
      }
    }
  }
}

function childRowStartX(
  rowItems: Array<{ childId: string; width: number }>,
  positions: Map<string, { x: number; y: number }>,
  nodeWidth: number,
  siblingGap: number,
  unionCenterX: number,
  rowWidth: number,
): number {
  const anchorIndex = rowItems.findIndex((item) => positions.has(item.childId));
  if (anchorIndex < 0) return unionCenterX - rowWidth / 2;

  const anchorPosition = positions.get(rowItems[anchorIndex].childId);
  if (!anchorPosition) return unionCenterX - rowWidth / 2;

  const prefixWidth = rowItems
    .slice(0, anchorIndex)
    .reduce((sum, item) => sum + item.width + siblingGap, 0);
  const anchoredStart = anchorPosition.x - prefixWidth;
  const theoreticalStart = unionCenterX - rowWidth / 2;

  if (Math.abs(anchoredStart - theoreticalStart) <= nodeWidth + siblingGap) return theoreticalStart;
  return anchoredStart;
}

function placeMissingFamilyUnitParents(
  visibleParents: string[],
  placedParents: string[],
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
  partnerGap: number,
): boolean {
  const anchorId = placedParents[0];
  const anchorPosition = positions.get(anchorId);
  const anchorIndex = visibleParents.indexOf(anchorId);
  if (!anchorPosition || anchorIndex < 0) return false;

  let changed = false;
  for (const parentId of visibleParents) {
    if (positions.has(parentId)) continue;
    const parentIndex = visibleParents.indexOf(parentId);
    positions.set(parentId, {
      x: anchorPosition.x + (parentIndex - anchorIndex) * (options.nodeWidth + partnerGap),
      y: anchorPosition.y,
    });
    changed = true;
  }
  return changed;
}

function alignPlacedFamilyUnionsToChildren(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
) {
  const allowedOccurrenceIds = new Set(occurrenceNodes.map((item) => item.occurrence.id));
  for (const unit of graph.familyUnits) {
    const visibleParents = orderedParentOccurrenceIds(unit).filter((occurrenceId) =>
      allowedOccurrenceIds.has(occurrenceId) && positions.has(occurrenceId),
    );
    const visibleChildren = unit.childOccurrenceIds.filter((occurrenceId) =>
      allowedOccurrenceIds.has(occurrenceId) && positions.has(occurrenceId),
    );
    if (!visibleParents.length || !visibleChildren.length) continue;

    const unionCenterX = averageOccurrenceCenterX(visibleParents, positions, options.nodeWidth);
    const childrenCenterX = averageOccurrenceCenterX(visibleChildren, positions, options.nodeWidth);
    const deltaX = childrenCenterX - unionCenterX;
    if (Math.abs(deltaX) < 1) continue;

    const movableParents = visibleParents.filter((parentId) =>
      !isLockedInAnotherPlacedFamily(graph, unit, parentId, positions, false),
    );
    if (!movableParents.length) continue;
    if (movableParents.length !== visibleParents.length) continue;

    const parentDeltaX = deltaX * (visibleParents.length / movableParents.length);
    const candidate = withShiftedParentPositions(positions, movableParents, parentDeltaX);
    if (movableParentPositionsCollide(movableParents, candidate, options)) continue;

    for (const parentId of movableParents) {
      const point = candidate.get(parentId);
      if (point) positions.set(parentId, point);
    }
  }
}

function averageOccurrenceCenterX(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  nodeWidth: number,
): number {
  const centers = occurrenceIds
    .map((occurrenceId) => positions.get(occurrenceId))
    .filter((point): point is { x: number; y: number } => Boolean(point))
    .map((point) => point.x + nodeWidth / 2);
  return centers.length ? centers.reduce((sum, value) => sum + value, 0) / centers.length : 0;
}

function shiftFamilyUnitBlockWithMovableParentsOutOfCollisions(
  graph: NormalizedFamilyGridGraph,
  unit: NormalizedFamilyUnit,
  visibleParents: string[],
  localPositions: Map<string, { x: number; y: number }>,
  globalPositions: Map<string, { x: number; y: number }>,
  preferredCenterX: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  if (!sideBranchBlockCollides(localPositions, globalPositions, options)) return;

  const movableParents = visibleParents.filter((parentId) =>
    globalPositions.has(parentId) && !isLockedInAnotherPlacedFamily(graph, unit, parentId, globalPositions, true),
  );
  if (!movableParents.length) {
    shiftFamilyUnitBlockOutOfCollisions(localPositions, globalPositions, preferredCenterX, options, rowGap);
    return;
  }

  const base = new Map(localPositions);
  const step = options.nodeWidth + rowGap;
  const multiplier = visibleParents.length / movableParents.length;
  for (let distance = 1; distance <= 100; distance += 1) {
    for (const direction of preferredFamilyUnitShiftDirections(visibleParents, movableParents, globalPositions, preferredCenterX, options)) {
      const deltaX = direction * step * distance;
      const candidateLocal = shiftedPositionMap(base, deltaX);
      const candidateGlobal = withShiftedParentPositions(globalPositions, movableParents, deltaX * multiplier);
      if (sideBranchBlockCollides(candidateLocal, candidateGlobal, options)) continue;
      if (movableParentPositionsCollide(movableParents, candidateGlobal, options)) continue;

      localPositions.clear();
      for (const [occurrenceId, point] of candidateLocal.entries()) localPositions.set(occurrenceId, point);
      for (const parentId of movableParents) {
        const point = candidateGlobal.get(parentId);
        if (point) globalPositions.set(parentId, point);
      }
      return;
    }
  }

  shiftFamilyUnitBlockOutOfCollisions(localPositions, globalPositions, preferredCenterX, options, rowGap);
}

function isLockedInAnotherPlacedFamily(
  graph: NormalizedFamilyGridGraph,
  currentUnit: NormalizedFamilyUnit,
  parentId: string,
  positions: Map<string, { x: number; y: number }>,
  lockCurrentChildren: boolean,
): boolean {
  if (lockCurrentChildren) {
    for (const childId of currentUnit.childOccurrenceIds) {
      if (positions.has(childId)) return true;
    }
  }
  for (const unit of graph.familyUnits) {
    if (unit.key === currentUnit.key || !unit.parentOccurrenceIds.includes(parentId)) continue;
    if (unit.childOccurrenceIds.some((childId) => positions.has(childId))) return true;
    if (unit.parentOccurrenceIds.some((candidateId) => candidateId !== parentId && positions.has(candidateId))) return true;
  }
  return false;
}

function preferredFamilyUnitShiftDirections(
  visibleParents: string[],
  movableParents: string[],
  positions: Map<string, { x: number; y: number }>,
  preferredCenterX: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
): Array<-1 | 1> {
  const movableCenters = movableParents
    .map((parentId) => positions.get(parentId))
    .filter((point): point is { x: number; y: number } => Boolean(point))
    .map((point) => point.x + options.nodeWidth / 2);
  const parentCenters = visibleParents
    .map((parentId) => positions.get(parentId))
    .filter((point): point is { x: number; y: number } => Boolean(point))
    .map((point) => point.x + options.nodeWidth / 2);
  const movableCenter = movableCenters.length
    ? movableCenters.reduce((sum, value) => sum + value, 0) / movableCenters.length
    : preferredCenterX;
  const parentCenter = parentCenters.length
    ? parentCenters.reduce((sum, value) => sum + value, 0) / parentCenters.length
    : preferredCenterX;
  if (Math.abs(movableCenter - parentCenter) > 0.001) {
    return movableCenter < parentCenter ? [-1, 1] : [1, -1];
  }
  return movableCenter < preferredCenterX ? [-1, 1] : [1, -1];
}

function withShiftedParentPositions(
  positions: Map<string, { x: number; y: number }>,
  parentIds: string[],
  deltaX: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const parentSet = new Set(parentIds);
  for (const [occurrenceId, point] of positions.entries()) {
    result.set(occurrenceId, parentSet.has(occurrenceId) ? { ...point, x: point.x + deltaX } : point);
  }
  return result;
}

function movableParentPositionsCollide(
  parentIds: string[],
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
): boolean {
  const parentSet = new Set(parentIds);
  for (const parentId of parentIds) {
    const point = positions.get(parentId);
    if (!point) continue;
    const otherPositions = new Map([...positions].filter(([occurrenceId]) => occurrenceId !== parentId && !parentSet.has(occurrenceId)));
    if (overlapsPlacedNode(point.x, point.y, otherPositions, options)) return true;
  }
  return false;
}

function shiftFamilyUnitBlockOutOfCollisions(
  localPositions: Map<string, { x: number; y: number }>,
  globalPositions: Map<string, { x: number; y: number }>,
  preferredCenterX: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  if (!sideBranchBlockCollides(localPositions, globalPositions, options)) return;

  const base = new Map(localPositions);
  const step = options.nodeWidth + rowGap;
  for (let distance = 1; distance <= 100; distance += 1) {
    for (const direction of preferredCollisionDirections(base, preferredCenterX, options)) {
      const candidate = shiftedPositionMap(base, direction * step * distance);
      if (sideBranchBlockCollides(candidate, globalPositions, options)) continue;
      localPositions.clear();
      for (const [occurrenceId, point] of candidate.entries()) localPositions.set(occurrenceId, point);
      return;
    }
  }
}

function preferredCollisionDirections(
  positions: Map<string, { x: number; y: number }>,
  preferredCenterX: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
): Array<-1 | 1> {
  const bounds = sideBranchBlockBounds(positions, { ...options, nodeHeight: 1 });
  const blockCenterX = bounds ? (bounds.minX + bounds.maxX) / 2 : preferredCenterX;
  return blockCenterX < preferredCenterX ? [-1, 1] : [1, -1];
}

function shiftedPositionMap(
  positions: Map<string, { x: number; y: number }>,
  deltaX: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  for (const [occurrenceId, point] of positions.entries()) {
    result.set(occurrenceId, { ...point, x: point.x + deltaX });
  }
  return result;
}

function compactAncestorBlocksTowardChildAxes(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const rootPosition = positions.get(rootOccurrenceId);
  const rootCenterX = (rootPosition?.x ?? 0) + options.nodeWidth / 2;
  const units = [...graph.parentFamilyByChild.entries()]
    .map(([childOccurrenceId, unit]) => ({ childOccurrenceId, unit }))
    .filter(({ childOccurrenceId, unit }) =>
      positions.has(childOccurrenceId) &&
      unit.parentOccurrenceIds.some((parentId) => positions.has(parentId)),
    )
    .sort((left, right) => {
      const leftGeneration = graph.occurrenceById.get(left.childOccurrenceId)?.generation ?? 0;
      const rightGeneration = graph.occurrenceById.get(right.childOccurrenceId)?.generation ?? 0;
      return leftGeneration - rightGeneration ||
        left.childOccurrenceId.localeCompare(right.childOccurrenceId, "uk");
    });

  for (let pass = 0; pass < 3; pass += 1) {
    for (const { childOccurrenceId, unit } of units) {
      compactAncestorBlockForChild(graph, childOccurrenceId, unit, rootCenterX, positions, options, rowGap);
    }
  }
}

function compactGlobalWhitespaceTowardBackbone(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  protectedOccurrenceIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const rootPosition = positions.get(rootOccurrenceId);
  if (!rootPosition) return;
  const rootCenterX = rootPosition.x + options.nodeWidth / 2;
  const targetGap = Math.max(rowGap * 1.35, Math.round(options.nodeWidth * 0.28));
  const maxGap = Math.max(options.nodeWidth * 1.2, targetGap * 2.4);

  for (let pass = 0; pass < 12; pass += 1) {
    const spans = occupiedHorizontalSpans(positions, options.nodeWidth);
    let moved = false;
    for (let index = 0; index < spans.length - 1; index += 1) {
      const leftSpan = spans[index];
      const rightSpan = spans[index + 1];
      const gap = rightSpan.minX - leftSpan.maxX;
      if (gap <= maxGap) continue;
      const shrink = gap - targetGap;
      if (shrink <= 1) continue;
      const movedThisGap = compactGlobalGap({
        graph,
        leftBoundaryX: leftSpan.maxX,
        rightBoundaryX: rightSpan.minX,
        shrink,
        rootCenterX,
        protectedOccurrenceIds,
        positions,
        options,
      });
      moved = moved || movedThisGap;
      if (movedThisGap) break;
    }
    if (!moved) break;
  }
}

function occupiedHorizontalSpans(
  positions: Map<string, { x: number; y: number }>,
  nodeWidth: number,
): Array<{ minX: number; maxX: number }> {
  const intervals = [...positions.values()]
    .map((point) => ({ minX: point.x, maxX: point.x + nodeWidth }))
    .sort((left, right) => left.minX - right.minX || left.maxX - right.maxX);
  const spans: Array<{ minX: number; maxX: number }> = [];
  for (const interval of intervals) {
    const current = spans[spans.length - 1];
    if (!current || interval.minX > current.maxX) {
      spans.push({ ...interval });
    } else {
      current.maxX = Math.max(current.maxX, interval.maxX);
    }
  }
  return spans;
}

function compactGlobalGap(input: {
  graph: NormalizedFamilyGridGraph;
  leftBoundaryX: number;
  rightBoundaryX: number;
  shrink: number;
  rootCenterX: number;
  protectedOccurrenceIds: Set<string>;
  positions: Map<string, { x: number; y: number }>;
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">;
}): boolean {
  const leftIds = [...input.positions.entries()]
    .filter(([, point]) => point.x + input.options.nodeWidth <= input.leftBoundaryX + 0.001)
    .map(([occurrenceId]) => occurrenceId);
  const rightIds = [...input.positions.entries()]
    .filter(([, point]) => point.x >= input.rightBoundaryX - 0.001)
    .map(([occurrenceId]) => occurrenceId);
  const leftHasProtected = leftIds.some((occurrenceId) => input.protectedOccurrenceIds.has(occurrenceId));
  const rightHasProtected = rightIds.some((occurrenceId) => input.protectedOccurrenceIds.has(occurrenceId));
  const gapCenterX = (input.leftBoundaryX + input.rightBoundaryX) / 2;

  const candidates: Array<{ ids: string[]; deltaX: number }> = [];
  if (!rightHasProtected) candidates.push({ ids: rightIds, deltaX: -input.shrink });
  if (!leftHasProtected) candidates.push({ ids: leftIds, deltaX: input.shrink });
  candidates.sort((left, right) => {
    const leftScore = compactionCandidateScore(left.deltaX, gapCenterX, input.rootCenterX);
    const rightScore = compactionCandidateScore(right.deltaX, gapCenterX, input.rootCenterX);
    return leftScore - rightScore || left.ids.length - right.ids.length;
  });

  for (const candidate of candidates) {
    if (!candidate.ids.length) continue;
    const candidateIds = new Set(candidate.ids);
    if (compactionSplitsVisibleFamilyUnit(input.graph, candidateIds, input.positions)) continue;
    const movedPositions = new Map(candidate.ids.map((occurrenceId) => {
      const point = input.positions.get(occurrenceId) as { x: number; y: number };
      return [occurrenceId, { ...point, x: point.x + candidate.deltaX }] as const;
    }));
    if (compactionCrossesRootCorridor(candidate.ids, input.positions, movedPositions, input.options, input.rootCenterX)) continue;
    const staticPositions = new Map([...input.positions].filter(([occurrenceId]) => !movedPositions.has(occurrenceId)));
    const branchPadding = Math.max(12, Math.round(input.options.nodeWidth * 0.16));
    const verticalPadding = Math.max(0, Math.round(input.options.nodeHeight * 0.25));
    if (sideBranchBlockCollides(movedPositions, staticPositions, input.options, branchPadding, verticalPadding)) continue;
    for (const [occurrenceId, point] of movedPositions.entries()) input.positions.set(occurrenceId, point);
    return true;
  }
  return false;
}

function compactionCrossesRootCorridor(
  occurrenceIds: string[],
  beforePositions: Map<string, { x: number; y: number }>,
  afterPositions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth">,
  rootCenterX: number,
): boolean {
  const beforeCenters = occurrenceIds
    .map((occurrenceId) => beforePositions.get(occurrenceId))
    .filter((point): point is { x: number; y: number } => Boolean(point))
    .map((point) => point.x + options.nodeWidth / 2);
  if (!beforeCenters.length) return false;
  const leftSide = beforeCenters.every((center) => center < rootCenterX);
  const rightSide = beforeCenters.every((center) => center > rootCenterX);
  if (!leftSide && !rightSide) return false;
  const corridor = Math.max(14, options.nodeWidth * 0.2);
  const afterCenters = [...afterPositions.values()].map((point) => point.x + options.nodeWidth / 2);
  if (leftSide) return afterCenters.some((center) => center > rootCenterX - corridor);
  return afterCenters.some((center) => center < rootCenterX + corridor);
}

function compactionSplitsVisibleFamilyUnit(
  graph: NormalizedFamilyGridGraph,
  movedIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
): boolean {
  for (const unit of graph.familyUnits) {
    const visibleIds = [...new Set([...unit.parentOccurrenceIds, ...unit.childOccurrenceIds])]
      .filter((occurrenceId) => positions.has(occurrenceId));
    if (visibleIds.length <= 1) continue;
    const movedCount = visibleIds.filter((occurrenceId) => movedIds.has(occurrenceId)).length;
    if (movedCount > 0 && movedCount < visibleIds.length) return true;
  }
  return false;
}

function compactionCandidateScore(deltaX: number, gapCenterX: number, rootCenterX: number): number {
  const movesTowardRoot = gapCenterX < rootCenterX ? deltaX > 0 : deltaX < 0;
  return movesTowardRoot ? 0 : 1;
}

function compactAncestorBlockForChild(
  graph: NormalizedFamilyGridGraph,
  childOccurrenceId: string,
  unit: NormalizedFamilyUnit,
  rootCenterX: number,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const childPosition = positions.get(childOccurrenceId);
  if (!childPosition) return;
  const parentIds = unit.parentOccurrenceIds.filter((parentId) => positions.has(parentId));
  if (!parentIds.length) return;
  const blockIds = collectAncestorBlockOccurrenceIds(graph, parentIds, positions);
  if (!blockIds.size) return;

  const parentCenterX = averageOccurrenceCenterX(parentIds, positions, options.nodeWidth);
  const childCenterX = childPosition.x + options.nodeWidth / 2;
  const desiredDelta = childCenterX - parentCenterX;
  if (Math.abs(desiredDelta) < 1) return;

  const externalPositions = new Map([...positions].filter(([occurrenceId]) => !blockIds.has(occurrenceId)));
  const localPositions = new Map([...positions]
    .filter(([occurrenceId]) => blockIds.has(occurrenceId))
    .map(([occurrenceId, point]) => [occurrenceId, { ...point }]));
  const side = ancestorBlockRootSide(localPositions, rootCenterX, options.nodeWidth);
  const compacted = closestNonCollidingShiftTowardAxis(
    localPositions,
    externalPositions,
    desiredDelta,
    side,
    rootCenterX,
    options,
    rowGap,
  );
  if (!compacted) return;
  for (const [occurrenceId, point] of compacted.entries()) positions.set(occurrenceId, point);
}

function collectAncestorBlockOccurrenceIds(
  graph: NormalizedFamilyGridGraph,
  startOccurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
): Set<string> {
  const result = new Set<string>();
  const queue = [...startOccurrenceIds];
  while (queue.length) {
    const occurrenceId = queue.shift();
    if (!occurrenceId || result.has(occurrenceId) || !positions.has(occurrenceId)) continue;
    result.add(occurrenceId);
    const parentUnit = graph.parentFamilyByChild.get(occurrenceId);
    if (!parentUnit) continue;
    for (const parentId of parentUnit.parentOccurrenceIds) queue.push(parentId);
  }
  return result;
}

function closestNonCollidingShiftTowardAxis(
  localPositions: Map<string, { x: number; y: number }>,
  externalPositions: Map<string, { x: number; y: number }>,
  desiredDelta: number,
  side: -1 | 0 | 1,
  rootCenterX: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
): Map<string, { x: number; y: number }> | null {
  const direction = desiredDelta < 0 ? -1 : 1;
  const maxDistance = Math.abs(desiredDelta);
  const step = Math.max(6, Math.min(options.nodeWidth / 4, rowGap));
  for (let distance = maxDistance; distance >= step; distance -= step) {
    const candidate = shiftedPositionMap(localPositions, direction * distance);
    if (ancestorBlockCrossesRootAxis(candidate, side, rootCenterX, options.nodeWidth, rowGap)) continue;
    if (sideBranchBlockCollides(candidate, externalPositions, options)) continue;
    return candidate;
  }
  const candidate = shiftedPositionMap(localPositions, desiredDelta);
  if (
    !ancestorBlockCrossesRootAxis(candidate, side, rootCenterX, options.nodeWidth, rowGap) &&
    !sideBranchBlockCollides(candidate, externalPositions, options)
  ) {
    return candidate;
  }
  return null;
}

function ancestorBlockRootSide(
  localPositions: Map<string, { x: number; y: number }>,
  rootCenterX: number,
  nodeWidth: number,
): -1 | 0 | 1 {
  const centers = [...localPositions.values()].map((point) => point.x + nodeWidth / 2);
  if (!centers.length) return 0;
  if (centers.every((center) => center < rootCenterX)) return -1;
  if (centers.every((center) => center > rootCenterX)) return 1;
  return 0;
}

function ancestorBlockCrossesRootAxis(
  localPositions: Map<string, { x: number; y: number }>,
  side: -1 | 0 | 1,
  rootCenterX: number,
  nodeWidth: number,
  rowGap: number,
): boolean {
  if (side === 0) return false;
  const corridor = Math.max(8, rowGap * 0.35);
  const minX = Math.min(...[...localPositions.values()].map((point) => point.x));
  const maxX = Math.max(...[...localPositions.values()].map((point) => point.x + nodeWidth));
  return side < 0 ? maxX > rootCenterX - corridor : minX < rootCenterX + corridor;
}

function descendantFamiliesForOccurrence(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
): NormalizedFamilyUnit[] {
  return graph.spouseFamiliesByPerson.get(occurrenceId) ?? [];
}

function isDescendantOccurrence(
  graph: NormalizedFamilyGridGraph,
  parentOccurrenceId: string,
  childOccurrenceId: string,
): boolean {
  const parent = graph.occurrenceById.get(parentOccurrenceId);
  const child = graph.occurrenceById.get(childOccurrenceId);
  if (!parent || !child) return false;
  return child.generation > parent.generation;
}

function placedRowBounds(
  positions: Map<string, { x: number; y: number }>,
  y: number,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
): { minX: number; maxX: number } | null {
  const points = [...positions.values()].filter((point) => Math.abs(point.y - y) < options.nodeHeight);
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x + options.nodeWidth)),
  };
}

function placeExpandedSideBranches(
  graph: NormalizedFamilyGridGraph,
  occurrenceNodes: OccurrenceLayoutItem[],
  rootItem: OccurrenceLayoutItem,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing" | "horizontalSpacing">,
) {
  const itemByOccurrence = new Map(occurrenceNodes.map((item) => [item.occurrence.id, item]));
  const rootPosition = positions.get(rootItem.occurrence.id);
  const rootCenterX = (rootPosition?.x ?? 0) + options.nodeWidth / 2;
  const rootBranchDirectionByPerson = rootBranchDirectionByPersonId(graph, rootItem);
  const expandedAnchors = occurrenceNodes
    .filter((item) => item.occurrence.sideBranchesExpanded && positions.has(item.occurrence.id))
    .sort((left, right) =>
      Math.abs(left.occurrence.generation) - Math.abs(right.occurrence.generation) ||
      left.occurrence.id.localeCompare(right.occurrence.id, "uk"),
    );
  const remaining = new Set(occurrenceNodes
    .filter((item) => !positions.has(item.occurrence.id))
    .map((item) => item.occurrence.id));
  const branchIdsByAnchor = expandedSideBranchIdsByAnchor(expandedAnchors, occurrenceNodes, remaining);

  for (const anchor of expandedAnchors) {
    const branchIds = (branchIdsByAnchor.get(anchor.occurrence.id) ?? [])
      .filter((occurrenceId) => remaining.has(occurrenceId))
      .sort((left, right) => sideBranchOccurrenceSort(itemByOccurrence, left, right));
    if (!branchIds.length) continue;
    const anchorPosition = positions.get(anchor.occurrence.id);
    if (!anchorPosition) continue;
    const anchorCenterX = anchorPosition.x + options.nodeWidth / 2;
    if (anchor.occurrence.id === rootItem.occurrence.id) {
      const branchIdsByDirection = splitRootExpandedBranchIdsByDirection(
        graph,
        rootItem,
        branchIds,
        itemByOccurrence,
        rootBranchDirectionByPerson,
      );
      for (const direction of [-1, 1] as const) {
        const directedBranchIds = branchIdsByDirection.get(direction) ?? [];
        if (!directedBranchIds.length) continue;
        placeSideBranchBlock(graph, directedBranchIds, itemByOccurrence, positions, anchorPosition.x, rootCenterX, direction, options);
      }
    } else {
      const direction = sideBranchDirection(anchor, rootBranchDirectionByPerson, rootCenterX, anchorCenterX);
      const globalDirection = globalSideBranchDirection(anchor, rootBranchDirectionByPerson, rootCenterX, anchorCenterX);
      placeSideBranchBlock(graph, branchIds, itemByOccurrence, positions, anchorPosition.x, anchorCenterX, direction, options);
      const rowGap = Math.max(18, options.horizontalSpacing * 0.12);
      if (direction === globalDirection) {
        shiftPlacedBranchBlockInsideCorridor(branchIds, positions, rootCenterX, globalDirection, options, rowGap);
        shiftPlacedBranchBlockOutOfCollisions(branchIds, positions, globalDirection, options, rowGap);
      } else {
        expandOpposedSideBranchCorridor(
          branchIds,
          positions,
          anchor.occurrence.id,
          rootItem.occurrence.id,
          itemByOccurrence,
          rootBranchDirectionByPerson,
          rootCenterX,
          globalDirection,
          direction,
          options,
          rowGap,
        );
        shiftPlacedBranchBlockOutOfCollisions(branchIds, positions, direction, options, rowGap);
        expandOpposedSideBranchCorridor(
          branchIds,
          positions,
          anchor.occurrence.id,
          rootItem.occurrence.id,
          itemByOccurrence,
          rootBranchDirectionByPerson,
          rootCenterX,
          globalDirection,
          direction,
          options,
          rowGap,
        );
        const updatedAnchorPosition = positions.get(anchor.occurrence.id) ?? anchorPosition;
        shiftPlacedBranchBlockBetweenCorridors(
          branchIds,
          positions,
          rootCenterX,
          globalDirection,
          direction > 0 ? updatedAnchorPosition.x + options.nodeWidth : updatedAnchorPosition.x,
          direction,
          options,
          rowGap,
        );
      }
    }
    for (const occurrenceId of branchIds) remaining.delete(occurrenceId);
  }
}

function orderRootSpouseFamilies(families: NormalizedFamilyUnit[]): NormalizedFamilyUnit[] {
  return [...families].sort((left, right) =>
    right.childOccurrenceIds.length - left.childOccurrenceIds.length ||
    left.childOccurrenceIds.join("|").localeCompare(right.childOccurrenceIds.join("|"), "uk") ||
    left.key.localeCompare(right.key, "uk"),
  );
}

function placeStandaloneRootPartners(
  graph: NormalizedFamilyGridGraph,
  rootOccurrenceId: string,
  positions: Map<string, { x: number; y: number }>,
  placedRootPartnerIds: Set<string>,
  metrics: {
    rightCursor: number;
    leftCursor: number;
    nodeWidth: number;
    partnerGap: number;
  },
) {
  const standalonePartners = graph.partnerRelations
    .map((edge) => {
      if (edge.fromOccurrenceId === rootOccurrenceId) return edge.toOccurrenceId ?? "";
      if (edge.toOccurrenceId === rootOccurrenceId) return edge.fromOccurrenceId ?? "";
      return "";
    })
    .filter((occurrenceId): occurrenceId is string =>
      Boolean(occurrenceId) &&
      occurrenceId !== rootOccurrenceId &&
      !positions.has(occurrenceId) &&
      !placedRootPartnerIds.has(occurrenceId)
    )
    .sort((left, right) => left.localeCompare(right, "uk"));
  if (!standalonePartners.length) return;

  let rightCursor = metrics.rightCursor;
  let leftCursor = metrics.leftCursor;
  standalonePartners.forEach((occurrenceId) => {
    if (partnerDirectionForGrid(graph, rootOccurrenceId, occurrenceId) > 0) {
      positions.set(occurrenceId, { x: rightCursor, y: 0 });
      rightCursor += metrics.nodeWidth + metrics.partnerGap;
      return;
    }
    positions.set(occurrenceId, { x: leftCursor, y: 0 });
    leftCursor -= metrics.nodeWidth + metrics.partnerGap;
  });
}

function splitRootExpandedBranchIdsByDirection(
  graph: NormalizedFamilyGridGraph,
  rootItem: OccurrenceLayoutItem,
  branchIds: string[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  rootBranchDirectionByPerson: Map<string, -1 | 1>,
): Map<-1 | 1, string[]> {
  const result = new Map<-1 | 1, string[]>([
    [-1, []],
    [1, []],
  ]);
  for (const occurrenceId of branchIds) {
    const item = itemByOccurrence.get(occurrenceId);
    const direction = item
      ? rootExpandedBranchDirection(graph, rootItem, item, rootBranchDirectionByPerson)
      : -1;
    result.get(direction)?.push(occurrenceId);
  }
  return result;
}

function rootExpandedBranchDirection(
  graph: NormalizedFamilyGridGraph,
  rootItem: OccurrenceLayoutItem,
  item: OccurrenceLayoutItem,
  rootBranchDirectionByPerson: Map<string, -1 | 1>,
): -1 | 1 {
  for (const personId of item.occurrence.path) {
    if (personId === rootItem.person.personId) continue;
    const direction = rootBranchDirectionByPerson.get(personId);
    if (direction) return direction;
  }
  const familySide = familySideForRootRelative(graph, rootItem, item);
  if (familySide) return familySide;
  return genderSide(rootItem.person.gender);
}

function familySideForRootRelative(
  graph: NormalizedFamilyGridGraph,
  rootItem: OccurrenceLayoutItem,
  item: OccurrenceLayoutItem,
): -1 | 1 | null {
  const rootParents = graph.parentFamilyByChild.get(rootItem.occurrence.id);
  if (rootParents?.parentOccurrenceIds.includes(item.occurrence.id)) {
    const side = parentSideForOccurrence(item.occurrence.id, rootParents.edges);
    if (side === 0) return -1;
    if (side === 1) return 1;
  }
  return null;
}

function genderSide(gender: string | undefined): -1 | 1 {
  const value = (gender ?? "").trim().toLocaleLowerCase("uk");
  if (["жінка", "жіноча", "female", "f", "woman"].includes(value)) return 1;
  return -1;
}

function genderSideOrNull(gender: string | undefined): -1 | 1 | null {
  const value = (gender ?? "").trim().toLocaleLowerCase("uk");
  if (["жінка", "жіноча", "Р¶С–РЅРєР°", "Р¶С–РЅРѕС‡Р°", "female", "f", "woman"].includes(value)) return 1;
  if (["чоловік", "чоловіча", "С‡РѕР»РѕРІС–Рє", "С‡РѕР»РѕРІС–С‡Р°", "male", "m", "man"].includes(value)) return -1;
  return null;
}

function partnerDirectionForGrid(
  graph: NormalizedFamilyGridGraph,
  anchorOccurrenceId: string,
  partnerOccurrenceId: string,
): -1 | 1 {
  const anchorSide = personGenderSideForGrid(graph, anchorOccurrenceId);
  const partnerSide = personGenderSideForGrid(graph, partnerOccurrenceId);
  if (anchorSide === -1 && partnerSide === 1) return 1;
  if (anchorSide === 1 && partnerSide === -1) return -1;
  if (partnerSide) return partnerSide;
  return 1;
}

function personGenderSideForGrid(graph: NormalizedFamilyGridGraph, occurrenceId: string): -1 | 1 | null {
  const value = (personGenderForOccurrence(graph, occurrenceId) ?? "").trim().toLocaleLowerCase("uk");
  if (
    value === "\u0436\u0456\u043d\u043a\u0430" ||
    value === "\u0436\u0456\u043d\u043e\u0447\u0430" ||
    value === "female" ||
    value === "f" ||
    value === "woman"
  ) {
    return 1;
  }
  if (
    value === "\u0447\u043e\u043b\u043e\u0432\u0456\u043a" ||
    value === "\u0447\u043e\u043b\u043e\u0432\u0456\u0447\u0430" ||
    value === "male" ||
    value === "m" ||
    value === "man"
  ) {
    return -1;
  }
  return genderSideOrNull(value);
}

function personGenderForOccurrence(graph: NormalizedFamilyGridGraph, occurrenceId: string): string | undefined {
  const occurrence = graph.occurrenceById.get(occurrenceId);
  return occurrence ? graph.peopleById.get(occurrence.personId)?.gender : undefined;
}

function rootBranchDirectionByPersonId(
  graph: NormalizedFamilyGridGraph,
  rootItem: OccurrenceLayoutItem,
): Map<string, -1 | 1> {
  const result = new Map<string, -1 | 1>();
  const rootFamily = graph.parentFamilyByChild.get(rootItem.occurrence.id);
  if (!rootFamily) return result;
  for (const parentId of rootFamily.parentOccurrenceIds) {
    const occurrence = graph.occurrenceById.get(parentId);
    if (!occurrence) continue;
    const side = parentSideForOccurrence(parentId, rootFamily.edges);
    if (side === 0) result.set(occurrence.personId, -1);
    else if (side === 1) result.set(occurrence.personId, 1);
  }
  return result;
}

function sideBranchDirection(
  anchor: OccurrenceLayoutItem,
  rootBranchDirectionByPerson: Map<string, -1 | 1>,
  rootCenterX: number,
  anchorCenterX: number,
): -1 | 1 {
  const localSide = genderSideOrNull(anchor.person.gender);
  if (localSide) return localSide;
  for (const personId of anchor.occurrence.path) {
    const direction = rootBranchDirectionByPerson.get(personId);
    if (direction) return direction;
  }
  return anchorCenterX < rootCenterX ? -1 : 1;
}

function globalSideBranchDirection(
  anchor: OccurrenceLayoutItem,
  rootBranchDirectionByPerson: Map<string, -1 | 1>,
  rootCenterX: number,
  anchorCenterX: number,
): -1 | 1 {
  for (const personId of anchor.occurrence.path) {
    const direction = rootBranchDirectionByPerson.get(personId);
    if (direction) return direction;
  }
  return anchorCenterX < rootCenterX ? -1 : 1;
}

function expandedSideBranchIdsByAnchor(
  expandedAnchors: OccurrenceLayoutItem[],
  occurrenceNodes: OccurrenceLayoutItem[],
  remaining: Set<string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const item of occurrenceNodes) {
    if (!remaining.has(item.occurrence.id)) continue;
    const anchor = [...expandedAnchors]
      .filter((candidate) => item.occurrence.path.includes(candidate.person.personId))
      .sort((left, right) =>
        right.occurrence.path.length - left.occurrence.path.length ||
        right.occurrence.generation - left.occurrence.generation ||
        right.occurrence.id.localeCompare(left.occurrence.id, "uk"),
      )[0];
    if (!anchor) continue;
    const row = result.get(anchor.occurrence.id) ?? [];
    row.push(item.occurrence.id);
    result.set(anchor.occurrence.id, row);
  }
  return result;
}

function placeSideBranchBlock(
  graph: NormalizedFamilyGridGraph,
  branchIds: string[],
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  positions: Map<string, { x: number; y: number }>,
  anchorX: number,
  rootCenterX: number,
  direction: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing" | "horizontalSpacing">,
) {
  const rowGap = Math.max(18, options.horizontalSpacing * 0.12);
  const branchGap = Math.max(rowGap * 1.15, options.horizontalSpacing * 0.16);
  const partnerGap = Math.max(18, options.horizontalSpacing * 0.08);
  const globalPositions = new Map(positions);
  const localPositions = new Map<string, { x: number; y: number }>();
  const branchSet = new Set(branchIds);
  const covered = new Set<string>();
  const topCandidates = [...branchIds].sort((left, right) =>
    Number(hasDescendantFamilyWithin(graph, right, branchSet)) - Number(hasDescendantFamilyWithin(graph, left, branchSet)) ||
    (itemByOccurrence.get(left)?.occurrence.generation ?? 0) - (itemByOccurrence.get(right)?.occurrence.generation ?? 0) ||
    (itemByOccurrence.get(left)?.occurrence.path.length ?? 0) - (itemByOccurrence.get(right)?.occurrence.path.length ?? 0) ||
    left.localeCompare(right, "uk"),
  );
  let cursor = direction < 0
    ? anchorX - branchGap
    : anchorX + options.nodeWidth + branchGap;

  for (const occurrenceId of topCandidates) {
    if (covered.has(occurrenceId)) continue;
    const item = itemByOccurrence.get(occurrenceId);
    if (!item) continue;
    const block = buildFamilyDescendantBlock(
      graph,
      occurrenceId,
      branchSet,
      options,
      partnerGap,
      rowGap,
      false,
      new Set(),
    );
    const rootPosition = block.positions.get(occurrenceId);
    const blockX = direction < 0 ? cursor - block.width : cursor;
    const dx = blockX - (rootPosition?.x ?? 0);
    const dy = item.occurrence.generation * options.verticalSpacing - (rootPosition?.y ?? 0);
    for (const [localOccurrenceId, point] of block.positions.entries()) {
      if (!branchSet.has(localOccurrenceId) || localPositions.has(localOccurrenceId)) continue;
      localPositions.set(localOccurrenceId, { x: point.x + dx, y: point.y + dy });
      covered.add(localOccurrenceId);
    }
    cursor = direction < 0
      ? blockX - rowGap
      : blockX + block.width + rowGap;
  }

  shiftSideBranchBlockInsideRootCorridor(localPositions, rootCenterX, direction, options, rowGap);
  shiftSideBranchBlockOutOfCollisions(localPositions, globalPositions, direction, options, rowGap);
  for (const [occurrenceId, point] of localPositions.entries()) positions.set(occurrenceId, point);
}

function hasDescendantFamilyWithin(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  allowedOccurrenceIds: Set<string>,
): boolean {
  return descendantFamiliesForOccurrence(graph, occurrenceId).some((unit) =>
    unit.childOccurrenceIds.some((childId) =>
      allowedOccurrenceIds.has(childId) && isDescendantOccurrence(graph, occurrenceId, childId),
    ),
  );
}

function shiftSideBranchBlockInsideRootCorridor(
  localPositions: Map<string, { x: number; y: number }>,
  rootCenterX: number,
  direction: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const bounds = sideBranchBlockBounds(localPositions, options);
  if (!bounds) return;
  const corridor = Math.max(10, rowGap * 0.45);
  const deltaX = direction < 0
    ? Math.min(0, rootCenterX - corridor - bounds.maxX)
    : Math.max(0, rootCenterX + corridor - bounds.minX);
  if (Math.abs(deltaX) < 0.001) return;
  for (const [id, point] of localPositions.entries()) {
    localPositions.set(id, { ...point, x: point.x + deltaX });
  }
}

function sideBranchBlockBounds(
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
): { minX: number; maxX: number } | null {
  const points = [...positions.values()];
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x + options.nodeWidth)),
  };
}

function selectedBranchBlockBounds(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
): { minX: number; maxX: number } | null {
  const points = occurrenceIds
    .map((occurrenceId) => positions.get(occurrenceId))
    .filter((point): point is { x: number; y: number } => Boolean(point));
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x + options.nodeWidth)),
  };
}

function shiftPlacedBranchBlockInsideCorridor(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  centerX: number,
  direction: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const bounds = selectedBranchBlockBounds(occurrenceIds, positions, options);
  if (!bounds) return;
  const corridor = Math.max(10, rowGap * 0.45);
  const deltaX = direction < 0
    ? Math.min(0, centerX - corridor - bounds.maxX)
    : Math.max(0, centerX + corridor - bounds.minX);
  if (Math.abs(deltaX) < 0.001) return;
  for (const occurrenceId of occurrenceIds) {
    const point = positions.get(occurrenceId);
    if (!point) continue;
    positions.set(occurrenceId, { ...point, x: point.x + deltaX });
  }
}

function shiftPlacedBranchBlockBetweenCorridors(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  rootCenterX: number,
  globalDirection: -1 | 1,
  anchorEdgeX: number,
  localDirection: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const bounds = selectedBranchBlockBounds(occurrenceIds, positions, options);
  if (!bounds) return;
  const corridor = Math.max(10, rowGap * 0.45);
  let minX = Number.NEGATIVE_INFINITY;
  let maxX = Number.POSITIVE_INFINITY;
  if (globalDirection < 0) maxX = Math.min(maxX, rootCenterX - corridor);
  else minX = Math.max(minX, rootCenterX + corridor);
  if (localDirection < 0) maxX = Math.min(maxX, anchorEdgeX - corridor);
  else minX = Math.max(minX, anchorEdgeX + corridor);

  const blockWidth = bounds.maxX - bounds.minX;
  const hasMin = Number.isFinite(minX);
  const hasMax = Number.isFinite(maxX);
  const availableWidth = hasMin && hasMax ? maxX - minX : Number.POSITIVE_INFINITY;
  let deltaX = 0;
  if (blockWidth > availableWidth) {
    deltaX = localDirection < 0
      ? (hasMax ? maxX - bounds.maxX : 0)
      : (hasMin ? minX - bounds.minX : 0);
  } else {
    if (hasMin && bounds.minX < minX) deltaX = minX - bounds.minX;
    if (hasMax && bounds.maxX + deltaX > maxX) deltaX = maxX - bounds.maxX;
  }
  if (Math.abs(deltaX) < 0.001) return;
  for (const occurrenceId of occurrenceIds) {
    const point = positions.get(occurrenceId);
    if (!point) continue;
    positions.set(occurrenceId, { ...point, x: point.x + deltaX });
  }
}

function expandOpposedSideBranchCorridor(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  anchorOccurrenceId: string,
  rootOccurrenceId: string,
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  rootBranchDirectionByPerson: Map<string, -1 | 1>,
  rootCenterX: number,
  globalDirection: -1 | 1,
  localDirection: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const bounds = selectedBranchBlockBounds(occurrenceIds, positions, options);
  const anchorPosition = positions.get(anchorOccurrenceId);
  if (!bounds || !anchorPosition) return;
  const corridor = Math.max(10, rowGap * 0.45);
  const blockWidth = bounds.maxX - bounds.minX;
  const anchorEdgeX = localDirection > 0
    ? anchorPosition.x + options.nodeWidth
    : anchorPosition.x;
  const minX = Math.max(
    globalDirection > 0 ? rootCenterX + corridor : Number.NEGATIVE_INFINITY,
    localDirection > 0 ? anchorEdgeX + corridor : Number.NEGATIVE_INFINITY,
  );
  const maxX = Math.min(
    globalDirection < 0 ? rootCenterX - corridor : Number.POSITIVE_INFINITY,
    localDirection < 0 ? anchorEdgeX - corridor : Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
  const availableWidth = maxX - minX;
  if (availableWidth >= blockWidth) return;
  const deltaX = globalDirection * (blockWidth - availableWidth + rowGap);
  const occurrenceSet = new Set(occurrenceIds);
  for (const [occurrenceId, point] of positions.entries()) {
    if (occurrenceId === rootOccurrenceId || occurrenceSet.has(occurrenceId)) continue;
    const item = itemByOccurrence.get(occurrenceId);
    if (!item) continue;
    const itemCenterX = point.x + options.nodeWidth / 2;
    const itemDirection = globalSideBranchDirection(
      item,
      rootBranchDirectionByPerson,
      rootCenterX,
      itemCenterX,
    );
    if (itemDirection !== globalDirection) continue;
    positions.set(occurrenceId, { ...point, x: point.x + deltaX });
  }
}

function shiftSideBranchBlockOutOfCollisions(
  localPositions: Map<string, { x: number; y: number }>,
  globalPositions: Map<string, { x: number; y: number }>,
  direction: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  let guard = 0;
  const step = options.nodeWidth + rowGap;
  while (guard < 100 && sideBranchBlockCollides(localPositions, globalPositions, options)) {
    for (const [id, point] of localPositions.entries()) {
      localPositions.set(id, { ...point, x: point.x + direction * step });
    }
    guard += 1;
  }
}

function shiftPlacedBranchBlockOutOfCollisions(
  occurrenceIds: string[],
  positions: Map<string, { x: number; y: number }>,
  direction: -1 | 1,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
) {
  const occurrenceSet = new Set(occurrenceIds);
  const selectedPositions = new Map<string, { x: number; y: number }>();
  const externalPositions = new Map<string, { x: number; y: number }>();
  for (const [occurrenceId, point] of positions.entries()) {
    if (occurrenceSet.has(occurrenceId)) selectedPositions.set(occurrenceId, { ...point });
    else externalPositions.set(occurrenceId, point);
  }
  shiftSideBranchBlockOutOfCollisions(selectedPositions, externalPositions, direction, options, rowGap);
  for (const [occurrenceId, point] of selectedPositions.entries()) positions.set(occurrenceId, point);
}

function sideBranchBlockCollides(
  localPositions: Map<string, { x: number; y: number }>,
  globalPositions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  horizontalPadding = 0,
  verticalPadding = 0,
): boolean {
  for (const point of localPositions.values()) {
    if (overlapsPlacedNode(point.x, point.y, globalPositions, options, horizontalPadding, verticalPadding)) return true;
  }
  return false;
}

function nearestFreeSideBranchX(
  candidateX: number,
  y: number,
  direction: -1 | 1,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  rowGap: number,
): number {
  let x = candidateX;
  let guard = 0;
  while (guard < 100 && overlapsPlacedNode(x, y, positions, options)) {
    x += direction * (options.nodeWidth + rowGap);
    guard += 1;
  }
  return x;
}

function overlapsPlacedNode(
  x: number,
  y: number,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight">,
  horizontalPadding = 0,
  verticalPadding = 0,
): boolean {
  for (const point of positions.values()) {
    if (Math.abs(point.y - y) >= options.nodeHeight + verticalPadding) continue;
    const left = x - horizontalPadding;
    const right = x + options.nodeWidth + horizontalPadding;
    const otherLeft = point.x;
    const otherRight = point.x + options.nodeWidth;
    if (left < otherRight && right > otherLeft) return true;
  }
  return false;
}

function sideBranchOccurrenceSort(
  itemByOccurrence: Map<string, OccurrenceLayoutItem>,
  leftId: string,
  rightId: string,
): number {
  const left = itemByOccurrence.get(leftId)?.occurrence;
  const right = itemByOccurrence.get(rightId)?.occurrence;
  return (left?.path.length ?? 0) - (right?.path.length ?? 0) ||
    leftId.localeCompare(rightId, "uk");
}

function placeAncestorParents(
  graph: NormalizedFamilyGridGraph,
  childOccurrenceId: string,
  childCenterX: number,
  childY: number,
  positions: Map<string, { x: number; y: number }>,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "verticalSpacing">,
  parentGap: number,
  expansionDirection: -1 | 0 | 1,
  widthMemo: Map<string, number>,
  visited: Set<string>,
  fixedPartnerRows: boolean,
) {
  if (visited.has(childOccurrenceId)) return;
  visited.add(childOccurrenceId);
  const familyUnit = graph.parentFamilyByChild.get(childOccurrenceId);
  if (!familyUnit) return;
  const parentOccurrenceIds = orderedParentOccurrenceIds(familyUnit);
  const parentY = childY - options.verticalSpacing;
  if (parentOccurrenceIds.length === 1) {
    const parentId = parentOccurrenceIds[0];
    const side = parentSideForOccurrence(parentId, familyUnit.edges);
    const branchWidth = ancestorBranchWidth(graph, parentId, options.nodeWidth, parentGap, widthMemo, new Set());
    const offset = Math.max(options.nodeWidth / 2 + parentGap / 2, branchWidth / 2);
    const x = side === 1
      ? childCenterX + offset - options.nodeWidth / 2
      : side === 0
        ? childCenterX - offset - options.nodeWidth / 2
        : childCenterX - options.nodeWidth / 2;
    positions.set(parentId, { x, y: parentY });
    placeAncestorParents(
      graph,
      parentId,
      x + options.nodeWidth / 2,
      parentY,
      positions,
      options,
      parentGap,
      ancestorExpansionDirection(parentId, familyUnit, expansionDirection),
      widthMemo,
      visited,
      fixedPartnerRows,
    );
    return;
  }
  const parentWidths = fixedPartnerRows
    ? parentOccurrenceIds.map(() => options.nodeWidth)
    : parentOccurrenceIds.map((parentId) => ancestorBranchWidth(
      graph,
      parentId,
      options.nodeWidth,
      parentGap,
      widthMemo,
      new Set(),
    ));
  const totalWidth = parentWidths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, parentOccurrenceIds.length - 1) * parentGap;
  let cursor = fixedPartnerRows && expansionDirection < 0
    ? childCenterX - totalWidth
    : fixedPartnerRows && expansionDirection > 0
      ? childCenterX
      : childCenterX - totalWidth / 2;
  for (let index = 0; index < parentOccurrenceIds.length; index += 1) {
    const parentId = parentOccurrenceIds[index];
    const branchWidth = parentWidths[index];
    const parentCenterX = cursor + branchWidth / 2;
    const x = parentCenterX - options.nodeWidth / 2;
    positions.set(parentId, { x, y: parentY });
    placeAncestorParents(
      graph,
      parentId,
      parentCenterX,
      parentY,
      positions,
      options,
      parentGap,
      ancestorExpansionDirection(parentId, familyUnit, expansionDirection),
      widthMemo,
      visited,
      fixedPartnerRows,
    );
    cursor += branchWidth + parentGap;
  }
}

function ancestorExpansionDirection(
  occurrenceId: string,
  familyUnit: NormalizedFamilyUnit,
  fallback: -1 | 0 | 1,
): -1 | 0 | 1 {
  const side = parentSideForOccurrence(occurrenceId, familyUnit.edges);
  if (side === 0) return -1;
  if (side === 1) return 1;
  return fallback;
}

function ancestorBranchWidth(
  graph: NormalizedFamilyGridGraph,
  occurrenceId: string,
  nodeWidth: number,
  parentGap: number,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(occurrenceId);
  if (cached !== undefined) return cached;
  if (visiting.has(occurrenceId)) return nodeWidth;
  visiting.add(occurrenceId);
  const familyUnit = graph.parentFamilyByChild.get(occurrenceId);
  if (!familyUnit) {
    memo.set(occurrenceId, nodeWidth);
    visiting.delete(occurrenceId);
    return nodeWidth;
  }
  const parents = orderedParentOccurrenceIds(familyUnit);
  if (parents.length === 0) {
    memo.set(occurrenceId, nodeWidth);
    visiting.delete(occurrenceId);
    return nodeWidth;
  }
  const parentWidth = parents.reduce(
    (sum, parentId) => sum + ancestorBranchWidth(graph, parentId, nodeWidth, parentGap, memo, visiting),
    0,
  ) + Math.max(0, parents.length - 1) * parentGap;
  if (parents.length === 1) {
    const width = Math.max(nodeWidth, parentWidth + parentGap);
    memo.set(occurrenceId, width);
    visiting.delete(occurrenceId);
    return width;
  }
  const width = Math.max(nodeWidth, parentWidth);
  memo.set(occurrenceId, width);
  visiting.delete(occurrenceId);
  return width;
}

function orderedParentOccurrenceIds(familyUnit: NormalizedFamilyUnit): string[] {
  return [...familyUnit.parentOccurrenceIds].sort((left, right) => {
    const leftSide = parentSideForOccurrence(left, familyUnit.edges);
    const rightSide = parentSideForOccurrence(right, familyUnit.edges);
    return leftSide - rightSide || left.localeCompare(right, "uk");
  });
}

function gridEdgePath(edge: FamilyTreeEdgeDto, from: FamilyTreeLayoutNode, to: FamilyTreeLayoutNode): string {
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
  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${fromCenterX} ${startY} V ${midY} H ${toCenterX} V ${endY}`;
}

export function buildFamilyGridLayoutModel(
  graph: NormalizedFamilyGridGraph,
  layout: FamilyTreeViewerLayout,
): FamilyGridLayoutModel {
  const blocks: FamilyGridBlock[] = [];
  const nodeByOccurrence = new Map(layout.nodes.map((node) => [node.occurrence.id, node]));
  const columnWidth = averageBlockWidth(layout.nodes);
  const rowHeight = averageRowHeight(layout.nodes);

  for (const node of layout.nodes) {
    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;
    const row = Math.round(node.y / rowHeight);
    const column = Math.round(centerX / columnWidth);
    const localWidth = subtreeWidthForOccurrence(node.occurrence.id, graph, nodeByOccurrence);
    blocks.push({
      id: `person:${node.occurrence.id}`,
      kind: "person",
      row,
      column,
      occurrenceId: node.occurrence.id,
      subtreeWidth: localWidth.total,
      reservedLeftWidth: localWidth.left,
      reservedRightWidth: localWidth.right,
      centerX,
      centerY,
    });
  }

  for (const unit of layout.familyUnits) {
    const parentRows = unit.parents.map((parent) => parent.y);
    const childRows = unit.children.map((child) => child.y);
    const row = Math.round(((Math.max(...parentRows) + Math.min(...childRows)) / 2) / rowHeight);
    blocks.push({
      id: `union:${unit.key}`,
      kind: "union",
      row,
      column: Math.round(unit.unitX / columnWidth),
      familyUnitKey: unit.key,
      subtreeWidth: Math.max(
        1,
        Math.ceil((Math.max(...unit.children.map((child) => child.x + child.width)) - Math.min(...unit.children.map((child) => child.x))) / columnWidth),
      ),
      reservedLeftWidth: Math.max(0, unit.unitX - Math.min(...unit.parents.map((parent) => parent.x))),
      reservedRightWidth: Math.max(0, Math.max(...unit.parents.map((parent) => parent.x + parent.width)) - unit.unitX),
      centerX: unit.unitX,
      centerY: unit.parentBusY,
    });
  }

  for (const placeholder of layout.placeholders ?? []) {
    blocks.push({
      id: `placeholder:${placeholder.id}`,
      kind: "placeholder",
      row: placeholder.row,
      column: placeholder.column,
      placeholderId: placeholder.id,
      occurrenceId: placeholder.targetOccurrenceId,
      subtreeWidth: placeholder.width,
      reservedLeftWidth: placeholder.width / 2,
      reservedRightWidth: placeholder.width / 2,
      centerX: placeholder.x + placeholder.width / 2,
      centerY: placeholder.y + placeholder.height / 2,
    });
  }

  return { graph, blocks };
}

export function buildFamilyGridPlaceholders(
  graph: FamilyTreeGraphDto,
  layout: FamilyTreeViewerLayout,
  options: Pick<FamilyGridLayoutOptions, "nodeWidth" | "nodeHeight" | "verticalSpacing">,
): FamilyTreeLayoutPlaceholder[] {
  const relationFlags = familyTreeRelationFlagsByPerson(graph);
  const compactSize = Math.max(34, Math.round(options.nodeHeight * 0.34));
  const parentWidth = Math.max(86, Math.round(options.nodeWidth * 0.46));
  const parentHeight = Math.max(64, Math.round(options.nodeHeight * 0.62));
  const actionWidth = Math.max(112, Math.round(options.nodeWidth * 0.58));
  const actionHeight = Math.max(54, Math.round(options.nodeHeight * 0.5));
  const parentTopOffset = Math.max(parentHeight + 18, Math.round(options.verticalSpacing * 0.54));
  const parentGap = Math.max(14, Math.round(options.nodeWidth * 0.08));
  const actionGap = Math.max(18, Math.round(options.nodeWidth * 0.1));
  const placeholders: FamilyTreeLayoutPlaceholder[] = [];
  const directBackboneIds = placeholderDirectBackboneOccurrenceIds(graph, layout);
  const nodeByOccurrence = new Map(layout.nodes.map((node) => [node.occurrence.id, node]));
  const showRootActionPlaceholders = false;

  for (const node of layout.nodes) {
    const flags = relationFlags.get(node.person.personId) ?? emptyFamilyTreeRelationFlags();
    const isRoot = node.occurrence.id === layout.rootOccurrenceId;
    const canShowParentPlaceholders = directBackboneIds.has(node.occurrence.id);
    const nodeCenterX = node.x + node.width / 2;
    const parentY = node.y - parentTopOffset;
    if (canShowParentPlaceholders && flags.biologicalFathers === 0) {
      const placeholder = missingParentPlaceholderPosition({
        graph,
        node,
        nodeByOccurrence,
        action: "add_father",
        parentY,
        parentWidth,
        parentHeight,
        parentGap,
      }) ?? {
        x: nodeCenterX - parentGap / 2 - parentWidth,
        y: parentY,
        width: parentWidth,
        height: parentHeight,
      };
      placeholders.push({
        id: `${node.occurrence.id}:add-father`,
        action: "add_father",
        label: "Додати батька",
        targetOccurrenceId: node.occurrence.id,
        ...placeholder,
        row: node.occurrence.generation - 1,
        column: Math.round((nodeCenterX - parentGap / 2 - parentWidth / 2) / Math.max(1, options.nodeWidth)),
        connectionPath: placeholderConnectionPathForAction("add_father", placeholder, node),
        dashArray: "6 6",
      });
    }
    if (canShowParentPlaceholders && flags.biologicalMothers === 0) {
      const placeholder = missingParentPlaceholderPosition({
        graph,
        node,
        nodeByOccurrence,
        action: "add_mother",
        parentY,
        parentWidth,
        parentHeight,
        parentGap,
      }) ?? {
        x: nodeCenterX + parentGap / 2,
        y: parentY,
        width: parentWidth,
        height: parentHeight,
      };
      placeholders.push({
        id: `${node.occurrence.id}:add-mother`,
        action: "add_mother",
        label: "Додати матір",
        targetOccurrenceId: node.occurrence.id,
        ...placeholder,
        row: node.occurrence.generation - 1,
        column: Math.round((nodeCenterX + parentGap / 2 + parentWidth / 2) / Math.max(1, options.nodeWidth)),
        connectionPath: placeholderConnectionPathForAction("add_mother", placeholder, node),
        dashArray: "6 6",
      });
    }
    if (showRootActionPlaceholders && isRoot && flags.partners === 0) {
      const placeholder = {
        x: node.x + node.width + actionGap,
        y: node.y + (node.height - actionHeight) / 2,
        width: actionWidth,
        height: actionHeight,
      };
      placeholders.push({
        id: `${node.occurrence.id}:add-partner`,
        action: "add_partner",
        label: "Додати партнера",
        targetOccurrenceId: node.occurrence.id,
        ...placeholder,
        row: node.occurrence.generation,
        column: Math.round((placeholder.x + placeholder.width / 2) / Math.max(1, options.nodeWidth)),
        connectionPath: placeholderConnectionPathForAction("add_partner", placeholder, node),
        dashArray: "6 6",
      });
    }
    if (showRootActionPlaceholders && isRoot && flags.children === 0) {
      const placeholder = {
        x: nodeCenterX - actionWidth / 2,
        y: node.y + node.height + Math.max(22, Math.round(options.verticalSpacing * 0.22)),
        width: actionWidth,
        height: actionHeight,
      };
      placeholders.push({
        id: `${node.occurrence.id}:add-child`,
        action: "add_child",
        label: "Додати дитину",
        targetOccurrenceId: node.occurrence.id,
        ...placeholder,
        row: node.occurrence.generation + 1,
        column: Math.round((placeholder.x + placeholder.width / 2) / Math.max(1, options.nodeWidth)),
        connectionPath: placeholderConnectionPathForAction("add_child", placeholder, node),
        dashArray: "6 6",
      });
    }
    placeholders.push({
      id: `${node.occurrence.id}:open-menu`,
      action: "open_menu",
      label: "Додати родича",
      targetOccurrenceId: node.occurrence.id,
      x: node.x + node.width - compactSize / 2,
      y: node.y + node.height - compactSize / 2,
      width: compactSize,
      height: compactSize,
      row: node.occurrence.generation,
      column: Math.round((node.x + node.width) / Math.max(1, options.nodeWidth)),
    });
  }
  return resolvePlaceholderRowOverlaps(placeholders, layout).sort((left, right) =>
    left.row - right.row ||
    left.x - right.x ||
    left.id.localeCompare(right.id, "uk"),
  );
}

function placeholderDirectBackboneOccurrenceIds(
  graph: FamilyTreeGraphDto,
  layout: FamilyTreeViewerLayout,
): Set<string> {
  const rootOccurrenceId = layout.rootOccurrenceId;
  if (!rootOccurrenceId) return new Set();
  const visibleOccurrenceIds = new Set(layout.nodes.map((node) => node.occurrence.id));
  const result = new Set<string>([rootOccurrenceId]);
  const queue = [rootOccurrenceId];
  while (queue.length) {
    const childId = queue.shift();
    if (!childId) continue;
    for (const edge of graph.edges) {
      if (edge.kind !== "parent_child") continue;
      if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
      if (edge.toOccurrenceId !== childId) continue;
      if (!visibleOccurrenceIds.has(edge.fromOccurrenceId) || result.has(edge.fromOccurrenceId)) continue;
      result.add(edge.fromOccurrenceId);
      queue.push(edge.fromOccurrenceId);
    }
  }
  return result;
}

function missingParentPlaceholderPosition(input: {
  graph: FamilyTreeGraphDto;
  node: FamilyTreeLayoutNode;
  nodeByOccurrence: Map<string, FamilyTreeLayoutNode>;
  action: "add_father" | "add_mother";
  parentY: number;
  parentWidth: number;
  parentHeight: number;
  parentGap: number;
}): { x: number; y: number; width: number; height: number } | null {
  const siblingSide = input.action === "add_father" ? 1 : 0;
  const siblingEdge = input.graph.edges.find((edge) =>
    edge.kind === "parent_child" &&
    edge.toOccurrenceId === input.node.occurrence.id &&
    edge.fromOccurrenceId &&
    normalizedParentSideForEdge(edge) === siblingSide,
  );
  const sibling = siblingEdge?.fromOccurrenceId
    ? input.nodeByOccurrence.get(siblingEdge.fromOccurrenceId)
    : null;
  if (!sibling) return null;
  const x = input.action === "add_father"
    ? sibling.x - input.parentGap - input.parentWidth
    : sibling.x + sibling.width + input.parentGap;
  return {
    x,
    y: sibling.y + (sibling.height - input.parentHeight) / 2,
    width: input.parentWidth,
    height: input.parentHeight,
  };
}

function normalizedParentSideForEdge(edge: FamilyTreeEdgeDto): number {
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? "").toLocaleLowerCase("uk");
  if (role.includes("\u0431\u0430\u0442") || role.includes("father")) return 0;
  if (role.includes("\u043c\u0430\u0442") || role.includes("mother")) return 1;
  return parentSideForEdge(edge);
}

function parentSideForEdge(edge: FamilyTreeEdgeDto): number {
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? "").toLocaleLowerCase("uk");
  if (role.includes("father") || role.includes("бать") || role.includes("Р±Р°С‚СЊ")) return 0;
  if (role.includes("mother") || role.includes("мат") || role.includes("РјР°С‚")) return 1;
  return 2;
}

function resolvePlaceholderRowOverlaps(
  placeholders: FamilyTreeLayoutPlaceholder[],
  layout: FamilyTreeViewerLayout,
): FamilyTreeLayoutPlaceholder[] {
  const nodeByOccurrence = new Map(layout.nodes.map((node) => [node.occurrence.id, node]));
  const rows = new Map<number, FamilyTreeLayoutPlaceholder[]>();
  for (const placeholder of placeholders) {
    const row = rows.get(placeholder.row) ?? [];
    row.push({ ...placeholder });
    rows.set(placeholder.row, row);
  }
  const gap = 10;
  for (const [rowIndex, row] of rows.entries()) {
    const anchorCenterY = placeholderRowAnchorCenterY(rowIndex, row, layout);
    if (anchorCenterY !== null) {
      for (const placeholder of row) {
        if (placeholder.action === "open_menu") continue;
        placeholder.y = anchorCenterY - placeholder.height / 2;
      }
    }
    row.sort((left, right) => left.x - right.x || left.id.localeCompare(right.id, "uk"));
    let cursor = -Infinity;
    for (const placeholder of row) {
      if (placeholder.x < cursor) {
        placeholder.x = cursor;
        placeholder.column = Math.round((placeholder.x + placeholder.width / 2) / Math.max(1, layout.nodes[0]?.width ?? 1));
      }
      cursor = placeholder.x + placeholder.width + gap;
      const target = nodeByOccurrence.get(placeholder.targetOccurrenceId);
      if (target && placeholder.action !== "open_menu") {
        placeholder.connectionPath = placeholderConnectionPathForAction(placeholder.action, placeholder, target);
      }
    }
  }
  return [...rows.values()].flat();
}

function placeholderRowAnchorCenterY(
  rowIndex: number,
  row: FamilyTreeLayoutPlaceholder[],
  layout: FamilyTreeViewerLayout,
): number | null {
  const nodesOnRow = layout.nodes.filter((node) => node.occurrence.generation === rowIndex);
  if (nodesOnRow.length) {
    const centers = nodesOnRow
      .map((node) => node.y + node.height / 2)
      .sort((left, right) => left - right);
    return centers[Math.floor(centers.length / 2)];
  }
  const visiblePlaceholders = row.filter((placeholder) => placeholder.action !== "open_menu");
  if (!visiblePlaceholders.length) return null;
  const centers = visiblePlaceholders
    .map((placeholder) => placeholder.y + placeholder.height / 2)
    .sort((left, right) => left - right);
  return centers[Math.floor(centers.length / 2)];
}

function placeholderConnectionPathForAction(
  action: FamilyTreeLayoutPlaceholder["action"],
  placeholder: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): string {
  if (action === "add_partner") return partnerPlaceholderConnectionPath(placeholder, node);
  if (action === "add_child") return childPlaceholderConnectionPath(placeholder, node);
  return placeholderConnectionPath(placeholder, node);
}

function placeholderConnectionPath(
  placeholder: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height?: number },
): string {
  const startX = placeholder.x + placeholder.width / 2;
  const startY = placeholder.y + placeholder.height;
  const endX = node.x + node.width / 2;
  const endY = node.y;
  const midY = startY + Math.max(16, (endY - startY) / 2);
  return `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`;
}

function partnerPlaceholderConnectionPath(
  placeholder: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): string {
  const nodeCenterY = node.y + node.height / 2;
  if (placeholder.x >= node.x + node.width) {
    return `M ${node.x + node.width} ${nodeCenterY} H ${placeholder.x}`;
  }
  if (placeholder.x + placeholder.width <= node.x) {
    return `M ${node.x} ${nodeCenterY} H ${placeholder.x + placeholder.width}`;
  }
  const placeholderCenterX = placeholder.x + placeholder.width / 2;
  const placeholderCenterY = placeholder.y + placeholder.height / 2;
  return `M ${node.x + node.width / 2} ${nodeCenterY} V ${placeholderCenterY} H ${placeholderCenterX}`;
}

function childPlaceholderConnectionPath(
  placeholder: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): string {
  const startX = node.x + node.width / 2;
  const startY = node.y + node.height;
  const endX = placeholder.x + placeholder.width / 2;
  const endY = placeholder.y;
  const midY = startY + Math.max(12, (endY - startY) / 2);
  return `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`;
}

function withPlaceholderBounds(
  layout: FamilyTreeViewerLayout,
  placeholders: FamilyTreeLayoutPlaceholder[],
  padding: number,
): FamilyTreeViewerLayout {
  if (!placeholders.length) return layout;
  const minX = Math.min(layout.minX + padding, ...placeholders.map((placeholder) => placeholder.x));
  const minY = Math.min(layout.minY + padding, ...placeholders.map((placeholder) => placeholder.y));
  const maxX = Math.max(layout.maxX - padding, ...placeholders.map((placeholder) => placeholder.x + placeholder.width));
  const maxY = Math.max(layout.maxY - padding, ...placeholders.map((placeholder) => placeholder.y + placeholder.height));
  return {
    ...layout,
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    width: Math.max(720, maxX - minX + padding * 2),
    height: Math.max(420, maxY - minY + padding * 2),
  };
}

export function normalizeFamilyGridGraph(graph: FamilyTreeGraphDto): NormalizedFamilyGridGraph {
  const peopleById = new Map(graph.nodes.map((node) => [node.personId, node]));
  const occurrenceById = new Map(graph.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const parentChildRelations = graph.edges
    .filter((edge) => edge.kind === "parent_child" && edge.fromOccurrenceId && edge.toOccurrenceId)
    .sort(stableEdgeSort);
  const partnerRelations = graph.edges
    .filter((edge) => edge.kind === "partner" && edge.fromOccurrenceId && edge.toOccurrenceId)
    .sort(stableEdgeSort);
  const familyUnits = normalizedFamilyUnits(parentChildRelations, occurrenceById, peopleById);
  const childrenByFamilyUnit = new Map<string, string[]>();
  const parentFamilyByChild = new Map<string, NormalizedFamilyUnit>();
  const spouseFamiliesByPerson = new Map<string, NormalizedFamilyUnit[]>();

  for (const unit of familyUnits) {
    childrenByFamilyUnit.set(unit.key, unit.childOccurrenceIds);
    for (const childId of unit.childOccurrenceIds) parentFamilyByChild.set(childId, unit);
    for (const parentId of unit.parentOccurrenceIds) {
      const row = spouseFamiliesByPerson.get(parentId) ?? [];
      row.push(unit);
      spouseFamiliesByPerson.set(parentId, row);
    }
  }

  for (const [personId, units] of spouseFamiliesByPerson.entries()) {
    spouseFamiliesByPerson.set(personId, [...units].sort((left, right) =>
      left.childOccurrenceIds.join("|").localeCompare(right.childOccurrenceIds.join("|"), "uk") ||
      left.key.localeCompare(right.key, "uk"),
    ));
  }

  return {
    peopleById,
    occurrenceById,
    parentChildRelations,
    partnerRelations,
    familyUnits,
    childrenByFamilyUnit,
    parentFamilyByChild,
    spouseFamiliesByPerson,
  };
}

function normalizedFamilyUnits(
  parentChildRelations: FamilyTreeEdgeDto[],
  occurrenceById: Map<string, FamilyTreeOccurrenceDto>,
  peopleById: Map<string, FamilyTreeNodeDto>,
): NormalizedFamilyUnit[] {
  const edgesByChild = new Map<string, FamilyTreeEdgeDto[]>();
  for (const edge of parentChildRelations) {
    if (!edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const row = edgesByChild.get(edge.toOccurrenceId) ?? [];
    row.push(edge);
    edgesByChild.set(edge.toOccurrenceId, row);
  }

  const groups = new Map<string, NormalizedFamilyUnit>();
  for (const [childOccurrenceId, childEdges] of edgesByChild.entries()) {
    const childGeneration = occurrenceById.get(childOccurrenceId)?.generation ?? 0;
    for (const familyEdges of partitionChildFamilyEdges(childEdges)) {
      const parentOccurrenceIds = orderedParentIdsForEdges(familyEdges);
      const key = normalizedFamilyUnitKey(childOccurrenceId, childGeneration, parentOccurrenceIds, familyEdges);
      const row = groups.get(key) ?? {
        key,
        parentOccurrenceIds: [],
        childOccurrenceIds: [],
        parentSetId: commonEdgeValue(familyEdges, "parentSetId"),
        familyGroupId: commonEdgeValue(familyEdges, "familyGroupId"),
        edges: [],
      };
      for (const parentId of parentOccurrenceIds) {
        if (!row.parentOccurrenceIds.includes(parentId)) row.parentOccurrenceIds.push(parentId);
      }
      if (!row.childOccurrenceIds.includes(childOccurrenceId)) row.childOccurrenceIds.push(childOccurrenceId);
      row.edges.push(...familyEdges);
      groups.set(key, row);
    }
  }
  return [...groups.values()].map((unit) => ({
    ...unit,
    parentOccurrenceIds: [...unit.parentOccurrenceIds].sort((left, right) =>
      parentSideForOccurrence(left, unit.edges) - parentSideForOccurrence(right, unit.edges) ||
      left.localeCompare(right, "uk"),
    ),
    childOccurrenceIds: [...unit.childOccurrenceIds].sort((left, right) =>
      stableOccurrenceSort(left, right, occurrenceById, peopleById),
    ),
    edges: [...unit.edges].sort(stableEdgeSort),
  })).sort((left, right) => left.key.localeCompare(right.key, "uk"));
}

function partitionChildFamilyEdges(edges: FamilyTreeEdgeDto[]): FamilyTreeEdgeDto[][] {
  const withParentSet = edges.filter((edge) => Boolean(edge.parentSetId));
  if (withParentSet.length) {
    const grouped = groupEdgesBy(edges, (edge) => edge.parentSetId ?? fallbackChildFamilyEdgeKey(edge));
    return [...grouped.values()];
  }
  const grouped = groupEdgesBy(edges, fallbackChildFamilyEdgeKey);
  return [...grouped.values()];
}

function groupEdgesBy(
  edges: FamilyTreeEdgeDto[],
  keyForEdge: (edge: FamilyTreeEdgeDto) => string,
): Map<string, FamilyTreeEdgeDto[]> {
  const grouped = new Map<string, FamilyTreeEdgeDto[]>();
  for (const edge of edges) {
    const key = keyForEdge(edge);
    const row = grouped.get(key) ?? [];
    row.push(edge);
    grouped.set(key, row);
  }
  return grouped;
}

function fallbackChildFamilyEdgeKey(edge: FamilyTreeEdgeDto): string {
  const familyGroupId = edge.familyGroupId?.trim();
  if (familyGroupId) return `family:${familyGroupId}`;
  return `type:${normalizeParentRelationshipType(edge.relationshipType)}`;
}

function orderedParentIdsForEdges(edges: FamilyTreeEdgeDto[]): string[] {
  return [...new Set(edges
    .map((edge) => edge.fromOccurrenceId)
    .filter((occurrenceId): occurrenceId is string => Boolean(occurrenceId)))]
    .sort((left, right) =>
      parentSideForOccurrence(left, edges) - parentSideForOccurrence(right, edges) ||
      left.localeCompare(right, "uk"),
    );
}

function normalizedFamilyUnitKey(
  childOccurrenceId: string,
  childGeneration: number,
  parentOccurrenceIds: string[],
  edges: FamilyTreeEdgeDto[],
): string {
  const relationshipKey = normalizedParentRelationshipSignature(parentOccurrenceIds, edges);
  if (parentOccurrenceIds.length >= 2) {
    return `parents:${parentOccurrenceIds.join("|")}:generation:${childGeneration}:types:${relationshipKey}`;
  }
  const sourceKey = commonEdgeValue(edges, "parentSetId") ??
    commonEdgeValue(edges, "familyGroupId") ??
    `child:${childOccurrenceId}`;
  return `source:${sourceKey}:parents:${parentOccurrenceIds.join("|")}:generation:${childGeneration}:types:${relationshipKey}`;
}

function normalizedParentRelationshipSignature(
  parentOccurrenceIds: string[],
  edges: FamilyTreeEdgeDto[],
): string {
  return parentOccurrenceIds.map((parentId) => {
    const edge = edges.find((item) => item.fromOccurrenceId === parentId);
    return normalizeParentRelationshipType(edge?.relationshipType);
  }).join("|") || "none";
}

function normalizeParentRelationshipType(type: string | null | undefined): string {
  const value = type?.trim().toLowerCase();
  if (!value || value === "parent") return "biological";
  return value;
}

function commonEdgeValue(
  edges: FamilyTreeEdgeDto[],
  key: "parentSetId" | "familyGroupId",
): string | null {
  const values = [...new Set(edges.map((edge) => edge[key]).filter((value): value is string => Boolean(value)))];
  return values.length === 1 ? values[0] : null;
}

function subtreeWidthForOccurrence(
  occurrenceId: string,
  graph: NormalizedFamilyGridGraph,
  nodeByOccurrence: Map<string, { x: number; width: number }>,
): { left: number; right: number; total: number } {
  const node = nodeByOccurrence.get(occurrenceId);
  if (!node) return { left: 0, right: 0, total: 1 };
  const axis = node.x + node.width / 2;
  const parentUnit = graph.parentFamilyByChild.get(occurrenceId);
  if (!parentUnit) return { left: node.width / 2, right: node.width / 2, total: node.width };
  const parentNodes = parentUnit.parentOccurrenceIds
    .map((id) => nodeByOccurrence.get(id))
    .filter((item): item is { x: number; width: number } => Boolean(item));
  if (!parentNodes.length) return { left: node.width / 2, right: node.width / 2, total: node.width };
  const minX = Math.min(node.x, ...parentNodes.map((item) => item.x));
  const maxX = Math.max(node.x + node.width, ...parentNodes.map((item) => item.x + item.width));
  return {
    left: Math.max(0, axis - minX),
    right: Math.max(0, maxX - axis),
    total: Math.max(node.width, maxX - minX),
  };
}

function stableEdgeSort(left: FamilyTreeEdgeDto, right: FamilyTreeEdgeDto): number {
  return left.relationshipId.localeCompare(right.relationshipId, "uk") ||
    left.id.localeCompare(right.id, "uk");
}

function stableOccurrenceSort(
  leftOccurrenceId: string,
  rightOccurrenceId: string,
  occurrenceById: Map<string, FamilyTreeOccurrenceDto>,
  peopleById: Map<string, FamilyTreeNodeDto>,
): number {
  const leftDate = sortableDateFromOccurrenceId(leftOccurrenceId, occurrenceById, peopleById);
  const rightDate = sortableDateFromOccurrenceId(rightOccurrenceId, occurrenceById, peopleById);
  if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate, "uk");
  if (leftDate && !rightDate) return -1;
  if (!leftDate && rightDate) return 1;
  return leftOccurrenceId.localeCompare(rightOccurrenceId, "uk");
}

function sortableDateFromOccurrenceId(
  occurrenceId: string,
  occurrenceById: Map<string, FamilyTreeOccurrenceDto>,
  peopleById: Map<string, FamilyTreeNodeDto>,
): string {
  const occurrence = occurrenceById.get(occurrenceId);
  const person = occurrence ? peopleById.get(occurrence.personId) : null;
  if (!person) return "";
  const birthEvent = person.events.find((event) => ["birth", "baptism", "christening"].includes(event.eventType));
  const rawDate = [birthEvent?.eventDate, birthEvent?.dateFrom, birthEvent?.dateText].find(Boolean) ?? "";
  return sortableDateText(rawDate);
}

function sortableDateText(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const iso = text.match(/\b(1[0-9]{3}|20[0-9]{2})(?:-(0[1-9]|1[0-2]))?(?:-(0[1-9]|[12][0-9]|3[01]))?\b/);
  if (iso) return [iso[1], iso[2] ?? "00", iso[3] ?? "00"].join("-");
  const dotted = text.match(/\b(?:(0?[1-9]|[12][0-9]|3[01])\.)?(?:(0?[1-9]|1[0-2])\.)?(1[0-9]{3}|20[0-9]{2})\b/);
  if (dotted) {
    const day = dotted[1]?.padStart(2, "0") ?? "00";
    const month = dotted[2]?.padStart(2, "0") ?? "00";
    return [dotted[3], month, day].join("-");
  }
  const year = text.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return year ? `${year[1]}-00-00` : "";
}

function parentSideForOccurrence(occurrenceId: string, edges: FamilyTreeEdgeDto[]): number {
  const edge = edges.find((item) => item.fromOccurrenceId === occurrenceId);
  const role = String(edge?.parentRoleLabel ?? edge?.metadata?.parentRoleLabel ?? "").toLocaleLowerCase("uk");
  if (role.includes("father") || role.includes("бать")) return 0;
  if (role.includes("mother") || role.includes("мат")) return 1;
  return 2;
}

function averageBlockWidth(nodes: Array<{ width: number }>): number {
  if (!nodes.length) return 1;
  return Math.max(1, nodes.reduce((sum, node) => sum + node.width, 0) / nodes.length);
}

function averageRowHeight(nodes: Array<{ y: number; height: number }>): number {
  if (nodes.length < 2) return Math.max(1, nodes[0]?.height ?? 1);
  const rows = [...new Set(nodes.map((node) => node.y))].sort((left, right) => left - right);
  const diffs = rows.slice(1).map((row, index) => Math.abs(row - rows[index]));
  return Math.max(1, diffs.length ? Math.min(...diffs) : nodes[0].height);
}
