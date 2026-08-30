import type {
  DocumentaryGraphEdge,
  DocumentaryGraphEntityType,
  DocumentaryGraphNode,
  DocumentaryGraphNodeId,
  PersonDocumentaryGraphSnapshot,
} from "../../types/contextGraph.ts";

export interface DocumentaryGraphLayoutNode extends DocumentaryGraphNode {
  /** Center X coordinate in the SVG canvas. */
  x: number;
  /** Center Y coordinate in the SVG canvas. */
  y: number;
  width: number;
  height: number;
  layerIndex: number;
  order: number;
}

export interface DocumentaryGraphLayoutEdge extends DocumentaryGraphEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  /** Ready-to-render deterministic SVG path. */
  path: string;
}

export interface DocumentaryGraphLayoutLayer {
  depth: number;
  x: number;
  nodeIds: DocumentaryGraphNodeId[];
}

export interface DocumentaryGraphLayeredLayout {
  width: number;
  height: number;
  nodes: DocumentaryGraphLayoutNode[];
  edges: DocumentaryGraphLayoutEdge[];
  layers: DocumentaryGraphLayoutLayer[];
}

export interface DocumentaryGraphLayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  columnGap?: number;
  rowGap?: number;
  nodeWidth?: number;
  nodeHeight?: number;
}

export type DocumentaryGraphNodePredicate = (
  node: DocumentaryGraphNode,
) => boolean;

const entityOrder: Record<DocumentaryGraphEntityType, number> = {
  person: 0,
  finding: 1,
  person_event: 2,
  document: 3,
  place: 4,
};

/**
 * Keeps the center node, applies an optional visibility predicate, removes
 * duplicate records and guarantees that every returned edge has two visible
 * endpoints. The source snapshot is never mutated.
 */
export function filterDocumentaryGraphSnapshot(
  snapshot: PersonDocumentaryGraphSnapshot,
  predicate: DocumentaryGraphNodePredicate = () => true,
): PersonDocumentaryGraphSnapshot {
  const nodesById = new Map<DocumentaryGraphNodeId, DocumentaryGraphNode>();
  snapshot.nodes.forEach((node) => {
    if (nodesById.has(node.id)) return;
    if (node.id === snapshot.centerNodeId || predicate(node)) nodesById.set(node.id, node);
  });

  const edgeIds = new Set<string>();
  const edges = snapshot.edges.filter((edge) => {
    if (edgeIds.has(edge.id)) return false;
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return false;
    edgeIds.add(edge.id);
    return true;
  });

  return {
    ...snapshot,
    nodes: [...nodesById.values()],
    edges,
  };
}

/**
 * Builds a stable left-to-right layout for the bounded documentary graph.
 * Depth 0 is the central person, direct documentary entities occupy depth 1,
 * and connected people/places occupy depth 2. Sorting is data-based rather
 * than insertion-based, so reversed RPC arrays produce byte-identical output.
 */
export function buildDocumentaryGraphLayeredLayout(
  nodes: readonly DocumentaryGraphNode[],
  edges: readonly DocumentaryGraphEdge[],
  options: DocumentaryGraphLayoutOptions = {},
): DocumentaryGraphLayeredLayout {
  const padding = finiteAtLeast(options.padding, 20, 42);
  const nodeWidth = finiteAtLeast(options.nodeWidth, 120, 196);
  const nodeHeight = finiteAtLeast(options.nodeHeight, 48, 72);
  const minimumColumnGap = finiteAtLeast(options.columnGap, 40, 120);
  const rowGap = finiteAtLeast(options.rowGap, 12, 28);
  const uniqueNodes = deduplicateNodes(nodes)
    .map((node) => ({ node, depth: normalizedDepth(node) }));
  const maximumDepth = Math.max(0, ...uniqueNodes.map((item) => item.depth));
  const layerCount = maximumDepth + 1;
  const layerGroups = Array.from({ length: layerCount }, (_, depth) => uniqueNodes
    .filter((item) => item.depth === depth)
    .map((item) => item.node)
    .sort(compareNodes));
  const largestLayer = Math.max(1, ...layerGroups.map((layer) => layer.length));
  const contentWidth = layerCount * nodeWidth + Math.max(0, layerCount - 1) * minimumColumnGap;
  const contentHeight = largestLayer * nodeHeight + Math.max(0, largestLayer - 1) * rowGap;
  const width = round(Math.max(finiteAtLeast(options.width, 320, 0), contentWidth + padding * 2));
  const height = round(Math.max(finiteAtLeast(options.height, 240, 0), contentHeight + padding * 2));
  const columnGap = layerCount <= 1
    ? 0
    : Math.max(minimumColumnGap, (width - padding * 2 - layerCount * nodeWidth) / (layerCount - 1));
  const layoutNodes: DocumentaryGraphLayoutNode[] = [];
  const layers: DocumentaryGraphLayoutLayer[] = [];

  layerGroups.forEach((layerNodes, layerIndex) => {
    const x = round(padding + nodeWidth / 2 + layerIndex * (nodeWidth + columnGap));
    const layerHeight = layerNodes.length * nodeHeight + Math.max(0, layerNodes.length - 1) * rowGap;
    const firstY = (height - layerHeight) / 2 + nodeHeight / 2;
    const nodeIds: DocumentaryGraphNodeId[] = [];
    layerNodes.forEach((node, order) => {
      nodeIds.push(node.id);
      layoutNodes.push({
        ...node,
        depth: layerIndex,
        x,
        y: round(firstY + order * (nodeHeight + rowGap)),
        width: nodeWidth,
        height: nodeHeight,
        layerIndex,
        order,
      });
    });
    layers.push({ depth: layerIndex, x, nodeIds });
  });

  const positionedById = new Map(layoutNodes.map((node) => [node.id, node] as const));
  const uniqueEdges = deduplicateEdges(edges)
    .filter((edge) => positionedById.has(edge.source) && positionedById.has(edge.target))
    .sort(compareEdges);
  const layoutEdges = uniqueEdges.flatMap((edge, edgeIndex) => {
    const source = positionedById.get(edge.source);
    const target = positionedById.get(edge.target);
    if (!source || !target) return [];
    const geometry = edgeGeometry(source, target, edgeIndex);
    return [{ ...edge, ...geometry }];
  });

  return {
    width,
    height,
    nodes: layoutNodes,
    edges: layoutEdges,
    layers,
  };
}

function normalizedDepth(node: DocumentaryGraphNode): number {
  if (node.entityType === "person" && node.metadata.isCenter === true) return 0;
  if (!Number.isFinite(node.depth)) return 1;
  return Math.min(2, Math.max(0, Math.round(node.depth)));
}

function compareNodes(left: DocumentaryGraphNode, right: DocumentaryGraphNode): number {
  const byEntity = entityOrder[left.entityType] - entityOrder[right.entityType];
  if (byEntity) return byEntity;
  const byLabel = stableCompare(left.label, right.label);
  return byLabel || stableCompare(left.id, right.id);
}

function compareEdges(left: DocumentaryGraphEdge, right: DocumentaryGraphEdge): number {
  return stableCompare(left.source, right.source)
    || stableCompare(left.target, right.target)
    || stableCompare(left.relationType, right.relationType)
    || stableCompare(left.id, right.id);
}

function edgeGeometry(
  source: DocumentaryGraphLayoutNode,
  target: DocumentaryGraphLayoutNode,
  edgeIndex: number,
): Pick<DocumentaryGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path"> {
  if (source.layerIndex === target.layerIndex) {
    const direction = source.y <= target.y ? 1 : -1;
    const sourceOffsetY = direction * Math.min(source.height / 3, 18);
    const targetOffsetY = -direction * Math.min(target.height / 3, 18);
    const sourceX = round(source.x + horizontalBoundaryOffset(source, sourceOffsetY));
    const targetX = round(target.x + horizontalBoundaryOffset(target, targetOffsetY));
    const sourceY = round(source.y + sourceOffsetY);
    const targetY = round(target.y + targetOffsetY);
    const gutterX = round(Math.max(sourceX, targetX) + 34 + (edgeIndex % 5) * 8);
    return {
      sourceX,
      sourceY,
      targetX,
      targetY,
      path: `M ${sourceX} ${sourceY} C ${gutterX} ${sourceY}, ${gutterX} ${targetY}, ${targetX} ${targetY}`,
    };
  }

  const leftToRight = source.x < target.x;
  const sourceOffsetX = horizontalBoundaryOffset(source, 0);
  const targetOffsetX = horizontalBoundaryOffset(target, 0);
  const sourceX = round(source.x + (leftToRight ? sourceOffsetX : -sourceOffsetX));
  const targetX = round(target.x + (leftToRight ? -targetOffsetX : targetOffsetX));
  const sourceY = round(source.y);
  const targetY = round(target.y);
  const middleX = round((sourceX + targetX) / 2);
  return {
    sourceX,
    sourceY,
    targetX,
    targetY,
    path: `M ${sourceX} ${sourceY} C ${middleX} ${sourceY}, ${middleX} ${targetY}, ${targetX} ${targetY}`,
  };
}

/**
 * Person nodes are rendered as circles inside a wider layout slot. Connectors
 * must therefore meet the circle itself rather than the invisible edge of the
 * slot. Other node shapes intentionally keep their rectangular half-width.
 */
function horizontalBoundaryOffset(
  node: DocumentaryGraphLayoutNode,
  verticalOffset: number,
): number {
  if (node.entityType !== "person") return node.width / 2;
  const radius = Math.min(node.width, node.height) / 2;
  const boundedY = Math.min(radius, Math.abs(verticalOffset));
  return Math.sqrt(Math.max(0, radius ** 2 - boundedY ** 2));
}

function deduplicateNodes(nodes: readonly DocumentaryGraphNode[]): DocumentaryGraphNode[] {
  const unique = new Map<DocumentaryGraphNodeId, DocumentaryGraphNode>();
  nodes.forEach((node) => {
    if (!unique.has(node.id)) unique.set(node.id, node);
  });
  return [...unique.values()];
}

function deduplicateEdges(edges: readonly DocumentaryGraphEdge[]): DocumentaryGraphEdge[] {
  const unique = new Map<string, DocumentaryGraphEdge>();
  edges.forEach((edge) => {
    if (!unique.has(edge.id)) unique.set(edge.id, edge);
  });
  return [...unique.values()];
}

function stableCompare(left: string, right: string): number {
  const normalizedLeft = left.trim().toLocaleLowerCase("uk-UA");
  const normalizedRight = right.trim().toLocaleLowerCase("uk-UA");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function finiteAtLeast(value: number | undefined, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
