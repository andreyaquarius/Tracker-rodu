import { getSupabaseClient } from "./supabaseAuth.ts";

export type GedcomImportOperationState =
  | "preparing"
  | "importing"
  | "rolling_back"
  | "completed"
  | "rolled_back";

export type GedcomImportEntityType =
  | "finding"
  | "person_relation"
  | "document"
  | "person";

export interface GedcomImportOperationStatus {
  operationId: string;
  projectId: string;
  status: GedcomImportOperationState;
  registeredRows: number;
  rolledBackRows: number;
  remainingRows: number;
}

export interface PrepareGedcomImportOperationInput {
  projectId: string;
  sourceKey: string;
  personIds: readonly string[];
  relationIds: readonly string[];
  documentIds: readonly string[];
  findingIds: readonly string[];
}

const REGISTRATION_BATCH_SIZE = 1_000;
const ROLLBACK_BATCH_SIZE = 500;
const ROLLBACK_FOREGROUND_BUDGET_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const BATCH_FENCE_INTERVAL_MS = 5_000;
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

export function parseGedcomImportOperationStatus(value: unknown): GedcomImportOperationStatus {
  const record = asRecord(value);
  const operationId = text(record?.operationId);
  const projectId = text(record?.projectId);
  const status = text(record?.status);
  if (
    !operationId
    || !projectId
    || !["preparing", "importing", "rolling_back", "completed", "rolled_back"].includes(status)
  ) {
    throw new Error("Сервер повернув некоректний стан GEDCOM-імпорту.");
  }
  return {
    operationId,
    projectId,
    status: status as GedcomImportOperationState,
    registeredRows: count(record?.registeredRows),
    rolledBackRows: count(record?.rolledBackRows),
    remainingRows: count(record?.remainingRows),
  };
}

async function callOperationRpc(
  functionName: string,
  args: Record<string, unknown>,
): Promise<GedcomImportOperationStatus> {
  const { data, error } = await getSupabaseClient().rpc(functionName, args);
  if (error) throw error;
  return parseGedcomImportOperationStatus(data);
}

function chunks<T>(items: readonly T[], size = REGISTRATION_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function registerEntityIds(
  operationId: string,
  entityType: GedcomImportEntityType,
  ids: readonly string[],
): Promise<void> {
  for (const batch of chunks(Array.from(new Set(ids.filter(Boolean))))) {
    await callOperationRpc("register_gedcom_import_entities", {
      target_operation_id: operationId,
      target_entity_type: entityType,
      target_entity_ids: batch,
    });
  }
}

/**
 * Creates and fully seals the rollback journal before the first entity write.
 * A browser crash while this function is registering IDs cannot leave imported
 * entities behind because persistence has not started yet.
 */
export async function prepareGedcomImportOperation(
  input: PrepareGedcomImportOperationInput,
): Promise<GedcomImportOperationStatus> {
  const started = await callOperationRpc("start_gedcom_import_operation", {
    target_project_id: input.projectId,
    target_source_key: input.sourceKey,
  });
  try {
    await registerEntityIds(started.operationId, "person", input.personIds);
    await registerEntityIds(started.operationId, "person_relation", input.relationIds);
    await registerEntityIds(started.operationId, "document", input.documentIds);
    await registerEntityIds(started.operationId, "finding", input.findingIds);
    return await callOperationRpc("seal_gedcom_import_operation", {
      target_operation_id: started.operationId,
    });
  } catch (error) {
    // No entity persistence has started yet. One awaited rollback page marks
    // the operation recoverable; the scheduled worker drains any remaining
    // partially registered journal rows.
    try {
      await rollbackGedcomImportOperation(started.operationId);
    } catch (rollbackError) {
      // Preserve the original preparation error. The durable operation stays
      // eligible for the scheduled cleanup worker.
      console.error("GEDCOM import preparation rollback failed", {
        operationId: started.operationId,
        rollbackError,
      });
    }
    throw error;
  }
}

export function startGedcomImportHeartbeat(operationId: string): void {
  stopGedcomImportHeartbeat(operationId);
  const timer = setInterval(() => {
    void touchGedcomImportOperation(operationId).catch((error) => {
      // A transient heartbeat failure must not abort an otherwise healthy
      // batch. The 15 minute server grace period tolerates many missed beats.
      console.warn("GEDCOM import heartbeat failed", { operationId, error });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimers.set(operationId, timer);
}

export function stopGedcomImportHeartbeat(operationId: string): void {
  const timer = heartbeatTimers.get(operationId);
  if (timer !== undefined) clearInterval(timer);
  heartbeatTimers.delete(operationId);
}

export async function touchGedcomImportOperation(
  operationId: string,
): Promise<GedcomImportOperationStatus> {
  return callOperationRpc("touch_gedcom_import_operation", {
    target_operation_id: operationId,
  });
}

/**
 * Returns an awaited pre-batch fence shared by all concurrent import workers.
 * It validates immediately on the first batch and after a suspended tab
 * resumes, while coalescing healthy imports to at most one RPC per five
 * seconds. Database row triggers provide the atomic fence for newly journaled
 * entities; this lease also stops late updates to reconciled existing rows.
 */
export function createGedcomImportBatchFence(
  operationId: string,
): () => Promise<void> {
  let lastCheckedAt = 0;
  let inFlight: Promise<void> | null = null;
  return async () => {
    if (Date.now() - lastCheckedAt < BATCH_FENCE_INTERVAL_MS) return;
    if (!inFlight) {
      inFlight = touchGedcomImportOperation(operationId)
        .then(() => {
          lastCheckedAt = Date.now();
        })
        .finally(() => {
          inFlight = null;
        });
    }
    await inFlight;
  };
}

export async function registerGedcomImportTree(
  operationId: string,
  treeId: string,
): Promise<GedcomImportOperationStatus> {
  return callOperationRpc("register_gedcom_import_tree", {
    target_operation_id: operationId,
    target_tree_id: treeId,
  });
}

export async function registerGedcomImportArchive(
  operationId: string,
  importBatchId: string,
): Promise<GedcomImportOperationStatus> {
  return callOperationRpc("register_gedcom_import_archive", {
    target_operation_id: operationId,
    target_import_batch_id: importBatchId,
  });
}

export async function completeGedcomImportOperation(
  operationId: string,
): Promise<GedcomImportOperationStatus> {
  try {
    return await callOperationRpc("complete_gedcom_import_operation", {
      target_operation_id: operationId,
    });
  } finally {
    stopGedcomImportHeartbeat(operationId);
  }
}

export async function rollbackGedcomImportOperation(
  operationId: string,
): Promise<GedcomImportOperationStatus> {
  stopGedcomImportHeartbeat(operationId);
  return callOperationRpc("rollback_gedcom_import_operation", {
    target_operation_id: operationId,
    batch_size: ROLLBACK_BATCH_SIZE,
  });
}

/**
 * Rolls back as much as possible while the error dialog is still open. If a
 * very large cleanup exceeds the foreground budget, its durable operation is
 * left in `rolling_back`; the scheduled server worker resumes the next batch.
 */
export async function rollbackGedcomImportOperationToCompletion(
  operationId: string,
  maxDurationMs = ROLLBACK_FOREGROUND_BUDGET_MS,
): Promise<GedcomImportOperationStatus> {
  const deadline = Date.now() + Math.max(0, maxDurationMs);
  let result = await rollbackGedcomImportOperation(operationId);
  while (result.status !== "rolled_back" && result.status !== "completed" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    result = await rollbackGedcomImportOperation(operationId);
  }
  return result;
}
