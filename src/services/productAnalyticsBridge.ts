import type { ProductAnalyticsActionCode } from "../utils/productAnalyticsRegistry.ts";
import type { ProductAnalyticsOutcome } from "./productAnalytics.ts";

/**
 * Optional browser-only telemetry bridge for domain services that are also
 * imported by Node tests or workers. Analytics must never become a runtime
 * dependency of the underlying user operation.
 */
function withProductAnalytics(
  callback: (analytics: typeof import("./productAnalytics.ts")) => void,
): void {
  if (typeof window === "undefined") return;
  void import("./productAnalytics.ts")
    .then(callback)
    .catch(() => undefined);
}

export function trackDeferredProductAnalyticsAction(
  actionCode: ProductAnalyticsActionCode,
): void {
  withProductAnalytics((analytics) => analytics.trackProductAnalyticsAction(actionCode));
}

export function trackDeferredProductAnalyticsOperation(
  actionCode: ProductAnalyticsActionCode,
  outcome: ProductAnalyticsOutcome,
  durationMs: number,
  count?: number | null,
): void {
  withProductAnalytics((analytics) => analytics.trackProductAnalyticsOperation(
    actionCode,
    outcome,
    durationMs,
    count,
  ));
}
