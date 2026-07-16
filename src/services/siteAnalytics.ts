export type AnalyticsAuthMethod = "email" | "google";

type TrackerRoduAnalyticsApi = Readonly<{
  activatePublicPage: (pathname: string) => boolean;
  hasConsent: () => boolean;
  openPreferences: () => void;
  suspendForPrivateApp: () => void;
  trackAuthSuccess: (method: AnalyticsAuthMethod) => Promise<boolean>;
}>;

type AnalyticsWindow = Window & {
  trackerRoduAnalytics?: TrackerRoduAnalyticsApi;
};

type PendingAuthAttempt = Readonly<{
  method: AnalyticsAuthMethod;
  startedAt: number;
}>;

export const ANALYTICS_CONSENT_KEY = "tracker-rodu-analytics-consent-v1";
export const ANALYTICS_CONSENT_EVENT = "tracker-rodu-analytics-consent-changed";

const ANALYTICS_READY_EVENT = "tracker-rodu-analytics-ready";
const PENDING_AUTH_KEY = "tracker-rodu-pending-auth-v1";
const PENDING_AUTH_TTL_MS = 30 * 60 * 1000;

function analyticsApi(): TrackerRoduAnalyticsApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as AnalyticsWindow).trackerRoduAnalytics;
}

function validAuthMethod(value: unknown): value is AnalyticsAuthMethod {
  return value === "email" || value === "google";
}

function takePendingAuthAttempt(now = Date.now()): PendingAuthAttempt | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PENDING_AUTH_KEY);
    window.sessionStorage.removeItem(PENDING_AUTH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PendingAuthAttempt>;
    if (!validAuthMethod(parsed.method) || typeof parsed.startedAt !== "number") {
      return null;
    }
    if (!Number.isFinite(parsed.startedAt) || parsed.startedAt > now) return null;
    if (now - parsed.startedAt > PENDING_AUTH_TTL_MS) return null;
    return { method: parsed.method, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

function waitForAnalyticsApi(timeoutMs = 1_500): Promise<TrackerRoduAnalyticsApi | undefined> {
  const current = analyticsApi();
  if (current || typeof window === "undefined") return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener(ANALYTICS_READY_EVENT, handleReady);
      window.clearTimeout(timeout);
      resolve(analyticsApi());
    };
    const handleReady = () => finish();
    const timeout = window.setTimeout(finish, timeoutMs);
    window.addEventListener(ANALYTICS_READY_EVENT, handleReady, { once: true });
  });
}

function clearAuthCallbackAddress(): boolean {
  if (typeof window === "undefined") return true;
  const location = window.location;
  if (
    location?.pathname !== "/" ||
    (!location.search && !location.hash) ||
    typeof window.history?.replaceState !== "function"
  ) {
    return true;
  }
  try {
    window.history.replaceState(window.history.state, "", "/");
    return !window.location.search && !window.location.hash;
  } catch {
    return false;
  }
}

export function beginAnalyticsAuth(method: AnalyticsAuthMethod): void {
  if (typeof window === "undefined") return;
  try {
    const attempt: PendingAuthAttempt = { method, startedAt: Date.now() };
    window.sessionStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(attempt));
  } catch {
    // Analytics must never prevent authorization when browser storage is blocked.
  }
}

export function cancelAnalyticsAuth(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_AUTH_KEY);
  } catch {
    // No-op: authorization remains functional without analytics storage.
  }
}

export async function reportPendingAuthSuccess(): Promise<boolean> {
  const attempt = takePendingAuthAttempt();
  if (!attempt) return false;
  if (!clearAuthCallbackAddress()) return false;
  const api = await waitForAnalyticsApi();
  return api?.trackAuthSuccess(attempt.method) ?? false;
}

export function activatePublicAnalyticsPage(pathname: string): void {
  const api = analyticsApi();
  if (api) {
    api.activatePublicPage(pathname);
    return;
  }
  if (typeof window === "undefined") return;
  window.addEventListener(
    ANALYTICS_READY_EVENT,
    () => analyticsApi()?.activatePublicPage(pathname),
    { once: true },
  );
}

export function suspendPublicAnalytics(): void {
  analyticsApi()?.suspendForPrivateApp();
}

export function analyticsConsentGranted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ANALYTICS_CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

export function openAnalyticsPreferences(): void {
  analyticsApi()?.openPreferences();
}
