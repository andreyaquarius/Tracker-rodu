import type { PlanLimit } from "../types/subscription";

export function hasPlanCapacity(limit: PlanLimit | null | undefined, used: number): boolean {
  if (!limit) return false;
  if (limit.isUnlimited) return true;
  return limit.value !== null && used < limit.value;
}

export function trialDaysRemaining(
  trialEndsAt: string | null | undefined,
  serverNow: string | null | undefined,
): number {
  if (!trialEndsAt || !serverNow) return 0;
  const end = new Date(trialEndsAt).getTime();
  const now = new Date(serverNow).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((end - now) / 86_400_000));
}
