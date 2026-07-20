import { getSupabaseClient } from "./supabaseAuth";
import { runAuthenticatedRpc } from "../utils/authenticatedRpc";
import type {
  PlanCode,
  PlanLimit,
  PlanLimitKey,
  SectionQuota,
  SubscriptionAccessMode,
  SubscriptionContext,
  SubscriptionPlan,
  SubscriptionStatus,
  SubscriptionUsage,
  UserSubscription,
} from "../types/subscription";

const limitKeys: PlanLimitKey[] = [
  "projects",
  "family_trees_total",
  "persons_total",
  "editors_total",
  "researches_total",
  "researches_per_project",
  "records_per_standard_section",
  "project_members",
  "custom_sections_per_project",
  "custom_fields_per_project",
  "table_imports_per_month",
  "ai_credits_per_month",
  "hypothesis_ai_reviews_per_month",
];

const usageProperty: Record<PlanLimitKey, string> = {
  projects: "projects",
  family_trees_total: "familyTreesTotal",
  persons_total: "personsTotal",
  editors_total: "editorsTotal",
  researches_total: "researchesTotal",
  researches_per_project: "researchesPerProject",
  records_per_standard_section: "recordsPerStandardSection",
  project_members: "projectMembers",
  custom_sections_per_project: "customSectionsPerProject",
  custom_fields_per_project: "customFieldsPerProject",
  table_imports_per_month: "tableImportsPerMonth",
  ai_credits_per_month: "aiCreditsPerMonth",
  hypothesis_ai_reviews_per_month: "hypothesisAiReviewsPerMonth",
};

const publishedPlanPrices: Partial<Record<PlanCode, { monthly: number; yearly: number; currency: string }>> = {
  researcher: { monthly: 229, yearly: 2290, currency: "UAH" },
  professional: { monthly: 699, yearly: 6990, currency: "UAH" },
};

const publishedAiCreditsPerMonth: Record<PlanCode, number> = {
  free: 5,
  researcher: 50,
  professional: 100,
};

const publishedHeadlineLimits: Record<
  PlanCode,
  Pick<Record<PlanLimitKey, PlanLimit>,
    "projects" | "family_trees_total" | "persons_total" | "editors_total" | "ai_credits_per_month">
> = {
  free: {
    projects: { key: "projects", value: 1, isUnlimited: false },
    family_trees_total: { key: "family_trees_total", value: 1, isUnlimited: false },
    persons_total: { key: "persons_total", value: 500, isUnlimited: false },
    editors_total: { key: "editors_total", value: 0, isUnlimited: false },
    ai_credits_per_month: { key: "ai_credits_per_month", value: publishedAiCreditsPerMonth.free, isUnlimited: false },
  },
  researcher: {
    projects: { key: "projects", value: null, isUnlimited: true },
    family_trees_total: { key: "family_trees_total", value: null, isUnlimited: true },
    persons_total: { key: "persons_total", value: 15_000, isUnlimited: false },
    editors_total: { key: "editors_total", value: 2, isUnlimited: false },
    ai_credits_per_month: { key: "ai_credits_per_month", value: publishedAiCreditsPerMonth.researcher, isUnlimited: false },
  },
  professional: {
    projects: { key: "projects", value: null, isUnlimited: true },
    family_trees_total: { key: "family_trees_total", value: null, isUnlimited: true },
    persons_total: { key: "persons_total", value: null, isUnlimited: true },
    editors_total: { key: "editors_total", value: 5, isUnlimited: false },
    ai_credits_per_month: { key: "ai_credits_per_month", value: publishedAiCreditsPerMonth.professional, isUnlimited: false },
  },
};

export async function loadSubscriptionContext(projectId?: string): Promise<SubscriptionContext> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedRpc({
    getSession: async () => {
      const result = await client.auth.getSession();
      return {
        data: { session: result.data.session },
        error: result.error,
      };
    },
    refreshSession: async () => {
      const result = await client.auth.refreshSession();
      return {
        data: { session: result.data.session },
        error: result.error,
      };
    },
    invoke: async () => {
      const result = await client.rpc(
        "get_my_subscription_context",
        { target_project_id: projectId || null },
      );
      return { data: result.data, error: result.error };
    },
    shouldRetryAfterRefresh: isSubscriptionContextAuthError,
  });
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
  return (plansResult.data ?? []).map((row) => {
    const code = String(row.code) as PlanCode;
    const limits = (limitsResult.data ?? [])
      .filter((limit) => limit.plan_id === row.id)
      .map((limit) => ({
        key: String(limit.limit_key) as PlanLimitKey,
        value: limit.limit_value === null ? null : Number(limit.limit_value),
        isUnlimited: Boolean(limit.is_unlimited),
      }));
    return {
      plan: {
        id: String(row.id),
        code,
        name: String(row.name),
        description: nullableString(row.description),
        priceMonthly: planPriceMonthly(code, row.price_monthly),
        priceYearly: planPriceYearly(code, row.price_yearly),
        currency: planCurrency(code, row.currency),
        isActive: Boolean(row.is_active),
      },
      limits: withDefaultPlanLimits(code, limits),
    };
  });
}

function isSubscriptionContextAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code ?? "") : "";
  const status = "status" in error ? Number(error.status) : 0;
  const message = "message" in error ? String(error.message ?? "").toLocaleLowerCase() : "";
  return status === 401 ||
    code === "PGRST301" ||
    (code === "42501" && message.includes("get_my_subscription_context")) ||
    message.includes("jwt expired");
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

export interface AppFeatureFlag {
  key: string;
  title: string;
  description: string;
  isEnabled: boolean;
  updatedAt: string | null;
}

export async function loadAppFeatureFlags(): Promise<Record<string, boolean>> {
  const { data, error } = await getSupabaseClient().rpc("get_app_feature_flags");
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, Boolean(value)]),
  );
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

export async function loadAdminFeatureFlags(): Promise<AppFeatureFlag[]> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_feature_flags");
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    key: String(row.key),
    title: String(row.title ?? row.key),
    description: String(row.description ?? ""),
    isEnabled: Boolean(row.is_enabled),
    updatedAt: nullableString(row.updated_at),
  }));
}

export async function adminSetFeatureFlag(input: {
  key: string;
  isEnabled: boolean;
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc("admin_set_feature_flag", {
    target_key: input.key,
    target_is_enabled: input.isEnabled,
  });
  if (error) throw error;
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

export async function cancelMySubscription(): Promise<void> {
  const { error } = await getSupabaseClient().rpc("cancel_my_subscription");
  if (error) throw error;
}

export function subscriptionErrorCode(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error ?? "");
  const match = message.match(/(PLAN_LIMIT_REACHED|FEATURE_NOT_AVAILABLE|PLAN_SCOPE_CREATE_BLOCKED|PLAN_SECTION_RECORD_LIMIT_REACHED):[a-z_]+|GEDCOM_(?:PERSON|TREE)_LIMIT_REACHED|AI_CREDITS_LIMIT_REACHED|AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED|ADMIN_SUBSCRIPTION_MANAGED_EXTERNALLY|START_PLAN_NOT_CONFIGURED|RESEARCH_REQUIRED_BY_PLAN|INVALID_RESEARCH_REFERENCE/i);
  return match?.[0] ?? "";
}

export function subscriptionErrorMessage(error: unknown): string {
  const code = subscriptionErrorCode(error);
  const messages: Record<string, string> = {
    "PLAN_LIMIT_REACHED:projects": "Ви використали доступну кількість проєктів.",
    "PLAN_LIMIT_REACHED:family_trees_total": "Ви використали доступну кількість родових дерев.",
    "PLAN_LIMIT_REACHED:persons_total": "Досягнуто загальний ліміт осіб у ваших проєктах.",
    "PLAN_LIMIT_REACHED:editors_total": "Використано всі редакторські місця вашого тарифу. Глядачів можна запрошувати без обмежень.",
    GEDCOM_PERSON_LIMIT_REACHED: "GEDCOM містить більше нових осіб, ніж дозволяє вільне місце вашого тарифу. Видаліть дублікати, зменште файл або перейдіть на вищий тариф.",
    GEDCOM_TREE_LIMIT_REACHED: "Для імпорту GEDCOM потрібно створити ще одне родове дерево, але ліміт дерев поточного тарифу вже використано.",
    "PLAN_LIMIT_REACHED:researches_total": "Ви використали доступну кількість досліджень.",
    "PLAN_LIMIT_REACHED:researches_per_project": "У цьому проєкті досягнуто ліміт досліджень.",
    "PLAN_LIMIT_REACHED:records_per_standard_section": "Досягнуто ліміт записів у цьому розділі.",
    "PLAN_LIMIT_REACHED:project_members": "У цьому проєкті досягнуто ліміт учасників.",
    "PLAN_LIMIT_REACHED:custom_sections_per_project": "Досягнуто ліміт власних розділів.",
    "PLAN_LIMIT_REACHED:custom_fields_per_project": "Досягнуто ліміт власних полів.",
    "PLAN_LIMIT_REACHED:table_imports_per_month": "Використано всі імпорти цього календарного місяця.",
    "PLAN_LIMIT_REACHED:ai_credits_per_month": "Використано всі ШІ-кредити цього місяця.",
    AI_CREDITS_LIMIT_REACHED: "Використано всі ШІ-кредити цього місяця.",
    "PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month": "Використано всі ШІ-кредити цього місяця.",
    AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED: "Використано всі ШІ-кредити цього місяця.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:persons": "Досягнуто ліміт записів у розділі «Особи». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:documents": "Досягнуто ліміт записів у розділі «Документи». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:year_matrix": "Досягнуто ліміт записів у розділі «Матриця років». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:tasks": "Досягнуто ліміт записів у розділі «Завдання». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:findings": "Досягнуто ліміт записів у розділі «Знахідки». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:hypotheses": "Досягнуто ліміт записів у розділі «Гіпотези». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SECTION_RECORD_LIMIT_REACHED:archive_requests": "Досягнуто ліміт записів у розділі «Запити в архів». Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
    "PLAN_SCOPE_CREATE_BLOCKED:projects": "У цьому проєкті можна редагувати й видаляти наявні дані, але створення нових записів заблоковане поточним тарифом.",
    "PLAN_SCOPE_CREATE_BLOCKED:researches": "У цьому дослідженні можна редагувати й видаляти наявні дані, але створення нових записів заблоковане поточним тарифом.",
    ADMIN_SUBSCRIPTION_MANAGED_EXTERNALLY: "Безстроковий доступ адміністратора керується через список адміністраторів.",
    START_PLAN_NOT_CONFIGURED: "Тариф «Старт» ще не налаштований у базі.",
    RESEARCH_REQUIRED_BY_PLAN: "На вашому тарифі запис має бути прив’язаний до дослідження.",
    INVALID_RESEARCH_REFERENCE: "Вибране дослідження недоступне для поточного проєкту.",
  };
  return messages[code] ?? (error instanceof Error ? error.message : "Дія недоступна для поточного тарифу.");
}

function mapContext(raw: Record<string, unknown>): SubscriptionContext {
  const rawSubscription = asRecord(raw.subscription);
  const rawPlan = asRecord(raw.plan);
  const rawLimits = asRecord(raw.limits);
  const rawUsage = asRecord(raw.usage);
  const rawSectionQuotas = asRecord(raw.sectionQuotas);
  const rawProjectCapacity = asRecord(raw.projectCapacity);
  const projectAccessMode = nullableString(raw.projectAccessMode) as SubscriptionAccessMode | null;
  const effectivePlanCode = String(raw.effectivePlanCode ?? rawPlan.code ?? "free") as PlanCode;
  const limits = {} as Record<PlanLimitKey, PlanLimit>;
  const usage = {} as SubscriptionUsage;
  for (const key of limitKeys) {
    const hasLimit = Object.prototype.hasOwnProperty.call(rawLimits, key);
    const limit = hasLimit ? asRecord(rawLimits[key]) : {};
    const publishedLimit = (publishedHeadlineLimits[effectivePlanCode] as Partial<
      Record<PlanLimitKey, PlanLimit>
    >)[key];
    const fallbackLimit = publishedLimit?.value ?? 0;
    limits[key] = {
      key,
      value: hasLimit
        ? limit.value === null || limit.value === undefined ? null : Number(limit.value)
        : fallbackLimit,
      isUnlimited: hasLimit ? Boolean(limit.isUnlimited) : Boolean(publishedLimit?.isUnlimited),
    };
    usage[key] = Number(rawUsage[usageProperty[key]] ?? 0);
  }
  const projectCapacityPlanCode = String(
    rawProjectCapacity.effectivePlanCode ?? effectivePlanCode,
  ) as PlanCode;
  const rawProjectCapacityLimits = asRecord(rawProjectCapacity.limits);
  const rawProjectCapacityUsage = asRecord(rawProjectCapacity.usage);
  const projectCapacityLimits = {} as Record<PlanLimitKey, PlanLimit>;
  const projectCapacityUsage = {} as SubscriptionUsage;
  for (const key of limitKeys) {
    const hasLimit = Object.prototype.hasOwnProperty.call(rawProjectCapacityLimits, key);
    const rawLimit = hasLimit ? asRecord(rawProjectCapacityLimits[key]) : {};
    const publishedLimit = (publishedHeadlineLimits[projectCapacityPlanCode] as Partial<
      Record<PlanLimitKey, PlanLimit>
    >)[key];
    projectCapacityLimits[key] = {
      key,
      value: hasLimit
        ? rawLimit.value === null || rawLimit.value === undefined ? null : Number(rawLimit.value)
        : publishedLimit?.value ?? 0,
      isUnlimited: hasLimit
        ? Boolean(rawLimit.isUnlimited)
        : Boolean(publishedLimit?.isUnlimited),
    };
    projectCapacityUsage[key] = Number(rawProjectCapacityUsage[usageProperty[key]] ?? 0);
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
  const planCode = String(rawPlan.code ?? raw.effectivePlanCode ?? "free") as PlanCode;
  const plan: SubscriptionPlan = {
    id: String(rawPlan.id ?? ""),
    code: planCode,
    name: String(rawPlan.name ?? "Старт"),
    description: nullableString(rawPlan.description),
    priceMonthly: planPriceMonthly(planCode, rawPlan.price_monthly ?? rawPlan.priceMonthly),
    priceYearly: planPriceYearly(planCode, rawPlan.price_yearly ?? rawPlan.priceYearly),
    currency: planCurrency(planCode, rawPlan.currency),
    isActive: Boolean(rawPlan.is_active ?? true),
  };
  return {
    subscription,
    effectivePlanCode,
    plan,
    limits,
    usage,
    projectCapacity: Object.keys(rawProjectCapacity).length
      ? {
          ownerId: String(rawProjectCapacity.ownerId ?? ""),
          effectivePlanCode: projectCapacityPlanCode,
          limits: projectCapacityLimits,
          usage: projectCapacityUsage,
        }
      : null,
    sectionQuotas: mapSectionQuotas(rawSectionQuotas),
    isAdmin: Boolean(raw.isAdmin),
    projectAccessMode,
    canCreateProjectRecords: Boolean(raw.canCreateProjectRecords ?? true),
    serverNow: String(raw.serverNow ?? new Date().toISOString()),
  };
}

function withDefaultPlanLimits(planCode: PlanCode, limits: PlanLimit[]): PlanLimit[] {
  const byKey = new Map(limits.map((limit) => [limit.key, limit]));
  for (const limit of Object.values(publishedHeadlineLimits[planCode])) {
    if (!byKey.has(limit.key)) byKey.set(limit.key, limit);
  }
  return Array.from(byKey.values());
}

function mapSectionQuotas(raw: Record<string, unknown>): Record<string, SectionQuota> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const record = asRecord(value);
    return [key, {
      sectionKey: String(record.sectionKey ?? key),
      used: Number(record.used ?? 0),
      limit: nullableNumber(record.limit),
      remaining: nullableNumber(record.remaining),
      canCreate: Boolean(record.canCreate ?? true),
      reason: nullableString(record.reason),
    }];
  }));
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

function planPriceMonthly(code: PlanCode, value: unknown): number | null {
  return nullableNumber(value) ?? publishedPlanPrices[code]?.monthly ?? null;
}

function planPriceYearly(code: PlanCode, value: unknown): number | null {
  return nullableNumber(value) ?? publishedPlanPrices[code]?.yearly ?? null;
}

function planCurrency(code: PlanCode, value: unknown): string {
  return nullableString(value) ?? publishedPlanPrices[code]?.currency ?? "UAH";
}
