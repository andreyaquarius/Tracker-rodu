export type PagedRangeRequest<T> = {
  range: (
    from: number,
    to: number,
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
