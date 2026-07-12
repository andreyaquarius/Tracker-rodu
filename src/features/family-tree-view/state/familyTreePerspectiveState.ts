import type {
  CameraState,
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  OccurrenceId,
  PersonId,
  UnionId,
} from "../types.ts";

export type FamilyTreePerspectiveKind =
  | "pedigree"
  | "family-corridor"
  | "all-descendants";

export interface FamilyTreeBranchVisibilitySnapshot {
  scopeKey: string;
  branchRevision: number;
  graphVersion?: string | number;
  permissionFingerprint?: string;
  layerKeys: readonly string[];
  pendingLayerKeys: readonly string[];
  activeLayerKeys: readonly string[];
  restorePersonLayerKeys: readonly (
    readonly [PersonId, readonly string[]]
  )[];
}

export interface FamilyTreeGenerationSettings {
  ancestorDepth: number;
  descendantDepth: number;
  collateralDepth: number;
  showAllParentSets: boolean;
  activeParentSetByChild: Readonly<Record<PersonId, UnionId>>;
}

/** One opened family step in an isolated descendant-line perspective. */
export interface FamilyCorridorTrailItem {
  scope: FamilyScope;
  continuation: FamilyContinuation;
  ownerPersonId?: PersonId;
  anchorOccurrenceId?: OccurrenceId;
}

/** Complete pedigree state restored after either temporary perspective. */
export interface FamilyTreePedigreeReturnSnapshot {
  treeId: string;
  graphVersion?: string | number;
  permissionFingerprint?: string;
  /** Immutable graph reference owned by the long-lived pedigree session. */
  pedigreeGraph: FamilyGraphData;
  focusHistory: readonly PersonId[];
  focusIndex: number;
  focusPersonId: PersonId;
  branchVisibility: FamilyTreeBranchVisibilitySnapshot;
  camera?: CameraState;
  selectedPersonId: PersonId;
  generationSettings: FamilyTreeGenerationSettings;
  familyContinuationOwners: readonly (readonly [string, PersonId])[];
}

export type FamilyTreePerspective =
  | { kind: "pedigree" }
  | {
      kind: "family-corridor";
      sessionId: string;
      scope: FamilyScope;
      /** Exact action that opened the isolated session, including its cursor. */
      continuation: FamilyContinuation;
      ownerPersonId?: PersonId;
      /** Ordered, root-to-leaf breadcrumb trail of opened family scopes. */
      trail: readonly FamilyCorridorTrailItem[];
      returnTo: FamilyTreePedigreeReturnSnapshot;
    }
  | {
      kind: "all-descendants";
      sessionId: string;
      rootPersonId: PersonId;
      returnTo: FamilyTreePedigreeReturnSnapshot;
    };

export interface CapturePedigreeSnapshotInput {
  treeId: string;
  graph: FamilyGraphData;
  focusHistory: readonly PersonId[];
  focusIndex: number;
  branchVisibility: FamilyTreeBranchVisibilitySnapshot;
  camera?: CameraState;
  selectedPersonId: PersonId;
  generationSettings: FamilyTreeGenerationSettings;
  familyContinuationOwners: ReadonlyMap<string, PersonId>;
}

export function capturePedigreeReturnSnapshot(
  input: CapturePedigreeSnapshotInput,
): FamilyTreePedigreeReturnSnapshot {
  const boundedFocusIndex = Math.max(
    0,
    Math.min(input.focusIndex, Math.max(0, input.focusHistory.length - 1)),
  );
  const focusHistory = [...input.focusHistory];
  const focusPersonId = focusHistory[boundedFocusIndex] ?? input.selectedPersonId;
  return {
    treeId: input.treeId,
    ...(input.graph.graphVersion === undefined
      ? {}
      : { graphVersion: input.graph.graphVersion }),
    ...(input.graph.permissionFingerprint === undefined
      ? {}
      : { permissionFingerprint: input.graph.permissionFingerprint }),
    pedigreeGraph: input.graph,
    focusHistory,
    focusIndex: boundedFocusIndex,
    focusPersonId,
    branchVisibility: {
      ...input.branchVisibility,
      layerKeys: [...input.branchVisibility.layerKeys],
      pendingLayerKeys: [...input.branchVisibility.pendingLayerKeys],
      activeLayerKeys: [...input.branchVisibility.activeLayerKeys],
      restorePersonLayerKeys:
        input.branchVisibility.restorePersonLayerKeys.map(([personId, keys]) => [
          personId,
          [...keys],
        ] as const),
    },
    ...(input.camera ? { camera: { ...input.camera } } : {}),
    selectedPersonId: input.selectedPersonId,
    generationSettings: {
      ...input.generationSettings,
      activeParentSetByChild: {
        ...input.generationSettings.activeParentSetByChild,
      },
    },
    familyContinuationOwners: [...input.familyContinuationOwners]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scopeId, personId]) => [scopeId, personId] as const),
  };
}

export function isSpecialFamilyTreePerspective(
  perspective: FamilyTreePerspective,
): perspective is Exclude<FamilyTreePerspective, { kind: "pedigree" }> {
  return perspective.kind !== "pedigree";
}

export function familyTreePerspectiveKey(
  perspective: FamilyTreePerspective,
  pedigreeFocusPersonId: PersonId,
): string {
  if (perspective.kind === "pedigree") {
    return `pedigree:${pedigreeFocusPersonId}`;
  }
  if (perspective.kind === "family-corridor") {
    return `family-corridor:${perspective.sessionId}:${perspective.scope.id}`;
  }
  return `all-descendants:${perspective.sessionId}:${perspective.rootPersonId}`;
}

export function specialPerspectiveReturnSnapshot(
  perspective: FamilyTreePerspective,
): FamilyTreePedigreeReturnSnapshot | undefined {
  return perspective.kind === "pedigree" ? undefined : perspective.returnTo;
}

/**
 * Adds a newly opened family scope to the breadcrumb trail. Reopening a scope
 * replaces its existing entry and drops every deeper step, keeping the trail
 * a unique, ordered root-to-leaf path.
 */
export function appendFamilyCorridorTrailItem(
  trail: readonly FamilyCorridorTrailItem[],
  item: FamilyCorridorTrailItem,
): readonly FamilyCorridorTrailItem[] {
  const existingIndex = trail.findIndex(
    candidate => candidate.scope.id === item.scope.id,
  );
  if (existingIndex < 0) return [...trail, item];
  return [...trail.slice(0, existingIndex), item];
}

/** Returns an immutable breadcrumb prefix including the requested item. */
export function keepFamilyCorridorTrailThrough(
  trail: readonly FamilyCorridorTrailItem[],
  index: number,
): readonly FamilyCorridorTrailItem[] {
  if (!Number.isFinite(index) || index < 0) return [];
  return trail.slice(0, Math.trunc(index) + 1);
}
