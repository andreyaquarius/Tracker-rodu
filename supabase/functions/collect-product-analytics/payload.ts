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
export type ProductAnalyticsEventName = "session_started" | "page_viewed" | "page_active_time";

export interface ProductAnalyticsEventPayload {
  eventId: string;
  name: ProductAnalyticsEventName;
  occurredAt: string;
  pageCode: ProductAnalyticsPageCode;
  activeSeconds: number;
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
const EVENT_NAMES = new Set(["session_started", "page_viewed", "page_active_time"]);
const PAGE_CODES = new Set<string>(PRODUCT_ANALYTICS_PAGE_CODES);

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
    ])) {
      return { ok: false, error: "Invalid analytics event shape." };
    }

    const eventId = typeof rawEvent.eventId === "string" ? rawEvent.eventId : "";
    const name = typeof rawEvent.name === "string" ? rawEvent.name : "";
    const occurredAt = typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : "";
    const pageCode = typeof rawEvent.pageCode === "string" ? rawEvent.pageCode : "";
    const activeSeconds = rawEvent.activeSeconds;
    const occurredAtMs = Date.parse(occurredAt);

    if (!UUID_PATTERN.test(eventId)
      || !EVENT_NAMES.has(name)
      || !PAGE_CODES.has(pageCode)
      || !Number.isFinite(occurredAtMs)
      || occurredAtMs < now - 24 * 60 * 60 * 1_000
      || occurredAtMs > now + 5 * 60 * 1_000
      || !Number.isInteger(activeSeconds)
      || (name === "page_active_time" && (Number(activeSeconds) < 1 || Number(activeSeconds) > 300))
      || (name !== "page_active_time" && activeSeconds !== 0)) {
      return { ok: false, error: "Invalid analytics event." };
    }

    parsedEvents.push({
      eventId,
      name: name as ProductAnalyticsEventName,
      occurredAt: new Date(occurredAtMs).toISOString(),
      pageCode: pageCode as ProductAnalyticsPageCode,
      activeSeconds: Number(activeSeconds),
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
