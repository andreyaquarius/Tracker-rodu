export type PlanCode = "free" | "researcher" | "professional";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "cancelled"
  | "expired";

export type PlanLimitKey =
  | "projects"
  | "researches_total"
  | "researches_per_project"
  | "project_members"
  | "custom_sections_per_project"
  | "custom_fields_per_project"
  | "table_imports_per_month"
  | "hypothesis_ai_reviews_per_month";

export type SubscriptionFeature =
  | "custom_sections"
  | "custom_fields"
  | "table_import"
  | "hypothesis_ai_review"
  | "project_members";

export interface SubscriptionPlan {
  id: string;
  code: PlanCode;
  name: string;
  description: string | null;
  priceMonthly: number | null;
  priceYearly: number | null;
  currency: string;
  isActive: boolean;
}

export interface PlanLimit {
  key: PlanLimitKey;
  value: number | null;
  isUnlimited: boolean;
}

export interface UserSubscription {
  id: string;
  storedPlanCode: PlanCode;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialUsed: boolean;
}

export type SubscriptionUsage = Record<PlanLimitKey, number>;

export interface SubscriptionContext {
  subscription: UserSubscription;
  effectivePlanCode: PlanCode;
  plan: SubscriptionPlan;
  limits: Record<PlanLimitKey, PlanLimit>;
  usage: SubscriptionUsage;
  isAdmin: boolean;
  serverNow: string;
}

export interface UpgradeReason {
  featureName: string;
  reason: string;
  recommendedPlan: PlanCode;
  used?: number;
  limit?: number;
}

// Checkout is intentionally provider-agnostic until a payment provider is selected.
export interface PaymentProvider {
  code: string;
  createCheckout(input: {
    userId: string;
    planCode: Exclude<PlanCode, "free">;
    returnUrl: string;
  }): Promise<{ checkoutUrl: string }>;
}
