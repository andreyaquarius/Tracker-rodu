import type {
  FamilyTreeLayoutInput,
  LayoutBounds,
  LayoutEdge,
  LayoutNode,
  LayoutPoint,
  LayoutResult,
  LayoutUnion,
  OccurrenceId,
} from "../types.ts";
import { layoutGraphEngine } from "./layoutEngine.ts";

function rotatePoint(point: LayoutPoint): LayoutPoint {
  return { x: -point.y, y: point.x };
}

function rotateNode(node: LayoutNode): LayoutNode {
  const center = rotatePoint({
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  });
  return {
    ...node,
    x: center.x - node.width / 2,
    y: center.y - node.height / 2,
  };
}

function placeParentPlaceholders(
  nodes: readonly LayoutNode[],
): LayoutNode[] {
  const structural = nodes.filter(
    node => node.kind !== "placeholder" && node.kind !== "continuation",
  );
  const primaryByPersonId = new Map<string, LayoutNode>();
  for (const node of structural) {
    if (!node.personId || primaryByPersonId.has(node.personId)) continue;
    primaryByPersonId.set(node.personId, node);
  }
  const columnXByGeneration = new Map<number, number>();
  for (const node of structural) {
    const current = columnXByGeneration.get(node.generation);
    columnXByGeneration.set(
      node.generation,
      current === undefined ? node.x : Math.min(current, node.x),
    );
  }
  const placeholderIndexByPersonId = new Map<string, number>();

  return nodes.map(node => {
    if (node.kind !== "placeholder" || !node.actionPersonId) return node;
    const source = primaryByPersonId.get(node.actionPersonId);
    if (!source) return node;
    const index = placeholderIndexByPersonId.get(node.actionPersonId) ?? 0;
    placeholderIndexByPersonId.set(node.actionPersonId, index + 1);
    const parentGeneration = source.generation + 1;
    const sourceCenterY = source.y + source.height / 2;
    const isFather = node.placeholderLabel?.includes("батька") ?? false;
    const isMother = node.placeholderLabel?.includes("матір") ?? false;
    const verticalDirection = isFather ? -1 : isMother ? 1 : index === 0 ? -1 : 1;
    const verticalOffset = Math.max(30, source.height * 0.34);
    const fallbackX = source.x + source.width + 82;
    return {
      ...node,
      generation: parentGeneration,
      x: columnXByGeneration.get(parentGeneration) ?? fallbackX,
      y: sourceCenterY + verticalDirection * verticalOffset - node.height / 2,
    };
  });
}

function rectanglePort(node: LayoutNode, toward: LayoutPoint): LayoutPoint {
  const center = {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
  const deltaX = toward.x - center.x;
  const deltaY = toward.y - center.y;
  if (Math.abs(deltaX) < 0.001 && Math.abs(deltaY) < 0.001) return center;
  const scale = 1 / Math.max(
    Math.abs(deltaX) / Math.max(1, node.width / 2),
    Math.abs(deltaY) / Math.max(1, node.height / 2),
  );
  return {
    x: center.x + deltaX * scale,
    y: center.y + deltaY * scale,
  };
}

function rotateEdge(
  edge: LayoutEdge,
  nodesById: ReadonlyMap<OccurrenceId, LayoutNode>,
): LayoutEdge {
  const points = edge.points.map(rotatePoint);
  if (points.length < 2) return { ...edge, points };

  const source = nodesById.get(edge.sourceId);
  if (source) points[0] = rectanglePort(source, points[1]!);
  const target = nodesById.get(edge.targetId);
  if (target) {
    points[points.length - 1] = rectanglePort(
      target,
      points[points.length - 2]!,
    );
  }
  return { ...edge, points };
}

function computeBounds(
  nodes: readonly LayoutNode[],
  unions: readonly LayoutUnion[],
  edges: readonly LayoutEdge[],
): LayoutBounds {
  if (!nodes.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const include = (point: LayoutPoint): void => {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  };
  for (const node of nodes) {
    include(node);
    include({ x: node.x + node.width, y: node.y + node.height });
  }
  for (const union of unions) include(union);
  for (const edge of edges) for (const point of edge.points) include(point);
  const padding = 120;
  return {
    left: left - padding,
    top: top - padding,
    right: right + padding,
    bottom: bottom + padding,
  };
}

/**
 * Direct pedigree mode reuses the proven recursive ancestor sector solver and
 * rotates only its final geometry. Cards remain upright while generations run
 * from the focus on the left towards older ancestors on the right.
 */
export function layoutDirectPedigree(
  input: FamilyTreeLayoutInput,
): LayoutResult {
  const vertical = layoutGraphEngine(
    {
      ...input,
      options: { ...input.options, layoutMode: "direct-pedigree" },
    },
    "family-graph",
  );
  const nodes = placeParentPlaceholders(vertical.nodes.map(rotateNode));
  const nodesById = new Map(nodes.map(node => [node.occurrenceId, node]));
  const unions = vertical.unions.map(union => ({
    ...union,
    ...rotatePoint(union),
  }));
  const edges = vertical.edges.map(edge => rotateEdge(edge, nodesById));
  return {
    ...vertical,
    nodes,
    unions,
    edges,
    bounds: computeBounds(nodes, unions, edges),
    // Horizontal generation columns do not use the classic horizontal bands.
    generationBands: [],
  };
}
