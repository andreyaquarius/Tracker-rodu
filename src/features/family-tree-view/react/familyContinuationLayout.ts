import type {
  FamilyContinuation,
  FamilyGraphData,
  LayoutNode,
  LayoutResult,
  LayoutUnion,
  PersonId,
} from "../types.ts";

export interface PositionedFamilyContinuation {
  id: string;
  continuation: FamilyContinuation;
  /** Person whose card owns this presentation of the family-scoped control. */
  ownerPersonId: PersonId;
  /** Always a person/reference card occurrence, never a union junction. */
  anchorOccurrenceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionFamilyContinuationsOptions {
  /** Remembers which parent opened an expanded family scope. */
  activeOwnerByScope?: ReadonlyMap<string, PersonId>;
}

/**
 * A v2 response with `familyContinuations` is authoritative for child-family
 * actions. Older cached responses may still contain the former per-person
 * `direction=children` control; rendering both creates two identical arrows.
 */
export function graphWithoutLegacyFamilyChildControls(
  graph: FamilyGraphData,
): FamilyGraphData {
  if (graph.familyContinuations === undefined || !graph.continuations?.length) {
    return graph;
  }
  const familyParentIds = new Set(
    graph.familyContinuations.flatMap(continuation =>
      continuation.scope.parentIds,
    ),
  );
  if (familyParentIds.size === 0) return graph;
  const continuations = graph.continuations.filter(
    continuation =>
      continuation.direction !== "children" ||
      !familyParentIds.has(continuation.personId),
  );
  return continuations.length === graph.continuations.length
    ? graph
    : { ...graph, continuations };
}

const CONTROL_SIZE = 30;
const CONTROL_TOP_GAP = 7;
const CONTROL_GAP = 4;

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Different imports/RPC layers can describe the same visible parent family
 * with a persisted family-group scope and a derived parents:* scope. They are
 * one user action, so their presentation identity is the exact parent set.
 */
export function familyContinuationPresentationKey(
  continuation: FamilyContinuation,
): string {
  const parentIds = [...new Set(continuation.scope.parentIds)].sort(
    compareStrings,
  );
  if (parentIds.length >= 2) return `parents:${parentIds.join("\u001f")}`;
  if (continuation.scope.familyGroupId) {
    return `family-group:${continuation.scope.familyGroupId}`;
  }
  const unionIds = [...new Set(continuation.scope.unionIds ?? [])].sort(
    compareStrings,
  );
  if (unionIds.length > 0) return `unions:${unionIds.join("\u001f")}`;
  return `scope:${continuation.scope.id}`;
}

function compareContinuationPreference(
  left: FamilyContinuation,
  right: FamilyContinuation,
): number {
  return (
    Number(Boolean(right.expanded)) - Number(Boolean(left.expanded)) ||
    Number(Boolean(right.scope.familyGroupId)) -
      Number(Boolean(left.scope.familyGroupId)) ||
    Number(right.scope.id.startsWith("family-group:")) -
      Number(left.scope.id.startsWith("family-group:")) ||
    (right.scope.unionIds?.length ?? 0) -
      (left.scope.unionIds?.length ?? 0) ||
    (right.hiddenCount ?? 0) - (left.hiddenCount ?? 0) ||
    compareStrings(left.scope.id, right.scope.id) ||
    compareStrings(left.id, right.id)
  );
}

export function reconcileFamilyContinuationPresentations(
  continuations: readonly FamilyContinuation[],
): FamilyContinuation[] {
  const grouped = new Map<string, FamilyContinuation[]>();
  for (const continuation of continuations) {
    const key = familyContinuationPresentationKey(continuation);
    const values = grouped.get(key);
    if (values) values.push(continuation);
    else grouped.set(key, [continuation]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, values]) => [...values].sort(compareContinuationPreference)[0]!);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort(compareStrings);
  const normalizedRight = [...new Set(right)].sort(compareStrings);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function unionMatchRank(
  graph: FamilyGraphData,
  layoutUnion: LayoutUnion,
  continuation: FamilyContinuation,
): number | undefined {
  const domainUnion = graph.unions.find(union => union.id === layoutUnion.unionId);
  if (!domainUnion) return undefined;
  if (continuation.scope.unionIds?.includes(domainUnion.id)) return 0;
  if (sameIds(domainUnion.memberIds, continuation.scope.parentIds)) return 10;
  if (
    continuation.scope.familyGroupId &&
    continuation.scope.parentIds.length === 0 &&
    domainUnion.familyGroupId === continuation.scope.familyGroupId
  ) {
    return 20;
  }
  return undefined;
}

function preferredAnchorUnion(
  graph: FamilyGraphData,
  layout: LayoutResult,
  continuation: FamilyContinuation,
): LayoutUnion | undefined {
  return layout.unions
    .map(union => ({ union, rank: unionMatchRank(graph, union, continuation) }))
    .filter(
      (candidate): candidate is { union: LayoutUnion; rank: number } =>
        candidate.rank !== undefined,
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        (left.union.kind === "partnership" ? -1 : 0) -
          (right.union.kind === "partnership" ? -1 : 0) ||
        compareStrings(left.union.occurrenceId, right.union.occurrenceId),
    )[0]?.union;
}

function preferredNode(
  candidates: readonly LayoutNode[],
): LayoutNode | undefined {
  return [...candidates].sort(
    (left, right) =>
      (left.kind === "person" ? 0 : 1) - (right.kind === "person" ? 0 : 1) ||
      Math.abs(left.generation) - Math.abs(right.generation) ||
      compareStrings(left.occurrenceId, right.occurrenceId),
  )[0];
}

function visibleParentNodes(
  graph: FamilyGraphData,
  layout: LayoutResult,
  continuation: FamilyContinuation,
): Map<PersonId, LayoutNode> {
  const result = new Map<PersonId, LayoutNode>();
  const nodesById = new Map(layout.nodes.map(node => [node.occurrenceId, node]));
  const union = preferredAnchorUnion(graph, layout, continuation);

  if (union) {
    for (const personId of continuation.scope.parentIds) {
      const match = preferredNode(
        union.memberOccurrenceIds
          .map(occurrenceId => nodesById.get(occurrenceId))
          .filter(
            (node): node is LayoutNode =>
              node !== undefined &&
              node.personId === personId &&
              (node.kind === "person" || node.kind === "reference"),
          ),
      );
      if (match) result.set(personId, match);
    }
  }

  for (const personId of continuation.scope.parentIds) {
    if (result.has(personId)) continue;
    const match = preferredNode(
      layout.nodes.filter(
        node =>
          node.personId === personId &&
          (node.kind === "person" || node.kind === "reference"),
      ),
    );
    if (match) result.set(personId, match);
  }
  return result;
}

function rectanglesIntersect(
  left: Pick<LayoutNode, "x" | "y" | "width" | "height">,
  right: Pick<LayoutNode, "x" | "y" | "width" | "height">,
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function placeWithoutAuxiliaryOverlap(
  control: PositionedFamilyContinuation,
  anchor: LayoutNode,
  layout: LayoutResult,
  alreadyPlaced: readonly PositionedFamilyContinuation[],
): void {
  const occupied = [
    ...layout.nodes.filter(
      node => node.kind === "continuation" || node.kind === "placeholder",
    ),
    ...alreadyPlaced.filter(
      item => item.anchorOccurrenceId === control.anchorOccurrenceId,
    ),
  ];
  const centeredX = anchor.x + (anchor.width - CONTROL_SIZE) / 2;
  const step = CONTROL_SIZE + CONTROL_GAP;
  const offsets = [0];
  for (let index = 1; index <= 12; index += 1) {
    offsets.push(-step * index, step * index);
  }
  const fits = (x: number): boolean => {
    const candidate = { ...control, x };
    return !occupied.some(item => rectanglesIntersect(candidate, item));
  };
  const withinCard = offsets
    .map(offset => centeredX + offset)
    .find(
      x =>
        x >= anchor.x &&
        x + CONTROL_SIZE <= anchor.x + anchor.width &&
        fits(x),
    );
  control.x =
    withinCard ??
    offsets.map(offset => centeredX + offset).find(fits) ??
    centeredX;
}

/**
 * The server owns one token per exact family scope. While closed, that one
 * action is mirrored below every visible parent card. Once opened, only the
 * card used to open it keeps the control; another partner family remains a
 * separate scope and therefore keeps its own control.
 */
export function positionFamilyContinuations(
  graph: FamilyGraphData,
  layout: LayoutResult,
  options: PositionFamilyContinuationsOptions = {},
): PositionedFamilyContinuation[] {
  const candidates: PositionedFamilyContinuation[] = [];
  for (const continuation of reconcileFamilyContinuationPresentations(
    graph.familyContinuations ?? [],
  )) {
    const parents = visibleParentNodes(graph, layout, continuation);
    if (parents.size === 0) continue;
    const rememberedOwner = options.activeOwnerByScope?.get(
      continuation.scope.id,
    );
    const ownerIds = continuation.expanded
      ? [
          rememberedOwner && parents.has(rememberedOwner)
            ? rememberedOwner
            : [...parents.keys()][0]!,
        ]
      : continuation.scope.parentIds.filter(personId => parents.has(personId));

    for (const ownerPersonId of [...new Set(ownerIds)]) {
      const anchor = parents.get(ownerPersonId);
      if (!anchor) continue;
      const control: PositionedFamilyContinuation = {
        id: `family-continuation:${continuation.scope.id}:${ownerPersonId}:${anchor.occurrenceId}`,
        continuation,
        ownerPersonId,
        anchorOccurrenceId: anchor.occurrenceId,
        x: anchor.x + (anchor.width - CONTROL_SIZE) / 2,
        y: anchor.y + anchor.height + CONTROL_TOP_GAP,
        width: CONTROL_SIZE,
        height: CONTROL_SIZE,
      };
      candidates.push(control);
    }
  }

  const controlsByOwner = new Map<PersonId, PositionedFamilyContinuation[]>();
  for (const control of candidates) {
    const values = controlsByOwner.get(control.ownerPersonId);
    if (values) values.push(control);
    else controlsByOwner.set(control.ownerPersonId, [control]);
  }
  const selected = [...controlsByOwner.values()]
    .map(values =>
      [...values].sort((left, right) => {
        const leftIsRememberedOwner =
          options.activeOwnerByScope?.get(left.continuation.scope.id) ===
          left.ownerPersonId;
        const rightIsRememberedOwner =
          options.activeOwnerByScope?.get(right.continuation.scope.id) ===
          right.ownerPersonId;
        return (
          Number(rightIsRememberedOwner) - Number(leftIsRememberedOwner) ||
          Number(Boolean(right.continuation.expanded)) -
            Number(Boolean(left.continuation.expanded)) ||
          compareStrings(
            familyContinuationPresentationKey(left.continuation),
            familyContinuationPresentationKey(right.continuation),
          ) ||
          compareStrings(
            left.continuation.scope.id,
            right.continuation.scope.id,
          )
        );
      })[0]!,
    )
    .sort(
      (left, right) =>
        compareStrings(left.anchorOccurrenceId, right.anchorOccurrenceId) ||
        compareStrings(left.continuation.scope.id, right.continuation.scope.id),
    );

  const positioned: PositionedFamilyContinuation[] = [];
  for (const control of selected) {
    const anchor = layout.nodes.find(
      node => node.occurrenceId === control.anchorOccurrenceId,
    );
    if (!anchor) continue;
    placeWithoutAuxiliaryOverlap(control, anchor, layout, positioned);
    positioned.push(control);
  }
  return positioned;
}
