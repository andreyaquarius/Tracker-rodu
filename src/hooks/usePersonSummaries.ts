import { useEffect, useMemo, useState } from "react";
import { loadProjectPersonSummaries, type ProjectPersonSummary } from "../services/projectPersonSummaries.ts";
import { onSupabaseAuthChange } from "../services/supabaseAuth";
import { createPersonSummaryCache } from "../utils/personSummaryCache.ts";

export function usePersonSummaries(projectId: string | undefined, scopeKey: string, revisions: ReadonlyMap<string, string>) {
  const cache = useMemo(() => createPersonSummaryCache(), []);
  const [authRevision, setAuthRevision] = useState(0);
  const scope = JSON.stringify([projectId, scopeKey, authRevision]);
  const requestKey = JSON.stringify([scope, [...revisions].sort(([a], [b]) => a.localeCompare(b))]);
  const [loaded, setLoaded] = useState<{ key: string; value: Map<string, ProjectPersonSummary> }>();
  useEffect(() => {
    if (!projectId) return;
    const subscription = onSupabaseAuthChange(() => {
      cache.clear();
      setAuthRevision((value) => value + 1);
    });
    return () => subscription?.unsubscribe();
  }, [cache, projectId]);
  useEffect(() => {
    if (!projectId || !revisions.size) return;
    const controller = new AbortController();
    // Coalesce a save's related collection updates and rapid page/filter changes.
    const timer = window.setTimeout(() => {
      void cache.load(scope, revisions, (ids, signal) => loadProjectPersonSummaries(projectId, ids, signal), controller.signal)
        .then((value) => { if (!controller.signal.aborted) setLoaded({ key: requestKey, value }); })
        .catch(() => { /* Keep the existing local-counter fallback during rollout/offline use. */ });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // Content-addressed revisions deliberately ignore new array/Map identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, projectId, requestKey]);
  return loaded?.key === requestKey ? loaded.value : null;
}
