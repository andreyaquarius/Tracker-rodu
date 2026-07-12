import {
  mergeNeighborhood,
  reconcileFamilyContinuations,
  type NeighborhoodResponse,
} from "./neighborhoodClient.ts";
import type {
  ContinuationDirection,
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  PersonId,
  TreeContinuation,
} from "../types.ts";

interface FamilyTreeBranchLayerBase {
  key: string;
  consumedToken: string;
  response: NeighborhoodResponse;
  parentKey?: string;
}

export interface FamilyTreePersonBranchLayer extends FamilyTreeBranchLayerBase {
  scopeKind?: "person";
  personId: PersonId;
  direction: ContinuationDirection;
}

export interface FamilyTreeFamilyBranchLayer extends FamilyTreeBranchLayerBase {
  scopeKind: "family";
  scope: FamilyScope;
}

export type FamilyTreeBranchLayer =
  | FamilyTreePersonBranchLayer
  | FamilyTreeFamilyBranchLayer;

export function familyTreeBranchKey(
  personId: PersonId,
  direction: ContinuationDirection,
): string {
  return `${personId}\u001f${direction}`;
}

/** One layer key for the family, regardless of which parent exposed it. */
export function familyTreeFamilyBranchKey(scopeId: string): string {
  return `family\u001f${scopeId}`;
}

export function isFamilyTreeFamilyBranchLayer(
  layer: FamilyTreeBranchLayer,
): layer is FamilyTreeFamilyBranchLayer {
  return layer.scopeKind === "family";
}

export function isFamilyTreePersonBranchLayer(
  layer: FamilyTreeBranchLayer,
): layer is FamilyTreePersonBranchLayer {
  return !isFamilyTreeFamilyBranchLayer(layer);
}

/**
 * Builds the visible graph from the immutable base response and reversible,
 * cached branch pages. A nested layer is visible only while every owner layer
 * above it is active.
 */
export function composeFamilyTreeBranchLayers(
  base: FamilyGraphData,
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
  activeKeys: ReadonlySet<string>,
): FamilyGraphData {
  const visibleLayers = [...layers.values()]
    .filter(layer => branchLayerIsVisible(layer.key, layers, activeKeys, new Set()))
    .sort((left, right) =>
      branchLayerDepth(left, layers) - branchLayerDepth(right, layers) ||
      left.key.localeCompare(right.key),
    );
  const normalizedBase = normalizeFamilyControls(base);
  if (!visibleLayers.length) return normalizedBase;

  let composed = normalizedBase;
  for (const layer of visibleLayers) {
    const response = tagOwnedBranchResponse(layer.response, layer.key, composed);
    composed = mergeNeighborhood(
      composed,
      response,
      [layer.consumedToken],
      isFamilyTreeFamilyBranchLayer(layer) ? [layer.scope.id] : [],
    );
  }

  const activeDirections = new Set(
    visibleLayers
      .filter(layer => !isFamilyTreeFamilyBranchLayer(layer))
      .map(layer => layer.key),
  );
  const activeFamilyScopes = new Set(
    visibleLayers
      .filter(isFamilyTreeFamilyBranchLayer)
      .map(layer => layer.scope.id),
  );
  const continuations = (composed.continuations ?? []).filter(continuation =>
    !activeDirections.has(familyTreeBranchKey(continuation.personId, continuation.direction)),
  );
  const familyContinuations = reconcileFamilyContinuations(
    composed.familyContinuations ?? [],
  ).filter(continuation => !activeFamilyScopes.has(continuation.scope.id));
  return {
    ...composed,
    continuations: [
      ...continuations,
      ...visibleLayers
        .filter(isFamilyTreePersonBranchLayer)
        .map(expandedBranchContinuation),
    ],
    familyContinuations: [
      ...familyContinuations,
      ...visibleLayers
        .filter(isFamilyTreeFamilyBranchLayer)
        .map(expandedFamilyBranchContinuation),
    ],
  };
}

export function branchLayerPersonIds(
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
): string[] {
  return [...new Set(
    [...layers.values()]
      .filter(isFamilyTreePersonBranchLayer)
      .map(layer => layer.personId),
  )]
    .sort((left, right) => left.localeCompare(right));
}

export function familyBranchLayerScopeIds(
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
): string[] {
  return [...new Set(
    [...layers.values()]
      .filter(isFamilyTreeFamilyBranchLayer)
      .map(layer => layer.scope.id),
  )].sort((left, right) => left.localeCompare(right));
}

export function collapsedBranchLayerPersonIds(
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
  activeKeys: ReadonlySet<string>,
): string[] {
  return branchLayerPersonIds(layers).filter(personId =>
    [...layers.values()]
      .filter(
        layer =>
          isFamilyTreePersonBranchLayer(layer) && layer.personId === personId,
      )
      .every(layer => !activeKeys.has(layer.key)),
  );
}

export function collapsedFamilyBranchLayerScopeIds(
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
  activeKeys: ReadonlySet<string>,
): string[] {
  const activeScopeIds = new Set(
    activeFamilyBranchLayerScopeIds(layers, activeKeys),
  );
  return familyBranchLayerScopeIds(layers).filter(
    scopeId => !activeScopeIds.has(scopeId),
  );
}

export function activeFamilyBranchLayerScopeIds(
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
  activeKeys: ReadonlySet<string>,
): string[] {
  return [...layers.values()]
    .filter(isFamilyTreeFamilyBranchLayer)
    .filter(layer => branchLayerIsVisible(layer.key, layers, activeKeys, new Set()))
    .map(layer => layer.scope.id)
    .sort((left, right) => left.localeCompare(right));
}

function branchLayerIsVisible(
  key: string,
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
  activeKeys: ReadonlySet<string>,
  visiting: Set<string>,
): boolean {
  if (!activeKeys.has(key)) return false;
  const layer = layers.get(key);
  if (!layer) return false;
  if (!layer.parentKey) return true;
  if (visiting.has(key)) return false;
  visiting.add(key);
  const visible = branchLayerIsVisible(layer.parentKey, layers, activeKeys, visiting);
  visiting.delete(key);
  return visible;
}

function branchLayerDepth(
  layer: FamilyTreeBranchLayer,
  layers: ReadonlyMap<string, FamilyTreeBranchLayer>,
): number {
  let depth = 0;
  let parentKey = layer.parentKey;
  const visited = new Set([layer.key]);
  while (parentKey && !visited.has(parentKey)) {
    visited.add(parentKey);
    depth += 1;
    parentKey = layers.get(parentKey)?.parentKey;
  }
  return depth;
}

function tagOwnedBranchResponse(
  response: NeighborhoodResponse,
  ownerBranchKey: string,
  current: FamilyGraphData,
): NeighborhoodResponse {
  const currentRelations = new Map(
    current.parentChildRelations.map(relation => [relation.id, relation]),
  );
  return {
    ...response,
    parentChildRelations: response.parentChildRelations.map(relation => {
      const existing = currentRelations.get(relation.id);
      const inheritedOwner = existing?.ownerBranchKey;
      const { ownerBranchKey: _ignoredOwner, ...plainRelation } = relation;
      if (inheritedOwner) return { ...plainRelation, ownerBranchKey: inheritedOwner };
      if (existing) return plainRelation;
      return { ...plainRelation, ownerBranchKey };
    }),
    continuations: (response.continuations ?? []).map(continuation => ({
      ...continuation,
      ownerBranchKey,
    })),
    familyContinuations: (response.familyContinuations ?? []).map(
      continuation => ({
        ...continuation,
        ownerBranchKey,
      }),
    ),
  };
}

function expandedBranchContinuation(
  layer: FamilyTreePersonBranchLayer,
): TreeContinuation {
  return {
    id: `active:${layer.key}`,
    personId: layer.personId,
    direction: layer.direction,
    token: `local:active:${layer.key}`,
    expanded: true,
    ...(layer.parentKey ? { ownerBranchKey: layer.parentKey } : {}),
  };
}

function expandedFamilyBranchContinuation(
  layer: FamilyTreeFamilyBranchLayer,
): FamilyContinuation {
  return {
    id: `active:${layer.key}`,
    scope: layer.scope,
    token: `local:active:${layer.key}`,
    expanded: true,
    ...(layer.parentKey ? { ownerBranchKey: layer.parentKey } : {}),
  };
}

function normalizeFamilyControls(base: FamilyGraphData): FamilyGraphData {
  if (!base.familyContinuations?.length) return base;
  const familyContinuations = reconcileFamilyContinuations(
    base.familyContinuations,
  );
  if (familyContinuations.length === base.familyContinuations.length) return base;
  return { ...base, familyContinuations };
}
