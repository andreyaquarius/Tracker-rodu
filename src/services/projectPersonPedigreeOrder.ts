import {
  pedigreeRanksFromAncestorOrderRows,
  type PersonPedigreeAncestorOrderRow,
} from "../utils/personPedigreeOrder.ts";
import {
  readFamilyTreeEntryPoints,
  type FamilyTreeEntryPoint,
} from "./familyTreeNeighborhoodService.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

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
 * Loads the complete canonical, privacy-filtered ancestor order for the
 * persisted tree root. Catalogue ordering is intentionally independent from
 * the bounded graph used by interactive tree visualisations.
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
  const { data, error } = await getSupabaseClient().rpc(
    "list_family_tree_direct_ancestor_order_v1",
    {
      target_tree_id: entry.id,
      target_root_person_id: rootPersonId,
    },
  );
  if (error) throw error;
  const ranks = pedigreeRanksFromAncestorOrderRows(
    rootPersonId,
    assertAncestorOrderRows(data),
  );
  return {
    treeId: entry.id,
    rootPersonId,
    ...ranks,
  };
}

function assertAncestorOrderRows(value: unknown): PersonPedigreeAncestorOrderRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Сервер повернув некоректний порядок прямих предків.");
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Сервер повернув некоректний запис прямого предка.");
    }
    const row = candidate as Partial<PersonPedigreeAncestorOrderRow>;
    const generation = Number(row.generation);
    if (
      typeof row.person_id !== "string" ||
      !row.person_id.trim() ||
      !Number.isInteger(generation) ||
      generation < 0 ||
      typeof row.order_path !== "string"
    ) {
      throw new Error("Сервер повернув неповний запис прямого предка.");
    }
    return {
      person_id: row.person_id,
      generation,
      order_path: row.order_path,
    };
  });
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
