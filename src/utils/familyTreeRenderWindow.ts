import type { FamilyTreeViewportState } from "../hooks/useFamilyTreeViewport";
import type { FamilyTreeLayoutNode, FamilyTreeViewerLayout } from "./familyTreeViewerLayout";

export type FamilyTreeRenderWindowPinned = {
  selectedOccurrenceId?: string;
  focusOccurrenceId?: string;
  openActionMenuId?: string;
  highlightedOccurrenceIds?: string[];
};

export type FamilyTreeRenderWindowSize = {
  width: number;
  height: number;
};

export type FamilyTreeRenderWindowOptions = {
  virtualizationThreshold?: number;
  overscan?: number;
  visualScale?: number;
};

export type RenderedFamilyTreeLayout = {
  nodes: FamilyTreeLayoutNode[];
  edges: FamilyTreeViewerLayout["edges"];
  familyUnits: FamilyTreeViewerLayout["familyUnits"];
  visibleOccurrenceIds: Set<string>;
};

const DEFAULT_VIRTUALIZATION_THRESHOLD = 220;
const MIN_RENDER_WINDOW_SIZE = 40;

export function visibleLayoutForViewport(
  layout: FamilyTreeViewerLayout,
  viewport: FamilyTreeViewportState,
  viewportSize: FamilyTreeRenderWindowSize | null,
  pinned: FamilyTreeRenderWindowPinned = {},
  options: FamilyTreeRenderWindowOptions = {},
): RenderedFamilyTreeLayout {
  const allVisible = (): RenderedFamilyTreeLayout => ({
    nodes: layout.nodes,
    edges: layout.edges,
    familyUnits: layout.familyUnits,
    visibleOccurrenceIds: new Set(layout.nodes.map((node) => node.occurrence.id)),
  });

  const virtualizationThreshold = options.virtualizationThreshold ?? DEFAULT_VIRTUALIZATION_THRESHOLD;
  if (layout.nodes.length <= virtualizationThreshold || !viewportSize) return allVisible();
  if (viewportSize.width < MIN_RENDER_WINDOW_SIZE || viewportSize.height < MIN_RENDER_WINDOW_SIZE) return allVisible();

  const overscan = options.overscan ?? Math.max(520, 220 / Math.max(viewport.scale, 0.08));
  const visualScale = Math.max(1, Number.isFinite(options.visualScale ?? 1) ? options.visualScale ?? 1 : 1);
  const minX = -viewport.x / viewport.scale - overscan;
  const maxX = (viewportSize.width - viewport.x) / viewport.scale + overscan;
  const minY = -viewport.y / viewport.scale - overscan;
  const maxY = (viewportSize.height - viewport.y) / viewport.scale + overscan;
  const pinnedIds = new Set([
    pinned.selectedOccurrenceId,
    pinned.focusOccurrenceId,
    pinned.openActionMenuId,
    ...(pinned.highlightedOccurrenceIds ?? []),
  ].filter((id): id is string => Boolean(id)));

  const visibleOccurrenceIds = new Set<string>();
  for (const node of layout.nodes) {
    if (
      pinnedIds.has(node.occurrence.id) ||
      rectIntersectsBounds(node, minX, minY, maxX, maxY, visualScale)
    ) {
      visibleOccurrenceIds.add(node.occurrence.id);
    }
  }
  includePinnedRelationshipContext(layout, visibleOccurrenceIds, pinnedIds);
  const nodes = layout.nodes.filter((node) => visibleOccurrenceIds.has(node.occurrence.id));
  const familyUnits = layout.familyUnits
    .map((unit) => clipFamilyUnitToVisibleNodes(unit, visibleOccurrenceIds))
    .filter((unit): unit is FamilyTreeViewerLayout["familyUnits"][number] => Boolean(unit));
  const unitEdgeIds = new Set(familyUnits.flatMap((unit) => unit.edges.map((edge) => edge.edge.id)));
  const edges = layout.edges.filter((edge) =>
    unitEdgeIds.has(edge.edge.id) ||
    (
      visibleOccurrenceIds.has(edge.from.occurrence.id) &&
      visibleOccurrenceIds.has(edge.to.occurrence.id)
    ),
  );

  return {
    nodes,
    edges,
    familyUnits,
    visibleOccurrenceIds,
  };
}

function includePinnedRelationshipContext(
  layout: FamilyTreeViewerLayout,
  visibleOccurrenceIds: Set<string>,
  pinnedIds: Set<string>,
): void {
  if (!pinnedIds.size) return;
  for (const edge of layout.edges) {
    const fromId = edge.from.occurrence.id;
    const toId = edge.to.occurrence.id;
    if (pinnedIds.has(fromId)) visibleOccurrenceIds.add(toId);
    if (pinnedIds.has(toId)) visibleOccurrenceIds.add(fromId);
  }
}

function clipFamilyUnitToVisibleNodes(
  unit: FamilyTreeViewerLayout["familyUnits"][number],
  visibleOccurrenceIds: Set<string>,
): FamilyTreeViewerLayout["familyUnits"][number] | null {
  const children = unit.children.filter((child) => visibleOccurrenceIds.has(child.occurrence.id));
  if (!children.length) return null;
  const parents = unit.parents;
  if (!parents.length) return null;
  const visibleChildIds = new Set(children.map((child) => child.occurrence.id));
  const edges = unit.edges.filter((edge) =>
    visibleChildIds.has(edge.to.occurrence.id),
  );
  if (!edges.length) return null;
  const unitX = parents.length > 1
    ? (nodeCenterX(parents[0]) + nodeCenterX(parents[parents.length - 1])) / 2
    : unit.unitX;
  return {
    ...unit,
    parentOccurrenceIds: parents.map((parent) => parent.occurrence.id),
    childOccurrenceIds: children.map((child) => child.occurrence.id),
    parents,
    children,
    edges,
    unitX,
    path: visibleFamilyUnitPath({
      parents,
      children,
      unitX,
      parentBusY: unit.parentBusY,
      childBusY: unit.childBusY,
    }),
    opacity: Math.min(...edges.map((edge) => edge.opacity)),
  };
}

function visibleFamilyUnitPath(input: {
  parents: FamilyTreeLayoutNode[];
  children: FamilyTreeLayoutNode[];
  unitX: number;
  parentBusY: number;
  childBusY: number;
}): string {
  const parents = [...input.parents].sort((left, right) => nodeCenterX(left) - nodeCenterX(right));
  const children = [...input.children].sort((left, right) => nodeCenterX(left) - nodeCenterX(right));
  const paths: string[] = [];
  if (parents.length > 1) {
    const first = parents[0];
    const last = parents[parents.length - 1];
    const fromX = first.x + first.width;
    const toX = last.x;
    paths.push(fromX <= toX
      ? `M ${fromX} ${input.parentBusY} H ${toX}`
      : `M ${nodeCenterX(first)} ${input.parentBusY} H ${nodeCenterX(last)}`);
  } else if (parents[0]) {
    const parent = parents[0];
    paths.push(`M ${nodeCenterX(parent)} ${parent.y + parent.height} V ${input.parentBusY}`);
  }
  if (children.length === 1) {
    const child = children[0];
    paths.push(visibleRoundedBranchPath(input.unitX, input.parentBusY, nodeCenterX(child), child.y));
    return paths.join(" ");
  }
  paths.push(visibleRoundedBranchPath(input.unitX, input.parentBusY, input.unitX, input.childBusY));
  paths.push(`M ${Math.min(input.unitX, nodeCenterX(children[0]))} ${input.childBusY} H ${Math.max(input.unitX, nodeCenterX(children[children.length - 1]))}`);
  for (const child of children) {
    paths.push(visibleRoundedBranchPath(nodeCenterX(child), input.childBusY, nodeCenterX(child), child.y));
  }
  return paths.join(" ");
}

function visibleRoundedBranchPath(startX: number, startY: number, endX: number, endY: number): string {
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

function nodeCenterX(node: FamilyTreeLayoutNode): number {
  return node.x + node.width / 2;
}

export function layoutVisibleInViewport(
  layout: FamilyTreeViewerLayout,
  viewport: FamilyTreeViewportState,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const minScreenX = viewport.x + layout.minX * viewport.scale;
  const maxScreenX = viewport.x + layout.maxX * viewport.scale;
  const minScreenY = viewport.y + layout.minY * viewport.scale;
  const maxScreenY = viewport.y + layout.maxY * viewport.scale;
  const visibleWidth = Math.min(viewportWidth, maxScreenX) - Math.max(0, minScreenX);
  const visibleHeight = Math.min(viewportHeight, maxScreenY) - Math.max(0, minScreenY);
  return visibleWidth >= 60 && visibleHeight >= 60;
}

function rectIntersectsBounds(
  node: FamilyTreeLayoutNode,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  visualScale: number,
): boolean {
  const extraWidth = node.width * Math.max(0, visualScale - 1) / 2;
  const extraHeight = node.height * Math.max(0, visualScale - 1) / 2;
  return node.x + node.width + extraWidth >= minX &&
    node.x - extraWidth <= maxX &&
    node.y + node.height + extraHeight >= minY &&
    node.y - extraHeight <= maxY;
}
