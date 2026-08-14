import { getSupabaseClient } from "./supabaseAuth.ts";
import type { ProductAnalyticsPageCode } from "../utils/productAnalyticsRegistry.ts";

export interface AdminAnalyticsOverview {
  suppressed: boolean;
  minimumCohort: number;
  users: number | null;
  sessions: number | null;
  pageViews: number | null;
  activeSeconds: number | null;
}

export interface AdminAnalyticsPageRow {
  pageCode: ProductAnalyticsPageCode;
  users: number;
  pageViews: number;
  activeSeconds: number;
  averageActiveSeconds: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadAdminAnalytics(
  from: Date,
  to: Date,
): Promise<{ overview: AdminAnalyticsOverview; pages: AdminAnalyticsPageRow[] }> {
  const params = { p_from: from.toISOString(), p_to: to.toISOString() };
  const client = getSupabaseClient();
  const [overviewResult, pagesResult] = await Promise.all([
    client.rpc("admin_get_product_analytics_overview", params),
    client.rpc("admin_get_product_analytics_pages", params),
  ]);
  if (overviewResult.error) throw overviewResult.error;
  if (pagesResult.error) throw pagesResult.error;

  const overviewRecord = record(overviewResult.data);
  const overview: AdminAnalyticsOverview = {
    suppressed: overviewRecord.suppressed === true,
    minimumCohort: Number(overviewRecord.minimumCohort ?? 5),
    users: nullableNumber(overviewRecord.users),
    sessions: nullableNumber(overviewRecord.sessions),
    pageViews: nullableNumber(overviewRecord.pageViews),
    activeSeconds: nullableNumber(overviewRecord.activeSeconds),
  };
  const rawPages = Array.isArray(pagesResult.data) ? pagesResult.data : [];
  const pages = rawPages.map((value): AdminAnalyticsPageRow => {
    const row = record(value);
    return {
      pageCode: String(row.page_code ?? "unknown") as ProductAnalyticsPageCode,
      users: Number(row.users ?? 0),
      pageViews: Number(row.page_views ?? 0),
      activeSeconds: Number(row.active_seconds ?? 0),
      averageActiveSeconds: Number(row.average_active_seconds ?? 0),
    };
  });
  return { overview, pages };
}
