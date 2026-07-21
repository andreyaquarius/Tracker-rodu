import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createCachedNeighborhoodClient,
  createSupabaseNeighborhoodClient,
  FAMILY_TREE_GRAPH_VERSION_CHANGED,
  FamilyTreeScopeConflictError,
  type DescendantFrontierPageRequest,
  type DescendantFrontierPageResponse,
  type FamilyTreeNeighborhoodClient,
  type NeighborhoodResponse,
  type SupabaseRpcLike,
} from "../src/features/family-tree-view/data/neighborhoodClient.ts";
import {
  loadProgressiveDescendantGraph,
  ProgressiveDescendantConflictError,
  type ProgressiveDescendantState,
} from "../src/features/family-tree-view/data/progressiveDescendantLoader.ts";

const GRAPH_VERSION_CONFLICT = FAMILY_TREE_GRAPH_VERSION_CHANGED;
const neighborhoodHookSource = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
    import.meta.url,
  ),
  "utf8",
);
const scopeConflictMigration = readFileSync(
  new URL(
    "../supabase/migrations/202607210003_family_tree_scope_conflict_response.sql",
    import.meta.url,
  ),
  "utf8",
);

function rejectingSupabaseRpc(calls: string[]): SupabaseRpcLike {
  return {
    rpc<T>(functionName: string) {
      calls.push(functionName);
      return Promise.resolve({
        data: null as T | null,
        error: { message: GRAPH_VERSION_CONFLICT },
      });
    },
  };
}

function frontierPage(
  request: DescendantFrontierPageRequest,
  childIds: readonly string[],
  graphVersion: string,
): DescendantFrontierPageResponse {
  return {
    persons: childIds.map(id => ({ id, displayName: id })),
    unions: [],
    parentChildRelations: childIds.map(childId => ({
      id: `${request.frontier.generation}:${childId}`,
      parentId: request.frontier.personIds[0]!,
      childId,
      kind: "biological",
    })),
    continuations: [],
    nextFrontier: {
      generation: request.frontier.generation + 1,
      personIds: [...childIds],
    },
    hasMore: false,
    progress: {
      currentGeneration: request.frontier.generation,
      nextGeneration: request.frontier.generation + 1,
      frontierCount: request.frontier.personIds.length,
      pageSize: request.pageSize ?? 100,
      pageNumber: 1,
      returnedDescendantCount: childIds.length,
      returnedPersonCount: childIds.length,
      returnedUnionCount: 0,
      returnedRelationCount: childIds.length,
      frontierComplete: true,
    },
    graphVersion,
    permissionFingerprint: "member",
  };
}

function progressiveClient(
  loadPage: (
    request: DescendantFrontierPageRequest,
  ) => Promise<DescendantFrontierPageResponse>,
): FamilyTreeNeighborhoodClient {
  return {
    load(): Promise<NeighborhoodResponse> {
      return Promise.reject(new Error("legacy neighborhood load is not used"));
    },
    loadDescendantFrontierPage: loadPage,
  };
}

test("Supabase neighborhood transports surface a graph-version conflict after one RPC", async () => {
  const neighborhoodCalls: string[] = [];
  const neighborhood = createSupabaseNeighborhoodClient(
    rejectingSupabaseRpc(neighborhoodCalls),
  );

  await assert.rejects(
    neighborhood.load({
      treeId: "tree",
      focusPersonId: "focus",
      knownGraphVersion: "stale-version",
      permissionFingerprint: "member",
    }),
    error =>
      error instanceof FamilyTreeScopeConflictError &&
      error.conflictCode === GRAPH_VERSION_CONFLICT,
  );

  // Give any accidentally scheduled promise retry a chance to run.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(neighborhoodCalls, ["get_family_tree_neighborhood_v1"]);

  const descendantCalls: string[] = [];
  const descendants = createSupabaseNeighborhoodClient(
    rejectingSupabaseRpc(descendantCalls),
  );
  await assert.rejects(
    descendants.loadDescendantFrontierPage({
      treeId: "tree",
      rootPersonId: "root",
      frontier: { generation: 0, personIds: ["root"] },
      knownGraphVersion: "stale-version",
      permissionFingerprint: "member",
    }),
    error =>
      error instanceof FamilyTreeScopeConflictError &&
      error.conflictCode === GRAPH_VERSION_CONFLICT,
  );
  await Promise.resolve();
  assert.deepEqual(descendantCalls, ["get_family_tree_descendants_frontier_v1"]);
});

test("a structured scope-conflict payload is rejected before it can masquerade as a graph", async () => {
  const calls: string[] = [];
  const supabase: SupabaseRpcLike = {
    rpc<T>(functionName: string) {
      calls.push(functionName);
      return Promise.resolve({
        data: { conflictCode: GRAPH_VERSION_CONFLICT } as T,
        error: null,
      });
    },
  };
  const client = createSupabaseNeighborhoodClient(supabase);

  await assert.rejects(
    client.load({
      treeId: "tree",
      focusPersonId: "focus",
      knownGraphVersion: "stale-version",
      permissionFingerprint: "member",
    }),
    error =>
      error instanceof FamilyTreeScopeConflictError &&
      error.conflictCode === GRAPH_VERSION_CONFLICT,
  );
  assert.deepEqual(calls, ["get_family_tree_neighborhood_v1"]);
});

test("cached client blocks a rejected graph token locally until a fresh base read succeeds", async () => {
  let remoteCalls = 0;
  const inner: FamilyTreeNeighborhoodClient = {
    async load(request) {
      remoteCalls += 1;
      if (request.knownGraphVersion === "stale-version") {
        throw new FamilyTreeScopeConflictError(GRAPH_VERSION_CONFLICT);
      }
      return {
        persons: [{ id: "focus", displayName: "Focus" }],
        unions: [],
        parentChildRelations: [],
        continuations: [],
        graphVersion: "fresh-version",
      };
    },
    loadDescendantFrontierPage() {
      return Promise.reject(new Error("not used"));
    },
  };
  const client = createCachedNeighborhoodClient(inner);
  const staleRequest = {
    treeId: "tree",
    focusPersonId: "focus",
    knownGraphVersion: "stale-version",
  } as const;

  await assert.rejects(client.load(staleRequest), FamilyTreeScopeConflictError);
  await assert.rejects(client.load(staleRequest), FamilyTreeScopeConflictError);
  assert.equal(remoteCalls, 1, "the rejected token must not hit PostgreSQL twice");

  const fresh = await client.load({ treeId: "tree", focusPersonId: "focus" });
  assert.equal(fresh.graphVersion, "fresh-version");
  assert.equal(remoteCalls, 2, "one unversioned rebase request is allowed");
});

test("progressive descendants stop after the first server graph-version conflict", async () => {
  const requests: DescendantFrontierPageRequest[] = [];
  const progress: ProgressiveDescendantState[] = [];
  const client = progressiveClient(async request => {
    requests.push(request);
    throw new Error(GRAPH_VERSION_CONFLICT);
  });

  await assert.rejects(
    loadProgressiveDescendantGraph({
      client,
      treeId: "tree",
      rootPersonId: "root",
      maxGenerations: 100,
      knownGraphVersion: "stale-version",
      permissionFingerprint: "member",
      yieldControl: async () => undefined,
      onProgress: state => progress.push(state),
    }),
    error =>
      error instanceof Error && error.message === GRAPH_VERSION_CONFLICT,
  );

  assert.equal(requests.length, 1);
  assert.equal(progress.at(-1)?.loading, false);
  assert.equal(progress.at(-1)?.pagesLoaded, 0);
  assert.equal(progress.at(-1)?.error?.message, GRAPH_VERSION_CONFLICT);
});

test("progressive descendants do not request later pages after a response-version conflict", async () => {
  const requests: DescendantFrontierPageRequest[] = [];
  const progress: ProgressiveDescendantState[] = [];
  const client = progressiveClient(async request => {
    requests.push(request);
    if (request.frontier.generation === 0) {
      return frontierPage(request, ["child"], "v1");
    }
    return frontierPage(request, ["grandchild"], "v2");
  });

  await assert.rejects(
    loadProgressiveDescendantGraph({
      client,
      treeId: "tree",
      rootPersonId: "root",
      maxGenerations: 100,
      initialGraph: {
        persons: [{ id: "root", displayName: "root" }],
        unions: [],
        parentChildRelations: [],
        continuations: [],
        graphVersion: "v1",
        permissionFingerprint: "member",
      },
      yieldControl: async () => undefined,
      onProgress: state => progress.push(state),
    }),
    error =>
      error instanceof ProgressiveDescendantConflictError &&
      error.partialState.pagesLoaded === 1 &&
      error.partialState.graph.persons.some(person => person.id === "child") &&
      !error.partialState.graph.persons.some(person => person.id === "grandchild"),
  );

  assert.deepEqual(
    requests.map(request => request.frontier),
    [
      { generation: 0, personIds: ["root"] },
      { generation: 1, personIds: ["child"] },
    ],
  );
  assert.equal(progress.at(-1)?.loading, false);
  assert.equal(progress.at(-1)?.pagesLoaded, 1);
  assert.equal(
    progress.at(-1)?.error instanceof ProgressiveDescendantConflictError,
    true,
  );
});

test("default branch auto-expansion stops the session after a failed or aborted request", () => {
  const start = neighborhoodHookSource.indexOf(
    "const attemptedPersonContinuationIds",
  );
  const end = neighborhoodHookSource.indexOf(
    "const togglePersonBranches",
    start,
  );
  assert.ok(start >= 0 && end > start, "default expansion effect must exist");
  const autoExpansion = neighborhoodHookSource.slice(start, end);

  assertAutoExpansionStops(autoExpansion, "expandPersonContinuation");
  assertAutoExpansionStops(autoExpansion, "expandFamilyContinuation");
});

test("manual neighborhood reload invalidates cached scope and discards its stale graph version", () => {
  const start = neighborhoodHookSource.indexOf("const reload = useCallback");
  const end = neighborhoodHookSource.indexOf(
    "const scopeIsCurrent",
    start,
  );
  assert.ok(start >= 0 && end > start, "reload callback must exist");
  const reload = neighborhoodHookSource.slice(start, end);

  const invalidate = reload.search(/invalidateTree(?:\?\.)?\(treeId\)/);
  const clearBase = reload.indexOf("baseGraphRef.current = EMPTY_GRAPH");
  const clearCurrent = Math.max(
    reload.indexOf("graphRef.current = EMPTY_GRAPH"),
    reload.indexOf("commit(EMPTY_GRAPH)"),
  );
  const scheduleReload = reload.indexOf("setReloadKey(value => value + 1)");

  assert.ok(invalidate >= 0, "reload must invalidate the tree response cache");
  assert.ok(clearBase > invalidate, "reload must discard the stale base graph");
  assert.ok(
    clearCurrent > clearBase,
    "reload must discard the current graph and its stale graphVersion",
  );
  assert.ok(
    scheduleReload > clearCurrent,
    "a clean request may start only after stale graph state is discarded",
  );
});

test("scope-conflict migration converts only expected 40001 conflicts at four public boundaries", () => {
  const publicFacades = [
    "get_family_tree_neighborhood_v2",
    "get_family_tree_family_children_v1",
    "get_family_tree_descendants_frontier_v1",
    "get_family_tree_root_lineage_v1",
  ] as const;

  for (const functionName of publicFacades) {
    const body = sqlFunctionBody(scopeConflictMigration, functionName);
    assert.match(body, /exception\s+when\s+sqlstate\s+'40001'\s+then/i);
    assert.match(
      body,
      /if\s+sqlerrm\s+in\s*\(\s*'TREE_GRAPH_VERSION_CHANGED'\s*,\s*'TREE_PERMISSION_SCOPE_CHANGED'\s*\)\s+then/i,
    );
    assert.match(
      body,
      /return\s+jsonb_build_object\(\s*'conflictCode'\s*,\s*sqlerrm\s*\)\s*;/i,
    );
    assert.match(
      body,
      /end\s+if\s*;\s*raise\s*;/i,
      `${functionName} must rethrow every other 40001 instead of hiding it`,
    );
    assert.doesNotMatch(
      body,
      /when\s+others\b/i,
      `${functionName} must not swallow unrelated database failures`,
    );
  }

  assert.equal(
    [...scopeConflictMigration.matchAll(/'conflictCode'/gi)].length,
    publicFacades.length,
  );
  assert.doesNotMatch(
    scopeConflictMigration,
    /create\s+or\s+replace\s+function\s+public\.get_family_tree_neighborhood_v1\s*\(/i,
    "neighborhood_v1 must remain untouched because the private v2 implementation delegates through it",
  );
});

function assertAutoExpansionStops(
  source: string,
  callbackName: "expandPersonContinuation" | "expandFamilyContinuation",
): void {
  const awaitedCall = `await ${callbackName}(`;
  const callIndex = source.indexOf(awaitedCall);
  assert.ok(callIndex >= 0, `${callbackName} must be awaited`);

  const assignmentPrefix = source.slice(Math.max(0, callIndex - 80), callIndex);
  const resultMatch = assignmentPrefix.match(/(\w+)\s*=\s*$/);
  assert.ok(resultMatch, `${callbackName} result must be captured`);
  const resultName = resultMatch[1]!;
  assert.match(
    source.slice(0, callIndex),
    new RegExp(`(?:const|let)\\s+${resultName}(?:\\s*[:=])`),
    `${callbackName} result must be stored in a local bounded-session variable`,
  );
  const guard = source.slice(callIndex + awaitedCall.length, callIndex + 360);
  assert.match(
    guard,
    new RegExp(
      `(?:${resultName}\\s*===\\s*["']failed["'][\\s\\S]*` +
        `${resultName}\\s*===\\s*["']aborted["']|` +
        `${resultName}\\s*===\\s*["']aborted["'][\\s\\S]*` +
        `${resultName}\\s*===\\s*["']failed["'])` +
        `[\\s\\S]*?return`,
    ),
    `${callbackName} failure or abort must stop the automatic expansion loop`,
  );
}

function sqlFunctionBody(source: string, functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${escapedName}` +
      `[\\s\\S]*?\\$wrapper\\$;`,
    "i",
  ));
  assert.ok(match, `${functionName} public wrapper must be present`);
  return match[0];
}
