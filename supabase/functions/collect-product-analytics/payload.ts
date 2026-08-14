export const PRODUCT_ANALYTICS_CONSENT_VERSION = 2;
export const PRODUCT_ANALYTICS_PAGE_CODES = [
  "projects",
  "dashboard",
  "map",
  "persons_list",
  "person_profile",
  "person_edit",
  "family_tree",
  "family_tree_pedigree",
  "ancestor_wheel",
  "tree_statistics",
  "researches",
  "documents",
  "document_viewer",
  "requests",
  "year_matrix",
  "tasks",
  "findings",
  "hypotheses",
  "backup",
  "settings",
  "subscription",
  "feedback",
  "custom_section",
  "unknown",
] as const;

export type ProductAnalyticsPageCode = typeof PRODUCT_ANALYTICS_PAGE_CODES[number];
export const PRODUCT_ANALYTICS_ACTION_CODES = [
  "project_open","project_create","person_create","person_edit","person_delete",
  "tree_open","tree_mode_change","tree_branch_expand","tree_search",
  "ancestor_chart_build","ancestor_chart_export","tree_statistics_open",
  "tree_statistics_export","gedcom_import_start","gedcom_import_complete",
  "gedcom_import_fail","gedcom_export_start","gedcom_export_complete",
  "gedcom_export_fail","document_create","document_viewer_open",
  "document_first_page_render","document_page_export","finding_create_from_document",
  "search_use","filter_apply","table_export","ai_hypothesis_check",
  "ai_document_recognition","feedback_create","subscription_page_open",
] as const;
export type ProductAnalyticsActionCode = typeof PRODUCT_ANALYTICS_ACTION_CODES[number];
export type ProductAnalyticsEventName =
  | "session_started"
  | "page_viewed"
  | "page_active_time"
  | "action_invoked"
  | "operation_finished";
export type ProductAnalyticsOutcome = "success" | "failure" | "cancelled";
export type ProductAnalyticsDurationBucket =
  | "lt_1s" | "1_3s" | "3_10s" | "10_30s" | "30_120s" | "gte_120s";
export type ProductAnalyticsCountBucket =
  | "1_100" | "101_500" | "501_2000" | "2001_10000" | "gte_10001";

export interface ProductAnalyticsEventPayload {
  eventId: string;
  name: ProductAnalyticsEventName;
  occurredAt: string;
  pageCode: ProductAnalyticsPageCode;
  activeSeconds: number;
  actionCode: ProductAnalyticsActionCode | null;
  outcome: ProductAnalyticsOutcome | null;
  durationBucket: ProductAnalyticsDurationBucket | null;
  countBucket: ProductAnalyticsCountBucket | null;
}

export interface ProductAnalyticsBatchPayload {
  sessionId: string;
  consentVersion: number;
  deviceClass: "desktop" | "tablet" | "mobile" | "unknown";
  viewportBucket: "xs" | "sm" | "md" | "lg" | "xl" | "unknown";
  appVersion: string;
  events: ProductAnalyticsEventPayload[];
}

export type ProductAnalyticsPayloadResult =
  | { ok: true; value: ProductAnalyticsBatchPayload }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_CLASSES = new Set(["desktop", "tablet", "mobile", "unknown"]);
const VIEWPORT_BUCKETS = new Set(["xs", "sm", "md", "lg", "xl", "unknown"]);
const EVENT_NAMES = new Set([
  "session_started", "page_viewed", "page_active_time", "action_invoked", "operation_finished",
]);
const PAGE_CODES = new Set<string>(PRODUCT_ANALYTICS_PAGE_CODES);
const ACTION_CODES = new Set<string>(PRODUCT_ANALYTICS_ACTION_CODES);
const OUTCOMES = new Set(["success", "failure", "cancelled"]);
const DURATION_BUCKETS = new Set(["lt_1s", "1_3s", "3_10s", "10_30s", "30_120s", "gte_120s"]);
const COUNT_BUCKETS = new Set(["1_100", "101_500", "501_2000", "2001_10000", "gte_10001"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseProductAnalyticsPayload(input: unknown): ProductAnalyticsPayloadResult {
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    "sessionId",
    "consentVersion",
    "deviceClass",
    "viewportBucket",
    "appVersion",
    "events",
  ])) {
    return { ok: false, error: "Invalid analytics batch shape." };
  }

  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const consentVersion = input.consentVersion;
  const deviceClass = typeof input.deviceClass === "string" ? input.deviceClass : "";
  const viewportBucket = typeof input.viewportBucket === "string" ? input.viewportBucket : "";
  const appVersion = typeof input.appVersion === "string" ? input.appVersion.trim() : "";
  const events = input.events;

  if (!UUID_PATTERN.test(sessionId)
    || consentVersion !== PRODUCT_ANALYTICS_CONSENT_VERSION
    || !DEVICE_CLASSES.has(deviceClass)
    || !VIEWPORT_BUCKETS.has(viewportBucket)
    || appVersion.length > 80
    || !Array.isArray(events)
    || events.length < 1
    || events.length > 50) {
    return { ok: false, error: "Invalid analytics batch." };
  }

  const parsedEvents: ProductAnalyticsEventPayload[] = [];
  const now = Date.now();
  for (const rawEvent of events) {
    if (!isPlainRecord(rawEvent) || !hasExactKeys(rawEvent, [
      "eventId",
      "name",
      "occurredAt",
      "pageCode",
      "activeSeconds",
      "actionCode",
      "outcome",
      "durationBucket",
      "countBucket",
    ])) {
      return { ok: false, error: "Invalid analytics event shape." };
    }

    const eventId = typeof rawEvent.eventId === "string" ? rawEvent.eventId : "";
    const name = typeof rawEvent.name === "string" ? rawEvent.name : "";
    const occurredAt = typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : "";
    const pageCode = typeof rawEvent.pageCode === "string" ? rawEvent.pageCode : "";
    const activeSeconds = rawEvent.activeSeconds;
    const actionCode = typeof rawEvent.actionCode === "string" ? rawEvent.actionCode : null;
    const outcome = typeof rawEvent.outcome === "string" ? rawEvent.outcome : null;
    const durationBucket = typeof rawEvent.durationBucket === "string" ? rawEvent.durationBucket : null;
    const countBucket = typeof rawEvent.countBucket === "string" ? rawEvent.countBucket : null;
    const occurredAtMs = Date.parse(occurredAt);

    const pageEvent = name === "session_started" || name === "page_viewed" || name === "page_active_time";
    const actionEvent = name === "action_invoked";
    const operationEvent = name === "operation_finished";
    const semanticFieldsValid = pageEvent
      ? actionCode === null && outcome === null && durationBucket === null && countBucket === null
      : actionEvent
        ? ACTION_CODES.has(actionCode ?? "")
          && outcome === null && durationBucket === null && countBucket === null
        : operationEvent
          ? ACTION_CODES.has(actionCode ?? "")
            && OUTCOMES.has(outcome ?? "")
            && DURATION_BUCKETS.has(durationBucket ?? "")
            && (countBucket === null || COUNT_BUCKETS.has(countBucket))
          : false;

    if (!UUID_PATTERN.test(eventId)
      || !EVENT_NAMES.has(name)
      || !PAGE_CODES.has(pageCode)
      || !Number.isFinite(occurredAtMs)
      || occurredAtMs < now - 24 * 60 * 60 * 1_000
      || occurredAtMs > now + 5 * 60 * 1_000
      || !Number.isInteger(activeSeconds)
      || (name === "page_active_time" && (Number(activeSeconds) < 1 || Number(activeSeconds) > 300))
      || (name !== "page_active_time" && activeSeconds !== 0)
      || !semanticFieldsValid) {
      return { ok: false, error: "Invalid analytics event." };
    }

    parsedEvents.push({
      eventId,
      name: name as ProductAnalyticsEventName,
      occurredAt: new Date(occurredAtMs).toISOString(),
      pageCode: pageCode as ProductAnalyticsPageCode,
      activeSeconds: Number(activeSeconds),
      actionCode: actionCode as ProductAnalyticsActionCode | null,
      outcome: outcome as ProductAnalyticsOutcome | null,
      durationBucket: durationBucket as ProductAnalyticsDurationBucket | null,
      countBucket: countBucket as ProductAnalyticsCountBucket | null,
    });
  }

  return {
    ok: true,
    value: {
      sessionId,
      consentVersion,
      deviceClass: deviceClass as ProductAnalyticsBatchPayload["deviceClass"],
      viewportBucket: viewportBucket as ProductAnalyticsBatchPayload["viewportBucket"],
      appVersion,
      events: parsedEvents,
    },
  };
}
