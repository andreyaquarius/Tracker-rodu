import type { PlanCode, SubscriptionStatus } from "../types/subscription.ts";

export const ADMIN_SUBSCRIPTIONS_PAGE_SIZE = 50;

export interface AdminSubscriptionRow {
  userId: string;
  email: string;
  displayName: string;
  planCode: PlanCode;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  isAdmin: boolean;
}

export interface AdminSubscriptionsQuery {
  page?: number;
  query?: string;
  plan?: PlanCode | "admin" | "all";
  status?: SubscriptionStatus | "all";
}

export interface AdminSubscriptionsPage {
  rows: AdminSubscriptionRow[];
  totalCount: number;
  filteredCount: number;
  page: number;
  pageSize: number;
}

export function adminSubscriptionsParams(input: AdminSubscriptionsQuery) {
  return {
    p_page: Number.isFinite(input.page) ? Math.max(1, Math.min(2_147_483_647, Math.floor(input.page!))) : 1,
    p_query: (input.query ?? "").trim().slice(0, 200),
    p_plan: input.plan ?? "all",
    p_status: input.status ?? "all",
  };
}

export function parseAdminSubscriptionsPage(data: unknown): AdminSubscriptionsPage {
  const invalidResponse = () => new Error("Сервер повернув некоректну сторінку підписок. Оновіть сторінку й спробуйте ще раз.");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidResponse();
  const value = data as Record<string, unknown>;
  const { total_count: totalCount, filtered_count: filteredCount, page, page_size: pageSize, items } = value;
  if (
    typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0
    || typeof filteredCount !== "number" || !Number.isSafeInteger(filteredCount) || filteredCount < 0 || filteredCount > totalCount
    || typeof page !== "number" || !Number.isSafeInteger(page) || page < 1
    || pageSize !== ADMIN_SUBSCRIPTIONS_PAGE_SIZE
    || page > Math.max(1, Math.ceil(filteredCount / pageSize))
    || !Array.isArray(items) || items.length !== Math.min(pageSize, Math.max(0, filteredCount - (page - 1) * pageSize))
  ) throw invalidResponse();
  const rows = items.map((item: unknown): AdminSubscriptionRow => {
    if (!item || typeof item !== "object") throw invalidResponse();
    const row = item as Record<string, unknown>;
    if (
      typeof row.user_id !== "string" || !row.user_id || typeof row.email !== "string"
      || !["free", "researcher", "professional"].includes(String(row.plan_code))
      || !["active", "trialing", "past_due", "cancelled", "expired"].includes(String(row.status))
      || typeof row.is_admin !== "boolean"
    ) throw invalidResponse();
    return {
      userId: row.user_id,
      email: row.email,
      displayName: String(row.display_name ?? ""),
      planCode: row.plan_code as PlanCode,
      status: row.status as SubscriptionStatus,
      trialEndsAt: row.trial_ends_at == null ? null : String(row.trial_ends_at),
      currentPeriodEnd: row.current_period_end == null ? null : String(row.current_period_end),
      isAdmin: row.is_admin,
    };
  });
  if (new Set(rows.map((row) => row.userId)).size !== rows.length) throw invalidResponse();
  return { rows, totalCount, filteredCount, page, pageSize };
}
