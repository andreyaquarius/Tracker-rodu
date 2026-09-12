export interface SupabaseFailure {
  operation: string;
  status: number;
  code?: string;
  method: string;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const timeout = setTimeout(() => { void reader.cancel().catch(() => {}); }, 1500);
  try {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const code = JSON.parse(text).code;
    return typeof code === "string" && /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
}

/** Observe only technical REST/RPC/Edge failures, without delaying/retrying requests. */
export function createMonitoredSupabaseFetch(
  fetcher: typeof fetch,
  supabaseUrl: string,
  report: (failure: SupabaseFailure) => void,
  enabled: () => boolean,
): typeof fetch {
  const shouldObserve = () => { try { return enabled(); } catch { return false; } };
  return async (input, init) => {
    if (!shouldObserve()) return fetcher(input, init);
    let operation = "";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const base = new URL(supabaseUrl);
      // Auth failures (bad password etc.) and Storage paths containing filenames
      // are intentionally not collected. Never inspect request bodies or headers.
      const match = /^\/(rest\/v1\/(?:rpc\/)?|functions\/v1\/)([a-z][a-z0-9_-]{0,95})$/.exec(url.pathname);
      if (url.origin === base.origin && match && /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) {
        operation = match[1].includes("rpc/") ? `rpc:${match[2]}`
          : match[1].startsWith("functions") ? `edge:${match[2]}` : `table:${match[2]}`;
      }
    } catch { /* Invalid URLs remain the underlying fetcher's responsibility. */ }
    const emit = (failure: SupabaseFailure) => {
      try { if (shouldObserve()) report(failure); } catch { /* Fail open. */ }
    };
    let response: Response;
    try {
      response = await fetcher(input, init);
    } catch (error) {
      if (operation && !(error && typeof error === "object" && "name" in error && error.name === "AbortError")) {
        emit({ operation, method, status: 0 });
      }
      throw error;
    }
    if (operation && shouldObserve() && response.status >= 400) {
      // Only an allowlisted code escapes the bounded clone reader. The caller
      // receives the original Response immediately and can still consume it.
      void errorCode(response).then(
        code => emit({ operation, method, status: response.status, code }),
        () => emit({ operation, method, status: response.status }),
      );
    }
    return response;
  };
}
