export type ProductAnalyticsDurationBucket =
  | "lt_1s"
  | "1_3s"
  | "3_10s"
  | "10_30s"
  | "30_120s"
  | "gte_120s";

export type ProductAnalyticsCountBucket =
  | "1_100"
  | "101_500"
  | "501_2000"
  | "2001_10000"
  | "gte_10001";

export function productAnalyticsDurationBucket(
  durationMs: number,
): ProductAnalyticsDurationBucket {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (safeDuration < 1_000) return "lt_1s";
  if (safeDuration < 3_000) return "1_3s";
  if (safeDuration < 10_000) return "3_10s";
  if (safeDuration < 30_000) return "10_30s";
  if (safeDuration < 120_000) return "30_120s";
  return "gte_120s";
}

export function productAnalyticsCountBucket(
  count: number | null | undefined,
): ProductAnalyticsCountBucket | null {
  if (count === null || count === undefined || !Number.isFinite(count) || count < 1) {
    return null;
  }
  if (count <= 100) return "1_100";
  if (count <= 500) return "101_500";
  if (count <= 2_000) return "501_2000";
  if (count <= 10_000) return "2001_10000";
  return "gte_10001";
}
