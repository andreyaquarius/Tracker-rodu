export const ZAGULYAKA_VERSION_CONFLICT = "ZAGULYAKA_VERSION_CONFLICT";
export const ZAGULYAKA_VERSION_CONFLICT_SQLSTATE = "40001";

export type ZagulyakaMutationScope = "author" | "admin";

export interface ZagulyakaVersionedMutation {
  scope: ZagulyakaMutationScope;
  /**
   * A merge affects two records. Every listed record is guarded so a stale
   * version for either one cannot produce a local retry storm.
   */
  recordIds: readonly string[];
  /** A stable service-level operation, rather than a UI button label. */
  action: string;
}

/**
 * Returned locally after the database has already rejected the same stale
 * mutation. A successful fresh record read is required before trying again.
 */
export class ZagulyakaVersionConflictCircuitOpenError extends Error {
  readonly code = "ZAGULYAKA_VERSION_CONFLICT_CIRCUIT_OPEN";
  readonly scope: ZagulyakaMutationScope;
  readonly recordIds: readonly string[];
  readonly action: string;

  constructor(mutation: ZagulyakaVersionedMutation) {
    super(`${ZAGULYAKA_VERSION_CONFLICT}: reload the record before retrying this action.`);
    this.name = "ZagulyakaVersionConflictCircuitOpenError";
    this.scope = mutation.scope;
    this.recordIds = normalizedRecordIds(mutation.recordIds);
    this.action = normalizedAction(mutation.action);
  }
}

export interface ZagulyakaMutationCircuitBreaker {
  run<T>(
    mutation: ZagulyakaVersionedMutation,
    invoke: () => Promise<T>,
  ): Promise<T>;
  /**
   * A read that includes the current lock version is the rebase boundary for
   * all local mutation actions on that record in this scope.
   */
  markRecordFresh(scope: ZagulyakaMutationScope, recordId: string): void;
}

/**
 * Recognises both the application error marker and the PostgreSQL SQLSTATE
 * carried by Supabase/PostgREST errors. This intentionally does not turn the
 * error into a retry: a stale optimistic lock must be rebased by a read.
 */
export function isZagulyakaVersionConflict(error: unknown): boolean {
  return hasVersionConflictMarker(error, new Set<unknown>());
}

/**
 * Keeps a rejected optimistic-lock mutation from being sent to PostgreSQL
 * again until the caller has loaded a fresh record. Equal in-flight requests
 * share one promise, which also covers duplicate click handlers before the
 * first request resolves.
 */
export function createZagulyakaMutationCircuitBreaker(): ZagulyakaMutationCircuitBreaker {
  const blockedActions = new Map<string, Set<string>>();
  const recordFreshness = new Map<string, number>();
  const inFlight = new Map<string, Promise<unknown>>();

  const markRecordFresh = (scope: ZagulyakaMutationScope, recordId: string): void => {
    const key = recordKey(scope, recordId);
    if (!key) return;
    blockedActions.delete(key);
    recordFreshness.set(key, (recordFreshness.get(key) ?? 0) + 1);
  };

  const run = <T>(
    mutation: ZagulyakaVersionedMutation,
    invoke: () => Promise<T>,
  ): Promise<T> => {
    const recordIds = normalizedRecordIds(mutation.recordIds);
    const action = normalizedAction(mutation.action);
    const normalizedMutation: ZagulyakaVersionedMutation = {
      scope: mutation.scope,
      recordIds,
      action,
    };
    if (!recordIds.length) return Promise.resolve().then(invoke);

    const keys = recordIds.map((recordId) => recordKey(mutation.scope, recordId));
    if (keys.some((key) => blockedActions.get(key)?.has(action))) {
      return Promise.reject(new ZagulyakaVersionConflictCircuitOpenError(normalizedMutation));
    }

    const flightKey = [mutation.scope, action, ...recordIds].join("\u001f");
    const existing = inFlight.get(flightKey) as Promise<T> | undefined;
    if (existing) return existing;

    const freshnessAtStart = new Map(keys.map((key) => [key, recordFreshness.get(key) ?? 0]));
    let request: Promise<T>;
    request = Promise.resolve()
      .then(invoke)
      .catch((error: unknown) => {
        if (isZagulyakaVersionConflict(error)) {
          // A response from a request that started before a successful reload
          // must not re-open the circuit after that reload has supplied a new
          // lock version to the UI.
          for (const key of keys) {
            if ((recordFreshness.get(key) ?? 0) !== freshnessAtStart.get(key)) continue;
            let actions = blockedActions.get(key);
            if (!actions) {
              actions = new Set<string>();
              blockedActions.set(key, actions);
            }
            actions.add(action);
          }
        }
        throw error;
      })
      .finally(() => {
        if (inFlight.get(flightKey) === request) inFlight.delete(flightKey);
      });
    inFlight.set(flightKey, request);
    return request;
  };

  return { run, markRecordFresh };
}

const defaultCircuitBreaker = createZagulyakaMutationCircuitBreaker();

export function runZagulyakaVersionedMutation<T>(
  mutation: ZagulyakaVersionedMutation,
  invoke: () => Promise<T>,
): Promise<T> {
  return defaultCircuitBreaker.run(mutation, invoke);
}

export function markZagulyakaRecordFresh(
  scope: ZagulyakaMutationScope,
  recordId: string,
): void {
  defaultCircuitBreaker.markRecordFresh(scope, recordId);
}

function normalizedRecordIds(recordIds: readonly string[]): string[] {
  return [...new Set(recordIds.map((recordId) => recordId.trim()).filter(Boolean))].sort();
}

function normalizedAction(action: string): string {
  return action.trim() || "mutation";
}

function recordKey(scope: ZagulyakaMutationScope, recordId: string): string {
  const id = recordId.trim();
  return id ? [scope, id].join("\u001f") : "";
}

function hasVersionConflictMarker(value: unknown, seen: Set<unknown>): boolean {
  if (typeof value === "string") {
    return value.includes(ZAGULYAKA_VERSION_CONFLICT) ||
      new RegExp(`\\b${ZAGULYAKA_VERSION_CONFLICT_SQLSTATE}\\b`).test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const candidate = value as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === ZAGULYAKA_VERSION_CONFLICT_SQLSTATE) return true;
  return hasVersionConflictMarker(candidate.message, seen) ||
    hasVersionConflictMarker(candidate.details, seen) ||
    hasVersionConflictMarker(candidate.hint, seen) ||
    hasVersionConflictMarker(candidate.cause, seen);
}
