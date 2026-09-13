type BrowserState = {
  network: "online" | "offline" | "unknown";
  visibility: "visible" | "hidden" | "unknown";
};

// Shared by the collector and the final Sentry privacy boundary. No free text.
export const SUPABASE_DIAGNOSTIC_TAG_PATTERNS = {
  failure_kind: /^(transport|http)$/,
  original_error_type: /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AbortError|TimeoutError|NetworkError|SecurityError|unknown)$/,
  network_start: /^(online|offline|unknown)$/,
  network_end: /^(online|offline|unknown)$/,
  visibility_start: /^(visible|hidden|unknown)$/,
  visibility_end: /^(visible|hidden|unknown)$/,
  pagehide_observed: /^(yes|no|unknown)$/,
  request_duration: /^(lt_100ms|100ms_1s|1s_5s|5s_30s|gte_30s|unknown)$/,
};

export const MAX_REQUEST_DURATION_MS = 86_400_000;

export interface SupabaseRequestDiagnostics {
  tags: Partial<Record<keyof typeof SUPABASE_DIAGNOSTIC_TAG_PATTERNS, string>>;
  durationMs?: number;
}

export type FinishSupabaseRequestDiagnostics = (
  kind: "transport" | "http", error?: unknown,
) => SupabaseRequestDiagnostics;

function safely<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

export function requestErrorType(error: unknown): string {
  return safely(() => {
    const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
    return typeof name === "string" && SUPABASE_DIAGNOSTIC_TAG_PATTERNS.original_error_type.test(name)
      ? name : "unknown";
  }, "unknown");
}

function browserState(): BrowserState {
  return {
    network: safely(() => typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
      ? "unknown" : navigator.onLine ? "online" : "offline", "unknown"),
    visibility: safely(() => typeof document !== "undefined"
      && (document.visibilityState === "visible" || document.visibilityState === "hidden")
      ? document.visibilityState : "unknown", "unknown"),
  };
}

/** Only in-memory lifecycle flags and monotonic elapsed time; no event history or IDs. */
export function createSupabaseRequestDiagnostics(options: {
  target?: EventTarget;
  readState?: () => BrowserState;
  now?: () => number;
} = {}) {
  const target = options.target ?? (typeof window === "undefined" ? undefined : window);
  const readState = options.readState ?? browserState;
  const now = options.now ?? (() => performance.now());
  let initialized = false;
  let pageHidden = false;
  let pagehideCount = 0;
  const onPageHide = () => { pageHidden = true; pagehideCount += 1; };
  const onPageShow = () => { pageHidden = false; };
  return {
    initialize(): void {
      if (initialized || !target) return;
      // Capture runs before analytics' ordinary pagehide listener starts a flush.
      try {
        target.addEventListener("pagehide", onPageHide, true);
        target.addEventListener("pageshow", onPageShow, true);
        initialized = true;
      } catch {
        safely(() => target.removeEventListener("pagehide", onPageHide, true), undefined);
        safely(() => target.removeEventListener("pageshow", onPageShow, true), undefined);
      }
    },
    begin(): FinishSupabaseRequestDiagnostics {
      const start = safely(readState, { network: "unknown", visibility: "unknown" } as BrowserState);
      const startedAt = safely(now, NaN);
      const startedHidden = pageHidden;
      const startingPagehideCount = pagehideCount;
      return (kind, error) => {
        const end = safely(readState, { network: "unknown", visibility: "unknown" } as BrowserState);
        const elapsed = safely(now, NaN) - startedAt;
        const durationMs = Number.isFinite(elapsed) && elapsed >= 0
          ? Math.min(MAX_REQUEST_DURATION_MS, Math.round(elapsed)) : undefined;
        return {
          tags: {
            failure_kind: kind,
            ...(kind === "transport" ? { original_error_type: requestErrorType(error) } : {}),
            network_start: start.network,
            network_end: end.network,
            visibility_start: start.visibility,
            visibility_end: end.visibility,
            pagehide_observed: !initialized ? "unknown"
              : startedHidden || pageHidden || pagehideCount !== startingPagehideCount ? "yes" : "no",
            request_duration: durationMs === undefined ? "unknown"
              : durationMs < 100 ? "lt_100ms" : durationMs < 1_000 ? "100ms_1s"
                : durationMs < 5_000 ? "1s_5s" : durationMs < 30_000 ? "5s_30s" : "gte_30s",
          },
          ...(durationMs === undefined ? {} : { durationMs }),
        };
      };
    },
  };
}

export const supabaseRequestDiagnostics = createSupabaseRequestDiagnostics();
