import { useEffect, useId } from "react";
import { setProductAnalyticsPageScope } from "../services/productAnalytics.ts";
import type { ProductAnalyticsPageCode } from "../utils/productAnalyticsRegistry.ts";

export function useProductAnalyticsPage(page: ProductAnalyticsPageCode | null, base?: ProductAnalyticsPageCode) {
  const scope = useId();
  // Updating an open overlay does not briefly record the underlying page again.
  useEffect(() => { setProductAnalyticsPageScope(scope, page, base); }, [scope, page, base]);
  useEffect(() => () => { setProductAnalyticsPageScope(scope, null); }, [scope]);
}
