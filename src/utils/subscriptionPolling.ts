export const SUBSCRIPTION_POLL_INTERVAL_MS = 10 * 60 * 1_000;
export const SUBSCRIPTION_POLL_JITTER_RATIO = 0.2;

export function getJitteredSubscriptionPollDelay(
  randomValue = Math.random(),
): number {
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  const minimum = SUBSCRIPTION_POLL_INTERVAL_MS * (1 - SUBSCRIPTION_POLL_JITTER_RATIO);
  const spread = SUBSCRIPTION_POLL_INTERVAL_MS * SUBSCRIPTION_POLL_JITTER_RATIO * 2;
  return Math.round(minimum + spread * normalizedRandom);
}

export function isSubscriptionRefreshDue(
  nextRefreshAt: number | null,
  now = Date.now(),
): boolean {
  return nextRefreshAt === null || now >= nextRefreshAt;
}

export interface InFlightRequestDeduper<T> {
  run: (factory: () => Promise<T>) => Promise<T>;
  clear: () => void;
  hasInFlightRequest: () => boolean;
}

export function createInFlightRequestDeduper<T>(): InFlightRequestDeduper<T> {
  let inFlight: Promise<T> | null = null;

  return {
    run(factory) {
      if (inFlight) return inFlight;

      let current: Promise<T>;
      current = Promise.resolve()
        .then(factory)
        .finally(() => {
          if (inFlight === current) inFlight = null;
        });
      inFlight = current;
      return current;
    },
    clear() {
      inFlight = null;
    },
    hasInFlightRequest() {
      return inFlight !== null;
    },
  };
}
