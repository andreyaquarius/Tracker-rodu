import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreeUnion,
  UnionId,
} from "../types.ts";

export interface RootLineageProjectionInput {
  graph: FamilyGraphData;
  rootPersonId: PersonId;
  /** Optional visual focus connected to the root through a narrow family path. */
  connectPersonId?: PersonId;
}

export interface RootLineageProjectionResult {
  graph: FamilyGraphData;
  lineagePersonIds: readonly PersonId[];
  bridgePersonIds: readonly PersonId[];
  connectorPersonIds: readonly PersonId[];
  hasRoot: boolean;
  hasCompleteBridge: boolean;
}

function graphIdentityConflicts(
  left: string | number | undefined,
  right: string | number | undefined,
): boolean {
  return Boolean(left && right && left !== right);
}

function mergeById<T extends { id: string }>(
  base: readonly T[],
  overlay: readonly T[],
): T[] {
  const values = new Map(overlay.map(value => [value.id, value]));
  const baseIds = new Set(base.map(value => value.id));
  for (const value of base) values.set(value.id, value);
  return [
    ...base,
    ...overlay.filter(value => !baseIds.has(value.id)),
  ].map(value => values.get(value.id)!);
}

/**
 * Adds only structural overlay rows. Base rows win on duplicate IDs so active
 * client-owned branch metadata and continuation tokens remain untouched.
 */
export function mergeRootLineageOverlay(
  base: FamilyGraphData,
  overlay: FamilyGraphData,
): FamilyGraphData {
  if (
    overlay.persons.length === 0 ||
    graphIdentityConflicts(base.graphVersion, overlay.graphVersion) ||
    graphIdentityConflicts(
      base.permissionFingerprint,
      overlay.permissionFingerprint,
    )
  ) {
    return base;
  }
  return {
    ...base,
    persons: mergeById(base.persons, overlay.persons),
    unions: mergeById(base.unions, overlay.unions),
    parentChildRelations: mergeById(
      base.parentChildRelations,
      overlay.parentChildRelations,
    ),
  };
}

interface BridgeEdge {
  kind: "relation" | "union";
  key: string;
}

interface BridgeStep {
  previousPersonId: PersonId;
  edge: BridgeEdge;
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function relationFamilyKey(relation: ParentChildRelation): string {
  return `${relation.childId}\u001f${relation.unionId ?? "<without-union>"}`;
}

function memberSignature(memberIds: readonly PersonId[]): string {
  return [...new Set(memberIds)].sort(compareIds).join("\u001f");
}

function emptyProjectionGraph(graph: FamilyGraphData): FamilyGraphData {
  return {
    ...graph,
    persons: [],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: [],
  };
}

/**
 * Keeps the persisted root, its complete loaded ancestor closure, and one
 * deterministic structural bridge to the temporary visual focus. The bridge
 * makes the root branch reachable by the occurrence builder without turning
 * the temporary focus into the lineage owner.
 */
export function buildRootLineageProjection({
  graph,
  rootPersonId,
  connectPersonId,
}: RootLineageProjectionInput): RootLineageProjectionResult {
  const personIds = new Set(graph.persons.map(person => person.id));
  if (!personIds.has(rootPersonId)) {
    return {
      graph: emptyProjectionGraph(graph),
      lineagePersonIds: [],
      bridgePersonIds: [],
      connectorPersonIds: [],
      hasRoot: false,
      hasCompleteBridge: false,
    };
  }

  const relationsByChild = new Map<PersonId, ParentChildRelation[]>();
  const relationsByFamily = new Map<string, ParentChildRelation[]>();
  for (const relation of graph.parentChildRelations) {
    const byChild = relationsByChild.get(relation.childId);
    if (byChild) byChild.push(relation);
    else relationsByChild.set(relation.childId, [relation]);
    const key = relationFamilyKey(relation);
    const family = relationsByFamily.get(key);
    if (family) family.push(relation);
    else relationsByFamily.set(key, [relation]);
  }
  for (const values of relationsByChild.values()) {
    values.sort((left, right) =>
      compareIds(relationFamilyKey(left), relationFamilyKey(right)) ||
      compareIds(left.parentId, right.parentId) ||
      compareIds(left.id, right.id),
    );
  }
  for (const values of relationsByFamily.values()) {
    values.sort((left, right) =>
      compareIds(left.parentId, right.parentId) || compareIds(left.id, right.id),
    );
  }

  const unionsById = new Map(graph.unions.map(union => [union.id, union]));
  const includedPersonIds = new Set<PersonId>([rootPersonId]);
  const includedRelationIds = new Set<string>();
  const includedUnionIds = new Set<UnionId>();
  const lineagePersonIds = new Set<PersonId>();
  const bridgePersonIds = new Set<PersonId>();

  const includeUnion = (unionId: UnionId): void => {
    const union = unionsById.get(unionId);
    if (!union) return;
    includedUnionIds.add(unionId);
    for (const memberId of union.memberIds) {
      if (personIds.has(memberId)) includedPersonIds.add(memberId);
    }
  };
  const includeRelationFamily = (key: string): void => {
    for (const relation of relationsByFamily.get(key) ?? []) {
      includedRelationIds.add(relation.id);
      if (personIds.has(relation.parentId)) includedPersonIds.add(relation.parentId);
      if (personIds.has(relation.childId)) includedPersonIds.add(relation.childId);
      if (relation.unionId) includeUnion(relation.unionId);
    }
  };

  const ancestorQueue: PersonId[] = [rootPersonId];
  for (let offset = 0; offset < ancestorQueue.length; offset += 1) {
    const childId = ancestorQueue[offset]!;
    if (lineagePersonIds.has(childId)) continue;
    lineagePersonIds.add(childId);
    includedPersonIds.add(childId);
    for (const relation of relationsByChild.get(childId) ?? []) {
      includeRelationFamily(relationFamilyKey(relation));
      if (!lineagePersonIds.has(relation.parentId)) {
        ancestorQueue.push(relation.parentId);
      }
    }
  }

  const adjacency = new Map<
    PersonId,
    Array<{ personId: PersonId; edge: BridgeEdge }>
  >();
  const addNeighbor = (
    from: PersonId,
    to: PersonId,
    edge: BridgeEdge,
  ): void => {
    if (!personIds.has(from) || !personIds.has(to) || from === to) return;
    const neighbors = adjacency.get(from);
    const value = { personId: to, edge };
    if (neighbors) neighbors.push(value);
    else adjacency.set(from, [value]);
  };
  for (const relation of graph.parentChildRelations) {
    const edge: BridgeEdge = {
      kind: "relation",
      key: relationFamilyKey(relation),
    };
    addNeighbor(relation.parentId, relation.childId, edge);
    addNeighbor(relation.childId, relation.parentId, edge);
  }
  for (const union of graph.unions) {
    const members = [...new Set(union.memberIds)].filter(memberId =>
      personIds.has(memberId),
    );
    for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
        const edge: BridgeEdge = { kind: "union", key: union.id };
        addNeighbor(members[leftIndex]!, members[rightIndex]!, edge);
        addNeighbor(members[rightIndex]!, members[leftIndex]!, edge);
      }
    }
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) =>
      compareIds(left.personId, right.personId) ||
      compareIds(left.edge.kind, right.edge.kind) ||
      compareIds(left.edge.key, right.edge.key),
    );
  }

  const bridgeStart = connectPersonId && personIds.has(connectPersonId)
    ? connectPersonId
    : undefined;
  const previous = new Map<PersonId, BridgeStep>();
  const visited = new Set<PersonId>();
  const bridgeQueue: PersonId[] = bridgeStart ? [bridgeStart] : [];
  if (bridgeStart) visited.add(bridgeStart);
  for (
    let offset = 0;
    offset < bridgeQueue.length && !visited.has(rootPersonId);
    offset += 1
  ) {
    const current = bridgeQueue[offset]!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor.personId)) continue;
      visited.add(neighbor.personId);
      previous.set(neighbor.personId, {
        previousPersonId: current,
        edge: neighbor.edge,
      });
      bridgeQueue.push(neighbor.personId);
    }
  }
  const hasCompleteBridge = !bridgeStart || visited.has(rootPersonId);
  if (bridgeStart && hasCompleteBridge) {
    let current = rootPersonId;
    bridgePersonIds.add(current);
    while (current !== bridgeStart) {
      const step = previous.get(current);
      if (!step) break;
      bridgePersonIds.add(step.previousPersonId);
      if (step.edge.kind === "relation") {
        includeRelationFamily(step.edge.key);
      } else {
        includeUnion(step.edge.key);
      }
      current = step.previousPersonId;
    }
    for (const personId of bridgePersonIds) includedPersonIds.add(personId);
  }

  // Parent-set and partnership records with the same members form one visual
  // family. Retaining both keeps the ordinary tree router deterministic.
  const includedParentSignatures = new Set(
    [...includedUnionIds]
      .map(unionId => unionsById.get(unionId))
      .filter(
        (union): union is TreeUnion =>
          union !== undefined && union.kind === "parent-set",
      )
      .map(union => memberSignature(union.memberIds)),
  );
  for (const union of graph.unions) {
    if (
      includedUnionIds.has(union.id) ||
      (union.kind === "partnership" &&
        includedParentSignatures.has(memberSignature(union.memberIds)))
    ) {
      includeUnion(union.id);
    }
  }

  const connectorPersonIds = [...includedPersonIds]
    .filter(
      personId =>
        !lineagePersonIds.has(personId) && !bridgePersonIds.has(personId),
    )
    .sort(compareIds);
  return {
    graph: {
      ...graph,
      persons: graph.persons.filter(person => includedPersonIds.has(person.id)),
      unions: graph.unions.filter(union => includedUnionIds.has(union.id)),
      parentChildRelations: graph.parentChildRelations.filter(relation =>
        includedRelationIds.has(relation.id),
      ),
      continuations: [],
      familyContinuations: [],
    },
    lineagePersonIds: [...lineagePersonIds].sort(compareIds),
    bridgePersonIds: [...bridgePersonIds].sort(compareIds),
    connectorPersonIds,
    hasRoot: true,
    hasCompleteBridge,
  };
}
