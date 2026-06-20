import { getSupabaseClient } from "./supabaseAuth";
import type {
  PlanCode,
  PlanLimit,
  PlanLimitKey,
  SubscriptionContext,
  SubscriptionPlan,
  SubscriptionStatus,
  SubscriptionUsage,
  UserSubscription,
} from "../types/subscription";

const limitKeys: PlanLimitKey[] = [
  "projects",
  "researches_total",
  "researches_per_project",
  "project_members",
  "custom_sections_per_project",
  "custom_fields_per_project",
  "table_imports_per_month",
  "hypothesis_ai_reviews_per_month",
];

const usageProperty: Record<PlanLimitKey, string> = {
  projects: "projects",
  researches_total: "researchesTotal",
  researches_per_project: "researchesPerProject",
  project_members: "projectMembers",
  custom_sections_per_project: "customSectionsPerProject",
  custom_fields_per_project: "customFieldsPerProject",
  table_imports_per_month: "tableImportsPerMonth",
  hypothesis_ai_reviews_per_month: "hypothesisAiReviewsPerMonth",
};

export async function loadSubscriptionContext(projectId?: string): Promise<SubscriptionContext> {
  const { data, error } = await getSupabaseClient().rpc(
    "get_my_subscription_context",
    { target_project_id: projectId || null },
  );
  if (error) throw error;
  if (!data || typeof data !== "object") {
    throw new Error("Не вдалося завантажити тарифний план.");
  }
  return mapContext(data as Record<string, unknown>);
}

export async function beginTableImport(projectId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc(
    "begin_table_import",
    { target_project_id: projectId },
  );
  if (error) throw error;
  return Number(data ?? 0);
}

export async function loadSubscriptionPlans(): Promise<Array<{
  plan: SubscriptionPlan;
  limits: PlanLimit[];
}>> {
  const client = getSupabaseClient();
  const [plansResult, limitsResult] = await Promise.all([
    client.from("subscription_plans").select(
      "id, code, name, description, is_active, price_monthly, price_yearly, currency, sort_order",
    ).eq("is_active", true).order("sort_order"),
    client.from("plan_limits").select("plan_id, limit_key, limit_value, is_unlimited"),
  ]);
  if (plansResult.error) throw plansResult.error;
  if (limitsResult.error) throw limitsResult.error;
  return (plansResult.data ?? []).map((row) => ({
    plan: {
      id: String(row.id),
      code: String(row.code) as PlanCode,
      name: String(row.name),
      description: nullableString(row.description),
      priceMonthly: nullableNumber(row.price_monthly),
      priceYearly: nullableNumber(row.price_yearly),
      currency: String(row.currency),
      isActive: Boolean(row.is_active),
    },
    limits: (limitsResult.data ?? [])
      .filter((limit) => limit.plan_id === row.id)
      .map((limit) => ({
        key: String(limit.limit_key) as PlanLimitKey,
        value: limit.limit_value === null ? null : Number(limit.limit_value),
        isUnlimited: Boolean(limit.is_unlimited),
      })),
  }));
}

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

export async function loadAdminSubscriptions(): Promise<AdminSubscriptionRow[]> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_subscriptions");
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    userId: String(row.user_id),
    email: String(row.email),
    displayName: String(row.display_name ?? ""),
    planCode: String(row.plan_code) as PlanCode,
    status: String(row.status) as SubscriptionStatus,
    trialEndsAt: nullableString(row.trial_ends_at),
    currentPeriodEnd: nullableString(row.current_period_end),
    isAdmin: Boolean(row.is_admin),
  }));
}

export async function adminSetSubscription(input: {
  userId: string;
  planCode: PlanCode;
  status?: SubscriptionStatus;
  periodEnd?: string | null;
  grantTrial?: boolean;
}): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc("admin_set_subscription", {
    target_user_id: input.userId,
    target_plan_code: input.planCode,
    target_status: input.status ?? "active",
    target_period_end: input.periodEnd ?? null,
    grant_trial: input.grantTrial ?? false,
  });
  if (error) throw error;
  return String(data);
}

export function subscriptionErrorCode(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error ?? "");
  const match = message.match(/(PLAN_LIMIT_REACHED|FEATURE_NOT_AVAILABLE):[a-z_]+/i);
  return match?.[0] ?? "";
}

export function subscriptionErrorMessage(error: unknown): string {
  const code = subscriptionErrorCode(error);
  const messages: Record<string, string> = {
    "PLAN_LIMIT_REACHED:projects": "Ви використали доступну кількість проєктів.",
    "PLAN_LIMIT_REACHED:researches_total": "Ви використали доступну кількість досліджень.",
    "PLAN_LIMIT_REACHED:researches_per_project": "У цьому проєкті досягнуто ліміт досліджень.",
    "PLAN_LIMIT_REACHED:project_members": "У цьому проєкті досягнуто ліміт учасників.",
    "PLAN_LIMIT_REACHED:custom_sections_per_project": "Досягнуто ліміт власних розділів.",
    "PLAN_LIMIT_REACHED:custom_fields_per_project": "Досягнуто ліміт власних полів.",
    "PLAN_LIMIT_REACHED:table_imports_per_month": "Використано всі імпорти цього календарного місяця.",
    "PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month": "Використано всі включені AI-аналізи гіпотез цього місяця.",
  };
  return messages[code] ?? (error instanceof Error ? error.message : "Дія недоступна для поточного тарифу.");
}

function mapContext(raw: Record<string, unknown>): SubscriptionContext {
  const rawSubscription = asRecord(raw.subscription);
  const rawPlan = asRecord(raw.plan);
  const rawLimits = asRecord(raw.limits);
  const rawUsage = asRecord(raw.usage);
  const limits = {} as Record<PlanLimitKey, PlanLimit>;
  const usage = {} as SubscriptionUsage;
  for (const key of limitKeys) {
    const limit = asRecord(rawLimits[key]);
    limits[key] = {
      key,
      value: limit.value === null || limit.value === undefined ? null : Number(limit.value),
      isUnlimited: Boolean(limit.isUnlimited),
    };
    usage[key] = Number(rawUsage[usageProperty[key]] ?? 0);
  }
  const subscription: UserSubscription = {
    id: String(rawSubscription.id ?? ""),
    storedPlanCode: String(rawSubscription.storedPlanCode ?? "free") as PlanCode,
    status: String(rawSubscription.status ?? "active") as SubscriptionStatus,
    currentPeriodStart: nullableString(rawSubscription.currentPeriodStart),
    currentPeriodEnd: nullableString(rawSubscription.currentPeriodEnd),
    trialStartedAt: nullableString(rawSubscription.trialStartedAt),
    trialEndsAt: nullableString(rawSubscription.trialEndsAt),
    trialUsed: Boolean(rawSubscription.trialUsed),
  };
  const plan: SubscriptionPlan = {
    id: String(rawPlan.id ?? ""),
    code: String(rawPlan.code ?? raw.effectivePlanCode ?? "free") as PlanCode,
    name: String(rawPlan.name ?? "Безкоштовний"),
    description: nullableString(rawPlan.description),
    priceMonthly: nullableNumber(rawPlan.price_monthly),
    priceYearly: nullableNumber(rawPlan.price_yearly),
    currency: String(rawPlan.currency ?? "UAH"),
    isActive: Boolean(rawPlan.is_active ?? true),
  };
  return {
    subscription,
    effectivePlanCode: String(raw.effectivePlanCode ?? "free") as PlanCode,
    plan,
    limits,
    usage,
    isAdmin: Boolean(raw.isAdmin),
    serverNow: String(raw.serverNow ?? new Date().toISOString()),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}
