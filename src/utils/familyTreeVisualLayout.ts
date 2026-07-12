import type {
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutFamilyUnit,
  FamilyTreeLayoutNode,
  FamilyTreeLayoutPlaceholder,
  FamilyTreeViewerLayout,
  FamilyTreeViewerLayoutOptions,
} from "./familyTreeViewerLayout";
import {
  buildFamilyTreeLayoutFamilyUnits,
  edgeDashArray,
  resolveNodeBadges,
} from "./familyTreeViewerLayout.ts";
import type { FamilyTreeGraphDto } from "../types/familyTree";
import type { FamilyTreeViewportState } from "../hooks/useFamilyTreeViewport";
import {
  buildFamilyTreeBlockGridLayout,
  buildFamilyGridPlaceholders,
  buildFamilyGridLayoutModel,
  normalizeFamilyGridGraph,
  type FamilyGridBlock,
  type FamilyGridLayoutModel,
  type NormalizedFamilyGridGraph,
} from "./familyTreeGridLayout.ts";

export type VisualNode = FamilyTreeLayoutNode;
export type VisualEdge = FamilyTreeLayoutEdge;
export type FamilyVisualGroup = FamilyTreeLayoutFamilyUnit;
export type TreeLayoutResult = FamilyTreeViewerLayout;
export type ViewportTransform = FamilyTreeViewportState;
export type VisualGridBlock = FamilyGridBlock;
export type VisualGridLayoutModel = FamilyGridLayoutModel;
export type VisualNormalizedFamilyGraph = NormalizedFamilyGridGraph;

export type UnionVisualNode = {
  id: string;
  familyGroupKey: string;
  x: number;
  y: number;
  parentOccurrenceIds: string[];
  childOccurrenceIds: string[];
};

export type TreeLayoutBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

export function calculateTreeLayout(
  graph: FamilyTreeGraphDto,
  options: FamilyTreeViewerLayoutOptions = {},
): TreeLayoutResult {
  return buildFamilyTreeBlockGridLayout(graph, options);
}

export type FamilyTreeLayoutCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "length" | "key">>;

export type FamilyTreeLayoutCacheOptions = {
  storage?: FamilyTreeLayoutCacheStorage | null;
  namespace?: string;
  maxBytes?: number;
};

type CachedLayoutProjection = {
  version: typeof LAYOUT_CACHE_VERSION;
  signature: string;
  rootOccurrenceId: string | null;
  nodes: Array<{
    occurrenceId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

const DEFAULT_LAYOUT_CACHE_NAMESPACE = "family-tree-layout";
const DEFAULT_LAYOUT_CACHE_MAX_BYTES = 900_000;
const LAYOUT_CACHE_VERSION = 18;
const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 88;
const DEFAULT_HORIZONTAL_SPACING = 150;
const DEFAULT_VERTICAL_SPACING = 132;
const DEFAULT_PADDING = 52;

export function calculateTreeLayoutWithCache(
  graph: FamilyTreeGraphDto,
  options: FamilyTreeViewerLayoutOptions = {},
  cacheOptions: FamilyTreeLayoutCacheOptions = {},
): TreeLayoutResult {
  const storage = resolveLayoutCacheStorage(cacheOptions.storage);
  const signature = familyTreeLayoutProjectionSignature(graph, options);
  const cacheKey = familyTreeLayoutCacheKey(graph, signature, cacheOptions.namespace);
  const treeCachePrefix = familyTreeLayoutTreeCachePrefix(graph, cacheOptions.namespace);
  const cached = storage ? readCachedLayoutProjection(storage, cacheKey, signature) : null;
  const cachedLayout = cached ? layoutFromCachedProjection(graph, cached, options) : null;
  if (cachedLayout) return cachedLayout;

  const layout = calculateTreeLayout(graph, options);
  if (storage) {
    writeCachedLayoutProjection(
      storage,
      cacheKey,
      treeCachePrefix,
      signature,
      layout,
      cacheOptions.maxBytes,
    );
  }
  return layout;
}

export function filterTreeLayoutByOccurrence(
  layout: TreeLayoutResult,
  isVisible: (node: FamilyTreeLayoutNode) => boolean,
): TreeLayoutResult {
  const nodes = layout.nodes.filter(isVisible);
  const visibleOccurrenceIds = new Set(nodes.map((node) => node.occurrence.id));
  const edges = layout.edges.filter((edge) =>
    visibleOccurrenceIds.has(edge.from.occurrence.id) &&
    visibleOccurrenceIds.has(edge.to.occurrence.id),
  );
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);
  const placeholders = (layout.placeholders ?? []).filter((placeholder) =>
    visibleOccurrenceIds.has(placeholder.targetOccurrenceId),
  );
  const bounds = layoutBounds(nodes, placeholders, DEFAULT_PADDING);
  return {
    ...layout,
    nodes,
    edges,
    familyUnits,
    placeholders,
    width: Math.max(720, bounds.maxX - bounds.minX),
    height: Math.max(420, bounds.maxY - bounds.minY),
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    rootOccurrenceId: layout.rootOccurrenceId && visibleOccurrenceIds.has(layout.rootOccurrenceId)
      ? layout.rootOccurrenceId
      : nodes.find((node) => node.occurrence.generation === 0)?.occurrence.id ?? nodes[0]?.occurrence.id ?? null,
  };
}

export function familyTreeLayoutProjectionSignature(
  graph: FamilyTreeGraphDto,
  options: FamilyTreeViewerLayoutOptions = {},
): string {
  return stableHash(JSON.stringify({
    treeId: graph.treeId,
    rootPersonId: graph.rootPersonId,
    mode: graph.mode,
    options: {
      nodeWidth: options.nodeWidth ?? DEFAULT_NODE_WIDTH,
      nodeHeight: options.nodeHeight ?? DEFAULT_NODE_HEIGHT,
      horizontalSpacing: options.horizontalSpacing ?? DEFAULT_HORIZONTAL_SPACING,
      verticalSpacing: options.verticalSpacing ?? DEFAULT_VERTICAL_SPACING,
      padding: options.padding ?? DEFAULT_PADDING,
    },
    occurrences: graph.occurrences.map((occurrence) => ({
      id: occurrence.id,
      personId: occurrence.personId,
      generation: occurrence.generation,
      path: occurrence.path,
      hiddenParentsCount: occurrence.hiddenParentsCount ?? 0,
      hiddenChildrenCount: occurrence.hiddenChildrenCount ?? 0,
      hiddenSideBranchesCount: occurrence.hiddenSideBranchesCount ?? 0,
      sideBranchesExpanded: Boolean(occurrence.sideBranchesExpanded),
    })).sort((left, right) => left.id.localeCompare(right.id, "uk")),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      fromOccurrenceId: edge.fromOccurrenceId,
      toOccurrenceId: edge.toOccurrenceId,
      relationshipType: edge.relationshipType,
      parentSetId: edge.parentSetId,
      familyGroupId: edge.familyGroupId,
      parentRoleLabel: edge.parentRoleLabel,
      lineStyle: edge.style.lineStyle,
      visibility: edge.style.visibility,
    })).sort((left, right) => left.id.localeCompare(right.id, "uk")),
  }));
}

export function familyTreeLayoutCacheKey(
  graph: FamilyTreeGraphDto,
  _signature: string,
  namespace = DEFAULT_LAYOUT_CACHE_NAMESPACE,
): string {
  return `${familyTreeLayoutTreeCachePrefix(graph, namespace)}${graph.rootPersonId || "no-root"}:${graph.mode}`;
}

function familyTreeLayoutTreeCachePrefix(
  graph: FamilyTreeGraphDto,
  namespace = DEFAULT_LAYOUT_CACHE_NAMESPACE,
): string {
  return `${namespace}:${graph.treeId || "no-tree"}:`;
}

function resolveLayoutCacheStorage(
  storage: FamilyTreeLayoutCacheOptions["storage"],
): FamilyTreeLayoutCacheStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function readCachedLayoutProjection(
  storage: FamilyTreeLayoutCacheStorage,
  key: string,
  signature: string,
): CachedLayoutProjection | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedLayoutProjection;
    if (parsed.version !== LAYOUT_CACHE_VERSION || parsed.signature !== signature || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage access can itself be blocked; layout calculation still works.
    }
    return null;
  }
}

function writeCachedLayoutProjection(
  storage: FamilyTreeLayoutCacheStorage,
  key: string,
  treeCachePrefix: string,
  signature: string,
  layout: TreeLayoutResult,
  maxBytes = DEFAULT_LAYOUT_CACHE_MAX_BYTES,
) {
  const projection: CachedLayoutProjection = {
    version: LAYOUT_CACHE_VERSION,
    signature,
    rootOccurrenceId: layout.rootOccurrenceId,
    nodes: layout.nodes.map((node) => ({
      occurrenceId: node.occurrence.id,
      x: roundLayoutNumber(node.x),
      y: roundLayoutNumber(node.y),
      width: roundLayoutNumber(node.width),
      height: roundLayoutNumber(node.height),
    })),
  };
  const raw = JSON.stringify(projection);
  pruneSupersededLayoutCache(storage, treeCachePrefix, key);
  if (raw.length > maxBytes) return;
  try {
    storage.setItem(key, raw);
  } catch {
    // Large GEDCOM projects can exhaust storage. In that case the deterministic layout remains the fallback.
  }
}

function pruneSupersededLayoutCache(
  storage: FamilyTreeLayoutCacheStorage,
  treeCachePrefix: string,
  currentKey: string,
): void {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return;
  const staleKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const candidate = storage.key(index);
      if (candidate && candidate !== currentKey && candidate.startsWith(treeCachePrefix)) {
        staleKeys.push(candidate);
      }
    }
  } catch {
    return;
  }
  for (const staleKey of staleKeys) {
    try {
      storage.removeItem(staleKey);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function layoutFromCachedProjection(
  graph: FamilyTreeGraphDto,
  projection: CachedLayoutProjection,
  options: FamilyTreeViewerLayoutOptions,
): TreeLayoutResult | null {
  const metrics = {
    nodeWidth: options.nodeWidth ?? DEFAULT_NODE_WIDTH,
    nodeHeight: options.nodeHeight ?? DEFAULT_NODE_HEIGHT,
    horizontalSpacing: options.horizontalSpacing ?? DEFAULT_HORIZONTAL_SPACING,
    verticalSpacing: options.verticalSpacing ?? DEFAULT_VERTICAL_SPACING,
    padding: options.padding ?? DEFAULT_PADDING,
  };
  const personById = new Map(graph.nodes.map((person) => [person.personId, person]));
  const occurrenceById = new Map(graph.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const cachedByOccurrence = new Map(projection.nodes.map((node) => [node.occurrenceId, node]));
  if (cachedByOccurrence.size !== graph.occurrences.length) return null;

  const nodes = graph.occurrences
    .map((occurrence) => {
      const person = personById.get(occurrence.personId);
      const cached = cachedByOccurrence.get(occurrence.id);
      if (!person || !cached) return null;
      return {
        occurrence,
        person,
        x: cached.x,
        y: cached.y,
        width: cached.width,
        height: cached.height,
        badges: resolveNodeBadges(graph, person, occurrence),
      };
    })
    .filter((node): node is FamilyTreeLayoutNode => Boolean(node))
    .sort((left, right) => left.y - right.y || left.x - right.x || left.occurrence.id.localeCompare(right.occurrence.id, "uk"));

  if (nodes.length !== graph.occurrences.length) return null;
  const nodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  const edges = graph.edges
    .map((edge) => {
      if (!edge.fromOccurrenceId || !edge.toOccurrenceId) return null;
      if (!occurrenceById.has(edge.fromOccurrenceId) || !occurrenceById.has(edge.toOccurrenceId)) return null;
      const from = nodeByOccurrence.get(edge.fromOccurrenceId);
      const to = nodeByOccurrence.get(edge.toOccurrenceId);
      if (!from || !to) return null;
      return {
        edge,
        from,
        to,
        path: cachedLayoutEdgePath(edge.kind, from, to),
        dashArray: edgeDashArray(edge),
        opacity: edge.style.visibility === "faded" ? 0.32 : 1,
      };
    })
    .filter((edge): edge is FamilyTreeLayoutEdge => Boolean(edge));
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);
  const bounds = layoutBounds(nodes, [], metrics.padding);
  const baseLayout: TreeLayoutResult = {
    nodes,
    edges,
    familyUnits,
    width: Math.max(720, bounds.maxX - bounds.minX),
    height: Math.max(420, bounds.maxY - bounds.minY),
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    rootOccurrenceId: projection.rootOccurrenceId,
  };
  const placeholders = buildFamilyGridPlaceholders(graph, baseLayout, metrics);
  const placeholderBounds = layoutBounds(nodes, placeholders, metrics.padding);
  return {
    ...baseLayout,
    placeholders,
    width: Math.max(720, placeholderBounds.maxX - placeholderBounds.minX),
    height: Math.max(420, placeholderBounds.maxY - placeholderBounds.minY),
    minX: placeholderBounds.minX,
    minY: placeholderBounds.minY,
    maxX: placeholderBounds.maxX,
    maxY: placeholderBounds.maxY,
  };
}

function cachedLayoutEdgePath(
  kind: FamilyTreeLayoutEdge["edge"]["kind"],
  from: FamilyTreeLayoutNode,
  to: FamilyTreeLayoutNode,
): string {
  const fromCenterX = from.x + from.width / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + to.width / 2;
  const toCenterY = to.y + to.height / 2;
  if (kind === "partner") {
    const fromLeft = fromCenterX <= toCenterX;
    const startX = fromLeft ? from.x + from.width : from.x;
    const endX = fromLeft ? to.x : to.x + to.width;
    return `M ${startX} ${fromCenterY} H ${endX}`;
  }
  if (kind === "association") {
    const controlY = Math.min(fromCenterY, toCenterY) - 55;
    return `M ${fromCenterX} ${fromCenterY} Q ${(fromCenterX + toCenterX) / 2} ${controlY} ${toCenterX} ${toCenterY}`;
  }
  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${fromCenterX} ${startY} V ${midY} H ${toCenterX} V ${endY}`;
}

function layoutBounds(
  nodes: FamilyTreeLayoutNode[],
  placeholders: FamilyTreeLayoutPlaceholder[],
  padding: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const items = [
    ...nodes.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height })),
    ...placeholders.map((placeholder) => ({
      x: placeholder.x,
      y: placeholder.y,
      width: placeholder.width,
      height: placeholder.height,
    })),
  ];
  if (!items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...items.map((item) => item.x)) - padding,
    minY: Math.min(...items.map((item) => item.y)) - padding,
    maxX: Math.max(...items.map((item) => item.x + item.width)) + padding,
    maxY: Math.max(...items.map((item) => item.y + item.height)) + padding,
  };
}

function roundLayoutNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeVisualFamilyGraph(graph: FamilyTreeGraphDto): VisualNormalizedFamilyGraph {
  return normalizeFamilyGridGraph(graph);
}

export function buildVisualGridModel(
  graph: FamilyTreeGraphDto,
  layout: TreeLayoutResult,
): VisualGridLayoutModel {
  return buildFamilyGridLayoutModel(normalizeFamilyGridGraph(graph), layout);
}

export function resolveGenerations(layout: TreeLayoutResult): Map<number, VisualNode[]> {
  const generations = new Map<number, VisualNode[]>();
  for (const node of layout.nodes) {
    const row = generations.get(node.occurrence.generation) ?? [];
    row.push(node);
    generations.set(node.occurrence.generation, row);
  }
  for (const [generation, row] of generations.entries()) {
    generations.set(generation, [...row].sort((left, right) => left.x - right.x));
  }
  return generations;
}

export function createVisualNodes(layout: TreeLayoutResult): VisualNode[] {
  return layout.nodes;
}

export function createUnionNodes(layout: TreeLayoutResult): UnionVisualNode[] {
  return layout.familyUnits.map((unit) => ({
    id: `union:${unit.key}`,
    familyGroupKey: unit.key,
    x: unit.unitX,
    y: unit.parentBusY,
    parentOccurrenceIds: unit.parentOccurrenceIds,
    childOccurrenceIds: unit.childOccurrenceIds,
  }));
}

export function buildFamilyVisualGroups(edges: VisualEdge[]): FamilyVisualGroup[] {
  return buildFamilyTreeLayoutFamilyUnits(edges);
}

export function routeEdges(layout: TreeLayoutResult): VisualEdge[] {
  return layout.edges;
}

export function calculateBounds(layout: TreeLayoutResult): TreeLayoutBounds {
  return {
    minX: layout.minX,
    minY: layout.minY,
    maxX: layout.maxX,
    maxY: layout.maxY,
    width: Math.max(0, layout.maxX - layout.minX),
    height: Math.max(0, layout.maxY - layout.minY),
  };
}

export function calculateVisualBounds(
  layout: TreeLayoutResult,
  visualScale = 1,
): TreeLayoutBounds {
  const scale = Math.max(1, Number.isFinite(visualScale) ? visualScale : 1);
  const items = [
    ...layout.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    ...(layout.placeholders ?? []).map((placeholder) => ({
      x: placeholder.x,
      y: placeholder.y,
      width: placeholder.width,
      height: placeholder.height,
    })),
  ];

  if (!items.length) {
    return calculateBounds(layout);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const extraWidth = item.width * (scale - 1) / 2;
    const extraHeight = item.height * (scale - 1) / 2;
    minX = Math.min(minX, item.x - extraWidth);
    minY = Math.min(minY, item.y - extraHeight);
    maxX = Math.max(maxX, item.x + item.width + extraWidth);
    maxY = Math.max(maxY, item.y + item.height + extraHeight);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}
