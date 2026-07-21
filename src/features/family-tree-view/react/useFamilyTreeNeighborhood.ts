"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  boundedBranchNodeLimit,
  boundedFamilyBranchChildLimit,
  graphVersionsConflict,
  isFamilyTreeScopeConflictError,
  isLocalContinuationToken,
  loadBoundedFamilyBranchPages,
  reconcileFamilyContinuations,
  permissionFingerprintsConflict,
  type FamilyTreeNeighborhoodClient,
  type FamilyBranchResponse,
  type NeighborhoodResponse,
} from "../data/neighborhoodClient.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  LayoutNode,
  PersonId,
  TreeContinuation,
} from "../types.ts";
import { MAX_RENDERED_FAMILY_TREE_NODES } from "./renderLimits.ts";
import {
  branchLayerPersonIds,
  activeFamilyBranchLayerScopeIds,
  collapsedFamilyBranchLayerScopeIds,
  collapsedBranchLayerPersonIds,
  composeFamilyTreeBranchLayers,
  familyBranchLayerScopeIds,
  familyTreeBranchKey,
  familyTreeFamilyBranchKey,
  isFamilyTreePersonBranchLayer,
  type FamilyTreeBranchLayer,
} from "../data/branchLayers.ts";
import type { FamilyTreeBranchVisibilitySnapshot } from "../state/familyTreePerspectiveState.ts";
import { nextDefaultBranchExpansion } from "../state/defaultBranchExpansion.ts";
export type { FamilyTreeBranchVisibilitySnapshot } from "../state/familyTreePerspectiveState.ts";

const EMPTY_GRAPH: FamilyGraphData = {
  persons: [],
  unions: [],
  parentChildRelations: [],
  continuations: [],
};

interface ActiveBranchRequest {
  controller: AbortController;
  epoch: number;
  revision: number;
  layerKey: string;
}

export interface UseFamilyTreeNeighborhoodInput {
  client: FamilyTreeNeighborhoodClient;
  treeId: string;
  focusPersonId: PersonId;
  enabled?: boolean;
  /** Separates temporary graph sessions even when their request shape matches. */
  sessionKey?: string;
  /** Loads only the structural graph, without expandable branch metadata. */
  structuralOnly?: boolean;
  ancestorDepth?: number;
  descendantDepth?: number;
  collateralDepth?: number;
  maxNodes?: number;
  permissionFingerprint?: string;
  /** Opens only this person's partners and direct-child family scopes after the base paint. */
  defaultVisibleFamilyPersonId?: PersonId;
  /** Also opens first cousins, parents' first cousins and their descendant scopes. */
  includeCousinDescendantsByDefault?: boolean;
}

export type FamilyTreeBranchRestoreResult =
  | "restored"
  | "stale-scope"
  | "stale-version"
  | "stale-permission";

export type FamilyContinuationExpansionResult =
  | "expanded"
  | "collapsed"
  | "unchanged"
  | "failed"
  | "aborted";

export type PersonContinuationExpansionResult =
  FamilyContinuationExpansionResult;

export interface UseFamilyTreeNeighborhoodResult {
  graph: FamilyGraphData;
  loading: boolean;
  error: Error | undefined;
  canceled: boolean;
  cancel: () => void;
  expandPersonContinuation: (
    continuation: TreeContinuation,
  ) => Promise<PersonContinuationExpansionResult>;
  expandContinuation: (
    token: string,
    node: LayoutNode,
  ) => Promise<PersonContinuationExpansionResult>;
  expandFamilyContinuation: (
    continuation: FamilyContinuation,
    visiblePersonIds?: ReadonlySet<PersonId>,
  ) => Promise<FamilyContinuationExpansionResult>;
  branchTogglePersonIds: readonly PersonId[];
  collapsedBranchPersonIds: readonly PersonId[];
  togglePersonBranches: (personId: PersonId) => void;
  familyBranchToggleScopeIds: readonly string[];
  activeFamilyScopeIds: readonly string[];
  collapsedFamilyScopeIds: readonly string[];
  collapseFamilyScope: (scopeId: string) => void;
  toggleFamilyScope: (scopeId: string) => void;
  captureBranchVisibility: () => FamilyTreeBranchVisibilitySnapshot;
  restoreBranchVisibility: (
    snapshot: FamilyTreeBranchVisibilitySnapshot,
  ) => FamilyTreeBranchRestoreResult;
  reload: () => void;
}

export function useFamilyTreeNeighborhood({
  client,
  treeId,
  focusPersonId,
  enabled = true,
  sessionKey = "default",
  structuralOnly = false,
  ancestorDepth = 7,
  descendantDepth = 0,
  collateralDepth = 0,
  maxNodes = 400,
  permissionFingerprint,
  defaultVisibleFamilyPersonId,
  includeCousinDescendantsByDefault = false,
}: UseFamilyTreeNeighborhoodInput): UseFamilyTreeNeighborhoodResult {
  const scopeKey = [
    treeId,
    focusPersonId,
    structuralOnly ? "structural" : "full",
    ancestorDepth,
    descendantDepth,
    collateralDepth,
    maxNodes,
    permissionFingerprint ?? "",
    sessionKey,
    defaultVisibleFamilyPersonId ?? "",
    includeCousinDescendantsByDefault ? "cousins" : "compact",
  ].join("\u001f");
  const [graph, setGraph] = useState<FamilyGraphData>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [canceled, setCanceled] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [baseLoadRevision, setBaseLoadRevision] = useState(0);
  const graphRef = useRef<FamilyGraphData>(EMPTY_GRAPH);
  const baseGraphRef = useRef<FamilyGraphData>(EMPTY_GRAPH);
  const graphScopeRef = useRef(scopeKey);
  const requestEpochRef = useRef(0);
  const branchRevisionRef = useRef(0);
  const baseLoadingRef = useRef(true);
  const baseControllerRef = useRef<AbortController | undefined>(undefined);
  const forceFreshBaseRef = useRef(false);
  const mountedRef = useRef(true);
  const activeBranchesRef = useRef(new Map<string, ActiveBranchRequest>());
  const branchLayersRef = useRef(new Map<string, FamilyTreeBranchLayer>());
  const activeBranchLayerKeysRef = useRef(new Set<string>());
  const restoreBranchLayerKeysRef = useRef(new Map<PersonId, Set<string>>());
  const scopeConflictRecoveryRef = useRef({
    scopeKey,
    automaticReloadUsed: false,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const syncLoading = useCallback((): void => {
    if (!mountedRef.current) return;
    setLoading(baseLoadingRef.current || activeBranchesRef.current.size > 0);
  }, []);

  const abortBranches = useCallback((): void => {
    for (const request of activeBranchesRef.current.values()) {
      request.controller.abort();
    }
    activeBranchesRef.current.clear();
  }, []);

  const cancel = useCallback((): void => {
    // Invalidating the epoch before aborting guarantees that even a transport
    // which resolves while handling abort cannot commit a late response.
    requestEpochRef.current += 1;
    const baseController = baseControllerRef.current;
    baseControllerRef.current = undefined;
    baseController?.abort();
    abortBranches();
    baseLoadingRef.current = false;
    if (!mountedRef.current) return;
    setLoading(false);
    setError(undefined);
    setCanceled(true);
  }, [abortBranches]);

  const commit = useCallback((next: FamilyGraphData): void => {
    graphRef.current = next;
    if (mountedRef.current) setGraph(next);
  }, []);

  const commitComposedGraph = useCallback((): void => {
    commit(composeFamilyTreeBranchLayers(
      baseGraphRef.current,
      branchLayersRef.current,
      activeBranchLayerKeysRef.current,
    ));
  }, [commit]);

  const resetBranchLayers = useCallback((): void => {
    branchLayersRef.current.clear();
    activeBranchLayerKeysRef.current.clear();
    restoreBranchLayerKeysRef.current.clear();
  }, []);

  const recoverFromScopeConflict = useCallback((): void => {
    // Invalidate every request that still carries the rejected version before
    // scheduling a fresh base read. This is deliberately single-flight: if
    // the graph changes again during that rebase, the user gets a retry action
    // instead of an unbounded RPC loop.
    requestEpochRef.current += 1;
    const baseController = baseControllerRef.current;
    baseControllerRef.current = undefined;
    baseController?.abort();
    abortBranches();
    client.invalidateTree?.(treeId);
    forceFreshBaseRef.current = true;
    baseGraphRef.current = EMPTY_GRAPH;
    graphRef.current = EMPTY_GRAPH;
    resetBranchLayers();
    commit(EMPTY_GRAPH);

    const recovery = scopeConflictRecoveryRef.current;
    const mayReload = recovery.scopeKey === scopeKey &&
      !recovery.automaticReloadUsed;
    if (mayReload) {
      recovery.automaticReloadUsed = true;
      baseLoadingRef.current = true;
      setError(undefined);
      syncLoading();
      setReloadKey(value => value + 1);
      return;
    }

    baseLoadingRef.current = false;
    syncLoading();
    setError(new Error(
      "Дані родового дерева змінилися під час завантаження. Спробуйте ще раз.",
    ));
  }, [
    abortBranches,
    client,
    commit,
    resetBranchLayers,
    scopeKey,
    syncLoading,
    treeId,
  ]);

  useEffect(() => {
    if (!enabled) return;
    setCanceled(false);
    const epoch = ++requestEpochRef.current;
    const controller = new AbortController();
    baseControllerRef.current = controller;
    const scopeChanged = graphScopeRef.current !== scopeKey;
    const forceFreshBase = forceFreshBaseRef.current;
    forceFreshBaseRef.current = false;
    if (scopeChanged || scopeConflictRecoveryRef.current.scopeKey !== scopeKey) {
      scopeConflictRecoveryRef.current = {
        scopeKey,
        automaticReloadUsed: false,
      };
    }

    abortBranches();
    resetBranchLayers();
    if (scopeChanged) {
      graphScopeRef.current = scopeKey;
      baseGraphRef.current = EMPTY_GRAPH;
      graphRef.current = EMPTY_GRAPH;
      setGraph(EMPTY_GRAPH);
    } else {
      commit(baseGraphRef.current);
    }

    const knownGraphVersion = scopeChanged || forceFreshBase
      ? undefined
      : graphRef.current.graphVersion;
    baseLoadingRef.current = true;
    syncLoading();
    setError(undefined);

    void client
      .load(
        {
          treeId,
          focusPersonId,
          ...(structuralOnly ? { structuralOnly: true } : {}),
          ancestorDepth,
          descendantDepth,
          collateralDepth,
          maxNodes,
          ...(knownGraphVersion === undefined ? {} : { knownGraphVersion }),
          ...(forceFreshBase || permissionFingerprint === undefined
            ? {}
            : { permissionFingerprint }),
        },
        controller.signal,
      )
      .then(response => {
        if (
          controller.signal.aborted ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return;
        }
        const normalizedResponse = response.familyContinuations
          ? {
              ...response,
              familyContinuations: reconcileFamilyContinuations(
                response.familyContinuations,
              ),
            }
          : response;
        if (baseControllerRef.current === controller) {
          baseControllerRef.current = undefined;
        }
        baseGraphRef.current = normalizedResponse;
        commit(normalizedResponse);
        baseLoadingRef.current = false;
        syncLoading();
        setBaseLoadRevision(value => value + 1);
        if (!defaultVisibleFamilyPersonId) {
          scopeConflictRecoveryRef.current.automaticReloadUsed = false;
        }
      })
      .catch(reason => {
        if (
          controller.signal.aborted ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return;
        }
        if (baseControllerRef.current === controller) {
          baseControllerRef.current = undefined;
        }
        if (isFamilyTreeScopeConflictError(reason)) {
          recoverFromScopeConflict();
          return;
        }
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        baseLoadingRef.current = false;
        syncLoading();
      });

    return () => {
      controller.abort();
      if (baseControllerRef.current === controller) {
        baseControllerRef.current = undefined;
      }
      abortBranches();
    };
  }, [
    abortBranches,
    ancestorDepth,
    client,
    collateralDepth,
    commit,
    descendantDepth,
    defaultVisibleFamilyPersonId,
    enabled,
    focusPersonId,
    maxNodes,
    permissionFingerprint,
    recoverFromScopeConflict,
    reloadKey,
    resetBranchLayers,
    scopeKey,
    sessionKey,
    structuralOnly,
    syncLoading,
    treeId,
  ]);

  const expandPersonContinuation = useCallback(
    async (
      continuation: TreeContinuation,
    ): Promise<PersonContinuationExpansionResult> => {
      const token = continuation.token;
      const layerKey = familyTreeBranchKey(
        continuation.personId,
        continuation.direction,
      );
      if (continuation.expanded || activeBranchLayerKeysRef.current.has(layerKey)) {
        activeBranchLayerKeysRef.current.delete(layerKey);
        commitComposedGraph();
        return "collapsed";
      }
      if (branchLayersRef.current.has(layerKey)) {
        setCanceled(false);
        activeBranchLayerKeysRef.current.add(layerKey);
        commitComposedGraph();
        return "expanded";
      }
      if (isLocalContinuationToken(token) || activeBranchesRef.current.has(token)) {
        return "unchanged";
      }

      setCanceled(false);

      const branchMaxNodes = boundedBranchNodeLimit(
        graphRef.current.persons.length,
        maxNodes,
        MAX_RENDERED_FAMILY_TREE_NODES,
      );
      if (branchMaxNodes === 0) {
        setError(
          new Error(
            "Досягнуто межу 600 осіб у поточному перегляді. Зробіть потрібну особу фокусною, щоб продовжити її гілку.",
          ),
        );
        return "failed";
      }

      const epoch = requestEpochRef.current;
      const revision = ++branchRevisionRef.current;
      const controller = new AbortController();
      activeBranchesRef.current.set(token, {
        controller,
        epoch,
        revision,
        layerKey,
      });
      syncLoading();
      setError(undefined);

      try {
        const response: NeighborhoodResponse = await client.load(
          {
            treeId,
            focusPersonId,
            maxNodes: branchMaxNodes,
            ...(graphRef.current.graphVersion === undefined
              ? {}
              : { knownGraphVersion: graphRef.current.graphVersion }),
            ...(permissionFingerprint === undefined
              ? {}
              : { permissionFingerprint }),
            branches: [
              {
                requestId: `expand:${continuation.id}:${revision}`,
                personId: continuation.personId,
                directions: [continuation.direction],
                cursors: { [continuation.direction]: token },
              },
            ],
          },
          controller.signal,
        );
        const active = activeBranchesRef.current.get(token);
        if (
          controller.signal.aborted ||
          active?.revision !== revision ||
          active?.epoch !== epoch ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return "aborted";
        }

        const current = graphRef.current;
        if (
          graphVersionsConflict(current.graphVersion, response.graphVersion) ||
          permissionFingerprintsConflict(
            current.permissionFingerprint,
            response.permissionFingerprint,
          )
        ) {
          recoverFromScopeConflict();
          return "failed";
        }
        branchLayersRef.current.set(layerKey, {
          key: layerKey,
          personId: continuation.personId,
          direction: continuation.direction,
          consumedToken: token,
          response,
          ...(continuation.ownerBranchKey
            ? { parentKey: continuation.ownerBranchKey }
            : {}),
        });
        activeBranchLayerKeysRef.current.add(layerKey);
        commitComposedGraph();
        return "expanded";
      } catch (reason) {
        const active = activeBranchesRef.current.get(token);
        if (
          controller.signal.aborted ||
          active?.revision !== revision ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return "aborted";
        }
        if (isFamilyTreeScopeConflictError(reason)) {
          recoverFromScopeConflict();
          return "failed";
        }
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        return "failed";
      } finally {
        const active = activeBranchesRef.current.get(token);
        if (active?.revision === revision) activeBranchesRef.current.delete(token);
        syncLoading();
      }
    },
    [
      abortBranches,
      client,
      commit,
      commitComposedGraph,
      focusPersonId,
      maxNodes,
      permissionFingerprint,
      recoverFromScopeConflict,
      resetBranchLayers,
      scopeKey,
      syncLoading,
      treeId,
    ],
  );

  const expandContinuation = useCallback(
    async (
      token: string,
      node: LayoutNode,
    ): Promise<PersonContinuationExpansionResult> => {
      const continuation = node.continuation;
      if (!continuation || continuation.token !== token) return "unchanged";
      return expandPersonContinuation(continuation);
    },
    [expandPersonContinuation],
  );

  const expandFamilyContinuation = useCallback(
    async (
      continuation: FamilyContinuation,
      visiblePersonIds?: ReadonlySet<PersonId>,
    ): Promise<FamilyContinuationExpansionResult> => {
      const layerKey = familyTreeFamilyBranchKey(continuation.scope.id);
      if (
        continuation.expanded ||
        activeBranchLayerKeysRef.current.has(layerKey)
      ) {
        activeBranchLayerKeysRef.current.delete(layerKey);
        commitComposedGraph();
        return "collapsed";
      }
      if (branchLayersRef.current.has(layerKey)) {
        setCanceled(false);
        activeBranchLayerKeysRef.current.add(layerKey);
        commitComposedGraph();
        return "expanded";
      }
      if (
        isLocalContinuationToken(continuation.token) ||
        activeBranchesRef.current.has(layerKey)
      ) {
        return "unchanged";
      }

      setCanceled(false);

      const loadedPersonIds = visiblePersonIds ?? new Set(
        graphRef.current.persons.map(person => person.id),
      );
      const missingParentCount = continuation.scope.parentIds.filter(
        parentId => !loadedPersonIds.has(parentId),
      ).length;
      const branchMaxNodes = boundedFamilyBranchChildLimit(
        loadedPersonIds.size + missingParentCount,
        maxNodes,
        MAX_RENDERED_FAMILY_TREE_NODES,
      );
      if (branchMaxNodes === 0) {
        setError(
          new Error(
            "Досягнуто межу 600 осіб у поточному перегляді.",
          ),
        );
        return "failed";
      }

      const epoch = requestEpochRef.current;
      const revision = ++branchRevisionRef.current;
      const controller = new AbortController();
      activeBranchesRef.current.set(layerKey, {
        controller,
        epoch,
        revision,
        layerKey,
      });
      syncLoading();
      setError(undefined);

      try {
        const commonRequest = {
          treeId,
          focusPersonId,
          scope: continuation.scope,
          cursor: continuation.token,
          pageSize: branchMaxNodes,
          ...(graphRef.current.graphVersion === undefined
            ? {}
            : { knownGraphVersion: graphRef.current.graphVersion }),
          ...(permissionFingerprint === undefined
            ? {}
            : { permissionFingerprint }),
        };
        let response: FamilyBranchResponse | NeighborhoodResponse;
        if (client.loadFamilyBranch) {
          response = await loadBoundedFamilyBranchPages(
            (request, signal) => client.loadFamilyBranch!(request, signal),
            commonRequest,
            loadedPersonIds,
            branchMaxNodes,
            controller.signal,
          );
        } else {
          response = await client.load(
            {
              treeId,
              focusPersonId,
              maxNodes: branchMaxNodes,
              ...(graphRef.current.graphVersion === undefined
                ? {}
                : { knownGraphVersion: graphRef.current.graphVersion }),
              ...(permissionFingerprint === undefined
                ? {}
                : { permissionFingerprint }),
              familyBranches: [
                {
                  requestId: `family:${continuation.id}:${revision}`,
                  scope: continuation.scope,
                  cursor: continuation.token,
                  pageSize: branchMaxNodes,
                },
              ],
            },
            controller.signal,
          );
        }
        const active = activeBranchesRef.current.get(layerKey);
        if (
          controller.signal.aborted ||
          active?.revision !== revision ||
          active?.epoch !== epoch ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return "aborted";
        }

        const current = graphRef.current;
        if (
          graphVersionsConflict(current.graphVersion, response.graphVersion) ||
          permissionFingerprintsConflict(
            current.permissionFingerprint,
            response.permissionFingerprint,
          )
        ) {
          recoverFromScopeConflict();
          return "failed";
        }

        branchLayersRef.current.set(layerKey, {
          scopeKind: "family",
          key: layerKey,
          scope: continuation.scope,
          consumedToken: continuation.token,
          response,
          ...(continuation.ownerBranchKey
            ? { parentKey: continuation.ownerBranchKey }
            : {}),
        });
        activeBranchLayerKeysRef.current.add(layerKey);
        commitComposedGraph();
        return "expanded";
      } catch (reason) {
        const active = activeBranchesRef.current.get(layerKey);
        if (
          controller.signal.aborted ||
          active?.revision !== revision ||
          epoch !== requestEpochRef.current ||
          graphScopeRef.current !== scopeKey
        ) {
          return "aborted";
        }
        if (isFamilyTreeScopeConflictError(reason)) {
          recoverFromScopeConflict();
          return "failed";
        }
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        return "failed";
      } finally {
        const active = activeBranchesRef.current.get(layerKey);
        if (active?.revision === revision) {
          activeBranchesRef.current.delete(layerKey);
        }
        syncLoading();
      }
    },
    [
      abortBranches,
      client,
      commit,
      commitComposedGraph,
      focusPersonId,
      maxNodes,
      permissionFingerprint,
      recoverFromScopeConflict,
      resetBranchLayers,
      scopeKey,
      syncLoading,
      treeId,
    ],
  );

  useEffect(() => {
    if (!enabled || !defaultVisibleFamilyPersonId || baseLoadRevision === 0) {
      return;
    }
    let stopped = false;
    const epoch = requestEpochRef.current;
    const attemptedPersonContinuationIds = new Set<string>();
    const attemptedFamilyScopeIds = new Set<string>();

    void (async () => {
      while (
        !stopped &&
        epoch === requestEpochRef.current &&
        graphScopeRef.current === scopeKey
      ) {
        const next = nextDefaultBranchExpansion({
          graph: graphRef.current,
          focusPersonId: defaultVisibleFamilyPersonId,
          includeCousinDescendants: includeCousinDescendantsByDefault,
          attemptedPersonContinuationIds,
          attemptedFamilyScopeIds,
        });
        if (!next) {
          scopeConflictRecoveryRef.current.automaticReloadUsed = false;
          return;
        }
        let result: FamilyContinuationExpansionResult;
        if (next.kind === "person") {
          attemptedPersonContinuationIds.add(next.continuation.id);
          result = await expandPersonContinuation(next.continuation);
        } else {
          attemptedFamilyScopeIds.add(next.continuation.scope.id);
          result = await expandFamilyContinuation(next.continuation);
        }
        if (result === "failed" || result === "aborted") return;
      }
    })();

    return () => {
      stopped = true;
    };
  }, [
    baseLoadRevision,
    defaultVisibleFamilyPersonId,
    enabled,
    expandFamilyContinuation,
    expandPersonContinuation,
    includeCousinDescendantsByDefault,
    scopeKey,
  ]);

  const togglePersonBranches = useCallback((personId: PersonId): void => {
    const keys = [...branchLayersRef.current.values()]
      .filter(isFamilyTreePersonBranchLayer)
      .filter(layer => layer.personId === personId)
      .map(layer => layer.key);
    if (!keys.length) return;
    const activeKeys = keys.filter(key => activeBranchLayerKeysRef.current.has(key));
    if (activeKeys.length) {
      restoreBranchLayerKeysRef.current.set(personId, new Set(activeKeys));
      for (const key of keys) activeBranchLayerKeysRef.current.delete(key);
    } else {
      setCanceled(false);
      const restoreKeys = restoreBranchLayerKeysRef.current.get(personId) ?? new Set(keys);
      for (const key of restoreKeys) {
        if (branchLayersRef.current.has(key)) activeBranchLayerKeysRef.current.add(key);
      }
    }
    commitComposedGraph();
  }, [commitComposedGraph]);

  const collapseFamilyScope = useCallback((scopeId: string): void => {
    const key = familyTreeFamilyBranchKey(scopeId);
    if (!activeBranchLayerKeysRef.current.delete(key)) return;
    commitComposedGraph();
  }, [commitComposedGraph]);

  const toggleFamilyScope = useCallback((scopeId: string): void => {
    const key = familyTreeFamilyBranchKey(scopeId);
    if (!branchLayersRef.current.has(key)) return;
    if (activeBranchLayerKeysRef.current.has(key)) {
      activeBranchLayerKeysRef.current.delete(key);
    } else {
      setCanceled(false);
      activeBranchLayerKeysRef.current.add(key);
    }
    commitComposedGraph();
  }, [commitComposedGraph]);

  const captureBranchVisibility = useCallback(
    (): FamilyTreeBranchVisibilitySnapshot => ({
      scopeKey: graphScopeRef.current,
      branchRevision: branchRevisionRef.current,
      ...(graphRef.current.graphVersion === undefined
        ? {}
        : { graphVersion: graphRef.current.graphVersion }),
      ...(graphRef.current.permissionFingerprint === undefined
        ? {}
        : { permissionFingerprint: graphRef.current.permissionFingerprint }),
      layerKeys: [...branchLayersRef.current.keys()].sort(),
      pendingLayerKeys: [...activeBranchesRef.current.values()]
        .map(request => request.layerKey)
        .sort(),
      activeLayerKeys: [...activeBranchLayerKeysRef.current].sort(),
      restorePersonLayerKeys: [...restoreBranchLayerKeysRef.current]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([personId, keys]) => [personId, [...keys].sort()] as const),
    }),
    [],
  );

  const restoreBranchVisibility = useCallback((
    snapshot: FamilyTreeBranchVisibilitySnapshot,
  ): FamilyTreeBranchRestoreResult => {
    if (snapshot.scopeKey !== graphScopeRef.current) return "stale-scope";
    if (
      graphVersionsConflict(snapshot.graphVersion, graphRef.current.graphVersion)
    ) {
      return "stale-version";
    }
    if (
      permissionFingerprintsConflict(
        snapshot.permissionFingerprint,
        graphRef.current.permissionFingerprint,
      )
    ) {
      return "stale-permission";
    }

    // Abort every in-flight expansion started in the temporary perspective.
    // A response that resolves after the user has returned must never reopen
    // a branch in the restored pedigree. Requests that were already pending
    // before entry remain valid and may finish normally.
    for (const [key, request] of activeBranchesRef.current) {
      if (request.revision <= snapshot.branchRevision) continue;
      request.controller.abort();
      activeBranchesRef.current.delete(key);
    }
    const retainedLayerKeys = new Set([
      ...snapshot.layerKeys,
      ...snapshot.pendingLayerKeys,
    ]);
    for (const key of branchLayersRef.current.keys()) {
      if (!retainedLayerKeys.has(key)) branchLayersRef.current.delete(key);
    }
    activeBranchLayerKeysRef.current.clear();
    for (const key of snapshot.activeLayerKeys) {
      if (branchLayersRef.current.has(key)) {
        activeBranchLayerKeysRef.current.add(key);
      }
    }
    for (const key of snapshot.pendingLayerKeys) {
      if (branchLayersRef.current.has(key)) {
        activeBranchLayerKeysRef.current.add(key);
      }
    }
    restoreBranchLayerKeysRef.current.clear();
    for (const [personId, keys] of snapshot.restorePersonLayerKeys) {
      const available = keys.filter(key => branchLayersRef.current.has(key));
      if (available.length) {
        restoreBranchLayerKeysRef.current.set(personId, new Set(available));
      }
    }
    commitComposedGraph();
    syncLoading();
    return "restored";
  }, [commitComposedGraph, syncLoading]);

  const reload = useCallback((): void => {
    requestEpochRef.current += 1;
    const baseController = baseControllerRef.current;
    baseControllerRef.current = undefined;
    baseController?.abort();
    abortBranches();
    client.invalidateTree?.(treeId);
    forceFreshBaseRef.current = true;
    baseGraphRef.current = EMPTY_GRAPH;
    graphRef.current = EMPTY_GRAPH;
    resetBranchLayers();
    commit(EMPTY_GRAPH);
    scopeConflictRecoveryRef.current = {
      scopeKey,
      automaticReloadUsed: false,
    };
    baseLoadingRef.current = true;
    setCanceled(false);
    setError(undefined);
    syncLoading();
    setReloadKey(value => value + 1);
  }, [
    abortBranches,
    client,
    commit,
    resetBranchLayers,
    scopeKey,
    syncLoading,
    treeId,
  ]);
  const scopeIsCurrent = graphScopeRef.current === scopeKey;
  const branchTogglePersonIds = branchLayerPersonIds(branchLayersRef.current);
  const collapsedBranchPersonIds = collapsedBranchLayerPersonIds(
    branchLayersRef.current,
    activeBranchLayerKeysRef.current,
  );
  const familyBranchToggleScopeIds = familyBranchLayerScopeIds(
    branchLayersRef.current,
  );
  const activeFamilyScopeIds = activeFamilyBranchLayerScopeIds(
    branchLayersRef.current,
    activeBranchLayerKeysRef.current,
  );
  const collapsedFamilyScopeIds = collapsedFamilyBranchLayerScopeIds(
    branchLayersRef.current,
    activeBranchLayerKeysRef.current,
  );
  return {
    graph: scopeIsCurrent ? graph : EMPTY_GRAPH,
    loading: enabled ? (scopeIsCurrent ? loading : true) : false,
    error: enabled && scopeIsCurrent ? error : undefined,
    canceled,
    cancel,
    expandPersonContinuation,
    expandContinuation,
    expandFamilyContinuation,
    branchTogglePersonIds,
    collapsedBranchPersonIds,
    togglePersonBranches,
    familyBranchToggleScopeIds,
    activeFamilyScopeIds,
    collapsedFamilyScopeIds,
    collapseFamilyScope,
    toggleFamilyScope,
    captureBranchVisibility,
    restoreBranchVisibility,
    reload,
  };
}
