import {
  init, captureException, browserApiErrorsIntegration, globalHandlersIntegration,
  dedupeIntegration, functionToStringIntegration, inboundFiltersIntegration,
  type ErrorEvent,
} from "@sentry/react";
import {
  createMonitoringRateLimit, isExpectedBrowserError, isPrivateShareRoute,
  sanitizeBrowserEvent, sentryIngestOrigin,
} from "../utils/browserMonitoringPrivacy.ts";

let enabled = false;

export function initializeBrowserMonitoring(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim() ?? "";
  if (enabled || !import.meta.env.PROD || import.meta.env.VITE_SENTRY_ENABLED === "false"
    || !sentryIngestOrigin(dsn) || isPrivateShareRoute(window.location.pathname)) return;
  const accept = createMonitoringRateLimit();
  try {
    init({
      dsn,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || "production",
      release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
      defaultIntegrations: false,
      integrations: [
        inboundFiltersIntegration(), functionToStringIntegration(),
        browserApiErrorsIntegration(), globalHandlersIntegration(), dedupeIntegration(),
      ],
      dataCollection: {
        userInfo: false, cookies: false,
        httpHeaders: { request: false, response: false }, httpBodies: [],
        urlQueryParams: false, databaseQueryData: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false }, stackFrameVariables: false, frameContextLines: 0,
      },
      enableLogs: false,
      enableMetrics: false,
      sendClientReports: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      enhanceFetchErrorMessages: false,
      transportOptions: {
        fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" },
      },
      beforeSend(event, hint) {
        // No attachment may bypass the event allowlist.
        hint.attachments = [];
        if (isExpectedBrowserError(hint.originalException)) return null;
        const sanitized = sanitizeBrowserEvent(event, window.location.pathname, navigator.userAgent);
        if (!sanitized || !accept(sanitized)) return null;
        return sanitized;
      },
    });
    enabled = true;
  } catch {
    // Monitoring must never prevent the application from opening.
    enabled = false;
  }
}

export function isBrowserMonitoringEnabled(): boolean {
  return enabled && !isPrivateShareRoute(window.location.pathname);
}

export function reportBrowserError(
  error: unknown,
  area: "react-root" | "react-recovery" | "route" | "family-tree" | "supabase" | "monitoring-test",
  tags: ErrorEvent["tags"] = {},
): string | undefined {
  if (!enabled || isExpectedBrowserError(error)) return undefined;
  try {
    return captureException(error, { tags: { ...tags, area } });
  } catch {
    // A failed reporter must not replace the original error or trigger a retry.
  }
}
