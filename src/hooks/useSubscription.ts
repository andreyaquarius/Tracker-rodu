import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSubscriptionContext } from "../services/subscriptionService";
import type {
  PlanLimitKey,
  SubscriptionContext,
  SubscriptionFeature,
} from "../types/subscription";
import { hasPlanCapacity, trialDaysRemaining as calculateTrialDaysRemaining } from "../utils/subscription";
import {
  createInFlightRequestDeduper,
  getJitteredSubscriptionPollDelay,
  isSubscriptionRefreshDue,
} from "../utils/subscriptionPolling";

export function useSubscription(projectId?: string, enabled = true, scopeKey = "") {
  const resolvedScopeKey = `${scopeKey}:${projectId ?? ""}:${enabled ? "1" : "0"}`;
  const [loadedScopeKey, setLoadedScopeKey] = useState(resolvedScopeKey);
  const [storedContext, setStoredContext] = useState<SubscriptionContext | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const requestGenerationRef = useRef(0);
  const refreshDeduperRef = useRef(
    createInFlightRequestDeduper<SubscriptionContext | null>(),
  );
  const nextAutomaticRefreshAtRef = useRef<number | null>(null);

  const refreshSubscription = useCallback((): Promise<SubscriptionContext | null> => {
    if (!enabled) {
      setStoredContext(null);
      setLoadedScopeKey(resolvedScopeKey);
      setLoading(false);
      return Promise.resolve(null);
    }

    const requestGeneration = requestGenerationRef.current;
    return refreshDeduperRef.current.run(async () => {
      setLoading(true);
      setError("");
      try {
        const next = await loadSubscriptionContext(projectId);
        if (requestGeneration !== requestGenerationRef.current) return null;
        setStoredContext(next);
        setLoadedScopeKey(resolvedScopeKey);
        return next;
      } catch (loadError) {
        if (requestGeneration === requestGenerationRef.current) {
          setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити тариф.");
        }
        return null;
      } finally {
        if (requestGeneration === requestGenerationRef.current) {
          nextAutomaticRefreshAtRef.current = Date.now() + getJitteredSubscriptionPollDelay();
          setLoading(false);
        }
      }
    });
  }, [enabled, projectId, resolvedScopeKey]);

  useEffect(() => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    refreshDeduperRef.current.clear();
    nextAutomaticRefreshAtRef.current = null;
    setLoadedScopeKey(resolvedScopeKey);
    setStoredContext(null);
    setLoading(enabled);

    if (!enabled) {
      setLoading(false);
      setError("");
    }

    return () => {
      if (requestGenerationRef.current !== requestGeneration) return;
      requestGenerationRef.current += 1;
      refreshDeduperRef.current.clear();
    };
  }, [enabled, projectId, resolvedScopeKey]);

  useEffect(() => {
    void refreshSubscription();
  }, [refreshSubscription]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const ensureNextRefreshAt = () => {
      if (nextAutomaticRefreshAtRef.current === null) {
        nextAutomaticRefreshAtRef.current = Date.now() + getJitteredSubscriptionPollDelay();
      }
      return nextAutomaticRefreshAtRef.current;
    };

    function runAutomaticRefresh() {
      timer = null;
      refreshIfDue();
    }

    const scheduleNextPoll = () => {
      clearTimer();
      if (disposed || document.hidden) return;

      const delay = Math.max(0, ensureNextRefreshAt() - Date.now());
      timer = window.setTimeout(runAutomaticRefresh, delay);
    };

    const refreshIfDue = () => {
      clearTimer();
      if (disposed || document.hidden) return;
      if (!isSubscriptionRefreshDue(ensureNextRefreshAt())) {
        scheduleNextPoll();
        return;
      }
      void refreshSubscription().finally(scheduleNextPoll);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearTimer();
        return;
      }
      refreshIfDue();
    };

    const handleWindowFocus = () => {
      refreshIfDue();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    scheduleNextPoll();

    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [enabled, refreshSubscription]);

  const context = loadedScopeKey === resolvedScopeKey ? storedContext : null;
  const scopedLoading = loadedScopeKey === resolvedScopeKey ? loading : enabled;
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
      ai_credit: "ai_credits_per_month",
      hypothesis_ai_review: "ai_credits_per_month",
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
    loading: scopedLoading,
    error,
    canCreateProject: withinLimit("projects"),
    canCreateResearch: canCreateProjectRecords && withinLimit("researches_total") && withinLimit("researches_per_project"),
    canCreateCustomSection: canCreateProjectRecords && canUseFeature("custom_sections"),
    canCreateCustomField: canCreateProjectRecords && canUseFeature("custom_fields"),
    canImportTable: canCreateProjectRecords && canUseFeature("table_import"),
    canUseIncludedHypothesisAiReview: canUseFeature("ai_credit"),
    canInviteMember: canCreateProjectRecords && canUseFeature("project_members"),
    canUseFeature,
    getLimit,
    getUsage,
    getRemaining,
    refreshSubscription,
  };
}
