import {
  graphVersionsConflict,
  mergeNeighborhood,
  permissionFingerprintsConflict,
  type DescendantFrontierPageRequest,
  type DescendantFrontierPageResponse,
  type FamilyTreeNeighborhoodClient,
} from "./neighborhoodClient.ts";
import type { FamilyGraphData, PersonId } from "../types.ts";

const EMPTY_GRAPH: FamilyGraphData = {
  persons: [],
  unions: [],
  parentChildRelations: [],
  continuations: [],
};

const MAX_FRONTIER_SIZE = 200;
const MAX_PAGE_SIZE = 200;

export interface ProgressiveDescendantState {
  graph: FamilyGraphData;
  loading: boolean;
  canceled: boolean;
  error: Error | undefined;
  loadedPersons: number;
  /** Number of completely loaded descendant generations. */
  loadedGenerations: number;
  pagesLoaded: number;
}

export interface LoadProgressiveDescendantGraphInput {
  client: FamilyTreeNeighborhoodClient;
  treeId: string;
  rootPersonId: PersonId;
  maxGenerations?: number;
  pageSize?: number;
  initialGraph?: FamilyGraphData;
  knownGraphVersion?: string | number;
  permissionFingerprint?: string;
  signal?: AbortSignal;
  onProgress?: (state: ProgressiveDescendantState) => void;
  /** Test seam; production defaults to yielding one task between every page. */
  yieldControl?: (signal?: AbortSignal) => Promise<void>;
}

export class ProgressiveDescendantConflictError extends Error {
  readonly partialState: ProgressiveDescendantState;

  constructor(message: string, partialState: ProgressiveDescendantState) {
    super(message);
    this.name = "ProgressiveDescendantConflictError";
    this.partialState = partialState;
  }
}

export async function loadProgressiveDescendantGraph(
  input: LoadProgressiveDescendantGraphInput,
): Promise<ProgressiveDescendantState> {
  const maxGenerations = normalizedNonNegativeInteger(
    input.maxGenerations,
    100,
  );
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, normalizedNonNegativeInteger(input.pageSize, 100)),
  );
  const initialGraph = withExpectedScope(
    input.initialGraph ?? EMPTY_GRAPH,
    input.knownGraphVersion,
    input.permissionFingerprint,
  );
  let state: ProgressiveDescendantState = {
    graph: initialGraph,
    loading: true,
    canceled: false,
    error: undefined,
    loadedPersons: initialGraph.persons.length,
    loadedGenerations: 0,
    pagesLoaded: 0,
  };
  const traversalSeen = new Set<PersonId>([input.rootPersonId]);
  let frontier: PersonId[] = [input.rootPersonId];
  let currentGeneration = 0;
  const yieldControl = input.yieldControl ?? yieldToMainThread;

  try {
    throwIfAborted(input.signal);
    while (frontier.length && currentGeneration < maxGenerations) {
      const chunks = chunkFrontier(frontier);
      const nextFrontier: PersonId[] = [];

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const personIds = chunks[chunkIndex]!;
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        let chunkComplete = false;

        while (!chunkComplete) {
          throwIfAborted(input.signal);
          const request: DescendantFrontierPageRequest = {
            treeId: input.treeId,
            rootPersonId: input.rootPersonId,
            frontier: { generation: currentGeneration, personIds },
            pageSize,
            ...(cursor ? { cursor } : {}),
            ...(state.graph.graphVersion === undefined
              ? {}
              : { knownGraphVersion: state.graph.graphVersion }),
            ...(state.graph.permissionFingerprint === undefined
              ? {}
              : { permissionFingerprint: state.graph.permissionFingerprint }),
          };
          const response = await input.client.loadDescendantFrontierPage(
            request,
            input.signal,
          );
          throwIfAborted(input.signal);
          assertFrontierResponse(response, request);
          assertCompatibleScope(state, response);

          const graph = mergeNeighborhood(state.graph, response);
          const graphPersonIds = new Set(graph.persons.map(person => person.id));
          for (const childId of response.nextFrontier.personIds) {
            if (!graphPersonIds.has(childId)) {
              throw new Error(
                `Пакет покоління ${response.nextFrontier.generation} не містить даних особи ${childId}.`,
              );
            }
            if (traversalSeen.has(childId)) continue;
            traversalSeen.add(childId);
            nextFrontier.push(childId);
          }

          chunkComplete = !response.hasMore;
          const generationComplete =
            chunkComplete && chunkIndex === chunks.length - 1;
          state = {
            graph,
            loading: true,
            canceled: false,
            error: undefined,
            loadedPersons: graph.persons.length,
            loadedGenerations: generationComplete
              ? response.nextFrontier.generation
              : state.loadedGenerations,
            pagesLoaded: state.pagesLoaded + 1,
          };
          input.onProgress?.(state);
          await yieldControl(input.signal);

          if (!chunkComplete) {
            const nextCursor = response.nextCursor!;
            if (seenCursors.has(nextCursor)) {
              throw new Error("Сервер повторив курсор пакета нащадків.");
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
        }
      }

      frontier = nextFrontier.sort((left, right) => left.localeCompare(right));
      currentGeneration += 1;
    }

    state = { ...state, loading: false };
    input.onProgress?.(state);
    return state;
  } catch (reason) {
    if (input.signal?.aborted || isAbortError(reason)) {
      state = {
        ...state,
        loading: false,
        canceled: true,
        error: undefined,
      };
      input.onProgress?.(state);
      return state;
    }
    const error = reason instanceof Error ? reason : new Error(String(reason));
    state = { ...state, loading: false, error };
    input.onProgress?.(state);
    throw error;
  }
}

function withExpectedScope(
  graph: FamilyGraphData,
  graphVersion: string | number | undefined,
  permissionFingerprint: string | undefined,
): FamilyGraphData {
  return {
    ...graph,
    ...(graph.graphVersion !== undefined || graphVersion === undefined
      ? {}
      : { graphVersion }),
    ...(graph.permissionFingerprint !== undefined ||
    permissionFingerprint === undefined
      ? {}
      : { permissionFingerprint }),
  };
}

function normalizedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value!));
}

function chunkFrontier(frontier: readonly PersonId[]): PersonId[][] {
  const unique = [...new Set(frontier)];
  const chunks: PersonId[][] = [];
  for (let offset = 0; offset < unique.length; offset += MAX_FRONTIER_SIZE) {
    chunks.push(unique.slice(offset, offset + MAX_FRONTIER_SIZE));
  }
  return chunks;
}

function assertFrontierResponse(
  response: DescendantFrontierPageResponse,
  request: DescendantFrontierPageRequest,
): void {
  const progress = response.progress;
  if (
    progress.currentGeneration !== request.frontier.generation ||
    response.nextFrontier.generation !== request.frontier.generation + 1 ||
    progress.nextGeneration !== response.nextFrontier.generation ||
    progress.frontierCount !== request.frontier.personIds.length ||
    progress.pageSize < 1 ||
    progress.pageSize > MAX_PAGE_SIZE ||
    progress.pageNumber < 1 ||
    progress.returnedDescendantCount < 0 ||
    progress.returnedPersonCount < 0 ||
    progress.returnedUnionCount < 0 ||
    progress.returnedRelationCount < 0 ||
    (response.hasMore && !response.nextCursor) ||
    (!response.hasMore && Boolean(response.nextCursor)) ||
    (!response.hasMore && !progress.frontierComplete)
  ) {
    throw new Error("Сервер повернув неузгоджений пакет покоління нащадків.");
  }
}

function assertCompatibleScope(
  state: ProgressiveDescendantState,
  response: DescendantFrontierPageResponse,
): void {
  if (
    graphVersionsConflict(state.graph.graphVersion, response.graphVersion)
  ) {
    throw new ProgressiveDescendantConflictError(
      "Версія родового графа змінилася під час завантаження нащадків.",
      state,
    );
  }
  if (
    permissionFingerprintsConflict(
      state.graph.permissionFingerprint,
      response.permissionFingerprint,
    )
  ) {
    throw new ProgressiveDescendantConflictError(
      "Доступ до родового графа змінився під час завантаження нащадків.",
      state,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== "undefined") {
    throw new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}

function yieldToMainThread(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 0);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (typeof DOMException !== "undefined") {
        reject(new DOMException("Aborted", "AbortError"));
      } else {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
