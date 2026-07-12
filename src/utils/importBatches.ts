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
