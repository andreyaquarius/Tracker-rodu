import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedBranchNodeLimit,
  boundedFamilyBranchChildLimit,
  createCachedNeighborhoodClient,
  isLocalContinuationToken,
  loadBoundedFamilyBranchPages,
  mergeFamilyBranchPages,
  mergeNeighborhood,
  reconcileFamilyContinuations,
  type FamilyBranchResponse,
  type FamilyTreeNeighborhoodClient,
  type NeighborhoodRequest,
  type NeighborhoodResponse,
} from "../src/features/family-tree-view/data/neighborhoodClient.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { MAX_RENDERED_FAMILY_TREE_NODES } from "../src/features/family-tree-view/react/renderLimits.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  TreeContinuation,
} from "../src/features/family-tree-view/types.ts";

const FAMILY_SCOPE: FamilyScope = {
  id: "family-scope-a",
  parentIds: ["father", "mother"],
  unionIds: ["parents-a"],
};

function familyContinuation(
  id: string,
  hiddenCount = 2,
): FamilyContinuation {
  return {
    id,
    scope: FAMILY_SCOPE,
    token: `cursor:${id}`,
    hiddenCount,
  };
}

test("branch node budget reserves the repeated anchor without exceeding the client ceiling", () => {
  assert.equal(boundedBranchNodeLimit(255, 400, 600), 346);
  assert.equal(boundedBranchNodeLimit(599, 400, 600), 2);
  assert.equal(boundedBranchNodeLimit(600, 400, 600), 0);
});

test("family child budget never uses the repeated-anchor allowance", () => {
  assert.equal(boundedFamilyBranchChildLimit(255, 400, 600), 345);
  assert.equal(boundedFamilyBranchChildLimit(599, 400, 600), 1);
  assert.equal(boundedFamilyBranchChildLimit(600, 400, 600), 0);
});

test("consecutive family pages merge canonically and consume the next cursor", () => {
  const page = (
    childId: string,
    nextCursor?: string,
  ): FamilyBranchResponse => ({
    persons: [
      { id: "father", displayName: "Father" },
      { id: "mother", displayName: "Mother" },
      { id: childId, displayName: childId },
    ],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: nextCursor
      ? [{
          id: "family-page",
          scope: FAMILY_SCOPE,
          token: nextCursor,
          hiddenCount: 1,
        }]
      : [],
    scope: FAMILY_SCOPE,
    graphVersion: "v1",
    permissionFingerprint: "permission-a",
    ...(nextCursor ? { nextCursor } : {}),
  });
  const merged = mergeFamilyBranchPages(
    page("child-a", "cursor:page-2"),
    page("child-b"),
    "cursor:page-2",
  );

  assert.deepEqual(
    merged.persons.map(person => person.id),
    ["father", "mother", "child-a", "child-b"],
  );
  assert.equal(merged.nextCursor, undefined);
  assert.deepEqual(merged.familyContinuations, []);
});

test("family expansion automatically follows the opaque next cursor within budget", async () => {
  const calls: Array<{ cursor?: string; pageSize?: number }> = [];
  const makePage = (
    childId: string,
    nextCursor?: string,
  ): FamilyBranchResponse => ({
    persons: [
      { id: "father", displayName: "Father" },
      { id: "mother", displayName: "Mother" },
      { id: childId, displayName: childId },
    ],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: [],
    scope: FAMILY_SCOPE,
    graphVersion: "v1",
    permissionFingerprint: "permission-a",
    ...(nextCursor ? { nextCursor } : {}),
  });
  const response = await loadBoundedFamilyBranchPages(
    async input => {
      calls.push({ cursor: input.cursor, pageSize: input.pageSize });
      return input.cursor === "cursor:page-2"
        ? makePage("child-b")
        : makePage("child-a", "cursor:page-2");
    },
    {
      treeId: "tree-a",
      focusPersonId: "focus-a",
      scope: FAMILY_SCOPE,
      cursor: "cursor:page-1",
      pageSize: 2,
    },
    new Set(["father", "mother"]),
    2,
  );

  assert.deepEqual(calls, [
    { cursor: "cursor:page-1", pageSize: 2 },
    { cursor: "cursor:page-2", pageSize: 1 },
  ]);
  assert.deepEqual(
    response.persons.map(person => person.id),
    ["father", "mother", "child-a", "child-b"],
  );
});

test("an advanced cursor may pass a child already loaded through another branch", async () => {
  const calls: string[] = [];
  const response = await loadBoundedFamilyBranchPages(
    async input => {
      calls.push(input.cursor ?? "");
      const repeated = input.cursor === "cursor:first";
      return {
        persons: [
          { id: "father", displayName: "Father" },
          { id: "mother", displayName: "Mother" },
          {
            id: repeated ? "already-loaded-child" : "new-child",
            displayName: "Child",
          },
        ],
        unions: [],
        parentChildRelations: [],
        continuations: [],
        familyContinuations: [],
        scope: FAMILY_SCOPE,
        ...(repeated ? { nextCursor: "cursor:second" } : {}),
      };
    },
    {
      treeId: "tree-a",
      focusPersonId: "focus-a",
      scope: FAMILY_SCOPE,
      cursor: "cursor:first",
      pageSize: 1,
    },
    new Set(["father", "mother", "already-loaded-child"]),
    1,
  );

  assert.deepEqual(calls, ["cursor:first", "cursor:second"]);
  assert.ok(response.persons.some(person => person.id === "new-child"));
});

function request(
  overrides: Partial<NeighborhoodRequest> = {},
): NeighborhoodRequest {
  return {
    treeId: "tree-a",
    focusPersonId: "focus-a",
    ancestorDepth: 7,
    descendantDepth: 3,
    collateralDepth: 1,
    maxNodes: 400,
    knownGraphVersion: "v1",
    permissionFingerprint: "permission-a",
    ...overrides,
  };
}

function responseFor(
  input: NeighborhoodRequest,
  marker: string,
  overrides: Partial<NeighborhoodResponse> = {},
): NeighborhoodResponse {
  return {
    persons: [{ id: `person-${marker}`, displayName: marker }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    ...(input.knownGraphVersion === undefined
      ? {}
      : { graphVersion: input.knownGraphVersion }),
    ...(input.permissionFingerprint === undefined
      ? {}
      : { permissionFingerprint: input.permissionFingerprint }),
    ...overrides,
  };
}

function recordingClient(
  makeResponse: (
    input: NeighborhoodRequest,
    callNumber: number,
  ) => NeighborhoodResponse = (input, callNumber) =>
    responseFor(input, String(callNumber)),
): {
  client: FamilyTreeNeighborhoodClient;
  calls: NeighborhoodRequest[];
} {
  const calls: NeighborhoodRequest[] = [];
  return {
    calls,
    client: {
      async load(input) {
        calls.push(input);
        return makeResponse(input, calls.length);
      },
    },
  };
}

function continuation(
  id: string,
  token: string,
  personId = "root",
): TreeContinuation {
  return {
    id,
    personId,
    direction: "children",
    token,
  };
}

function mergeFixtures(): {
  initial: FamilyGraphData;
  branch: NeighborhoodResponse;
} {
  return {
    initial: {
      persons: [
        { id: "root", displayName: "Root" },
        { id: "child", displayName: "Child before expansion" },
      ],
      unions: [
        { id: "union-a", kind: "parent-set", memberIds: ["root"] },
      ],
      parentChildRelations: [
        {
          id: "root-child",
          parentId: "root",
          childId: "child",
          unionId: "union-a",
          kind: "biological",
        },
      ],
      continuations: [
        continuation("continuation-consumed", "cursor-consumed"),
        continuation("continuation-retained", "cursor-retained"),
      ],
      graphVersion: "v1",
      permissionFingerprint: "permission-a",
    },
    branch: {
      persons: [
        { id: "child", displayName: "Child after expansion" },
        { id: "grandchild", displayName: "Grandchild" },
      ],
      unions: [
        { id: "union-a", kind: "parent-set", memberIds: ["root"] },
        { id: "union-b", kind: "parent-set", memberIds: ["child"] },
      ],
      parentChildRelations: [
        {
          id: "root-child",
          parentId: "root",
          childId: "child",
          unionId: "union-a",
          kind: "biological",
        },
        {
          id: "child-grandchild",
          parentId: "child",
          childId: "grandchild",
          unionId: "union-b",
          kind: "biological",
        },
      ],
      continuations: [
        continuation("continuation-next", "cursor-next", "grandchild"),
      ],
      graphVersion: "v1",
      permissionFingerprint: "permission-a",
    },
  };
}

test("mergeNeighborhood is idempotent when the same branch page is expanded repeatedly", () => {
  const { initial, branch } = mergeFixtures();
  const first = mergeNeighborhood(initial, branch, ["cursor-consumed"]);
  const repeated = mergeNeighborhood(first, branch, ["cursor-consumed"]);

  assert.deepEqual(repeated, first);
  assert.equal(first.persons.length, new Set(first.persons.map(item => item.id)).size);
  assert.equal(first.unions.length, new Set(first.unions.map(item => item.id)).size);
  assert.equal(
    first.parentChildRelations.length,
    new Set(first.parentChildRelations.map(item => item.id)).size,
  );
  assert.equal(
    first.persons.find(person => person.id === "child")?.displayName,
    "Child after expansion",
  );
});

test("mergeNeighborhood removes consumed continuations and retains unrelated cursors", () => {
  const { initial, branch } = mergeFixtures();
  const merged = mergeNeighborhood(initial, branch, ["cursor-consumed"]);
  const tokens = (merged.continuations ?? []).map(item => item.token).sort();

  assert.deepEqual(tokens, ["cursor-next", "cursor-retained"]);
  assert.equal(merged.graphVersion, "v1");
  assert.equal(merged.permissionFingerprint, "permission-a");
});

test("family continuations reconcile by scope instead of parent-side presentation id", () => {
  const reconciled = reconcileFamilyContinuations([
    familyContinuation("beside-father", 2),
    familyContinuation("beside-mother", 2),
  ]);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.id, "beside-mother");
  assert.equal(reconciled[0]?.scope.id, FAMILY_SCOPE.id);
});

test("an authoritative empty family response removes the stale closed control", () => {
  const previous: FamilyGraphData = {
    persons: [{ id: "father", displayName: "Father" }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: [familyContinuation("stale")],
    graphVersion: "v1",
  };
  const next: NeighborhoodResponse = {
    persons: [{ id: "father", displayName: "Father" }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    familyContinuations: [],
    graphVersion: "v1",
  };

  const merged = mergeNeighborhood(previous, next, [], [FAMILY_SCOPE.id]);

  assert.deepEqual(merged.familyContinuations, []);
});

test("production layout renders only the sibling and child branches already merged by the server", () => {
  const initial: FamilyGraphData = {
    persons: [
      { id: "focus", displayName: "Focus" },
      { id: "parent", displayName: "Parent" },
    ],
    unions: [
      { id: "focus-parents", kind: "parent-set", memberIds: ["parent"] },
    ],
    parentChildRelations: [
      {
        id: "parent-focus",
        parentId: "parent",
        childId: "focus",
        unionId: "focus-parents",
        kind: "biological",
      },
    ],
    continuations: [
      {
        id: "focus-siblings",
        personId: "focus",
        direction: "siblings",
        token: "cursor-siblings",
      },
      {
        id: "focus-children",
        personId: "focus",
        direction: "children",
        token: "cursor-children",
      },
    ],
    graphVersion: "v1",
    permissionFingerprint: "permission-a",
  };
  const siblingPage: NeighborhoodResponse = {
    persons: [
      { id: "focus", displayName: "Focus" },
      { id: "parent", displayName: "Parent" },
      { id: "sibling", displayName: "Sibling" },
    ],
    unions: [
      { id: "focus-parents", kind: "parent-set", memberIds: ["parent"] },
    ],
    parentChildRelations: [
      {
        id: "parent-focus",
        parentId: "parent",
        childId: "focus",
        unionId: "focus-parents",
        kind: "biological",
      },
      {
        id: "parent-sibling",
        parentId: "parent",
        childId: "sibling",
        unionId: "focus-parents",
        kind: "biological",
      },
    ],
    continuations: [],
    graphVersion: "v1",
    permissionFingerprint: "permission-a",
  };
  const childPage: NeighborhoodResponse = {
    persons: [
      { id: "focus", displayName: "Focus" },
      { id: "child", displayName: "Child" },
    ],
    unions: [
      { id: "focus-children", kind: "parent-set", memberIds: ["focus"] },
    ],
    parentChildRelations: [
      {
        id: "focus-child",
        parentId: "focus",
        childId: "child",
        unionId: "focus-children",
        kind: "biological",
      },
    ],
    continuations: [],
    graphVersion: "v1",
    permissionFingerprint: "permission-a",
  };
  const withSibling = mergeNeighborhood(initial, siblingPage, [
    "cursor-siblings",
  ]);
  const merged = mergeNeighborhood(withSibling, childPage, [
    "cursor-children",
  ]);
  const layout = layoutFamilyGraph({
    graph: merged,
    options: {
      focusPersonId: "focus",
      ancestorDepth: MAX_RENDERED_FAMILY_TREE_NODES,
      descendantDepth: MAX_RENDERED_FAMILY_TREE_NODES,
      collateralDepth: MAX_RENDERED_FAMILY_TREE_NODES,
      maxVisibleNodes: MAX_RENDERED_FAMILY_TREE_NODES,
      showUnknownParentPlaceholders: false,
    },
  });

  assert.deepEqual(
    layout.nodes
      .filter(node => node.kind === "person")
      .map(node => node.personId)
      .sort(),
    ["child", "focus", "parent", "sibling"],
  );
});

test("mergeNeighborhood rejects graph-version and permission-scope conflicts", () => {
  const { initial, branch } = mergeFixtures();

  assert.throws(
    () => mergeNeighborhood(initial, { ...branch, graphVersion: "v2" }),
    /Версія родового графа змінилася/,
  );
  assert.throws(
    () =>
      mergeNeighborhood(initial, {
        ...branch,
        permissionFingerprint: "permission-b",
      }),
    /Версія родового графа змінилася/,
  );
});

test("local continuation tokens are rejected before the inner client runs", async () => {
  const recorded = recordingClient();
  const cached = createCachedNeighborhoodClient(recorded.client);
  const input = request({
    branches: [
      {
        requestId: "expand-local",
        personId: "focus-a",
        directions: ["children"],
        cursors: { children: "local:children:focus-a:budget" },
      },
    ],
  });

  assert.equal(isLocalContinuationToken("local:children:focus-a:budget"), true);
  assert.equal(isLocalContinuationToken("server-cursor"), false);
  await assert.rejects(cached.load(input), /Локальний маркер продовження/);
  assert.equal(recorded.calls.length, 0);
});

test("cache keys separate tree, focus, every depth budget, graph version, and permission", async () => {
  const recorded = recordingClient();
  const cached = createCachedNeighborhoodClient(recorded.client, 64);
  let expectedCalls = 0;

  const expectMissThenHit = async (input: NeighborhoodRequest): Promise<void> => {
    const first = await cached.load(input);
    expectedCalls += 1;
    assert.equal(recorded.calls.length, expectedCalls);
    const second = await cached.load(input);
    assert.equal(recorded.calls.length, expectedCalls);
    assert.strictEqual(second, first);
  };

  await expectMissThenHit(request());
  await expectMissThenHit(request({ treeId: "tree-b" }));
  await expectMissThenHit(request({ focusPersonId: "focus-b" }));
  await expectMissThenHit(request({ ancestorDepth: 8 }));
  await expectMissThenHit(request({ descendantDepth: 4 }));
  await expectMissThenHit(request({ collateralDepth: 2 }));
  await expectMissThenHit(request({ maxNodes: 401 }));
  await expectMissThenHit(request({ structuralOnly: true }));
  await expectMissThenHit(request({ knownGraphVersion: "v2" }));
  await expectMissThenHit(
    request({
      knownGraphVersion: "v2",
      permissionFingerprint: "permission-b",
    }),
  );
  await expectMissThenHit(
    request({
      familyBranches: [
        {
          requestId: "family-request",
          scope: FAMILY_SCOPE,
          cursor: "family-cursor",
          pageSize: 50,
        },
      ],
    }),
  );
});

test("family branch compatibility transport uses the canonical family scope", async () => {
  const recorded = recordingClient();
  const cached = createCachedNeighborhoodClient(recorded.client);

  const response = await cached.loadFamilyBranch!({
    treeId: "tree-a",
    focusPersonId: "focus-a",
    scope: FAMILY_SCOPE,
    cursor: "family-cursor",
    pageSize: 25,
    knownGraphVersion: "v1",
    permissionFingerprint: "permission-a",
  });

  assert.equal(recorded.calls.length, 1);
  assert.equal(recorded.calls[0]?.familyBranches?.[0]?.scope.id, FAMILY_SCOPE.id);
  assert.equal(recorded.calls[0]?.familyBranches?.[0]?.cursor, "family-cursor");
  assert.equal(response.scope.id, FAMILY_SCOPE.id);
});

test("local family continuation cursor is rejected before transport", async () => {
  const recorded = recordingClient();
  const cached = createCachedNeighborhoodClient(recorded.client);

  await assert.rejects(
    cached.loadFamilyBranch!({
      treeId: "tree-a",
      focusPersonId: "focus-a",
      scope: FAMILY_SCOPE,
      cursor: "local:active:family-scope-a",
    }),
    /Локальний маркер продовження/,
  );
  assert.equal(recorded.calls.length, 0);
});

test("cache invalidates all entries for a tree when graph version or permission changes", async () => {
  const recorded = recordingClient();
  const cached = createCachedNeighborhoodClient(recorded.client, 32);

  const versionA = request({ treeId: "version-tree", focusPersonId: "a" });
  const versionB = request({ treeId: "version-tree", focusPersonId: "b" });
  await cached.load(versionA);
  await cached.load(versionB);
  await cached.load(versionA);
  await cached.load(versionB);
  assert.equal(recorded.calls.length, 2);

  const version2 = request({
    treeId: "version-tree",
    focusPersonId: "a",
    knownGraphVersion: "v2",
  });
  await cached.load(version2);
  await cached.load(version2);
  assert.equal(recorded.calls.length, 3);
  await cached.load(versionB);
  assert.equal(recorded.calls.length, 4);

  const permissionA = request({ treeId: "permission-tree", focusPersonId: "a" });
  const permissionB = request({ treeId: "permission-tree", focusPersonId: "b" });
  await cached.load(permissionA);
  await cached.load(permissionB);
  await cached.load(permissionA);
  await cached.load(permissionB);
  assert.equal(recorded.calls.length, 6);

  const changedPermission = request({
    treeId: "permission-tree",
    focusPersonId: "a",
    permissionFingerprint: "permission-b",
  });
  await cached.load(changedPermission);
  await cached.load(changedPermission);
  assert.equal(recorded.calls.length, 7);
  await cached.load(permissionB);
  assert.equal(recorded.calls.length, 8);
});

test("cache safely bypasses storage when no permission fingerprint is supplied", async () => {
  const recorded = recordingClient((input, callNumber) =>
    responseFor(input, String(callNumber), {
      graphVersion: "v1",
      permissionFingerprint: "server-permission",
    }),
  );
  const cached = createCachedNeighborhoodClient(recorded.client);
  const noFingerprint = request({ permissionFingerprint: undefined });

  const first = await cached.load(noFingerprint);
  const second = await cached.load(noFingerprint);
  assert.equal(recorded.calls.length, 2);
  assert.notStrictEqual(second, first);
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("aborted requests never reach or populate the resolved-response cache", async () => {
  const calls: NeighborhoodRequest[] = [];
  const pending: Array<{
    input: NeighborhoodRequest;
    deferred: Deferred<NeighborhoodResponse>;
  }> = [];
  const inner: FamilyTreeNeighborhoodClient = {
    load(input) {
      calls.push(input);
      const result = deferred<NeighborhoodResponse>();
      pending.push({ input, deferred: result });
      return result.promise;
    },
  };
  const cached = createCachedNeighborhoodClient(inner);
  const input = request({ treeId: "abort-tree" });

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    cached.load(input, alreadyAborted.signal),
    error => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls.length, 0);

  const controller = new AbortController();
  const abortedLoad = cached.load(input, controller.signal);
  assert.equal(calls.length, 1);
  controller.abort();
  pending[0]!.deferred.resolve(responseFor(input, "aborted"));
  await assert.rejects(
    abortedLoad,
    error => error instanceof Error && error.name === "AbortError",
  );

  const retry = cached.load(input);
  assert.equal(calls.length, 2);
  pending[1]!.deferred.resolve(responseFor(input, "retry"));
  const retriedResponse = await retry;
  assert.strictEqual(await cached.load(input), retriedResponse);
  assert.equal(calls.length, 2);
});

test("a stale concurrent response is returned to its caller but is not cached", async () => {
  const calls: NeighborhoodRequest[] = [];
  const pending = new Map<string, Deferred<NeighborhoodResponse>[]>();
  const inner: FamilyTreeNeighborhoodClient = {
    load(input) {
      calls.push(input);
      const result = deferred<NeighborhoodResponse>();
      const queue = pending.get(input.focusPersonId) ?? [];
      queue.push(result);
      pending.set(input.focusPersonId, queue);
      return result.promise;
    },
  };
  const cached = createCachedNeighborhoodClient(inner, 8);
  const older = request({ treeId: "race-tree", focusPersonId: "older" });
  const newer = request({ treeId: "race-tree", focusPersonId: "newer" });

  const olderLoad = cached.load(older);
  const newerLoad = cached.load(newer);
  pending.get("newer")![0]!.resolve(responseFor(newer, "newer"));
  const newerResponse = await newerLoad;
  pending.get("older")![0]!.resolve(responseFor(older, "older-stale"));
  const staleResponse = await olderLoad;

  assert.equal(staleResponse.persons[0]?.displayName, "older-stale");
  assert.strictEqual(await cached.load(newer), newerResponse);
  assert.equal(calls.length, 2);

  const olderRetry = cached.load(older);
  assert.equal(calls.length, 3);
  pending.get("older")![1]!.resolve(responseFor(older, "older-fresh"));
  const freshResponse = await olderRetry;
  assert.strictEqual(await cached.load(older), freshResponse);
  assert.equal(calls.length, 3);
});
