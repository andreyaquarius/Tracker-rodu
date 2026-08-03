export type ClientPdfOperationalEventName =
  | "document_source_resolve_started"
  | "document_source_resolve_succeeded"
  | "document_source_resolve_failed"
  | "pdf_viewer_opened"
  | "pdf_first_page_rendered"
  | "finding_created_from_pdf_selection"
  | "pdf_page_export_succeeded"
  | "pdf_page_export_failed";

export type PdfOperationalEventName = ClientPdfOperationalEventName | "pdf_proxy_request";

export type PdfOperationalRecord = Readonly<{
  component: "pdf_gateway";
  event: PdfOperationalEventName;
  request_id: string;
  provider?: "wikimedia" | "google_drive" | "direct_pdf" | "unknown";
  access_mode?: "direct_cors" | "secure_proxy" | "google_drive_api";
  status_code?: number;
  error_code?: string;
  duration_ms?: number;
  page_count?: number;
  file_size_bucket?: string;
  transferred_bytes?: number;
}>;

export type ParsedClientPdfOperationalEvent = Readonly<{
  projectId: string;
  record: PdfOperationalRecord;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLIENT_EVENT_NAMES = new Set<ClientPdfOperationalEventName>([
  "document_source_resolve_started",
  "document_source_resolve_succeeded",
  "document_source_resolve_failed",
  "pdf_viewer_opened",
  "pdf_first_page_rendered",
  "finding_created_from_pdf_selection",
  "pdf_page_export_succeeded",
  "pdf_page_export_failed",
]);
const ALLOWED_KEYS = new Set([
  "projectId",
  "event",
  "requestId",
  "provider",
  "accessMode",
  "statusCode",
  "errorCode",
  "durationMs",
  "pageCount",
  "fileSizeBucket",
  "transferredBytes",
]);
const PROVIDERS = new Set(["wikimedia", "google_drive", "direct_pdf", "unknown"]);
const ACCESS_MODES = new Set(["direct_cors", "secure_proxy", "google_drive_api"]);
const ERROR_CODES = new Set([
  "INVALID_URL",
  "UNSUPPORTED_SOURCE",
  "NOT_FOUND",
  "NOT_PDF",
  "ACCESS_DENIED",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "SOURCE_TOO_LARGE",
  "SOURCE_CHANGED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "CORRUPT_PDF",
  "EXPORT_FAILED",
  "DRIVE_ERROR",
  "UNKNOWN",
]);
const FILE_SIZE_BUCKETS = new Set([
  "unknown",
  "lt_1_mib",
  "1_to_10_mib",
  "10_to_100_mib",
  "100_to_500_mib",
  "gte_500_mib",
]);

/**
 * Strict server boundary. Extra fields are rejected rather than ignored so a
 * future caller cannot accidentally send a URL, title, ID, token, or message.
 */
export function parseClientPdfOperationalEvent(input: unknown): ParsedClientPdfOperationalEvent {
  if (!isRecord(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error("TELEMETRY_EVENT_INVALID");
  }
  const projectId = requiredUuid(input.projectId);
  const requestId = requiredUuid(input.requestId);
  if (typeof input.event !== "string" || !CLIENT_EVENT_NAMES.has(input.event as ClientPdfOperationalEventName)) {
    throw new Error("TELEMETRY_EVENT_INVALID");
  }
  const provider = optionalEnum(input.provider, PROVIDERS);
  const accessMode = optionalEnum(input.accessMode, ACCESS_MODES);
  const statusCode = optionalInteger(input.statusCode, 100, 599);
  const errorCode = optionalEnum(input.errorCode, ERROR_CODES);
  const durationMs = optionalInteger(input.durationMs, 0, 10 * 60 * 1000);
  const pageCount = optionalInteger(input.pageCount, 1, 2_000_000);
  const fileSizeBucket = optionalEnum(input.fileSizeBucket, FILE_SIZE_BUCKETS);
  const transferredBytes = optionalInteger(input.transferredBytes, 0, Number.MAX_SAFE_INTEGER);
  return {
    projectId,
    record: {
      component: "pdf_gateway",
      event: input.event as ClientPdfOperationalEventName,
      request_id: requestId,
      ...(provider ? { provider: provider as PdfOperationalRecord["provider"] } : {}),
      ...(accessMode ? { access_mode: accessMode as PdfOperationalRecord["access_mode"] } : {}),
      ...(statusCode === undefined ? {} : { status_code: statusCode }),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      ...(pageCount === undefined ? {} : { page_count: pageCount }),
      ...(fileSizeBucket ? { file_size_bucket: fileSizeBucket } : {}),
      ...(transferredBytes === undefined ? {} : { transferred_bytes: transferredBytes }),
    },
  };
}

export function createPdfProxyTelemetryRecord(input: {
  requestId: string;
  provider?: unknown;
  accessMode?: unknown;
  statusCode: number;
  errorCode?: unknown;
  durationMs: number;
  transferredBytes: number;
}): PdfOperationalRecord {
  const provider = optionalEnum(input.provider, PROVIDERS) ?? "unknown";
  const accessMode = typeof input.accessMode === "string" && ACCESS_MODES.has(input.accessMode)
    ? input.accessMode
    : undefined;
  const statusCode = optionalInteger(input.statusCode, 100, 599) ?? 500;
  const durationMs = optionalInteger(Math.round(input.durationMs), 0, 10 * 60 * 1000) ?? 0;
  const transferredBytes = optionalInteger(input.transferredBytes, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const errorCode = typeof input.errorCode === "string"
    ? sanitizeServerErrorCode(input.errorCode)
    : undefined;
  return {
    component: "pdf_gateway",
    event: "pdf_proxy_request",
    request_id: UUID_PATTERN.test(input.requestId) ? input.requestId : crypto.randomUUID(),
    provider: provider as PdfOperationalRecord["provider"],
    ...(accessMode ? { access_mode: accessMode as PdfOperationalRecord["access_mode"] } : {}),
    status_code: statusCode,
    ...(errorCode ? { error_code: errorCode } : {}),
    duration_ms: durationMs,
    transferred_bytes: transferredBytes,
  };
}

export function shouldSamplePdfProxySuccess(requestId: string, percent: number): boolean {
  const bounded = Number.isSafeInteger(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  if (bounded <= 0) return false;
  if (bounded >= 100) return true;
  let hash = 2_166_136_261;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return (hash % 100) < bounded;
}

export function shouldWritePdfProxyRecord(
  record: PdfOperationalRecord,
  successSamplePercent: number,
): boolean {
  return Boolean(record.error_code)
    || (record.status_code ?? 500) >= 400
    || shouldSamplePdfProxySuccess(record.request_id, successSamplePercent);
}

export function writePdfOperationalRecord(record: PdfOperationalRecord): void {
  const serialized = JSON.stringify(record);
  if (record.error_code || (record.status_code ?? 0) >= 400) console.error(serialized);
  else console.info(serialized);
}

function requiredUuid(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(normalized)) throw new Error("TELEMETRY_EVENT_INVALID");
  return normalized;
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("TELEMETRY_EVENT_INVALID");
  }
  return value;
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.has(value)) throw new Error("TELEMETRY_EVENT_INVALID");
  return value;
}

function sanitizeServerErrorCode(value: string): string {
  const normalized = value.trim().toLocaleUpperCase("en-US");
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized) ? normalized : "PDF_GATEWAY_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
