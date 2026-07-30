import type {
  DocumentSourceProvider,
  PdfAccessMode,
} from "./document-sources/contracts.ts";
import { DocumentSourceError } from "./document-sources/errors.ts";

export type PdfOperationalEventName =
  | "document_source_resolve_started"
  | "document_source_resolve_succeeded"
  | "document_source_resolve_failed"
  | "pdf_viewer_opened"
  | "pdf_first_page_rendered"
  | "finding_created_from_pdf_selection"
  | "pdf_page_export_succeeded"
  | "pdf_page_export_failed";

export type PdfOperationalErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SOURCE"
  | "NOT_FOUND"
  | "NOT_PDF"
  | "ACCESS_DENIED"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_CHANGED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CORRUPT_PDF"
  | "EXPORT_FAILED"
  | "DRIVE_ERROR"
  | "UNKNOWN";

export type PdfFileSizeBucket =
  | "unknown"
  | "lt_1_mib"
  | "1_to_10_mib"
  | "10_to_100_mib"
  | "100_to_500_mib"
  | "gte_500_mib";

/**
 * Privacy-safe operational fields. This type deliberately has no document,
 * person, user, source URL, file name, token, header, or free-text field.
 */
export interface PdfOperationalEventInput {
  event: PdfOperationalEventName;
  requestId?: string;
  provider?: DocumentSourceProvider | "unknown";
  accessMode?: PdfAccessMode;
  statusCode?: number;
  errorCode?: PdfOperationalErrorCode;
  durationMs?: number;
  pageCount?: number;
  fileSizeBucket?: PdfFileSizeBucket;
  transferredBytes?: number;
}

export interface SafePdfOperationalEvent extends PdfOperationalEventInput {
  requestId: string;
}

const EVENT_NAMES = new Set<PdfOperationalEventName>([
  "document_source_resolve_started",
  "document_source_resolve_succeeded",
  "document_source_resolve_failed",
  "pdf_viewer_opened",
  "pdf_first_page_rendered",
  "finding_created_from_pdf_selection",
  "pdf_page_export_succeeded",
  "pdf_page_export_failed",
]);
const PROVIDERS = new Set(["wikimedia", "google_drive", "direct_pdf", "unknown"]);
const ACCESS_MODES = new Set(["direct_cors", "secure_proxy", "google_drive_api"]);
const ERROR_CODES = new Set<PdfOperationalErrorCode>([
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
const FILE_SIZE_BUCKETS = new Set<PdfFileSizeBucket>([
  "unknown",
  "lt_1_mib",
  "1_to_10_mib",
  "10_to_100_mib",
  "100_to_500_mib",
  "gte_500_mib",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TELEMETRY_TIMEOUT_MS = 3_000;

export function createPdfOperationalRequestId(candidate?: string): string {
  const normalized = candidate?.trim() ?? "";
  if (UUID_PATTERN.test(normalized)) return normalized;
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomUuid();
}

export function pdfFileSizeBucket(bytes: number | null | undefined): PdfFileSizeBucket {
  if (!Number.isFinite(bytes) || !Number.isSafeInteger(bytes) || (bytes ?? -1) < 0) return "unknown";
  const value = bytes as number;
  const mib = 1024 * 1024;
  if (value < mib) return "lt_1_mib";
  if (value < 10 * mib) return "1_to_10_mib";
  if (value < 100 * mib) return "10_to_100_mib";
  if (value < 500 * mib) return "100_to_500_mib";
  return "gte_500_mib";
}

export function safePdfOperationalErrorCode(
  error: unknown,
  fallback: PdfOperationalErrorCode = "UNKNOWN",
): PdfOperationalErrorCode {
  if (error instanceof DocumentSourceError) {
    const mapped: Partial<Record<DocumentSourceError["code"], PdfOperationalErrorCode>> = {
      INVALID_URL: "INVALID_URL",
      UNSUPPORTED_SCHEME: "INVALID_URL",
      SENSITIVE_URL_NOT_PERSISTABLE: "INVALID_URL",
      UNSUPPORTED_PROVIDER: "UNSUPPORTED_SOURCE",
      MULTIPLE_SOURCE_CANDIDATES: "UNSUPPORTED_SOURCE",
      SOURCE_NOT_FOUND: "NOT_FOUND",
      WIKIMEDIA_FILE_NOT_FOUND: "NOT_FOUND",
      SOURCE_NOT_PDF: "NOT_PDF",
      ACCESS_DENIED: "ACCESS_DENIED",
      GOOGLE_DRIVE_PERMISSION_DENIED: "ACCESS_DENIED",
      OAUTH_REQUIRED: "AUTH_REQUIRED",
      GOOGLE_DRIVE_QUOTA_EXCEEDED: "RATE_LIMITED",
      SOURCE_TOO_LARGE_WITHOUT_RANGE: "SOURCE_TOO_LARGE",
      SOURCE_CHANGED: "SOURCE_CHANGED",
      NETWORK_ERROR: "NETWORK_ERROR",
      TIMEOUT: "TIMEOUT",
      PDF_CORRUPT: "CORRUPT_PDF",
      PDF_PASSWORD_REQUIRED: "CORRUPT_PDF",
      EXPORT_FAILED: "EXPORT_FAILED",
    };
    return mapped[error.code] ?? fallback;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  return fallback;
}

/** Runtime allowlist: unknown or private caller fields are never serialized. */
export function normalizePdfOperationalEvent(input: unknown): SafePdfOperationalEvent | null {
  if (!isRecord(input) || !EVENT_NAMES.has(input.event as PdfOperationalEventName)) return null;
  const event = input.event as PdfOperationalEventName;
  const requestId = createPdfOperationalRequestId(
    typeof input.requestId === "string" ? input.requestId : undefined,
  );
  const provider = typeof input.provider === "string" && PROVIDERS.has(input.provider)
    ? input.provider as SafePdfOperationalEvent["provider"]
    : undefined;
  const accessMode = typeof input.accessMode === "string" && ACCESS_MODES.has(input.accessMode)
    ? input.accessMode as PdfAccessMode
    : undefined;
  const statusCode = boundedInteger(input.statusCode, 100, 599);
  const errorCode = typeof input.errorCode === "string" && ERROR_CODES.has(input.errorCode as PdfOperationalErrorCode)
    ? input.errorCode as PdfOperationalErrorCode
    : undefined;
  const durationMs = boundedInteger(input.durationMs, 0, 10 * 60 * 1000);
  const pageCount = boundedInteger(input.pageCount, 1, 2_000_000);
  const fileSizeBucket = typeof input.fileSizeBucket === "string"
    && FILE_SIZE_BUCKETS.has(input.fileSizeBucket as PdfFileSizeBucket)
    ? input.fileSizeBucket as PdfFileSizeBucket
    : undefined;
  const transferredBytes = boundedInteger(input.transferredBytes, 0, Number.MAX_SAFE_INTEGER);
  return {
    event,
    requestId,
    ...(provider ? { provider } : {}),
    ...(accessMode ? { accessMode } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode ? { errorCode } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(fileSizeBucket ? { fileSizeBucket } : {}),
    ...(transferredBytes === undefined ? {} : { transferredBytes }),
  };
}

/**
 * Best-effort operational transport. Failures are intentionally swallowed so
 * telemetry can never block opening, reading, exporting, or saving a finding.
 */
export async function emitPdfOperationalEvent(
  projectId: string,
  input: PdfOperationalEventInput,
): Promise<void> {
  try {
    if (!UUID_PATTERN.test(projectId.trim()) || typeof fetch !== "function") return;
    const safeEvent = normalizePdfOperationalEvent(input);
    if (!safeEvent) return;
    const { getSupabaseSession } = await import("./supabaseAuth.ts");
    const session = await getSupabaseSession();
    if (!session?.access_token) return;
    const endpoint = telemetryEndpoint();
    if (!endpoint) return;
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      await fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        keepalive: true,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          ...(clientEnvironment().VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
            ? { apikey: clientEnvironment().VITE_SUPABASE_PUBLISHABLE_KEY!.trim() }
            : {}),
        },
        body: JSON.stringify({ projectId: projectId.trim(), ...safeEvent }),
      });
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  } catch {
    // Operational telemetry is never user-facing and must not change UX.
  }
}

function telemetryEndpoint(): string | null {
  const environment = clientEnvironment();
  const local = environment.VITE_LOCAL_EDGE_FUNCTIONS_URL?.trim();
  if (local) {
    const base = local.replace(/\/+$/gu, "");
    return `${base.endsWith("/pdf-gateway") ? base : `${base}/pdf-gateway`}/client-event`;
  }
  const supabaseUrl = environment.VITE_SUPABASE_URL?.trim();
  return supabaseUrl
    ? `${supabaseUrl.replace(/\/+$/gu, "")}/functions/v1/pdf-gateway/client-event`
    : null;
}

function clientEnvironment(): Partial<ImportMetaEnv> {
  return (import.meta as ImportMeta & { env?: Partial<ImportMetaEnv> }).env ?? {};
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fallbackRandomUuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
