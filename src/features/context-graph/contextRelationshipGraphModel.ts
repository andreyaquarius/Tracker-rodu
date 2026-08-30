export type ContextRelationshipGraphNodeKind = "person" | "group";

export interface ContextRelationshipGraphNode {
  id: string;
  label: string;
  kind: ContextRelationshipGraphNodeKind;
  /** False for masked/private nodes that may be inspected but never opened. */
  activatable?: boolean;
  subtitle?: string;
  description?: string;
  color?: string;
}

export interface ContextRelationshipGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  description?: string;
  directed?: boolean;
  /** Keep technical structure inspectable without filling the canvas with repeated labels. */
  labelVisibility?: "visible" | "details-only";
  /** Optional semantic line treatment; it never changes the stored relationship meaning. */
  lineStyle?: "solid" | "dashed";
  /** Original evidence rows retained when several records share one visible connection. */
  members?: readonly ContextRelationshipGraphEdgeMember[];
  /** Unique visible roles with their source-record counts. */
  roles?: readonly ContextRelationshipGraphRoleSummary[];
}

export interface ContextRelationshipGraphEdgeMember {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  description?: string;
  directed?: boolean;
}

export interface ContextRelationshipGraphRoleSummary {
  label: string;
  count: number;
}

export interface ContextRelationshipGraphLimits {
  maxNodes?: number;
  maxEdges?: number;
}

export interface BoundedContextRelationshipGraph {
  centerNodeId: string;
  nodes: ContextRelationshipGraphNode[];
  edges: ContextRelationshipGraphEdge[];
  omittedNodeCount: number;
  omittedEdgeCount: number;
}

export interface ContextRelationshipGraphLayoutNode extends ContextRelationshipGraphNode {
  x: number;
  y: number;
  z: number;
  /** Relative coordinates used only by the perspective view. */
  worldX: number;
  worldY: number;
  worldZ: number;
  depth: number;
}

export interface ContextRelationshipGraphLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  nodes: ContextRelationshipGraphLayoutNode[];
  edges: ContextRelationshipGraphEdge[];
}

export type ContextRelationshipGraphLayoutBuilder = (
  graph: BoundedContextRelationshipGraph,
) => ContextRelationshipGraphLayout;

export interface ContextRelationshipGraphProjectionNode extends ContextRelationshipGraphLayoutNode {
  screenX: number;
  screenY: number;
  scale: number;
  opacity: number;
}

export interface ContextRelationshipGraphProjectionEdge extends ContextRelationshipGraphEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  depth: number;
  scale: number;
  opacity: number;
}

export interface ContextRelationshipGraphProjection {
  nodes: ContextRelationshipGraphProjectionNode[];
  edges: ContextRelationshipGraphProjectionEdge[];
}

/** A manual node displacement in the projection's scene-local SVG units. */
export interface ContextRelationshipGraphNodeOffset {
  x: number;
  y: number;
}

export type ContextRelationshipGraphNodeOffsets = Readonly<Record<
  string,
  ContextRelationshipGraphNodeOffset | undefined
>>;

export interface ContextRelationshipGraphView {
  zoom: number;
  panX?: number;
  panY?: number;
  yaw?: number;
  pitch?: number;
}

export interface ContextRelationshipGraphWrappedLabel {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_NODES = 120;
const DEFAULT_MAX_EDGES = 320;
const MIN_NODE_LIMIT = 1;
const MAX_NODE_LIMIT = 250;
const MIN_EDGE_LIMIT = 0;
const MAX_EDGE_LIMIT = 1000;
const CAMERA_DISTANCE = 920;

export function buildBoundedContextRelationshipGraph(
  center: ContextRelationshipGraphNode,
  nodes: readonly ContextRelationshipGraphNode[],
  edges: readonly ContextRelationshipGraphEdge[],
  limits: ContextRelationshipGraphLimits = {},
): BoundedContextRelationshipGraph {
  const maxNodes = integerInRange(limits.maxNodes, DEFAULT_MAX_NODES, MIN_NODE_LIMIT, MAX_NODE_LIMIT);
  const maxEdges = integerInRange(limits.maxEdges, DEFAULT_MAX_EDGES, MIN_EDGE_LIMIT, MAX_EDGE_LIMIT);
  const uniqueNodes = new Map<string, ContextRelationshipGraphNode>();

  [...nodes, center].forEach((node) => {
    const id = node.id.trim();
    if (!id) return;
    uniqueNodes.set(id, normalizeNode(node, id));
  });
  uniqueNodes.set(center.id.trim(), normalizeNode(center, center.id.trim()));

  const otherNodes = [...uniqueNodes.values()]
    .filter((node) => node.id !== center.id.trim())
    .sort(compareNodes);
  const selectedNodes = [normalizeNode(center, center.id.trim()), ...otherNodes.slice(0, Math.max(0, maxNodes - 1))];
  const selectedIds = new Set(selectedNodes.map((node) => node.id));

  const validEdges = deduplicateEdges(edges)
    .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
    .sort(compareEdges);
  const selectedEdges = validEdges.slice(0, maxEdges);
  const allValidForUniqueNodes = deduplicateEdges(edges)
    .filter((edge) => uniqueNodes.has(edge.sourceId) && uniqueNodes.has(edge.targetId));

  return {
    centerNodeId: center.id.trim(),
    nodes: selectedNodes,
    edges: selectedEdges,
    omittedNodeCount: Math.max(0, uniqueNodes.size - selectedNodes.length),
    omittedEdgeCount: Math.max(0, allValidForUniqueNodes.length - selectedEdges.length),
  };
}

/** Stable radial/BFS layout used by both the flat and perspective views. */
export function buildContextRelationshipGraphLayout(
  graph: BoundedContextRelationshipGraph,
): ContextRelationshipGraphLayout {
  const depths = graphDepths(graph);
  const ordered = graph.nodes
    .filter((node) => node.id !== graph.centerNodeId)
    .slice()
    .sort((left, right) => {
      const depthDifference = (depths.get(left.id) ?? 999) - (depths.get(right.id) ?? 999);
      return depthDifference || compareNodes(left, right);
    });

  const ringAssignments = assignRings(ordered.length);
  const outerRadius = ringAssignments.length
    ? ringAssignments[ringAssignments.length - 1]!.radius
    : 120;
  const width = round(Math.max(760, outerRadius * 2 + 180));
  const height = round(Math.max(520, outerRadius * 2 + 150));
  const centerX = width / 2;
  const centerY = height / 2;
  const layoutNodes: ContextRelationshipGraphLayoutNode[] = [];
  const center = graph.nodes.find((node) => node.id === graph.centerNodeId);
  if (center) {
    layoutNodes.push({
      ...center,
      x: centerX,
      y: centerY,
      z: 0,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      depth: 0,
    });
  }

  let nodeIndex = 0;
  ringAssignments.forEach((ring, ringIndex) => {
    const startAngle = -Math.PI / 2 + (ringIndex % 2 ? Math.PI / Math.max(1, ring.count) : 0);
    for (let slot = 0; slot < ring.count; slot += 1) {
      const node = ordered[nodeIndex];
      nodeIndex += 1;
      if (!node) break;
      const angle = startAngle + (Math.PI * 2 * slot) / Math.max(1, ring.count);
      const spatial = spatialPointOnRing(ring.radius, ring.count, slot, ringIndex);
      layoutNodes.push({
        ...node,
        x: round(centerX + Math.cos(angle) * ring.radius),
        y: round(centerY + Math.sin(angle) * ring.radius),
        z: spatial.z,
        worldX: spatial.x,
        worldY: spatial.y,
        worldZ: spatial.z,
        depth: depths.get(node.id) ?? ringIndex + 1,
      });
    }
  });

  return {
    width,
    height,
    centerX,
    centerY,
    nodes: layoutNodes,
    edges: graph.edges.slice(),
  };
}

export function projectContextRelationshipGraph2D(
  layout: ContextRelationshipGraphLayout,
  view: ContextRelationshipGraphView,
): ContextRelationshipGraphProjection {
  const zoom = clampGraphZoom(view.zoom);
  const panX = finite(view.panX, 0);
  const panY = finite(view.panY, 0);
  const nodes = layout.nodes.map((node) => ({
    ...node,
    z: 0,
    screenX: round(layout.centerX + (node.x - layout.centerX) * zoom + panX),
    screenY: round(layout.centerY + (node.y - layout.centerY) * zoom + panY),
    scale: 1,
    opacity: 1,
  }));
  return projectionWithEdges(nodes, layout.edges);
}

/**
 * Applies yaw and pitch in world space followed by a pinhole-camera projection.
 * The returned nodes are sorted far-to-near, so later SVG elements paint over
 * earlier ones and preserve the visual depth cue.
 */
export function projectContextRelationshipGraph3D(
  layout: ContextRelationshipGraphLayout,
  view: ContextRelationshipGraphView,
): ContextRelationshipGraphProjection {
  const zoom = clampGraphZoom(view.zoom);
  const yaw = finite(view.yaw, -0.52);
  const pitch = clamp(finite(view.pitch, 0.28), -1.25, 1.25);
  const panX = finite(view.panX, 0);
  const panY = finite(view.panY, 0);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centroid = layout.nodes.reduce(
    (result, node) => ({
      x: result.x + node.worldX / Math.max(1, layout.nodes.length),
      y: result.y + node.worldY / Math.max(1, layout.nodes.length),
      z: result.z + node.worldZ / Math.max(1, layout.nodes.length),
    }),
    { x: 0, y: 0, z: 0 },
  );
  const spatialRadius = Math.max(
    1,
    ...layout.nodes.map((node) => Math.hypot(
      node.worldX - centroid.x,
      node.worldY - centroid.y,
      node.worldZ - centroid.z,
    )),
  );
  const cameraDistance = Math.max(CAMERA_DISTANCE, spatialRadius * 3.2);

  const nodes = layout.nodes.map((node) => {
    // Rotate the complete scene around its actual centre of mass rather than
    // pinning the focal node to the viewport centre. This lets the focal card
    // participate in the same spatial motion as every other card.
    const worldX = node.worldX - centroid.x;
    const worldY = node.worldY - centroid.y;
    const worldZ = node.worldZ - centroid.z;
    const yawX = worldX * cosYaw + worldZ * sinYaw;
    const yawZ = -worldX * sinYaw + worldZ * cosYaw;
    const pitchY = worldY * cosPitch - yawZ * sinPitch;
    const rotatedZ = worldY * sinPitch + yawZ * cosPitch;
    const perspective = cameraDistance / Math.max(cameraDistance * 0.45, cameraDistance - rotatedZ);
    const scale = clamp(perspective, 0.74, 1.42);
    const opacity = clamp(0.68 + (scale - 0.74) * 0.56, 0.68, 1);
    return {
      ...node,
      x: round(yawX),
      y: round(pitchY),
      z: round(rotatedZ),
      screenX: round(layout.centerX + yawX * perspective * zoom + panX),
      screenY: round(layout.centerY + pitchY * perspective * zoom + panY),
      scale: round(scale),
      opacity: round(opacity),
    };
  }).sort((left, right) => left.z - right.z || compareNodes(left, right));

  return projectionWithEdges(nodes, layout.edges);
}

/**
 * Applies user-controlled screen-plane node positions after camera projection.
 * Edge endpoints are rebuilt from the displaced nodes, so arrows and hit areas
 * remain attached while a card is dragged in either visual mode.
 */
export function applyContextRelationshipGraphNodeOffsets(
  projection: ContextRelationshipGraphProjection,
  offsets: ContextRelationshipGraphNodeOffsets,
): ContextRelationshipGraphProjection {
  if (!Object.keys(offsets).length) return projection;

  let changed = false;
  const nodes = projection.nodes.map((node) => {
    if (!Object.prototype.hasOwnProperty.call(offsets, node.id)) return node;
    const offset = offsets[node.id];
    if (!offset) return node;
    const offsetX = finite(offset.x, 0);
    const offsetY = finite(offset.y, 0);
    if (offsetX === 0 && offsetY === 0) return node;
    changed = true;
    return {
      ...node,
      screenX: round(node.screenX + offsetX),
      screenY: round(node.screenY + offsetY),
    };
  });

  return changed ? projectionWithEdges(nodes, projection.edges) : projection;
}

export function clampGraphZoom(value: number): number {
  return round(clamp(finite(value, 1), 0.45, 2.6));
}

/**
 * Wraps a visible graph label on word boundaries without destroying a normal
 * Ukrainian full name. Ellipsis is added only when the configured line budget
 * is genuinely exhausted; the full value remains available in details/title.
 */
export function wrapContextRelationshipGraphLabel(
  value: string,
  maximumCharacters = 24,
  maximumLines = 3,
): ContextRelationshipGraphWrappedLabel {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const lineLimit = Math.max(1, Math.round(maximumLines));
  const characterLimit = Math.max(4, Math.round(maximumCharacters));
  if (!normalized) return { lines: ["Без назви"], truncated: false };

  const tokens = normalized.split(" ").flatMap((word) => {
    if (word.length <= characterLimit) return [word];
    const chunks: string[] = [];
    for (let start = 0; start < word.length; start += characterLimit) {
      chunks.push(word.slice(start, start + characterLimit));
    }
    return chunks;
  });
  const unboundedLines: string[] = [];
  let current = "";
  tokens.forEach((token) => {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= characterLimit) {
      current = candidate;
      return;
    }
    if (current) unboundedLines.push(current);
    current = token;
  });
  if (current) unboundedLines.push(current);
  if (unboundedLines.length <= lineLimit) {
    return { lines: unboundedLines, truncated: false };
  }

  const lines = unboundedLines.slice(0, lineLimit);
  const lastIndex = lines.length - 1;
  const last = lines[lastIndex] ?? "";
  lines[lastIndex] = `${last.slice(0, Math.max(1, characterLimit - 1)).trimEnd()}…`;
  return { lines, truncated: true };
}

/**
 * Collapses parallel evidence rows into one visual connection per pair of
 * people. The original rows remain in `members`, so the detail panel can show
 * every source without drawing duplicate lines and labels on the canvas.
 */
export function groupContextRelationshipGraphEdgesByPair(
  edges: readonly ContextRelationshipGraphEdge[],
  centerNodeId: string,
): ContextRelationshipGraphEdge[] {
  const grouped = new Map<string, ContextRelationshipGraphEdgeMember[]>();
  edges.forEach((edge) => {
    const members = edge.members?.length
      ? edge.members
      : [{
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          label: edge.label,
          description: edge.description,
          directed: edge.directed,
        }];
    members.forEach((member) => {
      const sourceId = member.sourceId.trim();
      const targetId = member.targetId.trim();
      if (!sourceId || !targetId) return;
      const pair = [sourceId, targetId].sort(stableCompare);
      const key = `${pair[0]}\u0000${pair[1]}`;
      const current = grouped.get(key) ?? [];
      current.push({
        ...member,
        id: member.id.trim(),
        sourceId,
        targetId,
        label: member.label.trim() || "Зв’язок",
        description: member.description?.trim() || undefined,
        directed: member.directed ?? false,
      });
      grouped.set(key, current);
    });
  });

  return [...grouped.entries()].map(([key, rawMembers]) => {
    const members = rawMembers.slice().sort((left, right) => (
      stableCompare(left.label, right.label) || stableCompare(left.id, right.id)
    ));
    const endpoints = key.split("\u0000");
    const leftId = endpoints[0] ?? "";
    const rightId = endpoints[1] ?? "";
    const otherId = leftId === centerNodeId ? rightId : leftId;
    let sourceId = leftId === centerNodeId || rightId === centerNodeId ? otherId : leftId;
    let targetId = leftId === centerNodeId || rightId === centerNodeId ? centerNodeId : rightId;
    let directed = false;
    const first = members[0];
    if (first && members.every((member) => (
      member.directed
      && member.sourceId === first.sourceId
      && member.targetId === first.targetId
    ))) {
      sourceId = first.sourceId;
      targetId = first.targetId;
      directed = true;
    }

    const counts = new Map<string, number>();
    members.forEach((member) => counts.set(member.label, (counts.get(member.label) ?? 0) + 1));
    const roles = [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => stableCompare(left.label, right.label));
    const firstRole = roles[0]?.label ?? "Зв’язок";
    const label = roles.length <= 2
      ? roles.map((role) => role.label).join(" · ") || firstRole
      : `${firstRole} · +${roles.length - 1} ${pluralizeUkrainian(roles.length - 1, "роль", "ролі", "ролей")}`;
    return {
      id: `connection:${encodeURIComponent(leftId)}::${encodeURIComponent(rightId)}`,
      sourceId,
      targetId,
      label,
      description: `${members.length} ${pluralizeUkrainian(members.length, "запис", "записи", "записів")} · ${roles.length} ${pluralizeUkrainian(roles.length, "роль", "ролі", "ролей")}`,
      directed,
      members,
      roles,
    };
  }).sort(compareEdges);
}

function projectionWithEdges(
  nodes: ContextRelationshipGraphProjectionNode[],
  edges: readonly ContextRelationshipGraphEdge[],
): ContextRelationshipGraphProjection {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const projectedEdges = edges.flatMap((edge) => {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    if (!source || !target) return [];
    return [{
      ...edge,
      sourceX: source.screenX,
      sourceY: source.screenY,
      targetX: target.screenX,
      targetY: target.screenY,
      depth: round((source.z + target.z) / 2),
      scale: round((source.scale + target.scale) / 2),
      opacity: round(Math.min(source.opacity, target.opacity) * 0.82),
    }];
  }).sort((left, right) => left.depth - right.depth || compareEdges(left, right));
  return { nodes, edges: projectedEdges };
}

function graphDepths(graph: BoundedContextRelationshipGraph): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  graph.nodes.forEach((node) => adjacency.set(node.id, new Set()));
  graph.edges.forEach((edge) => {
    adjacency.get(edge.sourceId)?.add(edge.targetId);
    adjacency.get(edge.targetId)?.add(edge.sourceId);
  });
  const depth = new Map<string, number>([[graph.centerNodeId, 0]]);
  const queue = [graph.centerNodeId];
  while (queue.length) {
    const current = queue.shift()!;
    const nextDepth = (depth.get(current) ?? 0) + 1;
    [...(adjacency.get(current) ?? [])].sort(stableCompare).forEach((neighbor) => {
      if (depth.has(neighbor)) return;
      depth.set(neighbor, nextDepth);
      queue.push(neighbor);
    });
  }
  const disconnectedDepth = Math.max(1, ...depth.values()) + 1;
  graph.nodes.forEach((node) => {
    if (!depth.has(node.id)) depth.set(node.id, disconnectedDepth);
  });
  return depth;
}

function assignRings(count: number): Array<{ radius: number; count: number }> {
  const result: Array<{ radius: number; count: number }> = [];
  let remaining = count;
  let ringIndex = 0;
  while (remaining > 0) {
    // Relationship nodes are horizontal name cards, not small circles. The
    // larger footprint prevents ordinary ПІБ cards from colliding at rest.
    const radius = 245 + ringIndex * 190;
    const capacity = Math.max(5, Math.floor((Math.PI * 2 * radius) / 205));
    const ringCount = Math.min(remaining, capacity);
    result.push({ radius, count: ringCount });
    remaining -= ringCount;
    ringIndex += 1;
  }
  return result;
}

function spatialPointOnRing(
  radius: number,
  count: number,
  slot: number,
  ringIndex: number,
): { x: number; y: number; z: number } {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const vertical = clamp(1 - (2 * (slot + 0.5)) / Math.max(1, count), -0.68, 0.68);
  const azimuth = ringIndex * 0.37 + slot * goldenAngle;
  const horizontalRadius = radius * Math.sqrt(Math.max(0, 1 - vertical * vertical));
  return {
    x: round(horizontalRadius * Math.cos(azimuth)),
    y: round(radius * vertical),
    z: round(horizontalRadius * Math.sin(azimuth)),
  };
}

function deduplicateEdges(edges: readonly ContextRelationshipGraphEdge[]): ContextRelationshipGraphEdge[] {
  const byId = new Map<string, ContextRelationshipGraphEdge>();
  edges.forEach((edge) => {
    const id = edge.id.trim();
    const sourceId = edge.sourceId.trim();
    const targetId = edge.targetId.trim();
    if (!id || !sourceId || !targetId) return;
    byId.set(id, {
      ...edge,
      id,
      sourceId,
      targetId,
      label: edge.label.trim() || "Зв’язок",
      description: edge.description?.trim() || undefined,
      directed: edge.directed ?? false,
    });
  });
  return [...byId.values()];
}

function normalizeNode(node: ContextRelationshipGraphNode, id: string): ContextRelationshipGraphNode {
  return {
    ...node,
    id,
    label: node.label.trim() || (node.kind === "group" ? "Група без назви" : "Особа без імені"),
    kind: node.kind === "group" ? "group" : "person",
    subtitle: node.subtitle?.trim() || undefined,
    description: node.description?.trim() || undefined,
    color: validCssColorToken(node.color),
  };
}

function validCssColorToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^#[0-9a-f]{3,8}$/iu.test(trimmed) ? trimmed : undefined;
}

function compareNodes(left: ContextRelationshipGraphNode, right: ContextRelationshipGraphNode): number {
  return stableCompare(left.kind, right.kind)
    || stableCompare(left.label, right.label)
    || stableCompare(left.id, right.id);
}

function compareEdges(left: ContextRelationshipGraphEdge, right: ContextRelationshipGraphEdge): number {
  return stableCompare(left.label, right.label)
    || stableCompare(left.sourceId, right.sourceId)
    || stableCompare(left.targetId, right.targetId)
    || stableCompare(left.id, right.id);
}

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "uk", { sensitivity: "base", numeric: true });
}

function pluralizeUkrainian(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(Math.trunc(count));
  const mod100 = absolute % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = absolute % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function integerInRange(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.round(clamp(finite(value, fallback), minimum, maximum));
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
