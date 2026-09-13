import { requestErrorType } from "./supabaseRequestDiagnostics.ts";

// Audited RPCs: three STABLE reads and dashboard counters with an idempotent cache upsert.
// Keep POST: get_dashboard_stats is VOLATILE and cannot run in a GET read-only transaction.
const RETRYABLE_RPCS = new Set([
  "get_dashboard_stats", "get_my_subscription_context",
  "get_feedback_unread_count", "list_my_genehelp_notifications",
]);
const RETRY_DELAYS_MS = [300, 900];

function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Retry only replayable, audited reads. GETs already have retries in PostgREST. */
export function createRetryingSupabaseReadFetch(
  fetcher: typeof fetch,
  supabaseUrl: string,
  wait = waitForRetry,
): typeof fetch {
  return async (input, init) => {
    let retryable = false;
    try {
      // SDK RPCs use a string URL and serialized JSON. Never replay Request streams.
      if (!(input instanceof Request) && init?.method?.toUpperCase() === "POST"
        && (init.body === undefined || typeof init.body === "string")) {
        const url = new URL(String(input));
        const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
        retryable = url.origin === new URL(supabaseUrl).origin && Boolean(match && RETRYABLE_RPCS.has(match[1]));
      }
    } catch { /* Let fetch handle invalid URLs. */ }
    for (let attempt = 0; ; attempt += 1) {
      init?.signal?.throwIfAborted();
      try {
        return await fetcher(input, init);
      } catch (error) {
        if (!retryable || attempt >= RETRY_DELAYS_MS.length || init?.signal?.aborted
          || !["TypeError", "NetworkError"].includes(requestErrorType(error))) throw error;
        await wait(RETRY_DELAYS_MS[attempt], init?.signal);
      }
    }
  };
}
