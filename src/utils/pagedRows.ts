export type PagedRangeRequest<T> = {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

export type CursorPageRequest<T> = {
  gt: (column: string, value: string) => CursorPageRequest<T>;
  limit: (
    count: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

export type UpdatedCursorPageRequest<T> = {
  or: (filter: string) => UpdatedCursorPageRequest<T>;
  limit: (count: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

/** Matches ORDER BY updated_at DESC, id ASC, without growing OFFSET scans. */
export async function selectRowsByUpdatedCursor<T extends { id: string; updated_at: string }>(
  request: () => UpdatedCursorPageRequest<T>,
  batchSize = 1_000,
): Promise<T[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("Invalid cursor batch size.");
  const rows = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: T | undefined;
  for (;;) {
    let page = request();
    if (cursor) {
      // JSON quoting escapes PostgREST reserved characters; never interpolate
      // user input into the filter language. Values come from the last DB row.
      const date = JSON.stringify(cursor.updated_at);
      const id = JSON.stringify(cursor.id);
      page = page.or(`updated_at.lt.${date},and(updated_at.eq.${date},id.gt.${id})`);
    }
    const { data, error } = await page.limit(batchSize);
    if (error) throw error;
    const batch = data ?? [];
    for (const row of batch) if (!rows.has(row.id)) rows.set(row.id, row);
    if (batch.length < batchSize) return [...rows.values()];
    cursor = batch[batch.length - 1];
    const key = JSON.stringify([cursor.updated_at, cursor.id]);
    if (!cursor.updated_at || !cursor.id || cursors.has(key)) throw new Error("Cursor pagination did not advance.");
    cursors.add(key);
  }
}

/** Fetches independent range builders in bounded parallel windows. */
export async function selectRowsInParallel<T>(
  request: () => PagedRangeRequest<T>,
  batchSize = 1_000,
  concurrency = 3,
): Promise<T[]> {
  const rows: T[] = [];
  const windowSize = batchSize * concurrency;
  for (let windowStart = 0; ; windowStart += windowSize) {
    const batches = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const from = windowStart + index * batchSize;
        const to = from + batchSize - 1;
        const { data, error } = await request().range(from, to);
        if (error) throw error;
        return data ?? [];
      }),
    );
    for (const batch of batches) rows.push(...batch);
    if (batches.some((batch) => batch.length < batchSize)) break;
  }
  return rows;
}

/**
 * Reads a stable ascending cursor without increasingly expensive SQL OFFSETs.
 * The cursor column must be unique in the already-filtered result set.
 */
export async function selectRowsByCursor<T>(
  request: () => CursorPageRequest<T>,
  cursorColumn: string,
  cursorValue: (row: T) => string,
  batchSize = 1_000,
): Promise<T[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("Cursor page batchSize must be a positive integer.");
  }

  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let page = request();
    if (cursor !== null) page = page.gt(cursorColumn, cursor);
    const { data, error } = await page.limit(batchSize);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < batchSize) break;

    const nextCursor = cursorValue(batch[batch.length - 1]);
    if (!nextCursor || nextCursor === cursor) {
      throw new Error("Cursor pagination did not advance.");
    }
    cursor = nextCursor;
  }
  return rows;
}
