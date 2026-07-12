export interface ImportBatchOptions {
  maxItems?: number;
  maxBytes?: number;
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
