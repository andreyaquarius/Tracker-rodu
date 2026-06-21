import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSubscriptionContext } from "../services/subscriptionService";
import type {
  PlanLimitKey,
  SubscriptionContext,
  SubscriptionFeature,
} from "../types/subscription";
import { hasPlanCapacity, trialDaysRemaining as calculateTrialDaysRemaining } from "../utils/subscription";

export function useSubscription(projectId?: string, enabled = true) {
  const [context, setContext] = useState<SubscriptionContext | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const refreshSubscription = useCallback(async () => {
    if (!enabled) {
      setContext(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError("");
    try {
      const next = await loadSubscriptionContext(projectId);
      setContext(next);
      return next;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити тариф.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [enabled, projectId]);

  useEffect(() => {
    void refreshSubscription();
  }, [refreshSubscription]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void refreshSubscription(), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled, refreshSubscription]);

  const getLimit = useCallback((key: PlanLimitKey) => context?.limits[key] ?? null, [context]);
  const getUsage = useCallback((key: PlanLimitKey) => context?.usage[key] ?? 0, [context]);
  const getRemaining = useCallback((key: PlanLimitKey) => {
    const limit = getLimit(key);
    if (!limit || limit.isUnlimited || limit.value === null) return null;
    return Math.max(0, limit.value - getUsage(key));
  }, [getLimit, getUsage]);
  const withinLimit = useCallback((key: PlanLimitKey) => {
    return hasPlanCapacity(getLimit(key), getUsage(key));
  }, [getLimit, getUsage]);
  const canUseFeature = useCallback((feature: SubscriptionFeature) => {
    const key: Record<SubscriptionFeature, PlanLimitKey> = {
      custom_sections: "custom_sections_per_project",
      custom_fields: "custom_fields_per_project",
      table_import: "table_imports_per_month",
      hypothesis_ai_review: "hypothesis_ai_reviews_per_month",
      project_members: "project_members",
    };
    return withinLimit(key[feature]);
  }, [withinLimit]);
  const canCreateProjectRecords = context?.canCreateProjectRecords ?? true;

  const trialDaysRemaining = useMemo(() => {
    const endsAt = context?.subscription.trialEndsAt;
    if (!endsAt || context?.subscription.status !== "trialing") return 0;
    return calculateTrialDaysRemaining(endsAt, context.serverNow);
  }, [context]);

  return {
    context,
    subscription: context?.subscription ?? null,
    effectivePlan: context?.effectivePlanCode ?? null,
    plan: context?.plan ?? null,
    limits: context?.limits ?? null,
    usage: context?.usage ?? null,
    isAdmin: context?.isAdmin ?? false,
    projectAccessMode: context?.projectAccessMode ?? null,
    canCreateProjectRecords,
    isTrial: context?.subscription.status === "trialing" && trialDaysRemaining > 0,
    trialEndsAt: context?.subscription.trialEndsAt ?? null,
    trialDaysRemaining,
    loading,
    error,
    canCreateProject: withinLimit("projects"),
    canCreateResearch: canCreateProjectRecords && withinLimit("researches_total") && withinLimit("researches_per_project"),
    canCreateCustomSection: canCreateProjectRecords && canUseFeature("custom_sections"),
    canCreateCustomField: canCreateProjectRecords && canUseFeature("custom_fields"),
    canImportTable: canCreateProjectRecords && canUseFeature("table_import"),
    canUseIncludedHypothesisAiReview: canUseFeature("hypothesis_ai_review"),
    canInviteMember: canCreateProjectRecords && canUseFeature("project_members"),
    canUseFeature,
    getLimit,
    getUsage,
    getRemaining,
    refreshSubscription,
  };
}
