const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface BoundedFetchRetryOptions {
  /** Total number of attempts, including the first one. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Test seam; production callers use an abort-aware timer. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam for bounded jitter. */
  random?: () => number;
}

/**
 * Retries only idempotent HTTP requests and only for transient failures.
 * Response bodies are cancelled before a retry so a failed range request does
 * not keep consuming bandwidth in the background.
 */
export async function fetchWithBoundedRetry(
  fetchImplementation: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: BoundedFetchRetryOptions = {},
): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : "GET"))
    .trim()
    .toLocaleUpperCase("en-US");
  if (!RETRYABLE_METHODS.has(method)) {
    return fetchImplementation(input, init);
  }

  const maxAttempts = boundedInteger(options.maxAttempts, 3, 1, 5);
  const baseDelayMs = boundedInteger(options.baseDelayMs, 180, 0, 10_000);
  const maxDelayMs = boundedInteger(options.maxDelayMs, 1_500, baseDelayMs, 30_000);
  const signal = options.signal ?? init.signal ?? undefined;
  const sleep = options.sleep ?? abortableDelay;
  const random = options.random ?? Math.random;

  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchImplementation(input, {
        ...init,
        ...(signal ? { signal } : {}),
      });
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      const delayMs = retryDelay(response, attempt, baseDelayMs, maxDelayMs, random);
      await response.body?.cancel("retry-transient-http-response").catch(() => undefined);
      await sleep(delayMs, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      lastNetworkError = error;
      if (attempt === maxAttempts) throw error;
      await sleep(exponentialDelay(attempt, baseDelayMs, maxDelayMs, random), signal);
    }
  }

  throw lastNetworkError ?? new TypeError("Network request failed");
}

function retryDelay(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxDelayMs, Math.round(seconds * 1_000));
  }
  const retryAt = Date.parse(retryAfter);
  if (retryAfter && Number.isFinite(retryAt)) {
    return Math.min(maxDelayMs, Math.max(0, retryAt - Date.now()));
  }
  return exponentialDelay(attempt, baseDelayMs, maxDelayMs, random);
}

function exponentialDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const boundedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.min(maxDelayMs, Math.round(exponential * (0.85 + boundedRandom * 0.3)));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum
    ? value!
    : fallback;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
