import { useCallback, useEffect, useRef, useState } from "react";
import type { FamilyTreeGraphDto, FamilyTreeGraphQuery } from "../types/familyTree";
import { getFamilyTreeGraph } from "../services/familyTreeGraphService.ts";

const GRAPH_CACHE_LIMIT = 12;
const graphCache = new Map<string, FamilyTreeGraphDto>();

export function useFamilyTreeGraph(query: FamilyTreeGraphQuery | null) {
  const queryKey = query ? familyTreeGraphQueryKey(query) : "";
  const [data, setData] = useState<FamilyTreeGraphDto | null>(() =>
    queryKey ? graphCache.get(queryKey) ?? null : null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);
  const activeKeyRef = useRef(queryKey);

  const load = useCallback(async (force = false) => {
    if (!query) {
      setData(null);
      setError("");
      setIsLoading(false);
      activeKeyRef.current = "";
      return;
    }

    const currentKey = familyTreeGraphQueryKey(query);
    activeKeyRef.current = currentKey;
    const cached = graphCache.get(currentKey) ?? null;
    if (cached && !force) {
      setData(cached);
      setError("");
      setIsLoading(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(!cached);
    setError("");
    try {
      const result = await getFamilyTreeGraph(query);
      if (requestIdRef.current !== requestId) return;
      rememberFamilyTreeGraph(currentKey, result);
      setData(result);
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return;
      if (!cached) setData(null);
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити родове дерево.");
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (queryKey && activeKeyRef.current !== queryKey) {
      setData(graphCache.get(queryKey) ?? null);
      setError("");
      setIsLoading(false);
    }
    void load(false);
  }, [load, queryKey]);

  return {
    data,
    isLoading,
    error,
    refetch: () => load(true),
  };
}

export function familyTreeGraphQueryKey(query: FamilyTreeGraphQuery): string {
  return JSON.stringify({
    projectId: query.projectId,
    treeId: query.treeId ?? "",
    rootPersonId: query.rootPersonId ?? "",
    mode: query.mode,
    maxDepth: query.maxDepth ?? null,
    unlimitedDepth: Boolean(query.unlimitedDepth),
    maxDepthUp: query.maxDepthUp ?? null,
    maxDepthDown: query.maxDepthDown ?? null,
    includeAssociations: Boolean(query.includeAssociations),
    includeDisproven: Boolean(query.includeDisproven),
    includePrivateLiving: Boolean(query.includePrivateLiving),
    problemsMode: Boolean(query.problemsMode),
  });
}

function rememberFamilyTreeGraph(key: string, graph: FamilyTreeGraphDto): void {
  if (!key) return;
  if (graphCache.has(key)) graphCache.delete(key);
  graphCache.set(key, graph);
  while (graphCache.size > GRAPH_CACHE_LIMIT) {
    const oldestKey = graphCache.keys().next().value;
    if (!oldestKey) break;
    graphCache.delete(oldestKey);
  }
}
