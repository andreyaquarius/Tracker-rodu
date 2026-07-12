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
