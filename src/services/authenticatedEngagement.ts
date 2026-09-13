import { invokeEdgeFunction } from "./edgeFunctions";
import { AuthenticatedSessionRequiredError } from "../utils/authenticatedRpc.ts";
import {
  ANALYTICS_CONSENT_EVENT,
  ANALYTICS_CONSENT_KEY,
  analyticsConsentGranted,
} from "./siteAnalytics";
import {
  createActiveTimeAccumulator,
  discardAccumulatedActiveTime,
  drainActiveTimeSeconds,
  observeActiveTime,
  type ActiveTimeAccumulator,
} from "../utils/activeTimeAccumulator";

export type AnonymousEngagementIdentifiers = Readonly<{
  clientId: string;
  sessionId: string;
}>;

export type AuthenticatedEngagementPayload = AnonymousEngagementIdentifiers & Readonly<{
  activeSeconds: number;
}>;

export const AUTHENTICATED_ENGAGEMENT_FUNCTION_NAME = "track-authenticated-engagement";

const HEARTBEAT_INTERVAL_MS = 1_000;
const FLUSH_INTERVAL_MS = 60_000;
const MAX_OBSERVATION_GAP_MS = 5_000;
const MAX_ACTIVE_SECONDS_PER_REQUEST = 300;

let enabled = false;
let listenersAttached = false;
let heartbeatTimer: number | null = null;
let flushTimer: number | null = null;
let identifiers: AnonymousEngagementIdentifiers | null = null;
let accumulator: ActiveTimeAccumulator = createActiveTimeAccumulator();
let queuedActiveSeconds = 0;
let inFlightFlush: Promise<void> | null = null;
let consecutiveFailures = 0;
let nextRetryAt = 0;
let queueGeneration = 0;

function clockMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function randomPositiveUint32(): number {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random generation is unavailable.");
  }
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 4_294_967_295) + 1;
}

export function createAnonymousEngagementIdentifiers(): AnonymousEngagementIdentifiers {
  const clientPartA = randomPositiveUint32();
  const clientPartB = randomPositiveUint32();
  const sessionPartA = BigInt(randomPositiveUint32()) % 2_097_152n;
  const sessionPartB = BigInt(randomPositiveUint32());
  const sessionId = ((sessionPartA << 32n) | sessionPartB).toString();
  return {
    clientId: `${clientPartA}.${clientPartB}`,
    sessionId,
  };
}

function browserAvailable(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function mayCountActiveTime(): boolean {
  return enabled &&
    analyticsConsentGranted() &&
    document.visibilityState === "visible" &&
    typeof document.hasFocus === "function" &&
    document.hasFocus();
}

function observeCurrentState(forceInactive = false): void {
  if (!browserAvailable()) return;
  accumulator = observeActiveTime(
    accumulator,
    forceInactive ? false : mayCountActiveTime(),
    clockMs(),
    MAX_OBSERVATION_GAP_MS,
  );
}

function enqueueAccumulatedSeconds(): void {
  const drained = drainActiveTimeSeconds(accumulator);
  accumulator = drained.accumulator;
  queuedActiveSeconds += drained.activeSeconds;
}

function discardPendingEngagement(): void {
  queueGeneration += 1;
  accumulator = discardAccumulatedActiveTime(accumulator);
  queuedActiveSeconds = 0;
  consecutiveFailures = 0;
  nextRetryAt = 0;
}

function handlePresenceChange(): void {
  observeCurrentState();
  if (document.visibilityState === "hidden") {
    void flushAuthenticatedEngagement().catch(() => undefined);
  }
}

function handleConsentChange(): void {
  observeCurrentState();
  if (!analyticsConsentGranted()) discardPendingEngagement();
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== null && event.key !== ANALYTICS_CONSENT_KEY) return;
  handleConsentChange();
}

function handlePageHide(): void {
  observeCurrentState(true);
  void flushAuthenticatedEngagement().catch(() => undefined);
}

function attachListeners(): void {
  if (!browserAvailable() || listenersAttached) return;
  listenersAttached = true;
  document.addEventListener("visibilitychange", handlePresenceChange);
  window.addEventListener("focus", handlePresenceChange);
  window.addEventListener("blur", handlePresenceChange);
  window.addEventListener(ANALYTICS_CONSENT_EVENT, handleConsentChange);
  window.addEventListener("storage", handleStorageChange);
  window.addEventListener("pagehide", handlePageHide);
  // A hidden tab must not retry a failed flush on every one-second heartbeat.
  heartbeatTimer = window.setInterval(() => observeCurrentState(), HEARTBEAT_INTERVAL_MS);
  flushTimer = window.setInterval(() => {
    void flushAuthenticatedEngagement().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
}

function detachListeners(): void {
  if (!browserAvailable() || !listenersAttached) return;
  listenersAttached = false;
  document.removeEventListener("visibilitychange", handlePresenceChange);
  window.removeEventListener("focus", handlePresenceChange);
  window.removeEventListener("blur", handlePresenceChange);
  window.removeEventListener(ANALYTICS_CONSENT_EVENT, handleConsentChange);
  window.removeEventListener("storage", handleStorageChange);
  window.removeEventListener("pagehide", handlePageHide);
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  if (flushTimer !== null) window.clearInterval(flushTimer);
  heartbeatTimer = null;
  flushTimer = null;
}

async function transmitQueuedEngagement(): Promise<void> {
  if (Date.now() < nextRetryAt) return;
  const sendingIdentifiers = identifiers;
  const sendingGeneration = queueGeneration;
  while (queuedActiveSeconds > 0 && identifiers) {
    if (identifiers !== sendingIdentifiers) return;
    if (!analyticsConsentGranted()) {
      discardPendingEngagement();
      return;
    }

    const activeSeconds = Math.min(
      queuedActiveSeconds,
      MAX_ACTIVE_SECONDS_PER_REQUEST,
    );
    const payload: AuthenticatedEngagementPayload = {
      clientId: identifiers.clientId,
      sessionId: identifiers.sessionId,
      activeSeconds,
    };

    try {
      await invokeEdgeFunction<{ accepted: true }>(
        AUTHENTICATED_ENGAGEMENT_FUNCTION_NAME,
        payload,
        { authenticated: true },
      );
      if (identifiers !== sendingIdentifiers || queueGeneration !== sendingGeneration) return;
      queuedActiveSeconds -= activeSeconds;
      consecutiveFailures = 0;
      nextRetryAt = 0;
    } catch (error) {
      // Analytics is best-effort and must never interrupt authenticated work.
      if (identifiers !== sendingIdentifiers || queueGeneration !== sendingGeneration) return;
      if (error instanceof AuthenticatedSessionRequiredError) {
        discardPendingEngagement();
      } else {
        nextRetryAt = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(consecutiveFailures, 5));
        consecutiveFailures += 1;
      }
      return;
    }
  }
}

export function setAuthenticatedEngagementEnabled(nextEnabled: boolean): void {
  if (!browserAvailable() || nextEnabled === enabled) return;

  if (nextEnabled) {
    enabled = true;
    try {
      identifiers ??= createAnonymousEngagementIdentifiers();
    } catch {
      // Fail closed: unsupported browsers keep working without analytics.
      enabled = false;
      return;
    }
    accumulator = observeActiveTime(
      accumulator,
      mayCountActiveTime(),
      clockMs(),
      MAX_OBSERVATION_GAP_MS,
    );
    attachListeners();
    return;
  }

  observeCurrentState(true);
  enabled = false;
  detachListeners();
  // Explicit sign-out flushes before auth is removed. Losing auth must not send anonymously.
  discardPendingEngagement();
  identifiers = null;
}

export async function flushAuthenticatedEngagement(): Promise<void> {
  if (!browserAvailable()) return;
  observeCurrentState();
  enqueueAccumulatedSeconds();

  if (!identifiers || queuedActiveSeconds < 1) return;
  if (!analyticsConsentGranted()) {
    discardPendingEngagement();
    return;
  }
  if (inFlightFlush) {
    await inFlightFlush;
    return;
  }

  const operation = transmitQueuedEngagement();
  inFlightFlush = operation;
  try {
    await operation;
  } finally {
    if (inFlightFlush === operation) inFlightFlush = null;
  }
}

export async function flushAndStopAuthenticatedEngagement(): Promise<void> {
  if (!browserAvailable()) return;
  observeCurrentState(true);
  enabled = false;
  detachListeners();
  await flushAuthenticatedEngagement();

  // Never carry anonymous timing from one authorization session into another.
  queuedActiveSeconds = 0;
  consecutiveFailures = 0;
  nextRetryAt = 0;
  identifiers = null;
  accumulator = createActiveTimeAccumulator(clockMs(), false);
}
