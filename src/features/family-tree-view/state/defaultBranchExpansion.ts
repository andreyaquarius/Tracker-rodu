import type {
  FamilyContinuation,
  FamilyGraphData,
  PersonId,
  TreeContinuation,
} from "../types.ts";

export type DefaultBranchExpansion =
  | {
      kind: "person";
      reason: "focus-partners" | "cousin-connectors";
      continuation: TreeContinuation;
    }
  | {
      kind: "family";
      reason: "focus-family" | "cousin-descendants";
      continuation: FamilyContinuation;
    };

export interface DefaultBranchExpansionInput {
  graph: FamilyGraphData;
  focusPersonId: PersonId;
  includeCousinDescendants: boolean;
  attemptedPersonContinuationIds: ReadonlySet<string>;
  attemptedFamilyScopeIds: ReadonlySet<string>;
}

/**
 * Selects one bounded existing branch request at a time. It deliberately does
 * not turn on global descendant/collateral depth: those depth values fan out
 * from every loaded ancestor, while this plan opens only the focus family and
 * the two requested cousin origin levels.
 */
export function nextDefaultBranchExpansion({
  graph,
  focusPersonId,
  includeCousinDescendants,
  attemptedPersonContinuationIds,
  attemptedFamilyScopeIds,
}: DefaultBranchExpansionInput): DefaultBranchExpansion | undefined {
  const personContinuations = [...(graph.continuations ?? [])]
    .filter(continuation => !continuation.expanded)
    .filter(continuation =>
      !attemptedPersonContinuationIds.has(continuation.id)
    )
    .sort(comparePersonContinuations);
  const familyContinuations = [...(graph.familyContinuations ?? [])]
    .filter(continuation => !continuation.expanded)
    .filter(continuation =>
      !attemptedFamilyScopeIds.has(continuation.scope.id)
    )
    .sort((left, right) => left.scope.id.localeCompare(right.scope.id));

  const focusPartner = personContinuations.find(
    continuation =>
      continuation.personId === focusPersonId &&
      continuation.direction === "partners",
  );
  if (focusPartner) {
    return {
      kind: "person",
      reason: "focus-partners",
      continuation: focusPartner,
    };
  }

  const focusFamily = familyContinuations.find(continuation =>
    continuation.scope.parentIds.includes(focusPersonId)
  );
  if (focusFamily) {
    return {
      kind: "family",
      reason: "focus-family",
      continuation: focusFamily,
    };
  }

  if (!includeCousinDescendants) return undefined;

  const { parentsByChild, childrenByParent } = relationshipIndex(graph);
  const parents = sorted(parentsByChild.get(focusPersonId));
  const grandparents = sorted(new Set(
    parents.flatMap(parentId => [...(parentsByChild.get(parentId) ?? [])]),
  ));
  const cousinConnectorIds = new Set([...parents, ...grandparents]);

  const connectorContinuation = personContinuations.find(
    continuation =>
      continuation.direction === "siblings" &&
      cousinConnectorIds.has(continuation.personId),
  );
  if (connectorContinuation) {
    return {
      kind: "person",
      reason: "cousin-connectors",
      continuation: connectorContinuation,
    };
  }

  const directLineageIds = ancestorClosure(focusPersonId, parentsByChild);
  const collateralRoots = new Set<PersonId>();
  for (const connectorId of cousinConnectorIds) {
    for (const connectorParentId of parentsByChild.get(connectorId) ?? []) {
      for (const siblingId of childrenByParent.get(connectorParentId) ?? []) {
        if (
          siblingId !== connectorId &&
          !directLineageIds.has(siblingId)
        ) {
          collateralRoots.add(siblingId);
        }
      }
    }
  }
  const cousinDescendantIds = descendantClosure(
    collateralRoots,
    childrenByParent,
  );
  const cousinFamily = familyContinuations.find(continuation =>
    continuation.scope.parentIds.some(parentId =>
      cousinDescendantIds.has(parentId)
    )
  );
  if (!cousinFamily) return undefined;
  return {
    kind: "family",
    reason: "cousin-descendants",
    continuation: cousinFamily,
  };
}

function relationshipIndex(graph: FamilyGraphData): {
  parentsByChild: Map<PersonId, Set<PersonId>>;
  childrenByParent: Map<PersonId, Set<PersonId>>;
} {
  const parentsByChild = new Map<PersonId, Set<PersonId>>();
  const childrenByParent = new Map<PersonId, Set<PersonId>>();
  for (const relation of graph.parentChildRelations) {
    add(parentsByChild, relation.childId, relation.parentId);
    add(childrenByParent, relation.parentId, relation.childId);
  }
  return { parentsByChild, childrenByParent };
}

function ancestorClosure(
  focusPersonId: PersonId,
  parentsByChild: ReadonlyMap<PersonId, ReadonlySet<PersonId>>,
): Set<PersonId> {
  const visited = new Set<PersonId>([focusPersonId]);
  const queue = [focusPersonId];
  while (queue.length) {
    const childId = queue.shift()!;
    for (const parentId of parentsByChild.get(childId) ?? []) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      queue.push(parentId);
    }
  }
  return visited;
}

function descendantClosure(
  rootIds: ReadonlySet<PersonId>,
  childrenByParent: ReadonlyMap<PersonId, ReadonlySet<PersonId>>,
): Set<PersonId> {
  const visited = new Set<PersonId>(rootIds);
  const queue = [...rootIds].sort((left, right) => left.localeCompare(right));
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
    }
  }
  return visited;
}

function add(
  map: Map<PersonId, Set<PersonId>>,
  key: PersonId,
  value: PersonId,
): void {
  const values = map.get(key) ?? new Set<PersonId>();
  values.add(value);
  map.set(key, values);
}

function sorted(values: ReadonlySet<PersonId> | undefined): PersonId[] {
  return [...(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function comparePersonContinuations(
  left: TreeContinuation,
  right: TreeContinuation,
): number {
  return (
    left.personId.localeCompare(right.personId) ||
    left.direction.localeCompare(right.direction) ||
    left.id.localeCompare(right.id)
  );
}
