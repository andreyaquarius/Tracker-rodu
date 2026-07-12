import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreeContinuation,
  TreeUnion,
  UnionId,
} from "../types.ts";

/**
 * Identifies one family independently from either parent's card. Prefer a
 * domain familyGroupId; parentIds and unionIds are deterministic fallbacks for
 * older responses that do not carry one yet.
 */
export interface FamilyCorridorScope {
  familyGroupId?: string;
  familyKey?: string;
  parentIds?: readonly PersonId[];
  unionIds?: readonly UnionId[];
}

export interface FamilyCorridorProjectionInput {
  graph: FamilyGraphData;
  selectedFamily: FamilyCorridorScope;
  originalFocusPersonId: PersonId;
  /** Only these descendant families may add children outside the focus path. */
  activeNestedFamilies?: readonly FamilyCorridorScope[];
}

export interface FamilyCorridorProjectionResult {
  graph: FamilyGraphData;
  selectedFamilyKey: string;
  selectedParentIds: readonly PersonId[];
  directChildIds: readonly PersonId[];
  pathPersonIds: readonly PersonId[];
  activeNestedFamilyKeys: readonly string[];
  hasPathToOriginalFocus: boolean;
  /** Falls back to a selected parent when the old focus is not in the corridor. */
  perspectiveFocusPersonId?: PersonId;
}

interface ProjectionIndex {
  personIds: ReadonlySet<PersonId>;
  unionsById: ReadonlyMap<UnionId, TreeUnion>;
  unionsByGroupId: ReadonlyMap<string, readonly TreeUnion[]>;
  unionsByMemberSignature: ReadonlyMap<string, readonly TreeUnion[]>;
  relationsByChildId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>;
  relationsByParentId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>;
  relationsByChildAndUnion: ReadonlyMap<string, readonly ParentChildRelation[]>;
}

interface ResolvedFamilyScope {
  key: string;
  parentIds: readonly PersonId[];
  unionIds: ReadonlySet<UnionId>;
}

const KEY_SEPARATOR = ",";

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareIds);
}

function encodeKeyParts(values: readonly string[]): string {
  return values.map(value => encodeURIComponent(value)).join(KEY_SEPARATOR);
}

function decodeKeyParts(value: string): string[] {
  if (!value) return [];
  return uniqueSorted(
    value
      .split(KEY_SEPARATOR)
      .map(part => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .filter(Boolean),
  );
}

/** Creates the stable key used by family-level controls and saved UI state. */
export function familyCorridorScopeKey(scope: FamilyCorridorScope): string {
  if (scope.familyKey) return scope.familyKey;
  if (scope.familyGroupId) {
    return `family-group:${encodeURIComponent(scope.familyGroupId)}`;
  }
  const parentIds = uniqueSorted(scope.parentIds);
  if (parentIds.length) return `parents:${encodeKeyParts(parentIds)}`;
  const unionIds = uniqueSorted(scope.unionIds);
  if (unionIds.length) return `unions:${encodeKeyParts(unionIds)}`;
  return "family:unresolved";
}

/**
 * Produces the isolated family-corridor graph. The input graph is never
 * mutated, so entering and leaving this perspective can restore the exact
 * previous graph/view state.
 */
export function projectFamilyCorridorGraph(
  input: FamilyCorridorProjectionInput,
): FamilyGraphData {
  return buildFamilyCorridorProjection(input).graph;
}

export function buildFamilyCorridorProjection(
  input: FamilyCorridorProjectionInput,
): FamilyCorridorProjectionResult {
  const { graph, selectedFamily, originalFocusPersonId } = input;
  const index = buildProjectionIndex(graph);
  const selected = resolveFamilyScope(selectedFamily, graph, index);
  const includedPersonIds = new Set<PersonId>();
  const includedUnionIds = new Set<UnionId>();
  const includedRelationIds = new Set<string>();

  const includePerson = (personId: PersonId): void => {
    if (index.personIds.has(personId)) includedPersonIds.add(personId);
  };

  const includeUnion = (
    unionId: UnionId,
    includeCompanionPartnerships = true,
  ): void => {
    const union = index.unionsById.get(unionId);
    if (!union) return;
    includedUnionIds.add(union.id);
    for (const memberId of union.memberIds) includePerson(memberId);
    if (!includeCompanionPartnerships || union.kind === "partnership") return;

    const companionCandidates = union.familyGroupId
      ? index.unionsByGroupId.get(union.familyGroupId) ?? []
      : index.unionsByMemberSignature.get(memberSignature(union.memberIds)) ?? [];
    const partnerships = companionCandidates.filter(
      companion => companion.kind === "partnership",
    );
    const sameMemberPartnerships = partnerships.filter(
      companion =>
        memberSignature(companion.memberIds) === memberSignature(union.memberIds),
    );
    // A family-group id is useful for incomplete one-parent records, but an
    // accidentally reused group must never join two different couples.
    const companions = sameMemberPartnerships.length
      ? sameMemberPartnerships
      : partnerships.length === 1
        ? partnerships
        : [];
    for (const companion of companions) {
      includedUnionIds.add(companion.id);
      for (const memberId of companion.memberIds) includePerson(memberId);
    }
  };

  const includeRelation = (relation: ParentChildRelation): void => {
    includedRelationIds.add(relation.id);
    includePerson(relation.parentId);
    includePerson(relation.childId);
    if (relation.unionId) includeUnion(relation.unionId);
  };

  /** Include both parents of this child, but never siblings in the same family. */
  const includeRelationBundle = (relation: ParentChildRelation): void => {
    const bundle = index.relationsByChildAndUnion.get(
      childUnionKey(relation.childId, relation.unionId),
    ) ?? [relation];
    for (const bundledRelation of bundle) includeRelation(bundledRelation);
  };

  const includeResolvedFamily = (
    family: ResolvedFamilyScope,
  ): readonly PersonId[] => {
    for (const parentId of family.parentIds) includePerson(parentId);
    for (const unionId of family.unionIds) includeUnion(unionId, false);

    const relations = directFamilyRelations(family, graph, index);
    for (const relation of relations) includeRelationBundle(relation);
    return uniqueSorted(relations.map(relation => relation.childId));
  };

  const directChildIds = includeResolvedFamily(selected);

  // Include every loaded ancestor of either selected parent. A visited set
  // makes malformed cycles finite and deterministic.
  const ancestorQueue = [...selected.parentIds].sort(compareIds);
  const visitedAncestors = new Set<PersonId>();
  for (let offset = 0; offset < ancestorQueue.length; offset += 1) {
    const childId = ancestorQueue[offset];
    if (visitedAncestors.has(childId)) continue;
    visitedAncestors.add(childId);
    const incoming = index.relationsByChildId.get(childId) ?? [];
    for (const relation of incoming) {
      includeRelationBundle(relation);
      if (!visitedAncestors.has(relation.parentId)) {
        ancestorQueue.push(relation.parentId);
      }
    }
  }

  // A person lies on a directed path when it is reachable from the selected
  // parents and can also reach the original focus. This retains every loaded
  // path (including pedigree collapse) without enumerating paths exponentially.
  const descendantsOfSelected = reachablePeople(
    selected.parentIds,
    index.relationsByParentId,
    relation => relation.childId,
  );
  const ancestorsOfFocus = reachablePeople(
    [originalFocusPersonId],
    index.relationsByChildId,
    relation => relation.parentId,
  );
  const pathPeople = new Set<PersonId>();
  for (const personId of descendantsOfSelected) {
    if (ancestorsOfFocus.has(personId)) pathPeople.add(personId);
  }
  const hasPathToOriginalFocus =
    index.personIds.has(originalFocusPersonId) &&
    pathPeople.has(originalFocusPersonId) &&
    selected.parentIds.some(parentId => pathPeople.has(parentId));

  if (hasPathToOriginalFocus) {
    for (const personId of pathPeople) includePerson(personId);
    for (const relation of graph.parentChildRelations) {
      if (
        pathPeople.has(relation.parentId) &&
        pathPeople.has(relation.childId)
      ) {
        includeRelationBundle(relation);
      }
    }
  }

  // Active nested scopes can arrive in any order. Repeated passes allow a
  // grandchild family to become eligible after its parent family was included.
  const pendingNested = (input.activeNestedFamilies ?? [])
    .map(scope => resolveFamilyScope(scope, graph, index))
    .filter(scope => scope.key !== selected.key)
    .sort((left, right) => compareIds(left.key, right.key));
  const activeNestedFamilyKeys: string[] = [];
  let includedNestedFamily = true;
  while (pendingNested.length && includedNestedFamily) {
    includedNestedFamily = false;
    for (let indexInPending = 0; indexInPending < pendingNested.length;) {
      const family = pendingNested[indexInPending];
      const isConnectedDescendant = family.parentIds.some(parentId =>
        includedPersonIds.has(parentId) && descendantsOfSelected.has(parentId),
      );
      if (!isConnectedDescendant) {
        indexInPending += 1;
        continue;
      }
      includeResolvedFamily(family);
      activeNestedFamilyKeys.push(family.key);
      pendingNested.splice(indexInPending, 1);
      includedNestedFamily = true;
    }
  }

  const projectedGraph = filterGraph(
    graph,
    includedPersonIds,
    includedUnionIds,
    includedRelationIds,
    new Set([selected.key, ...activeNestedFamilyKeys]),
    new Set(
      [...descendantsOfSelected].filter(
        personId =>
          includedPersonIds.has(personId) &&
          !selected.parentIds.includes(personId),
      ),
    ),
  );
  const perspectiveFocusPersonId = hasPathToOriginalFocus
    ? originalFocusPersonId
    : selected.parentIds.find(personId => includedPersonIds.has(personId)) ??
      directChildIds.find(personId => includedPersonIds.has(personId));

  return {
    graph: projectedGraph,
    selectedFamilyKey: selected.key,
    selectedParentIds: selected.parentIds,
    directChildIds,
    pathPersonIds: uniqueSorted(
      [...pathPeople].filter(personId => index.personIds.has(personId)),
    ),
    activeNestedFamilyKeys,
    hasPathToOriginalFocus,
    ...(perspectiveFocusPersonId ? { perspectiveFocusPersonId } : {}),
  };
}

function buildProjectionIndex(graph: FamilyGraphData): ProjectionIndex {
  const unionsById = new Map(graph.unions.map(union => [union.id, union]));
  const unionsByGroupId = groupBy(graph.unions, union => union.familyGroupId);
  const unionsByMemberSignature = groupBy(
    graph.unions,
    union => memberSignature(union.memberIds),
  );
  const relationsByChildId = groupBy(
    graph.parentChildRelations,
    relation => relation.childId,
  );
  const relationsByParentId = groupBy(
    graph.parentChildRelations,
    relation => relation.parentId,
  );
  const relationsByChildAndUnion = groupBy(
    graph.parentChildRelations,
    relation => childUnionKey(relation.childId, relation.unionId),
  );
  return {
    personIds: new Set(graph.persons.map(person => person.id)),
    unionsById,
    unionsByGroupId,
    unionsByMemberSignature,
    relationsByChildId,
    relationsByParentId,
    relationsByChildAndUnion,
  };
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string | undefined,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function memberSignature(memberIds: readonly PersonId[]): string {
  return uniqueSorted(memberIds).join("\u001f");
}

function childUnionKey(childId: PersonId, unionId: UnionId | undefined): string {
  return `${childId}\u001f${unionId ?? "<without-union>"}`;
}

function resolveFamilyScope(
  scope: FamilyCorridorScope,
  graph: FamilyGraphData,
  index: ProjectionIndex,
): ResolvedFamilyScope {
  const parsed = parseFamilyKey(scope.familyKey);
  const familyGroupId = scope.familyGroupId ?? parsed.familyGroupId;
  const requestedUnionIds = uniqueSorted(
    scope.unionIds?.length ? scope.unionIds : parsed.unionIds,
  );
  const requestedParentIds = uniqueSorted(
    scope.parentIds?.length ? scope.parentIds : parsed.parentIds,
  );
  let seedUnions: readonly TreeUnion[] = [];
  let constrainGroupByMembers = false;

  if (familyGroupId) {
    const groupUnions = index.unionsByGroupId.get(familyGroupId) ?? [];
    if (requestedUnionIds.length) {
      const requested = new Set(requestedUnionIds);
      seedUnions = groupUnions.filter(union => requested.has(union.id));
      constrainGroupByMembers = true;
    } else if (requestedParentIds.length) {
      const requestedSignature = memberSignature(requestedParentIds);
      seedUnions = groupUnions.filter(
        union => memberSignature(union.memberIds) === requestedSignature,
      );
      constrainGroupByMembers = true;
    } else {
      seedUnions = groupUnions;
    }
  } else if (requestedUnionIds.length) {
    seedUnions = requestedUnionIds
      .map(unionId => index.unionsById.get(unionId))
      .filter((union): union is TreeUnion => Boolean(union));
  } else if (requestedParentIds.length) {
    seedUnions = index.unionsByMemberSignature.get(
      memberSignature(requestedParentIds),
    ) ?? [];
  } else if (scope.familyKey) {
    seedUnions = graph.unions.filter(union =>
      candidateUnionKeys(union).includes(scope.familyKey!),
    );
  }

  const familyUnions = new Map<UnionId, TreeUnion>();
  for (const seed of seedUnions) {
    let matches = seed.familyGroupId
      ? index.unionsByGroupId.get(seed.familyGroupId) ?? [seed]
      : index.unionsByMemberSignature.get(memberSignature(seed.memberIds)) ?? [seed];
    if (constrainGroupByMembers) {
      const seedSignature = memberSignature(seed.memberIds);
      matches = matches.filter(
        match => memberSignature(match.memberIds) === seedSignature,
      );
    }
    for (const match of matches) familyUnions.set(match.id, match);
  }

  const parentIds = requestedParentIds.length
    ? requestedParentIds
    : uniqueSorted([...familyUnions.values()].flatMap(union => union.memberIds));
  const generatedScope: FamilyCorridorScope = {
    ...(familyGroupId ? { familyGroupId } : {}),
    ...(parentIds.length ? { parentIds } : {}),
    ...(familyUnions.size ? { unionIds: [...familyUnions.keys()] } : {}),
  };
  return {
    key: scope.familyKey ?? familyCorridorScopeKey(generatedScope),
    parentIds,
    unionIds: new Set(familyUnions.keys()),
  };
}

function candidateUnionKeys(union: TreeUnion): string[] {
  return [
    ...(union.familyGroupId
      ? [familyCorridorScopeKey({ familyGroupId: union.familyGroupId })]
      : []),
    familyCorridorScopeKey({ parentIds: union.memberIds }),
    familyCorridorScopeKey({ unionIds: [union.id] }),
  ];
}

function parseFamilyKey(familyKey: string | undefined): {
  familyGroupId?: string;
  parentIds?: readonly PersonId[];
  unionIds?: readonly UnionId[];
} {
  if (!familyKey) return {};
  if (familyKey.startsWith("family-group:")) {
    const value = decodeKeyParts(familyKey.slice("family-group:".length))[0];
    return value ? { familyGroupId: value } : {};
  }
  if (familyKey.startsWith("parents:")) {
    return { parentIds: decodeKeyParts(familyKey.slice("parents:".length)) };
  }
  if (familyKey.startsWith("unions:")) {
    return { unionIds: decodeKeyParts(familyKey.slice("unions:".length)) };
  }
  return {};
}

function directFamilyRelations(
  family: ResolvedFamilyScope,
  graph: FamilyGraphData,
  index: ProjectionIndex,
): readonly ParentChildRelation[] {
  const included = new Map<string, ParentChildRelation>();
  for (const relation of graph.parentChildRelations) {
    if (relation.unionId && family.unionIds.has(relation.unionId)) {
      included.set(relation.id, relation);
    }
  }

  if (family.parentIds.length) {
    const requestedParents = new Set(family.parentIds);
    const unionlessByChild = groupBy(
      graph.parentChildRelations.filter(relation => !relation.unionId),
      relation => relation.childId,
    );
    for (const relations of unionlessByChild.values()) {
      const actualParents = new Set(relations.map(relation => relation.parentId));
      if (!family.parentIds.every(parentId => actualParents.has(parentId))) continue;
      for (const relation of relations) {
        if (requestedParents.has(relation.parentId)) included.set(relation.id, relation);
      }
    }

    // Legacy graphs can have a parent-set union whose member list is missing.
    // Use the relation parents only when no union could resolve the scope.
    if (!family.unionIds.size) {
      const grouped = groupBy(
        graph.parentChildRelations,
        relation => childUnionKey(relation.childId, relation.unionId),
      );
      for (const relations of grouped.values()) {
        const actualParents = uniqueSorted(relations.map(relation => relation.parentId));
        if (memberSignature(actualParents) !== memberSignature(family.parentIds)) continue;
        for (const relation of relations) included.set(relation.id, relation);
      }
    }
  }

  return graph.parentChildRelations.filter(relation => included.has(relation.id));
}

function reachablePeople(
  starts: readonly PersonId[],
  relationsByPerson: ReadonlyMap<PersonId, readonly ParentChildRelation[]>,
  nextPerson: (relation: ParentChildRelation) => PersonId,
): ReadonlySet<PersonId> {
  const reached = new Set<PersonId>();
  const queue = uniqueSorted(starts);
  for (let offset = 0; offset < queue.length; offset += 1) {
    const personId = queue[offset];
    if (reached.has(personId)) continue;
    reached.add(personId);
    const nextIds = uniqueSorted(
      (relationsByPerson.get(personId) ?? []).map(nextPerson),
    );
    for (const nextId of nextIds) {
      if (!reached.has(nextId)) queue.push(nextId);
    }
  }
  return reached;
}

function filterGraph(
  graph: FamilyGraphData,
  includedPersonIds: ReadonlySet<PersonId>,
  includedUnionIds: ReadonlySet<UnionId>,
  includedRelationIds: ReadonlySet<string>,
  activeFamilyScopeIds: ReadonlySet<string>,
  discoverableDescendantParentIds: ReadonlySet<PersonId>,
): FamilyGraphData {
  const base: FamilyGraphData = {
    ...graph,
    persons: graph.persons.filter(person => includedPersonIds.has(person.id)),
    unions: graph.unions.filter(union => includedUnionIds.has(union.id)),
    parentChildRelations: graph.parentChildRelations.filter(relation =>
      includedRelationIds.has(relation.id),
    ),
  };
  return {
    ...base,
    ...(graph.continuations === undefined
      ? {}
      : {
          continuations: graph.continuations.filter(continuation =>
            continuationBelongsToCorridor(
              continuation,
              includedPersonIds,
              includedUnionIds,
            ),
          ),
        }),
    ...(graph.familyContinuations === undefined
      ? {}
      : {
          familyContinuations: graph.familyContinuations.filter(
            continuation =>
              activeFamilyScopeIds.has(continuation.scope.id) ||
              continuation.scope.parentIds.some(parentId =>
                discoverableDescendantParentIds.has(parentId),
              ),
          ),
        }),
  };
}

function continuationBelongsToCorridor(
  continuation: TreeContinuation,
  includedPersonIds: ReadonlySet<PersonId>,
  includedUnionIds: ReadonlySet<UnionId>,
): boolean {
  if (!includedPersonIds.has(continuation.personId)) return false;
  if (continuation.unionId && !includedUnionIds.has(continuation.unionId)) {
    return false;
  }
  if (continuation.direction === "siblings") return false;
  if (continuation.direction === "partners") {
    return Boolean(
      continuation.unionId && includedUnionIds.has(continuation.unionId),
    );
  }
  return true;
}
