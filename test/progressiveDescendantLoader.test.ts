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
import { buildAllDescendantsProjection } from "../src/features/family-tree-view/state/allDescendantsProjection.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";

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
    includeFrontier?: boolean;
  } = {},
): DescendantFrontierPageResponse {
  const people = [
    ...new Set([
      ...(options.includeFrontier === false ? [] : request.frontier.personIds),
      ...childIds,
    ]),
  ];
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

test("a captured root seed survives the production RPC contract that omits frontier people", async () => {
  const rootPerson = { id: "overlay-root", displayName: "overlay root" };
  const client = clientWithFrontier(async request =>
    frontierPage(request, ["child"], { includeFrontier: false }));

  const result = await loadProgressiveDescendantGraph({
    client,
    treeId: "tree",
    rootPersonId: rootPerson.id,
    maxGenerations: 1,
    initialGraph: {
      persons: [rootPerson],
      unions: [],
      parentChildRelations: [],
      continuations: [],
      familyContinuations: [],
      graphVersion: "v1",
      permissionFingerprint: "member",
    },
    yieldControl: async () => undefined,
  });

  assert.deepEqual(
    result.graph.persons.map(person => person.id),
    ["overlay-root", "child"],
  );
  assert.equal(
    result.graph.parentChildRelations.some(
      relation =>
        relation.parentId === "overlay-root" && relation.childId === "child",
    ),
    true,
  );
});

test("progressive pages preserve every co-parent and descendant branch for projection", async () => {
  const requests: DescendantFrontierPageRequest[] = [];
  const client = clientWithFrontier(async request => {
    requests.push(request);
    if (request.frontier.generation === 0) {
      return {
        persons: [
          { id: "child-a", displayName: "child-a" },
          { id: "child-b", displayName: "child-b" },
          { id: "partner-a", displayName: "partner-a" },
          { id: "partner-b", displayName: "partner-b" },
        ],
        unions: [
          {
            id: "partnership:root-partner-a",
            kind: "partnership",
            memberIds: ["root", "partner-a"],
          },
          {
            id: "partnership:root-partner-b",
            kind: "partnership",
            memberIds: ["root", "partner-b"],
          },
          {
            id: "parent-set:root-family-a",
            kind: "parent-set",
            memberIds: ["root", "partner-a"],
          },
          {
            id: "parent-set:root-family-b",
            kind: "parent-set",
            memberIds: ["root", "partner-b"],
          },
        ],
        parentChildRelations: [
          {
            id: "root-child-a",
            parentId: "root",
            childId: "child-a",
            unionId: "parent-set:root-family-a",
            kind: "biological",
          },
          {
            id: "partner-a-child-a",
            parentId: "partner-a",
            childId: "child-a",
            unionId: "parent-set:root-family-a",
            kind: "biological",
          },
          {
            id: "root-child-b",
            parentId: "root",
            childId: "child-b",
            unionId: "parent-set:root-family-b",
            kind: "biological",
          },
          {
            id: "partner-b-child-b",
            parentId: "partner-b",
            childId: "child-b",
            unionId: "parent-set:root-family-b",
            kind: "biological",
          },
        ],
        continuations: [],
        nextFrontier: {
          generation: 1,
          personIds: ["child-a", "child-b"],
        },
        hasMore: false,
        progress: {
          currentGeneration: 0,
          nextGeneration: 1,
          frontierCount: 1,
          pageSize: request.pageSize ?? 100,
          pageNumber: 1,
          returnedDescendantCount: 2,
          returnedPersonCount: 4,
          returnedUnionCount: 4,
          returnedRelationCount: 4,
          frontierComplete: true,
        },
        graphVersion: "v1",
        permissionFingerprint: "member",
      };
    }
    return {
      persons: [
        { id: "grandchild-a", displayName: "grandchild-a" },
        { id: "grandchild-b", displayName: "grandchild-b" },
        { id: "child-a-partner", displayName: "child-a-partner" },
        { id: "child-b-partner", displayName: "child-b-partner" },
      ],
      unions: [
        {
          id: "partnership:child-a-partner",
          kind: "partnership",
          memberIds: ["child-a", "child-a-partner"],
        },
        {
          id: "partnership:child-b-partner",
          kind: "partnership",
          memberIds: ["child-b", "child-b-partner"],
        },
        {
          id: "parent-set:child-a-family",
          kind: "parent-set",
          memberIds: ["child-a", "child-a-partner"],
        },
        {
          id: "parent-set:child-b-family",
          kind: "parent-set",
          memberIds: ["child-b", "child-b-partner"],
        },
      ],
      parentChildRelations: [
        {
          id: "child-a-grandchild-a",
          parentId: "child-a",
          childId: "grandchild-a",
          unionId: "parent-set:child-a-family",
          kind: "biological",
        },
        {
          id: "child-a-partner-grandchild-a",
          parentId: "child-a-partner",
          childId: "grandchild-a",
          unionId: "parent-set:child-a-family",
          kind: "biological",
        },
        {
          id: "child-b-grandchild-b",
          parentId: "child-b",
          childId: "grandchild-b",
          unionId: "parent-set:child-b-family",
          kind: "biological",
        },
        {
          id: "child-b-partner-grandchild-b",
          parentId: "child-b-partner",
          childId: "grandchild-b",
          unionId: "parent-set:child-b-family",
          kind: "biological",
        },
      ],
      continuations: [],
      nextFrontier: {
        generation: 2,
        personIds: ["grandchild-a", "grandchild-b"],
      },
      hasMore: false,
      progress: {
        currentGeneration: 1,
        nextGeneration: 2,
        frontierCount: 2,
        pageSize: request.pageSize ?? 100,
        pageNumber: 1,
        returnedDescendantCount: 2,
        returnedPersonCount: 4,
        returnedUnionCount: 4,
        returnedRelationCount: 4,
        frontierComplete: true,
      },
      graphVersion: "v1",
      permissionFingerprint: "member",
    };
  });
  const initialGraph: FamilyGraphData = {
    persons: [{ id: "root", displayName: "root" }],
    unions: [],
    parentChildRelations: [],
    continuations: [],
    graphVersion: "v1",
    permissionFingerprint: "member",
  };

  const loaded = await loadProgressiveDescendantGraph({
    client,
    treeId: "tree",
    rootPersonId: "root",
    maxGenerations: 2,
    pageSize: 200,
    initialGraph,
    yieldControl: async () => undefined,
  });
  const projection = buildAllDescendantsProjection({
    graph: loaded.graph,
    rootPersonId: "root",
  });

  assert.deepEqual(
    requests.map(request => request.frontier),
    [
      { generation: 0, personIds: ["root"] },
      { generation: 1, personIds: ["child-a", "child-b"] },
    ],
  );
  assert.deepEqual(projection.descendantPersonIds, [
    "root",
    "child-a",
    "child-b",
    "grandchild-a",
    "grandchild-b",
  ]);
  assert.deepEqual(projection.connectorPersonIds, [
    "child-a-partner",
    "child-b-partner",
    "partner-a",
    "partner-b",
  ]);
  assert.deepEqual(
    projection.graph.persons.map(person => person.id).sort(),
    [
      "child-a",
      "child-a-partner",
      "child-b",
      "child-b-partner",
      "grandchild-a",
      "grandchild-b",
      "partner-a",
      "partner-b",
      "root",
    ],
  );
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
