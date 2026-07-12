import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreeUnion,
  UnionId,
} from "../types.ts";

export interface AllDescendantsProjectionInput {
  graph: FamilyGraphData;
  rootPersonId: PersonId;
  /** Original tree focus used to keep its direct bloodline visually primary. */
  originalFocusPersonId?: PersonId;
}

export interface AllDescendantsProjectionResult {
  graph: FamilyGraphData;
  rootPersonId: PersonId;
  descendantPersonIds: readonly PersonId[];
  connectorPersonIds: readonly PersonId[];
  /** Every loaded person on a directed root -> original-focus lineage. */
  focusLineagePersonIds: readonly PersonId[];
  generationByPersonId: ReadonlyMap<PersonId, number>;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function childFamilyKey(relation: ParentChildRelation): string {
  return `${relation.childId}\u001f${relation.unionId ?? "<without-union>"}`;
}

function memberSignature(memberIds: readonly PersonId[]): string {
  return [...new Set(memberIds)].sort(compareStrings).join("\u001f");
}

/**
 * Produces an immutable descendants-only view. Co-parents are retained as
 * connector cards, but their unrelated children are never traversed.
 */
export function buildAllDescendantsProjection({
  graph,
  rootPersonId,
  originalFocusPersonId,
}: AllDescendantsProjectionInput): AllDescendantsProjectionResult {
  const personsById = new Map(graph.persons.map(person => [person.id, person]));
  if (!personsById.has(rootPersonId)) {
    return {
      graph: {
        ...graph,
        persons: [],
        unions: [],
        parentChildRelations: [],
        ...(graph.continuations === undefined ? {} : { continuations: [] }),
        ...(graph.familyContinuations === undefined
          ? {}
          : { familyContinuations: [] }),
      },
      rootPersonId,
      descendantPersonIds: [],
      connectorPersonIds: [],
      focusLineagePersonIds: [],
      generationByPersonId: new Map(),
    };
  }

  const relationsByParent = groupBy(
    graph.parentChildRelations,
    relation => relation.parentId,
  );
  const relationsByChild = groupBy(
    graph.parentChildRelations,
    relation => relation.childId,
  );
  const descendants = new Set<PersonId>([rootPersonId]);
  const generationByPersonId = new Map<PersonId, number>([[rootPersonId, 0]]);
  const queue: PersonId[] = [rootPersonId];
  for (let offset = 0; offset < queue.length; offset += 1) {
    const parentId = queue[offset]!;
    const nextGeneration = (generationByPersonId.get(parentId) ?? 0) + 1;
    const childIds = [...new Set(
      (relationsByParent.get(parentId) ?? []).map(relation => relation.childId),
    )].sort(compareStrings);
    for (const childId of childIds) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      generationByPersonId.set(childId, nextGeneration);
      queue.push(childId);
    }
  }

  const relationBundles = groupBy(graph.parentChildRelations, childFamilyKey);
  const includedRelationIds = new Set<string>();
  const includedUnionIds = new Set<UnionId>();
  const connectorIds = new Set<PersonId>();
  for (const bundle of relationBundles.values()) {
    const childId = bundle[0]?.childId;
    if (!childId || !descendants.has(childId)) continue;
    if (!bundle.some(relation => descendants.has(relation.parentId))) continue;
    for (const relation of bundle) {
      includedRelationIds.add(relation.id);
      if (!descendants.has(relation.parentId)) connectorIds.add(relation.parentId);
      if (relation.unionId) includedUnionIds.add(relation.unionId);
    }
  }

  const unionsById = new Map(graph.unions.map(union => [union.id, union]));
  const includedParentSets = [...includedUnionIds]
    .map(unionId => unionsById.get(unionId))
    .filter(
      (union): union is TreeUnion =>
        union !== undefined && union.kind === "parent-set",
    );
  const includedParentSignatures = new Set(
    includedParentSets.map(union => memberSignature(union.memberIds)),
  );

  for (const union of graph.unions) {
    if (includedUnionIds.has(union.id)) {
      for (const memberId of union.memberIds) {
        if (!descendants.has(memberId)) connectorIds.add(memberId);
      }
      continue;
    }
    if (union.kind !== "partnership") continue;
    const hasDescendantMember = union.memberIds.some(memberId =>
      descendants.has(memberId),
    );
    const isCompanionPartnership = includedParentSignatures.has(
      memberSignature(union.memberIds),
    );
    if (!hasDescendantMember && !isCompanionPartnership) continue;
    includedUnionIds.add(union.id);
    for (const memberId of union.memberIds) {
      if (!descendants.has(memberId)) connectorIds.add(memberId);
    }
  }

  const includedPersonIds = new Set([...descendants, ...connectorIds]);
  const ancestorsOfOriginalFocus = new Set<PersonId>();
  if (originalFocusPersonId && personsById.has(originalFocusPersonId)) {
    const ancestorQueue: PersonId[] = [originalFocusPersonId];
    for (let offset = 0; offset < ancestorQueue.length; offset += 1) {
      const personId = ancestorQueue[offset]!;
      if (ancestorsOfOriginalFocus.has(personId)) continue;
      ancestorsOfOriginalFocus.add(personId);
      for (const relation of relationsByChild.get(personId) ?? []) {
        if (!ancestorsOfOriginalFocus.has(relation.parentId)) {
          ancestorQueue.push(relation.parentId);
        }
      }
    }
  }
  const hasPathToOriginalFocus = ancestorsOfOriginalFocus.has(rootPersonId);
  const focusLineagePersonIds = hasPathToOriginalFocus
    ? [...ancestorsOfOriginalFocus]
        .filter(personId => includedPersonIds.has(personId))
        .sort(compareStrings)
    : [rootPersonId];
  const projectedGraph: FamilyGraphData = {
    ...graph,
    persons: graph.persons.filter(person => includedPersonIds.has(person.id)),
    unions: graph.unions.filter(union => includedUnionIds.has(union.id)),
    parentChildRelations: graph.parentChildRelations.filter(relation =>
      includedRelationIds.has(relation.id),
    ),
    ...(graph.continuations === undefined
      ? {}
      : {
          continuations: graph.continuations.filter(
            continuation =>
              descendants.has(continuation.personId) &&
              (continuation.direction === "children" ||
                continuation.direction === "partners"),
          ),
        }),
    ...(graph.familyContinuations === undefined
      ? {}
      : {
          familyContinuations: graph.familyContinuations.filter(continuation =>
            continuation.scope.parentIds.some(parentId =>
              descendants.has(parentId),
            ),
          ),
        }),
  };
  const orderedDescendants = [...descendants].sort(
    (left, right) =>
      (generationByPersonId.get(left) ?? 0) -
        (generationByPersonId.get(right) ?? 0) ||
      compareStrings(left, right),
  );
  return {
    graph: projectedGraph,
    rootPersonId,
    descendantPersonIds: orderedDescendants,
    connectorPersonIds: [...connectorIds].sort(compareStrings),
    focusLineagePersonIds,
    generationByPersonId,
  };
}
