import { invokeEdgeFunction } from "./edgeFunctions.ts";
import {
  PRODUCT_ANALYTICS_CONSENT_EVENT,
  PRODUCT_ANALYTICS_CONSENT_KEY,
  PRODUCT_ANALYTICS_CONSENT_VERSION,
  productAnalyticsConsentGranted,
} from "./productAnalyticsConsent.ts";
import {
  PRODUCT_ANALYTICS_PAGE_ACTIONS,
  type ProductAnalyticsActionCode,
  type ProductAnalyticsPageCode,
} from "../utils/productAnalyticsRegistry.ts";
import {
  productAnalyticsCountBucket,
  productAnalyticsDurationBucket,
  type ProductAnalyticsCountBucket,
  type ProductAnalyticsDurationBucket,
} from "../utils/productAnalyticsBuckets.ts";

export {
  productAnalyticsCountBucket,
  productAnalyticsDurationBucket,
} from "../utils/productAnalyticsBuckets.ts";

export const PRODUCT_ANALYTICS_FUNCTION_NAME = "collect-product-analytics";

type ProductAnalyticsEventName =
  | "session_started"
  | "page_viewed"
  | "page_active_time"
  | "action_invoked"
  | "operation_finished";
export type ProductAnalyticsOutcome = "success" | "failure" | "cancelled";
type ProductAnalyticsEvent = {
  eventId: string;
  name: ProductAnalyticsEventName;
  occurredAt: string;
  pageCode: ProductAnalyticsPageCode;
  activeSeconds: number;
  actionCode: ProductAnalyticsActionCode | null;
  outcome: ProductAnalyticsOutcome | null;
  durationBucket: ProductAnalyticsDurationBucket | null;
  countBucket: ProductAnalyticsCountBucket | null;
};

const FLUSH_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const IDLE_AFTER_MS = 5 * 60_000;
const MAX_QUEUE = 100;
const MAX_EVENT_AGE_MS = 23 * 60 * 60_000;
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

let enabled = false;
let currentPage: ProductAnalyticsPageCode = "unknown";
let sessionId: string | null = null;
let queue: ProductAnalyticsEvent[] = [];
let activeMilliseconds = 0;
let lastTickAt = Date.now();
let lastInteractionAt = Date.now();
let heartbeatTimer: number | null = null;
let flushTimer: number | null = null;
let listenersAttached = false;
let inFlight: Promise<void> | null = null;
let consecutiveFailures = 0;
let nextRetryAt = 0;

function browserAvailable(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function secureUuid(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Secure UUID generation is unavailable.");
  }
  return crypto.randomUUID();
}

function mayCount(now: number): boolean {
  return enabled
    && productAnalyticsConsentGranted()
    && document.visibilityState === "visible"
    && document.hasFocus()
    && now - lastInteractionAt <= IDLE_AFTER_MS;
}

function tick(forceInactive = false): void {
  if (!browserAvailable()) return;
  const now = Date.now();
  const elapsed = Math.max(0, Math.min(now - lastTickAt, 5_000));
  if (!forceInactive && mayCount(now)) activeMilliseconds += elapsed;
  lastTickAt = now;
}

function enqueue(event: Omit<ProductAnalyticsEvent, "eventId" | "occurredAt">): void {
  try {
    queue.push({
      ...event,
      eventId: secureUuid(),
      occurredAt: new Date().toISOString(),
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
  } catch {
    // Fail closed when secure randomness is unavailable.
  }
}

function enqueueActiveTime(): void {
  const seconds = Math.min(300, Math.floor(activeMilliseconds / 1_000));
  if (seconds < 1) return;
  activeMilliseconds -= seconds * 1_000;
  enqueue({
    name: "page_active_time",
    pageCode: currentPage,
    activeSeconds: seconds,
    actionCode: null,
    outcome: null,
    durationBucket: null,
    countBucket: null,
  });
}

function enqueuePageAction(pageCode: ProductAnalyticsPageCode): void {
  const actionCode = PRODUCT_ANALYTICS_PAGE_ACTIONS[pageCode];
  if (!actionCode) return;
  enqueue({
    name: "action_invoked",
    pageCode,
    activeSeconds: 0,
    actionCode,
    outcome: null,
    durationBucket: null,
    countBucket: null,
  });
}

function handleInteraction(): void {
  tick();
  lastInteractionAt = Date.now();
}

function handlePresenceChange(): void {
  tick();
  if (document.visibilityState === "hidden") void flushProductAnalytics();
}

function handleConsentChange(): void {
  tick(true);
  if (!productAnalyticsConsentGranted()) {
    queue = [];
    activeMilliseconds = 0;
    consecutiveFailures = 0;
    nextRetryAt = 0;
  } else if (enabled && !sessionId) {
    startSession();
  }
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PRODUCT_ANALYTICS_CONSENT_KEY) return;
  handleConsentChange();
}

function handlePageHide(): void {
  tick(true);
  void flushProductAnalytics();
}

function attachListeners(): void {
  if (!browserAvailable() || listenersAttached) return;
  listenersAttached = true;
  document.addEventListener("visibilitychange", handlePresenceChange);
  window.addEventListener("focus", handlePresenceChange);
  window.addEventListener("blur", handlePresenceChange);
  window.addEventListener("pointerdown", handleInteraction, { passive: true });
  window.addEventListener("keydown", handleInteraction);
  window.addEventListener("scroll", handleInteraction, { passive: true });
  window.addEventListener(PRODUCT_ANALYTICS_CONSENT_EVENT, handleConsentChange);
  window.addEventListener("storage", handleStorage);
  window.addEventListener("pagehide", handlePageHide);
  heartbeatTimer = window.setInterval(() => tick(), HEARTBEAT_INTERVAL_MS);
  flushTimer = window.setInterval(() => void flushProductAnalytics(), FLUSH_INTERVAL_MS);
}

function detachListeners(): void {
  if (!browserAvailable() || !listenersAttached) return;
  listenersAttached = false;
  document.removeEventListener("visibilitychange", handlePresenceChange);
  window.removeEventListener("focus", handlePresenceChange);
  window.removeEventListener("blur", handlePresenceChange);
  window.removeEventListener("pointerdown", handleInteraction);
  window.removeEventListener("keydown", handleInteraction);
  window.removeEventListener("scroll", handleInteraction);
  window.removeEventListener(PRODUCT_ANALYTICS_CONSENT_EVENT, handleConsentChange);
  window.removeEventListener("storage", handleStorage);
  window.removeEventListener("pagehide", handlePageHide);
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  if (flushTimer !== null) window.clearInterval(flushTimer);
  heartbeatTimer = null;
  flushTimer = null;
}

function deviceClass(): "desktop" | "tablet" | "mobile" | "unknown" {
  if (!browserAvailable()) return "unknown";
  const width = window.innerWidth;
  if (width < 768) return "mobile";
  if (width < 1100) return "tablet";
  return "desktop";
}

function viewportBucket(): "xs" | "sm" | "md" | "lg" | "xl" | "unknown" {
  if (!browserAvailable()) return "unknown";
  const width = window.innerWidth;
  if (width < 480) return "xs";
  if (width < 768) return "sm";
  if (width < 1100) return "md";
  if (width < 1440) return "lg";
  return "xl";
}

function startSession(): void {
  if (!enabled || !productAnalyticsConsentGranted()) return;
  try {
    sessionId = secureUuid();
  } catch {
    enabled = false;
    return;
  }
  lastTickAt = Date.now();
  lastInteractionAt = Date.now();
  enqueue({
    name: "session_started",
    pageCode: currentPage,
    activeSeconds: 0,
    actionCode: null,
    outcome: null,
    durationBucket: null,
    countBucket: null,
  });
  enqueue({
    name: "page_viewed",
    pageCode: currentPage,
    activeSeconds: 0,
    actionCode: null,
    outcome: null,
    durationBucket: null,
    countBucket: null,
  });
  enqueuePageAction(currentPage);
}

export function setProductAnalyticsEnabled(nextEnabled: boolean): void {
  if (!browserAvailable() || nextEnabled === enabled) return;
  tick(true);
  enabled = nextEnabled;
  if (enabled) {
    attachListeners();
    if (!sessionId) startSession();
  } else {
    detachListeners();
    void flushProductAnalytics();
  }
}

export function setProductAnalyticsPage(pageCode: ProductAnalyticsPageCode): void {
  if (!browserAvailable() || pageCode === currentPage) return;
  tick(true);
  enqueueActiveTime();
  currentPage = pageCode;
  lastTickAt = Date.now();
  if (enabled && sessionId && productAnalyticsConsentGranted()) {
    enqueue({
      name: "page_viewed",
      pageCode,
      activeSeconds: 0,
      actionCode: null,
      outcome: null,
      durationBucket: null,
      countBucket: null,
    });
    enqueuePageAction(pageCode);
  }
}

function mayTrackAction(): boolean {
  return browserAvailable()
    && enabled
    && Boolean(sessionId)
    && productAnalyticsConsentGranted();
}

export function trackProductAnalyticsAction(actionCode: ProductAnalyticsActionCode): void {
  if (!mayTrackAction()) return;
  enqueue({
    name: "action_invoked",
    pageCode: currentPage,
    activeSeconds: 0,
    actionCode,
    outcome: null,
    durationBucket: null,
    countBucket: null,
  });
}

export function trackProductAnalyticsOperation(
  actionCode: ProductAnalyticsActionCode,
  outcome: ProductAnalyticsOutcome,
  durationMs: number,
  count?: number | null,
): void {
  if (!mayTrackAction()) return;
  enqueue({
    name: "operation_finished",
    pageCode: currentPage,
    activeSeconds: 0,
    actionCode,
    outcome,
    durationBucket: productAnalyticsDurationBucket(durationMs),
    countBucket: productAnalyticsCountBucket(count),
  });
}

async function transmit(): Promise<void> {
  const now = Date.now();
  if (now < nextRetryAt) return;
  queue = queue.filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    return Number.isFinite(occurredAt) && occurredAt >= now - MAX_EVENT_AGE_MS;
  });

  while (queue.length > 0 && sessionId && productAnalyticsConsentGranted()) {
    const batch = queue.slice(0, 50);
    try {
      await invokeEdgeFunction<{ accepted: true }>(PRODUCT_ANALYTICS_FUNCTION_NAME, {
        sessionId,
        consentVersion: PRODUCT_ANALYTICS_CONSENT_VERSION,
        deviceClass: deviceClass(),
        viewportBucket: viewportBucket(),
        appVersion: String(import.meta.env.VITE_APP_VERSION ?? "").slice(0, 80),
        events: batch,
      });
      queue.splice(0, batch.length);
      consecutiveFailures = 0;
      nextRetryAt = 0;
    } catch {
      const retryDelay = RETRY_DELAYS_MS[Math.min(consecutiveFailures, RETRY_DELAYS_MS.length - 1)];
      consecutiveFailures += 1;
      nextRetryAt = Date.now() + retryDelay;
      return;
    }
  }
}

export async function flushProductAnalytics(): Promise<void> {
  if (!browserAvailable()) return;
  tick();
  enqueueActiveTime();
  if (!sessionId || queue.length < 1 || !productAnalyticsConsentGranted()) return;
  if (inFlight) return inFlight;
  const operation = transmit();
  inFlight = operation;
  try {
    await operation;
  } finally {
    if (inFlight === operation) inFlight = null;
  }
}

export async function flushAndStopProductAnalytics(): Promise<void> {
  if (!browserAvailable()) return;
  tick(true);
  enqueueActiveTime();
  await flushProductAnalytics();
  enabled = false;
  detachListeners();
  queue = [];
  sessionId = null;
  activeMilliseconds = 0;
  consecutiveFailures = 0;
  nextRetryAt = 0;
  lastTickAt = Date.now();
}
