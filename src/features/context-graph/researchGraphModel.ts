import type {
  ContextAssertionKind,
  ContextEvidenceStatus,
  PersonResearchGraphFilters,
  PersonResearchGraphSnapshot,
  ResearchGraphEdge,
  ResearchGraphEntityType,
  ResearchGraphLayoutId,
  ResearchGraphNode,
  ResearchGraphNodeId,
} from "../../types/contextGraph.ts";

export type {
  PersonResearchGraphFilters,
  PersonResearchGraphSnapshot,
  ResearchGraphEdge,
  ResearchGraphEntityType,
  ResearchGraphNode,
  ResearchGraphNodeId,
} from "../../types/contextGraph.ts";

export interface ResearchGraphFilterOptions {
  entityTypes?: readonly ResearchGraphEntityType[];
  relationTypeIds?: readonly string[];
  evidenceStatuses?: readonly ContextEvidenceStatus[];
  assertionKinds?: readonly ContextAssertionKind[];
  confidenceMin?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface ResearchGraphLayoutNode extends ResearchGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  ring: number;
  order: number;
}

export interface ResearchGraphLayoutEdge extends ResearchGraphEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  path: string;
}

export interface ResearchGraphRadialLayout {
  width: number;
  height: number;
  nodes: ResearchGraphLayoutNode[];
  edges: ResearchGraphLayoutEdge[];
}

/** All research layouts deliberately expose the same render-ready contract. */
export type ResearchGraphLayout = ResearchGraphRadialLayout;

export interface ResearchGraphLayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  firstRadius?: number;
  ringGap?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  minimumArcGap?: number;
}

export interface ResearchGraphHierarchicalLayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  layerGap?: number;
  maxColumns?: number;
}

export interface ResearchGraphForceLayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  nodeGap?: number;
  iterations?: number;
  springLength?: number;
}

export type ResearchGraphAnyLayoutOptions = ResearchGraphLayoutOptions
  & ResearchGraphHierarchicalLayoutOptions
  & ResearchGraphForceLayoutOptions;

const entityOrder: Record<ResearchGraphEntityType, number> = {
  hypothesis: 0,
  person: 1,
  family: 2,
  finding: 3,
  event: 4,
  document: 5,
  source: 6,
  repository: 7,
  place: 8,
};

const statusOrder: Record<ContextEvidenceStatus, number> = {
  disputed: 0,
  disproven: 1,
  likely: 2,
  unknown: 3,
  proven: 4,
};

/**
 * Defensive client-side boundary for a server-produced projection. It keeps
 * the center, removes dangling/duplicate records, and prioritises explicit
 * hypotheses before applying the hard visualization cap. The source value is
 * never mutated.
 */
export function filterResearchGraphSnapshot(
  snapshot: PersonResearchGraphSnapshot,
  options: ResearchGraphFilterOptions = {},
): PersonResearchGraphSnapshot {
  const maxNodes = boundedInteger(options.maxNodes, 2, 100, 100);
  const maxEdges = boundedInteger(options.maxEdges, 1, 240, 220);
  const allowedEntityTypes = toSet(options.entityTypes);
  const allowedRelationTypes = toSet(options.relationTypeIds);
  const allowedStatuses = toSet(options.evidenceStatuses);
  const allowedAssertionKinds = toSet(options.assertionKinds);
  const confidenceMin = boundedNumber(options.confidenceMin, 0, 100, 0);

  const uniqueNodes = deduplicateNodes(snapshot.nodes)
    .filter((node) => (
      node.isCenter
      || !allowedEntityTypes
      || allowedEntityTypes.has(node.entityType)
    ))
    .sort((left, right) => (
      Number(right.isCenter) - Number(left.isCenter)
      || compareResearchNodes(left, right)
    ));
  const nodesWereCapped = uniqueNodes.length > maxNodes;
  const nodes = uniqueNodes.slice(0, maxNodes);
  const visibleIds = new Set(nodes.map((node) => node.id));

  const eligibleEdges = deduplicateEdges(snapshot.edges)
    .filter((edge) => (
      visibleIds.has(edge.source)
      && visibleIds.has(edge.target)
      && (!allowedRelationTypes || allowedRelationTypes.has(edge.relationTypeId))
      && (!allowedStatuses || allowedStatuses.has(edge.evidenceStatus))
      && (!allowedAssertionKinds || allowedAssertionKinds.has(edge.assertionKind))
      && boundedNumber(edge.confidence, 0, 100, 0) >= confidenceMin
    ))
    .sort(compareResearchEdges);
  const edgesWereCapped = eligibleEdges.length > maxEdges;
  const edges = eligibleEdges.slice(0, maxEdges);
  const centerNodeId = nodes.find((node) => node.isCenter)?.id;
  const connectedIds = new Set<ResearchGraphNodeId>(centerNodeId ? [centerNodeId] : []);
  edges.forEach((edge) => {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  });

  return {
    ...snapshot,
    nodes: nodes.filter((node) => connectedIds.has(node.id)),
    edges,
    truncated: {
      nodes: snapshot.truncated.nodes || nodesWereCapped,
      edges: snapshot.truncated.edges || edgesWereCapped,
    },
  };
}

/**
 * Stable concentric layout. Additional rings are allocated as the graph grows
 * so bounded 100-node snapshots stay readable instead of piling nodes on one
 * circumference. Hypotheses are sorted first and therefore remain close to
 * the focused person.
 */
export function buildResearchGraphRadialLayout(
  nodes: readonly ResearchGraphNode[],
  edges: readonly ResearchGraphEdge[],
  options: ResearchGraphLayoutOptions = {},
): ResearchGraphRadialLayout {
  const padding = finiteAtLeast(options.padding, 20, 48);
  const nodeWidth = finiteAtLeast(options.nodeWidth, 100, 164);
  const nodeHeight = finiteAtLeast(options.nodeHeight, 44, 70);
  const minimumArcGap = finiteAtLeast(options.minimumArcGap, 16, 32);
  const cardSeparation = Math.hypot(nodeWidth, nodeHeight) + 2;
  const centerSeparation = Math.hypot((nodeWidth + nodeHeight) / 2, nodeHeight) + 2;
  const firstRadius = Math.max(
    finiteAtLeast(options.firstRadius, 100, 188),
    centerSeparation,
  );
  const ringGap = Math.max(
    finiteAtLeast(options.ringGap, 60, 112),
    cardSeparation,
  );
  const uniqueNodes = deduplicateNodes(nodes).sort(compareResearchNodes);
  const center = selectResearchCenter(uniqueNodes);
  if (!center) {
    return {
      width: finiteAtLeast(options.width, 320, 760),
      height: finiteAtLeast(options.height, 240, 520),
      nodes: [],
      edges: [],
    };
  }

  const others = uniqueNodes
    .filter((node) => node.id !== center.id)
    .sort(compareResearchNodes);
  const rings: Array<{ radius: number; nodes: ResearchGraphNode[] }> = [];
  let cursor = 0;
  let radius = firstRadius;
  while (cursor < others.length) {
    const circumference = Math.PI * 2 * radius;
    const arcCapacity = Math.max(1, Math.floor(circumference / (nodeWidth + minimumArcGap)));
    const chordRatio = Math.min(1, cardSeparation / (2 * radius));
    const chordCapacity = Math.max(1, Math.floor(Math.PI / Math.asin(chordRatio)));
    const capacity = Math.min(arcCapacity, chordCapacity);
    rings.push({ radius, nodes: others.slice(cursor, cursor + capacity) });
    cursor += capacity;
    radius += ringGap;
  }
  const maximumRadius = rings.at(-1)?.radius ?? 0;
  const minimumWidth = Math.max(760, (maximumRadius + nodeWidth / 2 + padding) * 2);
  const minimumHeight = Math.max(520, (maximumRadius + nodeHeight / 2 + padding) * 2);
  const width = round(Math.max(finiteAtLeast(options.width, 320, 0), minimumWidth));
  const height = round(Math.max(finiteAtLeast(options.height, 240, 0), minimumHeight));
  const centerX = round(width / 2);
  const centerY = round(height / 2);
  const layoutNodes: ResearchGraphLayoutNode[] = [{
    ...center,
    depth: 0,
    x: centerX,
    y: centerY,
    width: nodeHeight,
    height: nodeHeight,
    ring: 0,
    order: 0,
  }];

  rings.forEach((ring, ringIndex) => {
    const angleOffset = ringIndex % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / ring.nodes.length;
    ring.nodes.forEach((node, order) => {
      const angle = angleOffset + (Math.PI * 2 * order) / ring.nodes.length;
      layoutNodes.push({
        ...node,
        x: round(centerX + Math.cos(angle) * ring.radius),
        y: round(centerY + Math.sin(angle) * ring.radius),
        width: node.entityType === "hypothesis" ? nodeHeight + 10 : nodeWidth,
        height: nodeHeight,
        ring: ringIndex + 1,
        order,
      });
    });
  });

  const positionedById = new Map(layoutNodes.map((node) => [node.id, node] as const));
  const layoutEdges = deduplicateEdges(edges)
    .filter((edge) => positionedById.has(edge.source) && positionedById.has(edge.target))
    .sort(compareResearchEdges)
    .flatMap((edge, edgeIndex): ResearchGraphLayoutEdge[] => {
      const source = positionedById.get(edge.source);
      const target = positionedById.get(edge.target);
      if (!source || !target) return [];
      const geometry = radialEdgeGeometry(source, target, edgeIndex);
      return [{ ...edge, ...geometry }];
    });

  return { width, height, nodes: layoutNodes, edges: layoutEdges };
}

/**
 * Deterministic top-to-bottom projection grouped by the server-provided graph
 * depth. Wide layers wrap into bounded rows while retaining their logical
 * layer number, so the 100-node projection never creates overlapping cards.
 */
export function buildResearchGraphHierarchicalLayout(
  nodes: readonly ResearchGraphNode[],
  edges: readonly ResearchGraphEdge[],
  options: ResearchGraphHierarchicalLayoutOptions = {},
): ResearchGraphLayout {
  const padding = finiteAtLeast(options.padding, 20, 48);
  const nodeWidth = finiteAtLeast(options.nodeWidth, 100, 164);
  const nodeHeight = finiteAtLeast(options.nodeHeight, 44, 70);
  const columnGap = finiteAtLeast(options.columnGap, 16, 36);
  const layerGap = finiteAtLeast(options.layerGap, 24, 76);
  const maxColumns = boundedInteger(options.maxColumns, 2, 16, 10);
  const uniqueNodes = deduplicateNodes(nodes).sort(compareResearchNodes);
  const center = selectResearchCenter(uniqueNodes);
  if (!center) return emptyResearchLayout(options);

  const grouped = new Map<number, ResearchGraphNode[]>();
  uniqueNodes.forEach((node) => {
    if (node.id === center.id) return;
    const layer = Math.max(1, Math.max(0, Math.round(node.depth)));
    const current = grouped.get(layer) ?? [];
    current.push(node);
    grouped.set(layer, current);
  });
  const layers = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([layer, layerNodes]) => ({ layer, nodes: layerNodes.sort(compareResearchNodes) }));
  const rowPlan: Array<{ layer: number; nodes: ResearchGraphNode[] }> = [{ layer: 0, nodes: [center] }];
  layers.forEach(({ layer, nodes: layerNodes }) => {
    for (let cursor = 0; cursor < layerNodes.length; cursor += maxColumns) {
      rowPlan.push({ layer, nodes: layerNodes.slice(cursor, cursor + maxColumns) });
    }
  });

  const widestRow = Math.max(1, ...rowPlan.map((row) => row.nodes.length));
  const minimumWidth = padding * 2 + widestRow * nodeWidth + Math.max(0, widestRow - 1) * columnGap;
  const minimumHeight = padding * 2 + rowPlan.length * nodeHeight
    + Math.max(0, rowPlan.length - 1) * layerGap;
  const width = round(Math.max(finiteAtLeast(options.width, 320, 0), 760, minimumWidth));
  const height = round(Math.max(finiteAtLeast(options.height, 240, 0), 520, minimumHeight));
  const centerX = round(width / 2);
  const layoutNodes: ResearchGraphLayoutNode[] = [];

  rowPlan.forEach((row, rowIndex) => {
    const rowWidth = row.nodes.length * nodeWidth + Math.max(0, row.nodes.length - 1) * columnGap;
    const left = (width - rowWidth) / 2;
    row.nodes.forEach((node, order) => {
      const isCenter = node.id === center.id;
      layoutNodes.push({
        ...node,
        depth: isCenter ? 0 : node.depth,
        x: isCenter ? centerX : round(left + nodeWidth / 2 + order * (nodeWidth + columnGap)),
        y: round(padding + nodeHeight / 2 + rowIndex * (nodeHeight + layerGap)),
        width: isCenter ? nodeHeight : node.entityType === "hypothesis" ? nodeHeight + 10 : nodeWidth,
        height: nodeHeight,
        ring: row.layer,
        order,
      });
    });
  });

  return completeResearchLayout(width, height, layoutNodes, edges, hierarchicalEdgeGeometry);
}

interface MutableForcePoint {
  node: ResearchGraphNode;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

interface ForceGridSlot {
  x: number;
  y: number;
  column: number;
  row: number;
}

/**
 * A dependency-free, fixed-iteration force projection. Initial coordinates,
 * pair traversal and spring traversal are stable, and the final positions are
 * snapped to the nearest free layout slot. The snap is intentional: it keeps
 * the visual clustering produced by the simulation while giving a hard
 * non-overlap guarantee for the bounded 100-node graph.
 */
export function buildResearchGraphForceLayout(
  nodes: readonly ResearchGraphNode[],
  edges: readonly ResearchGraphEdge[],
  options: ResearchGraphForceLayoutOptions = {},
): ResearchGraphLayout {
  const padding = finiteAtLeast(options.padding, 20, 48);
  const nodeWidth = finiteAtLeast(options.nodeWidth, 100, 164);
  const nodeHeight = finiteAtLeast(options.nodeHeight, 44, 70);
  const nodeGap = finiteAtLeast(options.nodeGap, 12, 28);
  const iterations = boundedInteger(options.iterations, 20, 240, 120);
  const springLength = finiteAtLeast(options.springLength, 60, 190);
  const uniqueNodes = deduplicateNodes(nodes).sort(compareResearchNodes);
  const center = selectResearchCenter(uniqueNodes);
  if (!center) return emptyResearchLayout(options);

  const side = nextOddInteger(Math.ceil(Math.sqrt(uniqueNodes.length)));
  const cellWidth = nodeWidth + nodeGap;
  const cellHeight = nodeHeight + nodeGap;
  const minimumWidth = padding * 2 + (side - 1) * cellWidth + nodeWidth;
  const minimumHeight = padding * 2 + (side - 1) * cellHeight + nodeHeight;
  const width = round(Math.max(finiteAtLeast(options.width, 320, 0), 760, minimumWidth));
  const height = round(Math.max(finiteAtLeast(options.height, 240, 0), 520, minimumHeight));
  const centerX = width / 2;
  const centerY = height / 2;
  const orderedNodes = [center, ...uniqueNodes.filter((node) => node.id !== center.id)];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const points = orderedNodes.map((node, index): MutableForcePoint => {
    if (index === 0) {
      return { node, x: centerX, y: centerY, velocityX: 0, velocityY: 0 };
    }
    const hashOffset = stableHash(node.id) / 0xffffffff * 0.18;
    const angle = index * goldenAngle + hashOffset;
    const radius = Math.min(Math.min(width, height) * 0.42, 72 + Math.sqrt(index) * 64);
    return {
      node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      velocityX: 0,
      velocityY: 0,
    };
  });
  const pointById = new Map(points.map((point) => [point.node.id, point] as const));
  const pointIndexById = new Map(points.map((point, index) => [point.node.id, index] as const));
  const visibleEdges = deduplicateEdges(edges)
    .filter((edge) => pointById.has(edge.source) && pointById.has(edge.target))
    .sort(compareResearchEdges);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations * 0.72;
    const forceX = new Array<number>(points.length).fill(0);
    const forceY = new Array<number>(points.length).fill(0);
    for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
      const left = points[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
        const right = points[rightIndex]!;
        let deltaX = right.x - left.x;
        let deltaY = right.y - left.y;
        if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
          const angle = (stableHash(`${left.node.id}|${right.node.id}`) % 360) * Math.PI / 180;
          deltaX = Math.cos(angle);
          deltaY = Math.sin(angle);
        }
        const distanceSquared = Math.max(64, deltaX * deltaX + deltaY * deltaY);
        const distance = Math.sqrt(distanceSquared);
        const repulsion = Math.min(18, 26_000 / distanceSquared) * cooling;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        forceX[leftIndex]! -= unitX * repulsion;
        forceY[leftIndex]! -= unitY * repulsion;
        forceX[rightIndex]! += unitX * repulsion;
        forceY[rightIndex]! += unitY * repulsion;
      }
    }
    visibleEdges.forEach((edge) => {
      const sourceIndex = pointIndexById.get(edge.source);
      const targetIndex = pointIndexById.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) return;
      const source = points[sourceIndex]!;
      const target = points[targetIndex]!;
      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const strength = (distance - springLength) * 0.018 * cooling;
      const springX = deltaX / distance * strength;
      const springY = deltaY / distance * strength;
      forceX[sourceIndex]! += springX;
      forceY[sourceIndex]! += springY;
      forceX[targetIndex]! -= springX;
      forceY[targetIndex]! -= springY;
    });
    points.forEach((point, index) => {
      if (point.node.id === center.id) {
        point.x = centerX;
        point.y = centerY;
        point.velocityX = 0;
        point.velocityY = 0;
        return;
      }
      forceX[index]! += (centerX - point.x) * 0.0025;
      forceY[index]! += (centerY - point.y) * 0.0025;
      point.velocityX = clamp((point.velocityX + forceX[index]!) * 0.78, -18, 18);
      point.velocityY = clamp((point.velocityY + forceY[index]!) * 0.78, -18, 18);
      point.x = clamp(point.x + point.velocityX, padding + nodeWidth / 2, width - padding - nodeWidth / 2);
      point.y = clamp(point.y + point.velocityY, padding + nodeHeight / 2, height - padding - nodeHeight / 2);
    });
  }

  const half = Math.floor(side / 2);
  const slots: ForceGridSlot[] = [];
  for (let row = -half; row <= half; row += 1) {
    for (let column = -half; column <= half; column += 1) {
      if (row === 0 && column === 0) continue;
      slots.push({
        x: centerX + column * cellWidth,
        y: centerY + row * cellHeight,
        column,
        row,
      });
    }
  }
  const availableSlots = [...slots];
  const layoutNodes: ResearchGraphLayoutNode[] = [{
    ...center,
    depth: 0,
    x: round(centerX),
    y: round(centerY),
    width: nodeHeight,
    height: nodeHeight,
    ring: 0,
    order: 0,
  }];
  points.slice(1).forEach((point, order) => {
    let selectedIndex = 0;
    let selectedDistance = Number.POSITIVE_INFINITY;
    availableSlots.forEach((slot, slotIndex) => {
      const distance = ((slot.x - point.x) / cellWidth) ** 2 + ((slot.y - point.y) / cellHeight) ** 2;
      const selected = availableSlots[selectedIndex]!;
      if (
        distance < selectedDistance - 1e-9
        || (
          Math.abs(distance - selectedDistance) <= 1e-9
          && (slot.row < selected.row || (slot.row === selected.row && slot.column < selected.column))
        )
      ) {
        selectedDistance = distance;
        selectedIndex = slotIndex;
      }
    });
    const slot = availableSlots.splice(selectedIndex, 1)[0]!;
    const renderedWidth = point.node.entityType === "hypothesis" ? nodeHeight + 10 : nodeWidth;
    const jitterLimit = Math.min(8, nodeGap / 4);
    const jitterHash = stableHash(point.node.id);
    const jitterX = ((jitterHash & 0xffff) / 0xffff * 2 - 1) * jitterLimit;
    const jitterY = (((jitterHash >>> 16) & 0xffff) / 0xffff * 2 - 1) * jitterLimit;
    layoutNodes.push({
      ...point.node,
      x: round(clamp(slot.x + jitterX, padding + renderedWidth / 2, width - padding - renderedWidth / 2)),
      y: round(clamp(slot.y + jitterY, padding + nodeHeight / 2, height - padding - nodeHeight / 2)),
      width: renderedWidth,
      height: nodeHeight,
      ring: Math.max(Math.abs(slot.column), Math.abs(slot.row)),
      order,
    });
  });

  return completeResearchLayout(width, height, layoutNodes, visibleEdges, forceEdgeGeometry);
}

/** One exhaustive entry point for UI and saved-view layout selection. */
export function buildResearchGraphLayout(
  nodes: readonly ResearchGraphNode[],
  edges: readonly ResearchGraphEdge[],
  layoutId: ResearchGraphLayoutId,
  options: ResearchGraphAnyLayoutOptions = {},
): ResearchGraphLayout {
  switch (layoutId) {
    case "hierarchical":
      return buildResearchGraphHierarchicalLayout(nodes, edges, options);
    case "force":
      return buildResearchGraphForceLayout(nodes, edges, options);
    case "radial":
      return buildResearchGraphRadialLayout(nodes, edges, options);
    default: {
      const unsupported: never = layoutId;
      throw new Error(`Unsupported research graph layout: ${String(unsupported)}`);
    }
  }
}

export function isResearchHypothesisEdge(edge: ResearchGraphEdge): boolean {
  return edge.assertionKind === "research_hypothesis"
    || edge.source.startsWith("hypothesis:")
    || edge.target.startsWith("hypothesis:");
}

function compareResearchNodes(left: ResearchGraphNode, right: ResearchGraphNode): number {
  const leftDepth = Math.max(0, Math.round(left.depth));
  const rightDepth = Math.max(0, Math.round(right.depth));
  return leftDepth - rightDepth
    || entityOrder[left.entityType] - entityOrder[right.entityType]
    || stableCompare(left.label, right.label)
    || stableCompare(left.id, right.id);
}

function compareResearchEdges(left: ResearchGraphEdge, right: ResearchGraphEdge): number {
  return Number(isResearchHypothesisEdge(right)) - Number(isResearchHypothesisEdge(left))
    || statusOrder[left.evidenceStatus] - statusOrder[right.evidenceStatus]
    || boundedNumber(right.confidence, 0, 100, 0) - boundedNumber(left.confidence, 0, 100, 0)
    || boundedInteger(right.evidenceCount, 0, Number.MAX_SAFE_INTEGER, 0)
      - boundedInteger(left.evidenceCount, 0, Number.MAX_SAFE_INTEGER, 0)
    || stableCompare(left.source, right.source)
    || stableCompare(left.target, right.target)
    || stableCompare(left.id, right.id);
}

function radialEdgeGeometry(
  source: ResearchGraphLayoutNode,
  target: ResearchGraphLayoutNode,
  edgeIndex: number,
): Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path"> {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const length = Math.max(1, Math.hypot(deltaX, deltaY));
  const sourceRadius = Math.min(source.width, source.height) / 2;
  const targetRadius = Math.min(target.width, target.height) / 2;
  const sourceX = round(source.x + deltaX / length * sourceRadius);
  const sourceY = round(source.y + deltaY / length * sourceRadius);
  const targetX = round(target.x - deltaX / length * targetRadius);
  const targetY = round(target.y - deltaY / length * targetRadius);
  const bend = ((edgeIndex % 5) - 2) * 5;
  const controlX = round((sourceX + targetX) / 2 - deltaY / length * bend);
  const controlY = round((sourceY + targetY) / 2 + deltaX / length * bend);
  return {
    sourceX,
    sourceY,
    targetX,
    targetY,
    path: `M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}`,
  };
}

type ResearchEdgeGeometryBuilder = (
  source: ResearchGraphLayoutNode,
  target: ResearchGraphLayoutNode,
  edgeIndex: number,
) => Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path">;

function completeResearchLayout(
  width: number,
  height: number,
  nodes: ResearchGraphLayoutNode[],
  edges: readonly ResearchGraphEdge[],
  geometryBuilder: ResearchEdgeGeometryBuilder,
): ResearchGraphLayout {
  const positionedById = new Map(nodes.map((node) => [node.id, node] as const));
  const layoutEdges = deduplicateEdges(edges)
    .filter((edge) => positionedById.has(edge.source) && positionedById.has(edge.target))
    .sort(compareResearchEdges)
    .flatMap((edge, edgeIndex): ResearchGraphLayoutEdge[] => {
      const source = positionedById.get(edge.source);
      const target = positionedById.get(edge.target);
      if (!source || !target) return [];
      return [{ ...edge, ...geometryBuilder(source, target, edgeIndex) }];
    });
  return { width, height, nodes, edges: layoutEdges };
}

function hierarchicalEdgeGeometry(
  source: ResearchGraphLayoutNode,
  target: ResearchGraphLayoutNode,
  edgeIndex: number,
): Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path"> {
  const endpoints = rectangularEdgeEndpoints(source, target);
  if (source.id === target.id) return selfLoopGeometry(source, edgeIndex);
  const verticalDelta = endpoints.targetY - endpoints.sourceY;
  if (Math.abs(verticalDelta) >= Math.abs(endpoints.targetX - endpoints.sourceX) * 0.25) {
    const middleY = round((endpoints.sourceY + endpoints.targetY) / 2);
    return {
      ...endpoints,
      path: `M ${endpoints.sourceX} ${endpoints.sourceY} C ${endpoints.sourceX} ${middleY} ${endpoints.targetX} ${middleY} ${endpoints.targetX} ${endpoints.targetY}`,
    };
  }
  const bend = 28 + edgeIndex % 4 * 7;
  const controlX = round((endpoints.sourceX + endpoints.targetX) / 2);
  const controlY = round((endpoints.sourceY + endpoints.targetY) / 2 - bend);
  return {
    ...endpoints,
    path: `M ${endpoints.sourceX} ${endpoints.sourceY} Q ${controlX} ${controlY} ${endpoints.targetX} ${endpoints.targetY}`,
  };
}

function forceEdgeGeometry(
  source: ResearchGraphLayoutNode,
  target: ResearchGraphLayoutNode,
  edgeIndex: number,
): Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path"> {
  if (source.id === target.id) return selfLoopGeometry(source, edgeIndex);
  const endpoints = rectangularEdgeEndpoints(source, target);
  const deltaX = endpoints.targetX - endpoints.sourceX;
  const deltaY = endpoints.targetY - endpoints.sourceY;
  const length = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = ((edgeIndex % 7) - 3) * 7;
  const controlX = round((endpoints.sourceX + endpoints.targetX) / 2 - deltaY / length * bend);
  const controlY = round((endpoints.sourceY + endpoints.targetY) / 2 + deltaX / length * bend);
  return {
    ...endpoints,
    path: `M ${endpoints.sourceX} ${endpoints.sourceY} Q ${controlX} ${controlY} ${endpoints.targetX} ${endpoints.targetY}`,
  };
}

function rectangularEdgeEndpoints(
  source: ResearchGraphLayoutNode,
  target: ResearchGraphLayoutNode,
): Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY"> {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
    return {
      sourceX: round(source.x + source.width / 2),
      sourceY: round(source.y),
      targetX: round(target.x + target.width / 2),
      targetY: round(target.y),
    };
  }
  const sourceScale = rectangleRayScale(deltaX, deltaY, source.width, source.height);
  const targetScale = rectangleRayScale(deltaX, deltaY, target.width, target.height);
  return {
    sourceX: round(source.x + deltaX * sourceScale),
    sourceY: round(source.y + deltaY * sourceScale),
    targetX: round(target.x - deltaX * targetScale),
    targetY: round(target.y - deltaY * targetScale),
  };
}

function rectangleRayScale(deltaX: number, deltaY: number, width: number, height: number): number {
  const horizontal = Math.abs(deltaX) > 0.001 ? width / 2 / Math.abs(deltaX) : Number.POSITIVE_INFINITY;
  const vertical = Math.abs(deltaY) > 0.001 ? height / 2 / Math.abs(deltaY) : Number.POSITIVE_INFINITY;
  return Math.min(horizontal, vertical);
}

function selfLoopGeometry(
  node: ResearchGraphLayoutNode,
  edgeIndex: number,
): Pick<ResearchGraphLayoutEdge, "sourceX" | "sourceY" | "targetX" | "targetY" | "path"> {
  const offset = 8 + edgeIndex % 3 * 5;
  const sourceX = round(node.x + node.width / 2 - offset);
  const targetX = round(node.x + node.width / 2 - offset * 2);
  const sourceY = round(node.y - node.height / 4);
  const targetY = round(node.y + node.height / 4);
  const loopX = round(node.x + node.width / 2 + 42 + offset);
  return {
    sourceX,
    sourceY,
    targetX,
    targetY,
    path: `M ${sourceX} ${sourceY} C ${loopX} ${sourceY - 32} ${loopX} ${targetY + 32} ${targetX} ${targetY}`,
  };
}

function selectResearchCenter(nodes: readonly ResearchGraphNode[]): ResearchGraphNode | undefined {
  return nodes.find((node) => node.isCenter)
    ?? nodes.find((node) => Math.max(0, Math.round(node.depth)) === 0)
    ?? nodes[0];
}

function emptyResearchLayout(options: { width?: number; height?: number }): ResearchGraphLayout {
  return {
    width: finiteAtLeast(options.width, 320, 760),
    height: finiteAtLeast(options.height, 240, 520),
    nodes: [],
    edges: [],
  };
}

function nextOddInteger(value: number): number {
  const integer = Math.max(1, Math.ceil(value));
  return integer % 2 === 0 ? integer + 1 : integer;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deduplicateNodes(nodes: readonly ResearchGraphNode[]): ResearchGraphNode[] {
  const unique = new Map<ResearchGraphNodeId, ResearchGraphNode>();
  nodes.forEach((node) => {
    if (!unique.has(node.id)) unique.set(node.id, node);
  });
  return [...unique.values()];
}

function deduplicateEdges(edges: readonly ResearchGraphEdge[]): ResearchGraphEdge[] {
  const unique = new Map<string, ResearchGraphEdge>();
  edges.forEach((edge) => {
    if (!unique.has(edge.id)) unique.set(edge.id, edge);
  });
  return [...unique.values()];
}

function toSet<Value extends string>(values: readonly Value[] | undefined): Set<Value> | null {
  return values?.length ? new Set(values) : null;
}

function stableCompare(left: string, right: string): number {
  const normalizedLeft = left.trim().toLocaleLowerCase("uk-UA");
  const normalizedRight = right.trim().toLocaleLowerCase("uk-UA");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteAtLeast(value: number | undefined, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
