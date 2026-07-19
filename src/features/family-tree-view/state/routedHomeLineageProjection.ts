import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreeUnion,
} from "../types.ts";
import { buildAllDescendantsProjection } from "./allDescendantsProjection.ts";

export interface RoutedHomeLineageProjectionInput {
  graph: FamilyGraphData;
  routedPersonId: PersonId;
  homePersonId: PersonId;
}

export interface RoutedHomeLineageProjectionResult {
  graph: FamilyGraphData;
  lineagePersonIds: readonly PersonId[];
  connectorPersonIds: readonly PersonId[];
  hasCompletePath: boolean;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function relationFamilyKey(relation: ParentChildRelation): string {
  return `${relation.childId}\u001f${relation.unionId ?? "<without-union>"}`;
}

function memberSignature(memberIds: readonly PersonId[]): string {
  return [...new Set(memberIds)].sort(compareStrings).join("\u001f");
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
 * Isolates every loaded directed lineage from a person opened by route to the
 * tree's persisted home person. Co-parents needed by those parent sets remain
 * as connector cards, but unrelated descendant branches are removed.
 */
export function buildRoutedHomeLineageProjection({
  graph,
  routedPersonId,
  homePersonId,
}: RoutedHomeLineageProjectionInput): RoutedHomeLineageProjectionResult {
  const descendantsProjection = buildAllDescendantsProjection({
    graph,
    rootPersonId: routedPersonId,
    originalFocusPersonId: homePersonId,
  });
  const descendantPersonIds = new Set(descendantsProjection.descendantPersonIds);
  const lineagePersonIds = new Set(
    descendantsProjection.focusLineagePersonIds.filter(personId =>
      descendantPersonIds.has(personId),
    ),
  );
  const hasCompletePath =
    lineagePersonIds.has(routedPersonId) && lineagePersonIds.has(homePersonId);

  if (!hasCompletePath) {
    return {
      graph: emptyProjectionGraph(graph),
      lineagePersonIds: [],
      connectorPersonIds: [],
      hasCompletePath: false,
    };
  }

  const relationsByFamily = new Map<string, ParentChildRelation[]>();
  for (const relation of graph.parentChildRelations) {
    const key = relationFamilyKey(relation);
    const family = relationsByFamily.get(key);
    if (family) family.push(relation);
    else relationsByFamily.set(key, [relation]);
  }

  const includedRelationIds = new Set<string>();
  const includedUnionIds = new Set<string>();
  const connectorPersonIds = new Set<PersonId>();
  for (const relation of graph.parentChildRelations) {
    if (
      !lineagePersonIds.has(relation.parentId) ||
      !lineagePersonIds.has(relation.childId)
    ) {
      continue;
    }
    for (const familyRelation of relationsByFamily.get(relationFamilyKey(relation)) ?? []) {
      includedRelationIds.add(familyRelation.id);
      if (!lineagePersonIds.has(familyRelation.parentId)) {
        connectorPersonIds.add(familyRelation.parentId);
      }
      if (familyRelation.unionId) includedUnionIds.add(familyRelation.unionId);
    }
  }

  const unionsById = new Map(graph.unions.map(union => [union.id, union]));
  const parentSetSignatures = new Set(
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
      !includedUnionIds.has(union.id) &&
      !(
        union.kind === "partnership" &&
        parentSetSignatures.has(memberSignature(union.memberIds))
      )
    ) {
      continue;
    }
    includedUnionIds.add(union.id);
    for (const memberId of union.memberIds) {
      if (!lineagePersonIds.has(memberId)) connectorPersonIds.add(memberId);
    }
  }

  const includedPersonIds = new Set([
    ...lineagePersonIds,
    ...connectorPersonIds,
  ]);
  return {
    graph: {
      ...graph,
      persons: graph.persons.filter(person => includedPersonIds.has(person.id)),
      unions: graph.unions.filter(union => includedUnionIds.has(union.id)),
      parentChildRelations: graph.parentChildRelations.filter(relation =>
        includedRelationIds.has(relation.id),
      ),
      // The route corridor is a structural overlay. Its continuation tokens
      // belong to a separate hook session and must never control the main view.
      continuations: [],
      familyContinuations: [],
    },
    lineagePersonIds: [...lineagePersonIds].sort(compareStrings),
    connectorPersonIds: [...connectorPersonIds].sort(compareStrings),
    hasCompletePath: true,
  };
}
