import type {
  ContinuationDirection,
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  PersonId,
  TreeContinuation,
} from "../types.ts";

export interface NeighborhoodBranchRequest {
  requestId: string;
  personId: PersonId;
  directions: readonly ContinuationDirection[];
  cursors?: Partial<Record<ContinuationDirection, string>>;
}

export interface NeighborhoodFamilyBranchRequest {
  requestId: string;
  scope: FamilyScope;
  cursor?: string;
  pageSize?: number;
}

export interface NeighborhoodRequest {
  treeId: string;
  focusPersonId: PersonId;
  /** Requests the relationship graph without expandable branch metadata. */
  structuralOnly?: boolean;
  ancestorDepth?: number;
  descendantDepth?: number;
  collateralDepth?: number;
  maxNodes?: number;
  knownGraphVersion?: string | number;
  permissionFingerprint?: string;
  branches?: readonly NeighborhoodBranchRequest[];
  /** Optional compatibility transport for family-aware neighborhood RPCs. */
  familyBranches?: readonly NeighborhoodFamilyBranchRequest[];
}

export interface NeighborhoodResponse extends FamilyGraphData {
  continuations: readonly TreeContinuation[];
  familyContinuations?: readonly FamilyContinuation[];
}

export interface FamilyBranchRequest {
  treeId: string;
  focusPersonId: PersonId;
  scope: FamilyScope;
  cursor?: string;
  pageSize?: number;
  knownGraphVersion?: string | number;
  permissionFingerprint?: string;
}

export interface FamilyBranchResponse extends NeighborhoodResponse {
  /** Echoed by the server and authoritative for this response. */
  scope: FamilyScope;
  nextCursor?: string;
}

export interface DescendantFrontierPageRequest {
  treeId: string;
  rootPersonId: PersonId;
  /** Current breadth-first source frontier. The transport accepts at most 200. */
  frontier: {
    generation: number;
    personIds: readonly PersonId[];
  };
  cursor?: string;
  pageSize?: number;
  knownGraphVersion?: string | number;
  permissionFingerprint?: string;
}

export interface DescendantFrontierPageResponse extends NeighborhoodResponse {
  nextFrontier: {
    generation: number;
    personIds: readonly PersonId[];
  };
  hasMore: boolean;
  progress: {
    currentGeneration: number;
    nextGeneration: number;
    frontierCount: number;
    pageSize: number;
    pageNumber: number;
    returnedDescendantCount: number;
    returnedPersonCount: number;
    returnedUnionCount: number;
    returnedRelationCount: number;
    frontierComplete: boolean;
  };
  nextCursor?: string;
}

export interface FamilyTreeNeighborhoodClient {
  load(
    request: NeighborhoodRequest,
    signal?: AbortSignal,
  ): Promise<NeighborhoodResponse>;
  /** Dedicated family child endpoint; old clients may omit it. */
  loadFamilyBranch?(
    request: FamilyBranchRequest,
    signal?: AbortSignal,
  ): Promise<FamilyBranchResponse>;
  loadDescendantFrontierPage(
    request: DescendantFrontierPageRequest,
    signal?: AbortSignal,
  ): Promise<DescendantFrontierPageResponse>;
  /** Clears resolved responses for one tree before a version-conflict rebase. */
  invalidateTree?(treeId: string): void;
}

export const FAMILY_TREE_GRAPH_VERSION_CHANGED = "TREE_GRAPH_VERSION_CHANGED";
export const FAMILY_TREE_PERMISSION_SCOPE_CHANGED = "TREE_PERMISSION_SCOPE_CHANGED";

export type FamilyTreeScopeConflictCode =
  | typeof FAMILY_TREE_GRAPH_VERSION_CHANGED
  | typeof FAMILY_TREE_PERMISSION_SCOPE_CHANGED;

/**
 * Expected optimistic-read conflict returned by the tree RPCs. It must never
 * be retried as a generic transient database error with the same graph token.
 */
export class FamilyTreeScopeConflictError extends Error {
  readonly conflictCode: FamilyTreeScopeConflictCode;

  constructor(conflictCode: FamilyTreeScopeConflictCode) {
    super(conflictCode);
    this.name = "FamilyTreeScopeConflictError";
    this.conflictCode = conflictCode;
  }
}

export function readFamilyTreeScopeConflictCode(
  value: unknown,
): FamilyTreeScopeConflictCode | undefined {
  if (typeof value === "string") {
    if (value.includes(FAMILY_TREE_GRAPH_VERSION_CHANGED)) {
      return FAMILY_TREE_GRAPH_VERSION_CHANGED;
    }
    if (value.includes(FAMILY_TREE_PERMISSION_SCOPE_CHANGED)) {
      return FAMILY_TREE_PERMISSION_SCOPE_CHANGED;
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    conflictCode?: unknown;
    message?: unknown;
  };
  return readFamilyTreeScopeConflictCode(candidate.conflictCode) ??
    readFamilyTreeScopeConflictCode(candidate.message);
}

export function isFamilyTreeScopeConflictError(
  value: unknown,
): value is FamilyTreeScopeConflictError {
  return value instanceof FamilyTreeScopeConflictError ||
    readFamilyTreeScopeConflictCode(value) !== undefined;
}

export function familyTreeTransportError(value: unknown): Error {
  const conflictCode = readFamilyTreeScopeConflictCode(value);
  if (conflictCode) return new FamilyTreeScopeConflictError(conflictCode);
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return new Error(message);
  }
  return new Error(String(value));
}

export function throwIfFamilyTreeScopeConflict(value: unknown): void {
  const conflictCode = readFamilyTreeScopeConflictCode(value);
  if (conflictCode) throw new FamilyTreeScopeConflictError(conflictCode);
}

const LOCAL_CONTINUATION_TOKEN_PREFIX = "local:";

/**
 * A branch response always repeats its visible anchor person. Restricting the
 * response to the remaining unique-person slots plus that anchor guarantees
 * that an idempotent merge cannot exceed the client graph ceiling.
 */
export function boundedBranchNodeLimit(
  loadedPersonCount: number,
  requestedMaxNodes: number,
  hardLimit: number,
): number {
  const loaded = Number.isFinite(loadedPersonCount)
    ? Math.max(0, Math.floor(loadedPersonCount))
    : hardLimit;
  const requested = Number.isFinite(requestedMaxNodes)
    ? Math.max(1, Math.floor(requestedMaxNodes))
    : 1;
  const remaining = Math.max(0, Math.floor(hardLimit) - loaded);
  return remaining > 0 ? Math.min(requested, remaining + 1) : 0;
}

/**
 * The family endpoint interprets pageSize as a number of children and repeats
 * every parent separately. Unlike a person branch, it therefore gets no
 * repeated-anchor allowance: a page can add at most the remaining card slots.
 */
export function boundedFamilyBranchChildLimit(
  loadedPersonCount: number,
  requestedMaxNodes: number,
  hardLimit: number,
): number {
  const loaded = Number.isFinite(loadedPersonCount)
    ? Math.max(0, Math.floor(loadedPersonCount))
    : hardLimit;
  const requested = Number.isFinite(requestedMaxNodes)
    ? Math.max(1, Math.floor(requestedMaxNodes))
    : 1;
  const remaining = Math.max(0, Math.floor(hardLimit) - loaded);
  return Math.min(requested, remaining);
}

/** Layout-only continuations describe a client view boundary, not an API cursor. */
export function isLocalContinuationToken(token: string): boolean {
  return token.startsWith(LOCAL_CONTINUATION_TOKEN_PREFIX);
}

function assertServerSafeRequest(request: NeighborhoodRequest): void {
  for (const branch of request.branches ?? []) {
    for (const token of Object.values(branch.cursors ?? {})) {
      if (token && isLocalContinuationToken(token)) {
        throw new Error(
          "Локальний маркер продовження не можна надсилати на сервер.",
        );
      }
    }
  }
  for (const branch of request.familyBranches ?? []) {
    if (branch.cursor && isLocalContinuationToken(branch.cursor)) {
      throw new Error(
        "Локальний маркер продовження не можна надсилати на сервер.",
      );
    }
  }
}

function assertServerSafeFamilyRequest(request: FamilyBranchRequest): void {
  if (request.cursor && isLocalContinuationToken(request.cursor)) {
    throw new Error(
      "Локальний маркер продовження не можна надсилати на сервер.",
    );
  }
}

function assertDescendantFrontierPageRequest(
  request: DescendantFrontierPageRequest,
): void {
  if (
    !request.treeId ||
    !request.rootPersonId ||
    !Number.isInteger(request.frontier.generation) ||
    request.frontier.generation < 0 ||
    request.frontier.personIds.length < 1 ||
    request.frontier.personIds.length > 200 ||
    request.frontier.personIds.some(personId => !personId)
  ) {
    throw new Error("Некоректний запит пакета покоління нащадків.");
  }
  if (
    request.pageSize !== undefined &&
    (!Number.isInteger(request.pageSize) ||
      request.pageSize < 1 ||
      request.pageSize > 200)
  ) {
    throw new Error("Розмір пакета покоління нащадків має бути від 1 до 200.");
  }
}

export function graphVersionsConflict(
  previous: FamilyGraphData["graphVersion"],
  next: FamilyGraphData["graphVersion"],
): boolean {
  return previous !== undefined && next !== undefined && !Object.is(previous, next);
}

export function permissionFingerprintsConflict(
  previous: FamilyGraphData["permissionFingerprint"],
  next: FamilyGraphData["permissionFingerprint"],
): boolean {
  return previous !== undefined && next !== undefined && previous !== next;
}

export function createHttpNeighborhoodClient(
  endpoint = "/api/v1/tree/neighborhood",
  descendantFrontierEndpoint = "/api/v1/tree/descendants-frontier",
): FamilyTreeNeighborhoodClient {
  return {
    async load(request, signal) {
      assertServerSafeRequest(request);
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      };
      const response = await fetch(endpoint, init);
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        throw new Error(
          payload?.error?.message ??
            `Не вдалося завантажити гілку дерева (${response.status}).`,
        );
      }
      return (await response.json()) as NeighborhoodResponse;
    },
    async loadDescendantFrontierPage(request, signal) {
      assertDescendantFrontierPageRequest(request);
      const response = await fetch(descendantFrontierEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        throw new Error(
          payload?.error?.message ??
            `Не вдалося завантажити пакет нащадків (${response.status}).`,
        );
      }
      return (await response.json()) as DescendantFrontierPageResponse;
    },
  };
}

export interface SupabaseRpcLike {
  rpc<T>(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{
    data: T | null;
    error: { message: string; code?: string } | null;
  }>;
}

export interface NeighborhoodCacheOptions {
  /** LRU entry ceiling. Values above 512 are clamped. */
  maxEntries?: number;
}

export interface CachedFamilyTreeNeighborhoodClient
  extends FamilyTreeNeighborhoodClient {
  clear(): void;
  invalidateTree(treeId: string): void;
}

interface NeighborhoodCacheEntry {
  treeId: string;
  graphVersion: string | number | undefined;
  permissionFingerprint: string;
  response: NeighborhoodResponse;
}

interface TreeCacheScope {
  graphVersion: string | number | undefined;
  permissionFingerprint: string;
}

type ConflictAwareRequest = Pick<
  NeighborhoodRequest,
  "treeId" | "knownGraphVersion" | "permissionFingerprint"
>;

const NO_PERMISSION_FINGERPRINT = "<none>";

function normalizedCacheLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 64;
  return Math.min(512, Math.max(1, Math.floor(value!)));
}

function cacheKey(
  request: NeighborhoodRequest,
  graphVersion = request.knownGraphVersion,
  permissionFingerprint =
    request.permissionFingerprint ?? NO_PERMISSION_FINGERPRINT,
): string {
  return JSON.stringify({
    treeId: request.treeId,
    graphVersion: graphVersion ?? null,
    permissionFingerprint,
    focusPersonId: request.focusPersonId,
    structuralOnly: request.structuralOnly ?? false,
    ancestorDepth: request.ancestorDepth ?? null,
    descendantDepth: request.descendantDepth ?? null,
    collateralDepth: request.collateralDepth ?? null,
    maxNodes: request.maxNodes ?? null,
    branches: (request.branches ?? []).map(branch => ({
      requestId: branch.requestId,
      personId: branch.personId,
      directions: [...branch.directions],
      cursors: Object.fromEntries(
        Object.entries(branch.cursors ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })),
    familyBranches: (request.familyBranches ?? []).map(branch => ({
      requestId: branch.requestId,
      scope: normalizedFamilyScope(branch.scope),
      cursor: branch.cursor ?? null,
      pageSize: branch.pageSize ?? null,
    })),
  });
}

function normalizedFamilyScope(scope: FamilyScope): Record<string, unknown> {
  return {
    id: scope.id,
    parentIds: [...scope.parentIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    unionIds: [...(scope.unionIds ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    familyGroupId: scope.familyGroupId ?? null,
  };
}

/**
 * Bounded resolved-response cache. It never shares an in-flight request, so
 * aborting one consumer cannot cancel or leak another consumer's result.
 */
export function createCachedNeighborhoodClient(
  inner: FamilyTreeNeighborhoodClient,
  options: NeighborhoodCacheOptions | number = {},
): CachedFamilyTreeNeighborhoodClient {
  const maxEntries = normalizedCacheLimit(
    typeof options === "number" ? options : options.maxEntries,
  );
  const entries = new Map<string, NeighborhoodCacheEntry>();
  const scopes = new Map<string, TreeCacheScope>();
  const treeRequestRevisions = new Map<string, number>();
  const blockedScopeConflicts = new Map<
    string,
    Map<string, FamilyTreeScopeConflictCode>
  >();
  let cacheEpoch = 0;

  const conflictScopeKey = (request: ConflictAwareRequest): string => [
    String(request.knownGraphVersion ?? ""),
    request.permissionFingerprint ?? "",
  ].join("\u001f");

  const throwIfScopeWasRejected = (request: ConflictAwareRequest): void => {
    if (request.knownGraphVersion === undefined) return;
    const conflictCode = blockedScopeConflicts
      .get(request.treeId)
      ?.get(conflictScopeKey(request));
    if (conflictCode) throw new FamilyTreeScopeConflictError(conflictCode);
  };

  const rememberScopeConflict = (
    request: ConflictAwareRequest,
    reason: unknown,
  ): void => {
    const conflictCode = readFamilyTreeScopeConflictCode(reason);
    if (!conflictCode || request.knownGraphVersion === undefined) return;
    let treeConflicts = blockedScopeConflicts.get(request.treeId);
    if (!treeConflicts) {
      treeConflicts = new Map();
      blockedScopeConflicts.set(request.treeId, treeConflicts);
    }
    treeConflicts.set(conflictScopeKey(request), conflictCode);
  };

  const runWithConflictGuard = async <T>(
    request: ConflictAwareRequest,
    load: () => Promise<T>,
  ): Promise<T> => {
    throwIfScopeWasRejected(request);
    try {
      const response = await load();
      // A successful unversioned base read is the rebase boundary. Only then
      // may callers send branch requests again for this tree.
      if (request.knownGraphVersion === undefined) {
        blockedScopeConflicts.delete(request.treeId);
      }
      return response;
    } catch (reason) {
      rememberScopeConflict(request, reason);
      throw reason;
    }
  };

  const invalidateTree = (treeId: string): void => {
    for (const [key, entry] of entries) {
      if (entry.treeId === treeId) entries.delete(key);
    }
    scopes.delete(treeId);
    treeRequestRevisions.set(
      treeId,
      (treeRequestRevisions.get(treeId) ?? 0) + 1,
    );
    inner.invalidateTree?.(treeId);
  };

  const setEntry = (key: string, entry: NeighborhoodCacheEntry): void => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };

  return {
    async load(request, signal) {
      assertServerSafeRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // Safe-by-default: without a caller-owned auth/RLS fingerprint there is
      // no reliable way to detect a permission change before a cache hit.
      if (request.permissionFingerprint === undefined) {
        return runWithConflictGuard(request, () => inner.load(request, signal));
      }

      throwIfScopeWasRejected(request);

      const requestFingerprint =
        request.permissionFingerprint;
      const requestedScope: TreeCacheScope = {
        graphVersion: request.knownGraphVersion,
        permissionFingerprint: requestFingerprint,
      };
      const currentScope = scopes.get(request.treeId);
      if (
        currentScope &&
        (currentScope.permissionFingerprint !== requestFingerprint ||
          graphVersionsConflict(
            currentScope.graphVersion,
            requestedScope.graphVersion,
          ))
      ) {
        invalidateTree(request.treeId);
      }

      const requestRevision =
        (treeRequestRevisions.get(request.treeId) ?? 0) + 1;
      treeRequestRevisions.set(request.treeId, requestRevision);
      const requestCacheEpoch = cacheEpoch;

      const key = cacheKey(request);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.response;
      }

      if (!scopes.has(request.treeId)) scopes.set(request.treeId, requestedScope);
      let response: NeighborhoodResponse;
      try {
        response = await inner.load(request, signal);
      } catch (reason) {
        rememberScopeConflict(request, reason);
        throw reason;
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (request.knownGraphVersion === undefined) {
        blockedScopeConflicts.delete(request.treeId);
      }
      if (
        requestCacheEpoch !== cacheEpoch ||
        treeRequestRevisions.get(request.treeId) !== requestRevision
      ) {
        return response;
      }

      const responseFingerprint =
        response.permissionFingerprint ?? requestFingerprint;
      const responseVersion = response.graphVersion ?? request.knownGraphVersion;
      const latestScope = scopes.get(request.treeId);
      if (
        latestScope &&
        (latestScope.permissionFingerprint !== responseFingerprint ||
          graphVersionsConflict(latestScope.graphVersion, responseVersion))
      ) {
        const requestStillMatches =
          latestScope.permissionFingerprint === requestFingerprint &&
          !graphVersionsConflict(
            latestScope.graphVersion,
            request.knownGraphVersion,
          );
        if (!requestStillMatches) return response;
        invalidateTree(request.treeId);
      }

      const responseScope: TreeCacheScope = {
        graphVersion: responseVersion,
        permissionFingerprint: responseFingerprint,
      };
      scopes.set(request.treeId, responseScope);
      setEntry(cacheKey(request, responseVersion, responseFingerprint), {
        treeId: request.treeId,
        graphVersion: responseVersion,
        permissionFingerprint: responseFingerprint,
        response,
      });
      return response;
    },
    async loadFamilyBranch(request, signal) {
      assertServerSafeFamilyRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return runWithConflictGuard(request, async () => {
        if (inner.loadFamilyBranch) {
          return inner.loadFamilyBranch(request, signal);
        }
        const response = await inner.load(
          {
            treeId: request.treeId,
            focusPersonId: request.focusPersonId,
            maxNodes: request.pageSize,
            ...(request.knownGraphVersion === undefined
              ? {}
              : { knownGraphVersion: request.knownGraphVersion }),
            ...(request.permissionFingerprint === undefined
              ? {}
              : { permissionFingerprint: request.permissionFingerprint }),
            familyBranches: [
              {
                requestId: `family:${request.scope.id}`,
                scope: request.scope,
                ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
                ...(request.pageSize === undefined
                  ? {}
                  : { pageSize: request.pageSize }),
              },
            ],
          },
          signal,
        );
        return { ...response, scope: request.scope };
      });
    },
    async loadDescendantFrontierPage(request, signal) {
      assertDescendantFrontierPageRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await runWithConflictGuard(
        request,
        () => inner.loadDescendantFrontierPage(request, signal),
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return response;
    },
    clear() {
      entries.clear();
      scopes.clear();
      treeRequestRevisions.clear();
      blockedScopeConflicts.clear();
      cacheEpoch += 1;
    },
    invalidateTree,
  };
}

/**
 * Keeps the visualization independent from the Supabase SDK version. The RPC
 * must perform authorization and living-person masking server-side.
 */
export function createSupabaseNeighborhoodClient(
  supabase: SupabaseRpcLike,
  functionName = "get_family_tree_neighborhood_v1",
  familyFunctionName = "get_family_tree_family_children_v1",
  descendantFrontierFunctionName = "get_family_tree_descendants_frontier_v1",
): FamilyTreeNeighborhoodClient {
  return {
    async load(request, signal) {
      assertServerSafeRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { data, error } = await supabase.rpc<NeighborhoodResponse>(
        functionName,
        { p_request: request },
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (error) throw familyTreeTransportError(error);
      throwIfFamilyTreeScopeConflict(data);
      if (!data) throw new Error("Сервер повернув порожнє оточення дерева.");
      return data;
    },
    async loadFamilyBranch(request, signal) {
      assertServerSafeFamilyRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { data, error } = await supabase.rpc<FamilyBranchResponse>(
        familyFunctionName,
        {
          p_request: {
            treeId: request.treeId,
            scope: request.scope,
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            ...(request.pageSize === undefined
              ? {}
              : { pageSize: request.pageSize }),
            ...(request.knownGraphVersion === undefined
              ? {}
              : { knownGraphVersion: request.knownGraphVersion }),
            ...(request.permissionFingerprint === undefined
              ? {}
              : { permissionFingerprint: request.permissionFingerprint }),
          },
        },
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (error) throw familyTreeTransportError(error);
      throwIfFamilyTreeScopeConflict(data);
      if (!data) throw new Error("Сервер повернув порожню сімейну гілку.");
      return data;
    },
    async loadDescendantFrontierPage(request, signal) {
      assertDescendantFrontierPageRequest(request);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { data, error } =
        await supabase.rpc<DescendantFrontierPageResponse>(
          descendantFrontierFunctionName,
          { p_request: request },
        );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (error) throw familyTreeTransportError(error);
      throwIfFamilyTreeScopeConflict(data);
      if (!data) throw new Error("Сервер повернув порожній пакет нащадків.");
      return data;
    },
  };
}

function mergeById<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const values = new Map(previous.map(item => [item.id, item]));
  for (const item of next) values.set(item.id, item);
  return [...values.values()];
}

/**
 * Family controls are canonical by scope rather than by presentation id. A
 * later item is authoritative, which reconciles old responses that emitted
 * the same children control once beside each parent.
 */
export function reconcileFamilyContinuations(
  continuations: readonly FamilyContinuation[],
): FamilyContinuation[] {
  const values = new Map<string, FamilyContinuation>();
  for (const continuation of continuations) {
    values.set(continuation.scope.id, continuation);
  }
  return [...values.values()];
}

/** Idempotently merges an expanded branch into the client entity cache. */
export function mergeNeighborhood(
  previous: FamilyGraphData,
  next: NeighborhoodResponse,
  consumedTokens: readonly string[] = [],
  authoritativeFamilyScopeIds: readonly string[] = [],
): FamilyGraphData {
  if (
    graphVersionsConflict(previous.graphVersion, next.graphVersion) ||
    permissionFingerprintsConflict(
      previous.permissionFingerprint,
      next.permissionFingerprint,
    )
  ) {
    throw new Error(
      "Версія родового графа змінилася; часткову відповідь потрібно відкинути й перезавантажити оточення.",
    );
  }
  const consumed = new Set(consumedTokens);
  const retained = (previous.continuations ?? []).filter(
    item => !consumed.has(item.token),
  );
  const authoritativeScopes = new Set(authoritativeFamilyScopeIds);
  const retainedFamilyContinuations = reconcileFamilyContinuations(
    previous.familyContinuations ?? [],
  ).filter(
    item =>
      !consumed.has(item.token) && !authoritativeScopes.has(item.scope.id),
  );
  const nextFamilyContinuations = reconcileFamilyContinuations(
    next.familyContinuations ?? [],
  );
  const merged: FamilyGraphData = {
    persons: mergeById(previous.persons, next.persons),
    unions: mergeById(previous.unions, next.unions),
    parentChildRelations: mergeById(
      previous.parentChildRelations,
      next.parentChildRelations,
    ),
    continuations: mergeById(retained, next.continuations ?? []),
    familyContinuations: reconcileFamilyContinuations([
      ...retainedFamilyContinuations,
      ...nextFamilyContinuations,
    ]),
  };
  const graphVersion = next.graphVersion ?? previous.graphVersion;
  const permissionFingerprint =
    next.permissionFingerprint ?? previous.permissionFingerprint;
  return {
    ...merged,
    ...(graphVersion === undefined ? {} : { graphVersion }),
    ...(permissionFingerprint === undefined ? {} : { permissionFingerprint }),
  };
}

/** Merges consecutive pages from the same family scope without duplicates. */
export function mergeFamilyBranchPages(
  previous: FamilyBranchResponse,
  next: FamilyBranchResponse,
  consumedCursor: string,
): FamilyBranchResponse {
  if (previous.scope.id !== next.scope.id) {
    throw new Error("Сервер повернув наступну сторінку для іншої сім’ї.");
  }
  const merged = mergeNeighborhood(
    previous,
    next,
    [consumedCursor],
    [next.scope.id],
  );
  return {
    ...merged,
    continuations: merged.continuations ?? [],
    scope: next.scope,
    ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
  };
}

/**
 * Loads every server page that fits the current visible-graph budget. The
 * opaque cursor is the only pagination state forwarded between requests.
 */
export async function loadBoundedFamilyBranchPages(
  loadPage: (
    request: FamilyBranchRequest,
    signal?: AbortSignal,
  ) => Promise<FamilyBranchResponse>,
  request: FamilyBranchRequest,
  existingPersonIds: ReadonlySet<PersonId>,
  maxNewChildren: number,
  signal?: AbortSignal,
  maxPages = 8,
): Promise<FamilyBranchResponse> {
  const parentIds = new Set(request.scope.parentIds);
  const boundedChildren = Math.max(1, Math.floor(maxNewChildren));
  const addedChildCount = (response: FamilyBranchResponse): number => new Set(
    response.persons
      .filter(person =>
        !existingPersonIds.has(person.id) && !parentIds.has(person.id)
      )
      .map(person => person.id),
  ).size;

  let response = await loadPage(
    { ...request, pageSize: boundedChildren },
    signal,
  );
  const seenCursors = new Set(
    request.cursor ? [request.cursor] : [],
  );
  let previousAddedCount = addedChildCount(response);
  let pageCount = 1;
  while (response.nextCursor && previousAddedCount < boundedChildren) {
    const cursor = response.nextCursor;
    if (seenCursors.has(cursor) || pageCount >= maxPages) {
      throw new Error(
        "Сервер не зміг безпечно завершити пагінацію дітей цієї сім’ї.",
      );
    }
    seenCursors.add(cursor);
    const nextPage = await loadPage(
      {
        ...request,
        cursor,
        pageSize: boundedChildren - previousAddedCount,
      },
      signal,
    );
    response = mergeFamilyBranchPages(response, nextPage, cursor);
    pageCount += 1;
    previousAddedCount = addedChildCount(response);
  }
  return response;
}
