import type {
  BoundedContextRelationshipGraph,
  ContextRelationshipGraphEdge,
  ContextRelationshipGraphLayout,
  ContextRelationshipGraphLayoutNode,
  ContextRelationshipGraphNode,
} from "./contextRelationshipGraphModel.ts";

const CARD_WIDTH = 196;
const CARD_HEIGHT = 94;
const HORIZONTAL_GAP = 24;
const VERTICAL_GAP = 20;
const SCENE_MARGIN = 80;
const CENTER_GROUP_Y = -160;
const GROUP_RING_MINIMUM_RADIUS = 480;
const GROUP_CLUSTER_ARC = 620;
const MEMBER_RING_START = 250;
const MEMBER_RING_STEP = 230;
const MEMBER_ANGLES = [-Math.PI / 4, Math.PI / 4, -3 * Math.PI / 4, 3 * Math.PI / 4] as const;

interface Point {
  x: number;
  y: number;
}

/**
 * A deterministic compound layout for the ritual surname network.
 *
 * The focal person, surname-group anchors and exact sample people occupy
 * separate visual levels. Exact people are placed in collision-checked local
 * sectors around the surname group that owns their membership. This avoids
 * mixing technical group nodes and exact people on one generic BFS ring.
 */
export function buildChurchRoleRelationshipGraphLayout(
  graph: BoundedContextRelationshipGraph,
): ContextRelationshipGraphLayout {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const center = nodesById.get(graph.centerNodeId) ?? graph.nodes[0];
  if (!center) {
    return {
      width: 760,
      height: 520,
      centerX: 380,
      centerY: 260,
      nodes: [],
      edges: [],
    };
  }

  const groups = graph.nodes
    .filter((node) => node.kind === "group")
    .slice()
    .sort(compareNodes);
  const membershipGroups = collectMembershipGroups(graph.edges, nodesById);
  const centerGroupId = [...(membershipGroups.get(center.id) ?? [])]
    .filter((groupId) => nodesById.get(groupId)?.kind === "group")
    .sort(stableCompare)[0];
  const counterpartGroups = groups.filter((group) => group.id !== centerGroupId);
  const positions = new Map<string, Point>([[center.id, { x: 0, y: 0 }]]);
  const ownerGroupByPersonId = new Map<string, string>();

  if (centerGroupId) {
    positions.set(centerGroupId, { x: 0, y: CENTER_GROUP_Y });
  }

  const groupRingRadius = counterpartGroupRadius(counterpartGroups.length);
  counterpartGroups.forEach((group, index) => {
    const angle = counterpartGroups.length === 1
      ? 0
      : (Math.PI * 2 * index) / counterpartGroups.length;
    positions.set(group.id, {
      x: round(Math.cos(angle) * groupRingRadius),
      y: round(Math.sin(angle) * groupRingRadius),
    });
  });

  const people = graph.nodes
    .filter((node) => node.kind === "person" && node.id !== center.id)
    .slice()
    .sort(compareNodes);
  people.forEach((person) => {
    const memberships = [...(membershipGroups.get(person.id) ?? [])]
      .filter((groupId) => nodesById.get(groupId)?.kind === "group")
      .sort(stableCompare);
    const owner = centerGroupId && memberships.includes(centerGroupId)
      ? centerGroupId
      : memberships[0];
    if (owner) ownerGroupByPersonId.set(person.id, owner);
  });

  const membersByOwner = new Map<string, ContextRelationshipGraphNode[]>();
  people.forEach((person) => {
    const owner = ownerGroupByPersonId.get(person.id);
    if (!owner) return;
    const members = membersByOwner.get(owner) ?? [];
    members.push(person);
    membersByOwner.set(owner, members);
  });
  membersByOwner.forEach((members) => members.sort(compareNodes));

  const ownerOrder = [
    ...(centerGroupId ? [centerGroupId] : []),
    ...counterpartGroups.map((group) => group.id),
  ];
  ownerOrder.forEach((ownerId) => {
    const anchor = positions.get(ownerId);
    if (!anchor) return;
    const members = membersByOwner.get(ownerId) ?? [];
    const direction = ownerId === centerGroupId
      ? Math.atan2(anchor.y, anchor.x || 0.0001)
      : Math.atan2(-anchor.y, -anchor.x);
    members.forEach((person, memberIndex) => {
      const candidates = memberCandidates(anchor, direction, memberIndex);
      positions.set(person.id, firstAvailablePosition(candidates, positions));
    });
  });

  const unownedPeople = people.filter((person) => !ownerGroupByPersonId.has(person.id));
  const unownedRadius = groupRingRadius + 360;
  unownedPeople.forEach((person, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, unownedPeople.length);
    const preferred = {
      x: round(Math.cos(angle) * unownedRadius),
      y: round(Math.sin(angle) * unownedRadius),
    };
    positions.set(person.id, firstAvailablePosition([preferred], positions));
  });

  // Malformed input may contain disconnected group nodes not covered by the
  // normal counterpart pass. Keep every selected node visible and finite.
  graph.nodes.slice().sort(compareNodes).forEach((node) => {
    if (!positions.has(node.id)) positions.set(node.id, fallbackPosition(positions));
  });

  const bounds = sceneBounds(positions);
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  const width = round(Math.max(760, contentWidth + SCENE_MARGIN * 2));
  const height = round(Math.max(520, contentHeight + SCENE_MARGIN * 2));
  const translateX = (width - contentWidth) / 2 - bounds.minX;
  const translateY = (height - contentHeight) / 2 - bounds.minY;
  const centerPosition = positions.get(center.id) ?? { x: 0, y: 0 };
  const centerX = round(centerPosition.x + translateX);
  const centerY = round(centerPosition.y + translateY);
  const groupDepthById = groupWorldDepths(centerGroupId, counterpartGroups, groupRingRadius);
  const layoutNodes = graph.nodes
    .slice()
    .sort((left, right) => semanticDepth(left, center.id, centerGroupId) - semanticDepth(right, center.id, centerGroupId)
      || compareNodes(left, right))
    .map((node): ContextRelationshipGraphLayoutNode => {
      const point = positions.get(node.id) ?? { x: 0, y: 0 };
      const ownerId = ownerGroupByPersonId.get(node.id);
      const worldZ = node.id === center.id
        ? 0
        : node.kind === "group"
          ? groupDepthById.get(node.id) ?? deterministicDepth(node.id, 150)
          : ownerId
            ? (groupDepthById.get(ownerId) ?? 0) + deterministicDepth(node.id, 58)
            : deterministicDepth(node.id, 190);
      return {
        ...node,
        x: round(point.x + translateX),
        y: round(point.y + translateY),
        z: round(worldZ),
        worldX: round(point.x - centerPosition.x),
        worldY: round((point.y - centerPosition.y) * 0.72),
        worldZ: round(worldZ),
        depth: semanticDepth(node, center.id, centerGroupId),
      };
    });

  return {
    width,
    height,
    centerX,
    centerY,
    nodes: layoutNodes,
    edges: graph.edges.slice().sort((left, right) => stableCompare(left.id, right.id)),
  };
}

function collectMembershipGroups(
  edges: readonly ContextRelationshipGraphEdge[],
  nodesById: ReadonlyMap<string, ContextRelationshipGraphNode>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    if (!edge.id.startsWith("surname-membership:")) return;
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    const person = source?.kind === "person" && target?.kind === "group"
      ? source
      : target?.kind === "person" && source?.kind === "group"
        ? target
        : undefined;
    const group = source?.kind === "group" && target?.kind === "person"
      ? source
      : target?.kind === "group" && source?.kind === "person"
        ? target
        : undefined;
    if (!person || !group) return;
    const groupIds = result.get(person.id) ?? new Set<string>();
    groupIds.add(group.id);
    result.set(person.id, groupIds);
  });
  return result;
}

function counterpartGroupRadius(count: number): number {
  if (count <= 1) return GROUP_RING_MINIMUM_RADIUS;
  const requiredRadius = GROUP_CLUSTER_ARC / (2 * Math.sin(Math.PI / count));
  return round(Math.max(GROUP_RING_MINIMUM_RADIUS, requiredRadius));
}

function memberCandidates(anchor: Point, direction: number, memberIndex: number): Point[] {
  const candidates: Point[] = [];
  const preferredRing = Math.floor(memberIndex / MEMBER_ANGLES.length);
  const preferredSlot = memberIndex % MEMBER_ANGLES.length;
  for (let pass = 0; pass < 24; pass += 1) {
    const ring = preferredRing + pass;
    const distance = MEMBER_RING_START + ring * MEMBER_RING_STEP;
    for (let slotOffset = 0; slotOffset < MEMBER_ANGLES.length; slotOffset += 1) {
      const slot = (preferredSlot + slotOffset) % MEMBER_ANGLES.length;
      const angle = direction + MEMBER_ANGLES[slot]!;
      candidates.push({
        x: round(anchor.x + Math.cos(angle) * distance),
        y: round(anchor.y + Math.sin(angle) * distance),
      });
    }
  }
  return candidates;
}

function firstAvailablePosition(candidates: readonly Point[], positions: ReadonlyMap<string, Point>): Point {
  for (const candidate of candidates) {
    if (![...positions.values()].some((position) => cardsOverlap(candidate, position))) {
      return candidate;
    }
  }
  return fallbackPosition(positions);
}

function fallbackPosition(positions: ReadonlyMap<string, Point>): Point {
  const current = [...positions.values()];
  const bottom = current.length ? Math.max(...current.map((point) => point.y)) : 0;
  return { x: 0, y: round(bottom + CARD_HEIGHT + VERTICAL_GAP) };
}

function cardsOverlap(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) < CARD_WIDTH + HORIZONTAL_GAP
    && Math.abs(left.y - right.y) < CARD_HEIGHT + VERTICAL_GAP;
}

function sceneBounds(positions: ReadonlyMap<string, Point>) {
  const values = [...positions.values()];
  if (!values.length) return { minX: -CARD_WIDTH / 2, maxX: CARD_WIDTH / 2, minY: -CARD_HEIGHT / 2, maxY: CARD_HEIGHT / 2 };
  return {
    minX: Math.min(...values.map((point) => point.x - CARD_WIDTH / 2)),
    maxX: Math.max(...values.map((point) => point.x + CARD_WIDTH / 2)),
    minY: Math.min(...values.map((point) => point.y - CARD_HEIGHT / 2)),
    maxY: Math.max(...values.map((point) => point.y + CARD_HEIGHT / 2)),
  };
}

function groupWorldDepths(
  centerGroupId: string | undefined,
  counterpartGroups: readonly ContextRelationshipGraphNode[],
  radius: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (centerGroupId) result.set(centerGroupId, -90);
  counterpartGroups.forEach((group, index) => {
    const band = Math.min(radius * 0.34, 125 + Math.floor(index / 2) * 34);
    result.set(group.id, index % 2 ? -band : band);
  });
  return result;
}

function semanticDepth(
  node: ContextRelationshipGraphNode,
  centerId: string,
  centerGroupId: string | undefined,
): number {
  if (node.id === centerId) return 0;
  if (node.id === centerGroupId) return 1;
  if (node.kind === "group") return 2;
  return 3;
}

function deterministicDepth(value: string, amplitude: number): number {
  const normalized = (stableHash(value) % 2001) / 2000;
  return round((normalized * 2 - 1) * amplitude);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareNodes(left: ContextRelationshipGraphNode, right: ContextRelationshipGraphNode): number {
  return stableCompare(left.label, right.label) || stableCompare(left.id, right.id);
}

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "uk", { sensitivity: "base", numeric: true });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
