import type { ProjectPersonSummary } from "../services/projectPersonSummaries.ts";

/** Component-owned cache: no persisted personal data or cross-account reuse. */
export function createPersonSummaryCache(now: () => number = Date.now) {
  const entries = new Map<string, { revision: string; expires: number; value?: ProjectPersonSummary }>();
  let scope = "";
  let epoch = 0;
  return {
    clear() { entries.clear(); epoch += 1; },
    async load(
      nextScope: string,
      revisions: ReadonlyMap<string, string>,
      load: (ids: string[], signal: AbortSignal) => Promise<Map<string, ProjectPersonSummary>>,
      signal: AbortSignal,
    ): Promise<Map<string, ProjectPersonSummary>> {
      if (scope !== nextScope) { scope = nextScope; entries.clear(); epoch += 1; }
      const requestEpoch = epoch;
      const result = new Map<string, ProjectPersonSummary>();
      const missing: string[] = [];
      for (const [id, revision] of revisions) {
        const entry = entries.get(id);
        if (entry && entry.expires > now() && entry.revision === revision) {
          if (entry.value) result.set(id, entry.value);
        } else missing.push(id);
      }
      for (let offset = 0; offset < missing.length; offset += 200) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const ids = missing.slice(offset, offset + 200);
        const values = await load(ids, signal);
        if (signal.aborted || epoch !== requestEpoch) throw new DOMException("Aborted", "AbortError");
        for (const id of ids) {
          const value = values.get(id);
          entries.delete(id);
          entries.set(id, { value, revision: revisions.get(id)!, expires: now() + 30_000 });
          if (value) result.set(id, value);
        }
        while (entries.size > 1_000) entries.delete(entries.keys().next().value!);
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return result;
    },
  };
}
