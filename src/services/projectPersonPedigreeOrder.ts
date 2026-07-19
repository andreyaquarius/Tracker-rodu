import {
  buildCircularAncestorChartModel,
  MAX_CIRCULAR_ANCESTOR_GENERATIONS,
} from "../features/family-tree-view/circular/circularAncestorChartLayout.ts";
import { pedigreeRanksFromOccurrences } from "../utils/personPedigreeOrder.ts";
import {
  createTrackerNeighborhoodClient,
  readFamilyTreeEntryPoints,
  type FamilyTreeEntryPoint,
} from "./familyTreeNeighborhoodService.ts";

export interface ProjectPersonPedigreeContext {
  treeId: string;
  rootPersonId: string;
}

export interface ProjectPersonPedigreeOrder extends ProjectPersonPedigreeContext {
  familyOrder: ReadonlyMap<string, number>;
  directAncestorIds: ReadonlySet<string>;
}

export interface ProjectPersonPedigreeLoadOptions {
  signal?: AbortSignal;
  cacheScope?: string;
}

const EMPTY_PEDIGREE_ORDER: ProjectPersonPedigreeOrder = {
  treeId: "",
  rootPersonId: "",
  familyOrder: new Map(),
  directAncestorIds: new Set(),
};

const PEDIGREE_ORDER_CACHE_TTL_MS = 10 * 60 * 1000;
const pedigreeOrderCache = new Map<string, {
  value: ProjectPersonPedigreeOrder;
  expiresAt: number;
}>();
const pedigreeOrderRequests = new Map<string, Promise<ProjectPersonPedigreeOrder>>();
const pedigreeCacheRevisions = new Map<string, number>();

export function readCachedProjectPersonPedigreeOrder(
  projectId: string,
  requestedContext?: ProjectPersonPedigreeContext,
  cacheScope = "",
): ProjectPersonPedigreeOrder | null {
  const key = pedigreeCacheKey(projectId, requestedContext, cacheScope);
  const cached = pedigreeOrderCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    pedigreeOrderCache.delete(key);
    return null;
  }
  return cached.value;
}

export function invalidateProjectPersonPedigreeOrder(
  projectId: string,
  cacheScope = "",
): void {
  const namespace = pedigreeCacheNamespace(projectId, cacheScope);
  pedigreeCacheRevisions.set(namespace, (pedigreeCacheRevisions.get(namespace) ?? 0) + 1);
}

/**
 * Loads the same canonical, privacy-filtered ancestor neighborhood that powers
 * the circular chart and converts its Ahnentafel slots into catalogue ranks.
 */
export async function loadProjectPersonPedigreeOrder(
  projectId: string,
  requestedContext?: ProjectPersonPedigreeContext,
  options: ProjectPersonPedigreeLoadOptions = {},
): Promise<ProjectPersonPedigreeOrder> {
  const requestKey = pedigreeCacheKey(projectId, requestedContext, options.cacheScope);
  const cached = readCachedProjectPersonPedigreeOrder(
    projectId,
    requestedContext,
    options.cacheScope,
  );
  if (cached) return cached;

  const pending = pedigreeOrderRequests.get(requestKey)
    ?? createProjectPersonPedigreeOrderRequest(
      projectId,
      requestedContext,
      requestKey,
      options.cacheScope,
    );
  return waitForPedigreeOrder(pending, options.signal);
}

async function createProjectPersonPedigreeOrderRequest(
  projectId: string,
  requestedContext: ProjectPersonPedigreeContext | undefined,
  requestKey: string,
  cacheScope = "",
): Promise<ProjectPersonPedigreeOrder> {
  const request = fetchProjectPersonPedigreeOrder(projectId, requestedContext)
    .then((value) => {
      // A missing tree/root is expected during first-project setup. It must not
      // become a sticky cache entry after the user creates or imports a tree.
      if (value.treeId && value.rootPersonId) {
        const cached = { value, expiresAt: Date.now() + PEDIGREE_ORDER_CACHE_TTL_MS };
        pedigreeOrderCache.set(requestKey, cached);
        pedigreeOrderCache.set(pedigreeCacheKey(projectId, value, cacheScope), cached);
      }
      return value;
    })
    .finally(() => {
      pedigreeOrderRequests.delete(requestKey);
    });
  pedigreeOrderRequests.set(requestKey, request);
  return request;
}

async function fetchProjectPersonPedigreeOrder(
  projectId: string,
  requestedContext?: ProjectPersonPedigreeContext,
): Promise<ProjectPersonPedigreeOrder> {
  const entries = await readFamilyTreeEntryPoints(projectId);
  const entry = selectPedigreeEntry(entries, requestedContext?.treeId);
  if (!entry?.rootPersonId) return EMPTY_PEDIGREE_ORDER;

  // The persisted tree root is authoritative. Temporary focus changes in the
  // workspace and circular chart must never change catalogue ordering.
  const rootPersonId = entry.rootPersonId;
  const client = createTrackerNeighborhoodClient();
  const graph = await client.load({
    treeId: entry.id,
    focusPersonId: rootPersonId,
    ancestorDepth: MAX_CIRCULAR_ANCESTOR_GENERATIONS,
    descendantDepth: 0,
    collateralDepth: 0,
    maxNodes: 600,
    // Catalogue sorting only needs the persisted root and its ancestor links.
    // Avoid calculating expandable branch metadata in the background while a
    // person card is navigating to the tree.
    structuralOnly: true,
  });
  const model = buildCircularAncestorChartModel(
    graph,
    rootPersonId,
    MAX_CIRCULAR_ANCESTOR_GENERATIONS,
  );
  return createPedigreeOrder(entry.id, rootPersonId, model.occurrences);
}

function createPedigreeOrder(
  treeId: string,
  rootPersonId: string,
  occurrences: readonly { personId: string; slot: number }[],
): ProjectPersonPedigreeOrder {
  return { treeId, rootPersonId, ...pedigreeRanksFromOccurrences(rootPersonId, occurrences) };
}

function pedigreeCacheKey(
  projectId: string,
  context?: ProjectPersonPedigreeContext,
  cacheScope = "",
): string {
  const namespace = pedigreeCacheNamespace(projectId, cacheScope);
  const revision = pedigreeCacheRevisions.get(namespace) ?? 0;
  return [namespace, revision, context?.treeId ?? "", context?.rootPersonId ?? ""].join("\u001f");
}

function pedigreeCacheNamespace(projectId: string, cacheScope: string): string {
  return [projectId, cacheScope].join("\u001f");
}

function waitForPedigreeOrder(
  request: Promise<ProjectPersonPedigreeOrder>,
  signal?: AbortSignal,
): Promise<ProjectPersonPedigreeOrder> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function selectPedigreeEntry(
  entries: readonly FamilyTreeEntryPoint[],
  requestedTreeId?: string,
): FamilyTreeEntryPoint | null {
  return entries.find((entry) => entry.id === requestedTreeId)
    ?? entries.find((entry) => entry.isDefault)
    ?? entries[0]
    ?? null;
}

function abortError(): Error {
  const error = new Error("Pedigree order loading was aborted.");
  error.name = "AbortError";
  return error;
}
