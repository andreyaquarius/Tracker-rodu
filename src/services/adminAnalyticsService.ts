import { getSupabaseClient } from "./supabaseAuth.ts";
import type {
  ProductAnalyticsActionCode,
  ProductAnalyticsPageCode,
} from "../utils/productAnalyticsRegistry.ts";

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

export interface AdminAnalyticsActionRow {
  actionCode: ProductAnalyticsActionCode;
  users: number;
  invocations: number;
  completions: number;
  successes: number;
  failures: number;
  cancellations: number;
  successRate: number | null;
  durationBuckets: Record<string, number>;
}

export type AdminAnalyticsFunnelCode =
  | "onboarding"
  | "gedcom_import"
  | "document_research"
  | "ai_hypothesis";
export type AdminAnalyticsPeriodDays = 7 | 30 | 90;

export interface AdminAnalyticsPreferences {
  periodDays: AdminAnalyticsPeriodDays;
  funnelCode: AdminAnalyticsFunnelCode;
}

export interface AdminAnalyticsFunnelStep {
  ordinal: number;
  stepCode: string;
  actors: number;
  conversionPercent: number;
}

export interface AdminAnalyticsFunnel {
  funnelCode: AdminAnalyticsFunnelCode;
  suppressed: boolean;
  minimumCohort: number;
  steps: AdminAnalyticsFunnelStep[];
}

export interface AdminAnalyticsRetentionRow {
  cohortWeek: string;
  planCode: string;
  cohortSize: number;
  d1: number;
  d1Percent: number;
  d7: number | null;
  d7Percent: number | null;
  d30: number | null;
  d30Percent: number | null;
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

function analyticsPeriodDays(value: unknown): AdminAnalyticsPeriodDays {
  return value === 7 || value === 90 ? value : 30;
}

function analyticsFunnelCode(value: unknown): AdminAnalyticsFunnelCode {
  return value === "gedcom_import"
    || value === "document_research"
    || value === "ai_hypothesis"
    ? value
    : "onboarding";
}

export async function loadAdminAnalyticsPreferences(): Promise<AdminAnalyticsPreferences> {
  const { data, error } = await getSupabaseClient().rpc("get_my_admin_analytics_preferences");
  if (error) throw error;
  const value = record(data);
  return {
    periodDays: analyticsPeriodDays(Number(value.periodDays ?? 30)),
    funnelCode: analyticsFunnelCode(value.funnelCode),
  };
}

export async function saveAdminAnalyticsPreferences(
  preferences: AdminAnalyticsPreferences,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("set_my_admin_analytics_preferences", {
    p_period_days: preferences.periodDays,
    p_funnel_code: preferences.funnelCode,
  });
  if (error) throw error;
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

export async function loadAdminAnalyticsActions(
  from: Date,
  to: Date,
): Promise<AdminAnalyticsActionRow[]> {
  const { data, error } = await getSupabaseClient().rpc(
    "admin_get_product_analytics_actions",
    { p_from: from.toISOString(), p_to: to.toISOString() },
  );
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((value) => {
    const row = record(value);
    return {
      actionCode: String(row.action_code ?? "project_open") as ProductAnalyticsActionCode,
      users: Number(row.users ?? 0),
      invocations: Number(row.invocations ?? 0),
      completions: Number(row.completions ?? 0),
      successes: Number(row.successes ?? 0),
      failures: Number(row.failures ?? 0),
      cancellations: Number(row.cancellations ?? 0),
      successRate: nullableNumber(row.success_rate),
      durationBuckets: Object.fromEntries(
        Object.entries(record(row.duration_buckets)).map(([key, count]) => [key, Number(count ?? 0)]),
      ),
    };
  });
}

export async function loadAdminAnalyticsFunnel(
  from: Date,
  to: Date,
  funnelCode: AdminAnalyticsFunnelCode,
): Promise<AdminAnalyticsFunnel> {
  const { data, error } = await getSupabaseClient().rpc(
    "admin_get_product_analytics_funnel",
    { p_from: from.toISOString(), p_to: to.toISOString(), p_funnel_code: funnelCode },
  );
  if (error) throw error;
  const result = record(data);
  return {
    funnelCode,
    suppressed: result.suppressed === true,
    minimumCohort: Number(result.minimumCohort ?? 5),
    steps: (Array.isArray(result.steps) ? result.steps : []).map((value) => {
      const step = record(value);
      return {
        ordinal: Number(step.ordinal ?? 0),
        stepCode: String(step.stepCode ?? ""),
        actors: Number(step.actors ?? 0),
        conversionPercent: Number(step.conversionPercent ?? 0),
      };
    }),
  };
}

export async function loadAdminAnalyticsRetention(
  from: Date,
  to: Date,
): Promise<AdminAnalyticsRetentionRow[]> {
  const { data, error } = await getSupabaseClient().rpc(
    "admin_get_product_analytics_retention",
    { p_from: from.toISOString(), p_to: to.toISOString() },
  );
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((value) => {
    const row = record(value);
    return {
      cohortWeek: String(row.cohortWeek ?? ""),
      planCode: String(row.planCode ?? "unknown"),
      cohortSize: Number(row.cohortSize ?? 0),
      d1: Number(row.d1 ?? 0),
      d1Percent: Number(row.d1Percent ?? 0),
      d7: nullableNumber(row.d7),
      d7Percent: nullableNumber(row.d7Percent),
      d30: nullableNumber(row.d30),
      d30Percent: nullableNumber(row.d30Percent),
    };
  });
}
