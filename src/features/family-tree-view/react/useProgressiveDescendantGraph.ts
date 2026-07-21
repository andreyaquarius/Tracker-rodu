"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadProgressiveDescendantGraph,
  type ProgressiveDescendantState,
} from "../data/progressiveDescendantLoader.ts";
import type { FamilyTreeNeighborhoodClient } from "../data/neighborhoodClient.ts";
import type { FamilyGraphData, PersonId } from "../types.ts";

const EMPTY_GRAPH: FamilyGraphData = {
  persons: [],
  unions: [],
  parentChildRelations: [],
  continuations: [],
};

export interface UseProgressiveDescendantGraphInput {
  client: FamilyTreeNeighborhoodClient;
  treeId: string;
  rootPersonId: PersonId;
  enabled?: boolean;
  sessionKey?: string;
  maxGenerations?: number;
  pageSize?: number;
  initialGraph?: FamilyGraphData;
  knownGraphVersion?: string | number;
  permissionFingerprint?: string;
}

export interface UseProgressiveDescendantGraphResult
  extends ProgressiveDescendantState {
  cancel: () => void;
  reload: () => void;
}

export function useProgressiveDescendantGraph({
  client,
  treeId,
  rootPersonId,
  enabled = true,
  sessionKey = "default",
  maxGenerations = 100,
  pageSize = 100,
  initialGraph = EMPTY_GRAPH,
  knownGraphVersion,
  permissionFingerprint,
}: UseProgressiveDescendantGraphInput): UseProgressiveDescendantGraphResult {
  const scopeKey = [
    treeId,
    rootPersonId,
    sessionKey,
    maxGenerations,
    pageSize,
    knownGraphVersion ?? "",
    permissionFingerprint ?? "",
  ].join("\u001f");
  const initialState = stateForGraph(initialGraph, false);
  const [state, setState] = useState<ProgressiveDescendantState>(initialState);
  const stateRef = useRef(state);
  const scopeRef = useRef(scopeKey);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const runRef = useRef(0);
  const forceFreshReloadRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  const commit = useCallback((next: ProgressiveDescendantState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled || !treeId || !rootPersonId) {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      const idle = { ...stateRef.current, loading: false };
      commit(idle);
      return undefined;
    }

    const scopeChanged = scopeRef.current !== scopeKey;
    scopeRef.current = scopeKey;
    const forceFreshReload = forceFreshReloadRef.current;
    forceFreshReloadRef.current = false;
    const seedGraph = forceFreshReload
      ? freshDescendantSeed(initialGraph, rootPersonId)
      : (scopeChanged ? initialGraph : stateRef.current.graph);
    const startingState = stateForGraph(seedGraph, true);
    commit(startingState);

    const run = ++runRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;

    void loadProgressiveDescendantGraph({
      client,
      treeId,
      rootPersonId,
      maxGenerations,
      pageSize,
      initialGraph: seedGraph,
      ...(
        forceFreshReload || knownGraphVersion === undefined
          ? {}
          : { knownGraphVersion }
      ),
      ...(forceFreshReload || permissionFingerprint === undefined
        ? {}
        : { permissionFingerprint }),
      signal: controller.signal,
      onProgress: progress => {
        if (run !== runRef.current || controller.signal.aborted) return;
        commit(progress);
      },
    })
      .then(result => {
        if (run !== runRef.current) return;
        if (controllerRef.current === controller) {
          controllerRef.current = undefined;
        }
        commit(result);
      })
      .catch(reason => {
        if (run !== runRef.current || controller.signal.aborted) return;
        if (controllerRef.current === controller) {
          controllerRef.current = undefined;
        }
        const error = reason instanceof Error
          ? reason
          : new Error(String(reason));
        commit({
          ...stateRef.current,
          loading: false,
          canceled: false,
          error,
        });
      });

    return () => {
      controller.abort();
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
    };
  }, [
    client,
    commit,
    enabled,
    initialGraph,
    knownGraphVersion,
    maxGenerations,
    pageSize,
    permissionFingerprint,
    reloadKey,
    rootPersonId,
    scopeKey,
    treeId,
  ]);

  const cancel = useCallback((): void => {
    runRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    commit({
      ...stateRef.current,
      loading: false,
      canceled: true,
      error: undefined,
    });
  }, [commit]);

  const reload = useCallback((): void => {
    forceFreshReloadRef.current = true;
    client.invalidateTree?.(treeId);
    commit({
      ...stateRef.current,
      loading: true,
      canceled: false,
      error: undefined,
      loadedGenerations: 0,
      pagesLoaded: 0,
    });
    setReloadKey(value => value + 1);
  }, [client, commit, treeId]);

  return { ...state, cancel, reload };
}

function freshDescendantSeed(
  graph: FamilyGraphData,
  rootPersonId: PersonId,
): FamilyGraphData {
  return {
    persons: graph.persons.filter(person => person.id === rootPersonId),
    unions: [],
    parentChildRelations: [],
    continuations: [],
  };
}

function stateForGraph(
  graph: FamilyGraphData,
  loading: boolean,
): ProgressiveDescendantState {
  return {
    graph,
    loading,
    canceled: false,
    error: undefined,
    loadedPersons: graph.persons.length,
    loadedGenerations: 0,
    pagesLoaded: 0,
  };
}
