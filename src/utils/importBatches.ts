import { isDatabaseStatementTimeout } from "./databaseErrors.ts";

export interface ImportBatchOptions {
  maxItems?: number;
  maxBytes?: number;
}

export interface ImportBatchProgress {
  completedBatches: number;
  totalBatches: number;
  processedItems: number;
  totalItems: number;
}

export interface RunImportBatchesOptions {
  concurrency?: number;
  onProgress?: (progress: ImportBatchProgress) => void;
}

export interface AdaptiveImportBatchOptions {
  /** Number of retries after the first transient infrastructure failure. */
  maxTransientRetries?: number;
  /** Base delay used for bounded exponential backoff. */
  retryDelayMs?: number;
  /** Timeout-prone batches are split until this row count is reached. */
  minBatchItems?: number;
}

export type ImportPhase =
  | "persons"
  | "relations"
  | "documents"
  | "year-matrix"
  | "tasks"
  | "task-person-delete"
  | "task-person-insert"
  | "findings"
  | "finding-participant-delete"
  | "finding-participant-upsert";

export interface ImportPhaseProgress extends ImportBatchProgress {
  phase: ImportPhase;
}

export interface ImportPhaseProgressOptions {
  onProgress?: (progress: ImportPhaseProgress) => void;
}

export const DEFAULT_IMPORT_BATCH_ITEMS = 200;
export const DEFAULT_IMPORT_BATCH_BYTES = 500_000;
export const FINDING_IMPORT_BATCH_ITEMS = 50;
export const FINDING_IMPORT_BATCH_BYTES = 250_000;
export const PERSON_IMPORT_BATCH_ITEMS = 100;
export const PERSON_IMPORT_BATCH_BYTES = 250_000;
export const RELATION_IMPORT_BATCH_ITEMS = 100;
export const RELATION_IMPORT_BATCH_BYTES = 250_000;

const utf8Encoder = new TextEncoder();

/**
 * Splits PostgREST mutation payloads by both row count and serialized UTF-8 size.
 * A single oversized row is kept intact so callers can surface the database error
 * without silently dropping or truncating genealogical data.
 */
export function chunkImportRows<T>(
  rows: readonly T[],
  options: ImportBatchOptions = {},
): T[][] {
  const maxItems = options.maxItems ?? DEFAULT_IMPORT_BATCH_ITEMS;
  const maxBytes = options.maxBytes ?? DEFAULT_IMPORT_BATCH_BYTES;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new RangeError("Import batch maxItems must be a positive integer.");
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 2) {
    throw new RangeError("Import batch maxBytes must be at least 2.");
  }

  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 2; // JSON array brackets.

  for (const row of rows) {
    const serialized = JSON.stringify(row) ?? "null";
    const rowBytes = utf8Encoder.encode(serialized).byteLength;
    const addedBytes = rowBytes + (batch.length ? 1 : 0); // JSON comma.
    if (batch.length && (batch.length >= maxItems || batchBytes + addedBytes > maxBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(row);
    batchBytes += rowBytes + (batch.length > 1 ? 1 : 0);
  }

  if (batch.length) batches.push(batch);
  return batches;
}

export function chunkFindingImportRows<T>(rows: readonly T[]): T[][] {
  return chunkImportRows(rows, {
    maxItems: FINDING_IMPORT_BATCH_ITEMS,
    maxBytes: FINDING_IMPORT_BATCH_BYTES,
  });
}

export function chunkPersonImportRows<T>(rows: readonly T[]): T[][] {
  return chunkImportRows(rows, {
    maxItems: PERSON_IMPORT_BATCH_ITEMS,
    maxBytes: PERSON_IMPORT_BATCH_BYTES,
  });
}

export function chunkRelationImportRows<T>(rows: readonly T[]): T[][] {
  return chunkImportRows(rows, {
    maxItems: RELATION_IMPORT_BATCH_ITEMS,
    maxBytes: RELATION_IMPORT_BATCH_BYTES,
  });
}

function transientErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLocaleLowerCase();
  if (typeof error === "string") return error.toLocaleLowerCase();
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const record = error as Record<string, unknown>;
  return [record.code, record.message, record.details, record.hint, record.status, record.statusCode]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLocaleLowerCase();
}

/**
 * Restricts automatic retries to database/network failures that are safe for
 * idempotent upserts. Validation, uniqueness and permission errors must reach
 * the caller immediately instead of being hidden behind repeated requests.
 */
export function isTransientImportError(error: unknown): boolean {
  if (isDatabaseStatementTimeout(error)) return true;
  const text = transientErrorText(error);
  const status = error && typeof error === "object"
    ? Number((error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode)
    : Number.NaN;
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  return /(^|\s)(08000|08001|08003|08004|08006|08007|08p01|40001|40p01|53300|55p03|57p01|57p02|57p03|pgrst000|pgrst001|pgrst002|pgrst003)(\s|$)/i.test(text)
    || text.includes("failed to fetch")
    || text.includes("fetch failed")
    || text.includes("load failed")
    || text.includes("networkerror")
    || text.includes("network request failed")
    || text.includes("connection reset")
    || text.includes("connection terminated")
    || text.includes("service unavailable")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("temporarily unavailable");
}

function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Lets React paint progress and process input between network mutations. */
async function yieldImportControl(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Persists one logical batch using an idempotent worker. Statement timeouts are
 * handled by recursively reducing the amount of trigger work in one database
 * statement. Short infrastructure failures retry the same upsert with bounded
 * backoff. The outer batch resolves only after every split succeeds, which
 * keeps existing progress counters monotonic and retry-safe.
 */
export async function runAdaptiveImportBatch<T>(
  batch: readonly T[],
  worker: (items: T[]) => Promise<void>,
  options: AdaptiveImportBatchOptions = {},
): Promise<void> {
  if (!batch.length) return;
  const maxTransientRetries = options.maxTransientRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const minBatchItems = options.minBatchItems ?? 1;
  if (!Number.isInteger(maxTransientRetries) || maxTransientRetries < 0) {
    throw new RangeError("Import retry count must be a non-negative integer.");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("Import retry delay must be non-negative.");
  }
  if (!Number.isInteger(minBatchItems) || minBatchItems < 1) {
    throw new RangeError("Adaptive import minBatchItems must be a positive integer.");
  }

  const execute = async (items: readonly T[]): Promise<void> => {
    let transientAttempts = 0;
    while (true) {
      try {
        await worker([...items]);
        await yieldImportControl();
        return;
      } catch (error) {
        if (isDatabaseStatementTimeout(error) && items.length >= minBatchItems * 2) {
          const splitAt = Math.floor(items.length / 2);
          await waitForRetry(retryDelayMs);
          await execute(items.slice(0, splitAt));
          await execute(items.slice(splitAt));
          return;
        }
        if (!isTransientImportError(error) || transientAttempts >= maxTransientRetries) {
          throw error;
        }
        const delay = retryDelayMs * (2 ** transientAttempts);
        transientAttempts += 1;
        await waitForRetry(delay);
      }
    }
  };

  await execute(batch);
}

/**
 * Runs mutation batches with bounded concurrency. Progress is emitted only
 * after a batch succeeds, so all counters are monotonic and never over-report
 * persisted rows.
 */
export async function runImportBatches<T>(
  batches: readonly T[][],
  worker: (batch: T[], batchIndex: number) => Promise<void>,
  options: RunImportBatchesOptions = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Import batch concurrency must be a positive integer.");
  }
  if (!batches.length) return;

  const totalBatches = batches.length;
  const totalItems = batches.reduce((sum, batch) => sum + batch.length, 0);
  let nextBatchIndex = 0;
  let completedBatches = 0;
  let processedItems = 0;
  let hasError = false;
  let firstError: unknown;

  const runWorker = async () => {
    while (!hasError) {
      const batchIndex = nextBatchIndex;
      if (batchIndex >= totalBatches) return;
      nextBatchIndex += 1;
      const batch = batches[batchIndex];
      try {
        await worker(batch, batchIndex);
      } catch (error) {
        hasError = true;
        firstError = error;
        return;
      }
      completedBatches += 1;
      processedItems += batch.length;
      options.onProgress?.({
        completedBatches,
        totalBatches,
        processedItems,
        totalItems,
      });
      await yieldImportControl();
    }
  };

  const workerCount = Math.min(concurrency, totalBatches);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (hasError) throw firstError;
}

export function withImportPhase(
  phase: ImportPhase,
  onProgress?: ImportPhaseProgressOptions["onProgress"],
): RunImportBatchesOptions["onProgress"] {
  if (!onProgress) return undefined;
  return (progress) => onProgress({ phase, ...progress });
}
