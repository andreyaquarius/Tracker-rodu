import assert from "node:assert/strict";
import test from "node:test";
import {
  loadProgressiveDescendantGraph,
  ProgressiveDescendantConflictError,
  type ProgressiveDescendantState,
} from "../src/features/family-tree-view/data/progressiveDescendantLoader.ts";
import type {
  DescendantFrontierPageRequest,
  DescendantFrontierPageResponse,
  FamilyTreeNeighborhoodClient,
  NeighborhoodResponse,
} from "../src/features/family-tree-view/data/neighborhoodClient.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function frontierPage(
  request: DescendantFrontierPageRequest,
  childIds: readonly string[],
  options: {
    hasMore?: boolean;
    nextCursor?: string;
    pageNumber?: number;
    graphVersion?: string;
    permissionFingerprint?: string;
  } = {},
): DescendantFrontierPageResponse {
  const people = [...new Set([...request.frontier.personIds, ...childIds])];
  return {
    persons: people.map(id => ({ id, displayName: id })),
    unions: [],
    parentChildRelations: childIds.map((childId, index) => ({
      id: `${request.frontier.generation}:${request.cursor ?? "first"}:${index}`,
      parentId: request.frontier.personIds[0]!,
      childId,
      kind: "biological",
    })),
    continuations: [],
    nextFrontier: {
      generation: request.frontier.generation + 1,
      personIds: childIds,
    },
    hasMore: options.hasMore ?? false,
    progress: {
      currentGeneration: request.frontier.generation,
      nextGeneration: request.frontier.generation + 1,
      frontierCount: request.frontier.personIds.length,
      pageSize: request.pageSize ?? 100,
      pageNumber: options.pageNumber ?? 1,
      returnedDescendantCount: childIds.length,
      returnedPersonCount: people.length,
      returnedUnionCount: 0,
      returnedRelationCount: childIds.length,
      frontierComplete: !(options.hasMore ?? false),
    },
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
    graphVersion: options.graphVersion ?? "v1",
    permissionFingerprint: options.permissionFingerprint ?? "member",
  };
}

function clientWithFrontier(
  loadPage: FamilyTreeNeighborhoodClient["loadDescendantFrontierPage"],
): FamilyTreeNeighborhoodClient {
  return {
    load(): Promise<NeighborhoodResponse> {
      return Promise.reject(new Error("legacy neighborhood load is not used"));
    },
    loadDescendantFrontierPage: loadPage,
  };
}

test("commits page one before a deferred page two resolves", async () => {
  const pageTwo = deferred<DescendantFrontierPageResponse>();
  const pageTwoStarted = deferred<void>();
  const progress: ProgressiveDescendantState[] = [];
  const client = clientWithFrontier(async request => {
    if (request.cursor === "cursor:2") {
      pageTwoStarted.resolve(undefined);
      return pageTwo.promise;
    }
    return frontierPage(request, ["child-a"], {
      hasMore: true,
      nextCursor: "cursor:2",
    });
  });

  const loading = loadProgressiveDescendantGraph({
    client,
    treeId: "tree",
    rootPersonId: "root",
    maxGenerations: 1,
    pageSize: 2,
    knownGraphVersion: "v1",
    permissionFingerprint: "member",
    yieldControl: async () => undefined,
    onProgress: state => progress.push(state),
  });

  await pageTwoStarted.promise;
  assert.equal(progress[0]?.pagesLoaded, 1);
  assert.deepEqual(
    progress[0]?.graph.persons.map(person => person.id),
    ["root", "child-a"],
  );
  assert.equal(progress[0]?.loading, true);

  const secondRequest: DescendantFrontierPageRequest = {
    treeId: "tree",
    rootPersonId: "root",
    frontier: { generation: 0, personIds: ["root"] },
    cursor: "cursor:2",
    pageSize: 2,
    knownGraphVersion: "v1",
    permissionFingerprint: "member",
  };
  pageTwo.resolve(frontierPage(secondRequest, ["child-b"], { pageNumber: 2 }));
  const result = await loading;

  assert.equal(result.pagesLoaded, 2);
  assert.equal(result.loadedGenerations, 1);
  assert.deepEqual(
    result.graph.persons.map(person => person.id),
    ["root", "child-a", "child-b"],
  );
});

test("cancel preserves the graph committed from page one", async () => {
  const controller = new AbortController();
  const pageTwoStarted = deferred<void>();
  const progress: ProgressiveDescendantState[] = [];
  const client = clientWithFrontier(async (request, signal) => {
    if (request.cursor !== "cursor:2") {
      return frontierPage(request, ["child-a"], {
        hasMore: true,
        nextCursor: "cursor:2",
      });
    }
    pageTwoStarted.resolve(undefined);
    return new Promise<DescendantFrontierPageResponse>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });

  const loading = loadProgressiveDescendantGraph({
    client,
    treeId: "tree",
    rootPersonId: "root",
    maxGenerations: 1,
    knownGraphVersion: "v1",
    permissionFingerprint: "member",
    signal: controller.signal,
    yieldControl: async () => undefined,
    onProgress: state => progress.push(state),
  });

  await pageTwoStarted.promise;
  controller.abort();
  const result = await loading;

  assert.equal(result.canceled, true);
  assert.equal(result.loading, false);
  assert.equal(result.pagesLoaded, 1);
  assert.deepEqual(
    result.graph.persons.map(person => person.id),
    ["root", "child-a"],
  );
  assert.equal(progress.at(-1)?.canceled, true);
});

test("breadth-first traversal chunks a large frontier and removes cycles", async () => {
  const requests: DescendantFrontierPageRequest[] = [];
  const firstChildren = Array.from({ length: 200 }, (_, index) => `child-${index}`);
  const client = clientWithFrontier(async request => {
    requests.push(request);
    if (request.frontier.generation === 0 && !request.cursor) {
      return frontierPage(request, ["root", ...firstChildren.slice(0, 199)], {
        hasMore: true,
        nextCursor: "cursor:root:2",
      });
    }
    if (request.frontier.generation === 0) {
      return frontierPage(request, [firstChildren[199]!], { pageNumber: 2 });
    }
    return frontierPage(request, []);
  });

  const result = await loadProgressiveDescendantGraph({
    client,
    treeId: "tree",
    rootPersonId: "root",
    maxGenerations: 2,
    pageSize: 200,
    knownGraphVersion: "v1",
    permissionFingerprint: "member",
    yieldControl: async () => undefined,
  });

  const generationOneRequests = requests.filter(
    request => request.frontier.generation === 1,
  );
  assert.deepEqual(
    generationOneRequests.map(request => request.frontier.personIds.length),
    [200],
  );
  assert.equal(
    generationOneRequests[0]?.frontier.personIds.includes("root"),
    false,
  );
  assert.equal(result.loadedGenerations, 2);
  assert.equal(result.loadedPersons, 201);
});

test("rejects graph-version and permission changes without committing the page", async () => {
  const initialGraph = {
    persons: [{ id: "root", displayName: "root" }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    graphVersion: "v1",
    permissionFingerprint: "member",
  } as const;

  for (const conflict of [
    { graphVersion: "v2", permissionFingerprint: "member" },
    { graphVersion: "v1", permissionFingerprint: "admin" },
  ]) {
    const client = clientWithFrontier(async request =>
      frontierPage(request, ["child"], conflict));
    await assert.rejects(
      loadProgressiveDescendantGraph({
        client,
        treeId: "tree",
        rootPersonId: "root",
        maxGenerations: 1,
        initialGraph,
        yieldControl: async () => undefined,
      }),
      error =>
        error instanceof ProgressiveDescendantConflictError &&
        error.partialState.graph.persons.length === 1 &&
        error.partialState.pagesLoaded === 0,
    );
  }
});
