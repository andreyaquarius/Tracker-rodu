export type ActiveTimeAccumulator = Readonly<{
  active: boolean;
  accumulatedMs: number;
  lastObservedAtMs: number;
}>;

export type DrainedActiveTime = Readonly<{
  accumulator: ActiveTimeAccumulator;
  activeSeconds: number;
}>;

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Creates browser-independent active-time state. Callers provide the clock so
 * the calculation stays deterministic and can use performance.now() in the UI.
 */
export function createActiveTimeAccumulator(
  nowMs = 0,
  active = false,
): ActiveTimeAccumulator {
  return {
    active,
    accumulatedMs: 0,
    lastObservedAtMs: finiteNonNegative(nowMs, 0),
  };
}

/**
 * Advances the accumulator to one observation. Only the interval during which
 * the previous observation was active is counted. maxActiveStepMs prevents a
 * suspended browser or sleeping computer from being mistaken for active use.
 */
export function observeActiveTime(
  accumulator: ActiveTimeAccumulator,
  active: boolean,
  nowMs: number,
  maxActiveStepMs = Number.POSITIVE_INFINITY,
): ActiveTimeAccumulator {
  const observedAtMs = Math.max(
    accumulator.lastObservedAtMs,
    finiteNonNegative(nowMs, accumulator.lastObservedAtMs),
  );
  const elapsedMs = observedAtMs - accumulator.lastObservedAtMs;
  const maximumStep = maxActiveStepMs === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : finiteNonNegative(maxActiveStepMs, 0);
  const countedMs = accumulator.active ? Math.min(elapsedMs, maximumStep) : 0;

  return {
    active,
    accumulatedMs: accumulator.accumulatedMs + countedMs,
    lastObservedAtMs: observedAtMs,
  };
}

/**
 * Returns complete seconds and preserves any fractional remainder. This makes
 * periodic uploads idempotent without rounding the same time more than once.
 */
export function drainActiveTimeSeconds(
  accumulator: ActiveTimeAccumulator,
): DrainedActiveTime {
  const activeSeconds = Math.floor(accumulator.accumulatedMs / 1_000);
  return {
    activeSeconds,
    accumulator: {
      ...accumulator,
      accumulatedMs: accumulator.accumulatedMs - activeSeconds * 1_000,
    },
  };
}

export function discardAccumulatedActiveTime(
  accumulator: ActiveTimeAccumulator,
): ActiveTimeAccumulator {
  return {
    ...accumulator,
    active: false,
    accumulatedMs: 0,
  };
}
