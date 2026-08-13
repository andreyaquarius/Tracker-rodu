import {
  mergeCanonicalAncestorKinship,
  mergeCanonicalFamilyOrder,
  pedigreeRanksFromAncestorOrderRows,
  type PersonPedigreeAncestorOrderRow,
} from "../utils/personPedigreeOrder.ts";
import type {
  PersonKinshipDescriptor,
  PersonKinshipKind,
} from "../utils/personKinship.ts";
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
  kinshipByPersonId: ReadonlyMap<string, PersonKinshipDescriptor>;
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
  kinshipByPersonId: new Map(),
};

const PEDIGREE_ORDER_CACHE_TTL_MS = 10 * 60 * 1000;
const PEDIGREE_ORDER_CACHE_VERSION = "canonical-direct-ancestors-v2";
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
  const client = getSupabaseClient();
  const rpcArguments = {
    target_tree_id: entry.id,
    target_root_person_id: rootPersonId,
  };
  const [ancestorResult, kinshipResult] = await Promise.all([
    client.rpc("list_family_tree_direct_ancestor_order_v1", rpcArguments),
    client.rpc("list_family_tree_root_kinship_v1", rpcArguments),
  ]);

  // The complete direct-ancestor traversal is the canonical source for the
  // catalogue segment and Ahnentafel ordering. The broader kinship traversal
  // is intentionally used only to enrich labels for descendants, collateral
  // and affinal relatives; it must never redefine who is a direct ancestor.
  if (!ancestorResult.error) {
    const ancestorRows = assertAncestorOrderRows(ancestorResult.data);
    const canonicalRanks = pedigreeRanksFromAncestorOrderRows(rootPersonId, ancestorRows);
    const canonicalKinship = ancestorKinshipMap(rootPersonId, ancestorRows);

    if (!kinshipResult.error) {
      const broaderKinship = kinshipMapFromRows(assertKinshipRows(kinshipResult.data));
      const kinshipByPersonId = mergeCanonicalAncestorKinship(
        broaderKinship,
        canonicalKinship,
      );
      return {
        treeId: entry.id,
        rootPersonId,
        familyOrder: mergeCanonicalFamilyOrder(
          canonicalRanks.familyOrder,
          pedigreeOrderFromKinship(rootPersonId, kinshipByPersonId).familyOrder,
        ),
        directAncestorIds: canonicalRanks.directAncestorIds,
        kinshipByPersonId,
      };
    }
    // Relationship-label enrichment is optional. A transient or rolling-
    // deployment failure of the broader graph must not hide a valid canonical
    // ancestor list or mark the tree as unavailable in the Persons module.
    return {
      treeId: entry.id,
      rootPersonId,
      ...canonicalRanks,
      kinshipByPersonId: canonicalKinship,
    };
  }

  // Compatibility during a rolling deployment in which the newer complete
  // ancestor RPC is not available yet. Other server errors stay visible so a
  // partial kinship result cannot silently produce a smaller ancestor count.
  if (!isMissingDirectAncestorFunctionError(ancestorResult.error)) {
    throw ancestorResult.error;
  }
  if (kinshipResult.error) throw kinshipResult.error;
  const kinshipByPersonId = kinshipMapFromRows(assertKinshipRows(kinshipResult.data));
  return {
    treeId: entry.id,
    rootPersonId,
    ...pedigreeOrderFromKinship(rootPersonId, kinshipByPersonId),
    kinshipByPersonId,
  };
}

interface PersonKinshipRow {
  person_id: string;
  kinship_kind: PersonKinshipKind;
  up_steps: number | string;
  down_steps: number | string;
  partner_steps: number | string;
  order_path: string;
  via_person_id: string | null;
}

function assertKinshipRows(value: unknown): PersonKinshipRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Сервер повернув некоректний список спорідненості.");
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Сервер повернув некоректний запис спорідненості.");
    }
    const row = candidate as Partial<PersonKinshipRow>;
    const upSteps = Number(row.up_steps);
    const downSteps = Number(row.down_steps);
    const partnerSteps = Number(row.partner_steps);
    const kinds: readonly PersonKinshipKind[] = ["root", "ancestor", "descendant", "collateral", "affinal"];
    if (
      typeof row.person_id !== "string"
      || !row.person_id.trim()
      || !kinds.includes(row.kinship_kind as PersonKinshipKind)
      || !Number.isInteger(upSteps)
      || upSteps < 0
      || !Number.isInteger(downSteps)
      || downSteps < 0
      || !Number.isInteger(partnerSteps)
      || partnerSteps < 0
      || typeof row.order_path !== "string"
      || (row.via_person_id !== null && row.via_person_id !== undefined && typeof row.via_person_id !== "string")
    ) {
      throw new Error("Сервер повернув неповний запис спорідненості.");
    }
    return {
      person_id: row.person_id,
      kinship_kind: row.kinship_kind as PersonKinshipKind,
      up_steps: upSteps,
      down_steps: downSteps,
      partner_steps: partnerSteps,
      order_path: row.order_path,
      via_person_id: row.via_person_id ?? null,
    };
  });
}

function kinshipMapFromRows(rows: readonly PersonKinshipRow[]): ReadonlyMap<string, PersonKinshipDescriptor> {
  return new Map(rows.map((row) => [row.person_id, {
    kind: row.kinship_kind,
    upSteps: Number(row.up_steps),
    downSteps: Number(row.down_steps),
    partnerSteps: Number(row.partner_steps),
    orderPath: row.order_path,
    viaPersonId: row.via_person_id ?? undefined,
  }]));
}

function pedigreeOrderFromKinship(
  rootPersonId: string,
  kinshipByPersonId: ReadonlyMap<string, PersonKinshipDescriptor>,
): Pick<ProjectPersonPedigreeOrder, "familyOrder" | "directAncestorIds"> {
  const orderedIds = [...kinshipByPersonId]
    .sort(([firstId, first], [secondId, second]) => (
      kinshipPriority(first) - kinshipPriority(second)
      || first.upSteps + first.downSteps + first.partnerSteps - (second.upSteps + second.downSteps + second.partnerSteps)
      || first.upSteps - second.upSteps
      || compareCodePoints(first.orderPath, second.orderPath)
      || compareCodePoints(firstId, secondId)
    ))
    .map(([personId]) => personId);
  if (!orderedIds.includes(rootPersonId)) orderedIds.unshift(rootPersonId);
  return {
    familyOrder: new Map(orderedIds.map((personId, index) => [personId, index])),
    directAncestorIds: new Set(
      [...kinshipByPersonId]
        .filter(([, kinship]) => kinship.kind === "ancestor")
        .map(([personId]) => personId),
    ),
  };
}

function ancestorKinshipMap(
  rootPersonId: string,
  rows: readonly PersonPedigreeAncestorOrderRow[],
): ReadonlyMap<string, PersonKinshipDescriptor> {
  const result = new Map<string, PersonKinshipDescriptor>([[rootPersonId, {
    kind: "root",
    upSteps: 0,
    downSteps: 0,
    partnerSteps: 0,
    orderPath: "",
  }]]);
  for (const row of rows) {
    const personId = row.person_id.trim();
    const generation = Number(row.generation);
    if (!personId || personId === rootPersonId || !Number.isInteger(generation) || generation < 1) continue;
    const next: PersonKinshipDescriptor = {
      kind: "ancestor",
      upSteps: generation,
      downSteps: 0,
      partnerSteps: 0,
      orderPath: row.order_path,
    };
    const current = result.get(personId);
    if (!current || next.upSteps < current.upSteps || (
      next.upSteps === current.upSteps && next.orderPath < current.orderPath
    )) {
      result.set(personId, next);
    }
  }
  return result;
}

function kinshipPriority(value: PersonKinshipDescriptor): number {
  if (value.kind === "root") return 0;
  if (value.kind === "ancestor") return 1;
  if (value.kind === "collateral") return 2;
  if (value.kind === "descendant") return 3;
  return 4;
}

function isMissingDirectAncestorFunctionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? "").toUpperCase();
  const message = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("en");
  return code === "PGRST202"
    || (message.includes("list_family_tree_direct_ancestor_order_v1") && (
      message.includes("not find")
      || message.includes("does not exist")
      || message.includes("schema cache")
    ));
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
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
  return [PEDIGREE_ORDER_CACHE_VERSION, projectId, cacheScope].join("\u001f");
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
