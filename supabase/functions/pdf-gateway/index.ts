import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";
import { decryptApiKey, encryptApiKey } from "../_shared/ai.ts";
import {
  pdfGatewayLimitsFromEnvironment,
  type PdfGatewayLimits,
} from "./config.ts";
import {
  createBoundedPdfStream,
  fetchPublicPdfWithRedirects,
  safePdfResponseHeaders,
  validatePdfHeadResponse,
  validatePdfUpstreamResponse,
  PdfGatewayUpstreamError,
  rangeFromRequest,
} from "./gatewayCore.ts";
import {
  assertSameAddressSet,
  PdfGatewaySecurityError,
  resolvePublicHostAddresses,
  validatePublicPdfUrl,
} from "./security.ts";
import {
  canonicalFingerprint,
  createOpaqueSessionToken,
  hashOpaqueSessionToken,
  isValidOpaqueSessionToken,
} from "./session.ts";
import {
  createPdfProxyTelemetryRecord,
  parseClientPdfOperationalEvent,
  shouldWritePdfProxyRecord,
  writePdfOperationalRecord,
} from "./telemetry.ts";
import {
  GoogleDrivePublicError,
  googleDrivePublicMediaUrl,
  googleDrivePublicMetadataUrl,
  parseGoogleDrivePublicMetadata,
  parseGoogleDrivePublicReference,
} from "./googleDrivePublic.ts";

type DocumentSourceRow = {
  id: string;
  project_id: string;
  document_id: string;
  provider: string;
  original_url: string;
  canonical_url: string | null;
  provider_host: string | null;
  provider_file_id: string | null;
  mime_type: string;
  access_mode: string;
  fingerprint: Record<string, unknown> | null;
  status: string;
  initial_page: number | null;
  updated_at: string;
};

type PdfAccessSessionRow = {
  id: string;
  project_id: string;
  document_id: string;
  document_source_id: string;
  user_id: string;
  provider: string;
  upstream_host: string;
  source_fingerprint: Record<string, unknown> | null;
  upstream_authorization_ciphertext: string | null;
  upstream_access_mode: "secure_proxy" | "google_drive_api";
  expires_at: string;
};

const DOCUMENT_SOURCE_FIELDS = [
  "id",
  "project_id",
  "document_id",
  "provider",
  "original_url",
  "canonical_url",
  "provider_host",
  "provider_file_id",
  "mime_type",
  "access_mode",
  "fingerprint",
  "status",
  "initial_page",
  "updated_at",
].join(", ");

class PdfGatewayHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "PdfGatewayHttpError";
    this.status = status;
    this.code = code;
  }
}

function environment(): Record<string, string | undefined> {
  return {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? undefined,
    SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY") ?? undefined,
    SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS") ?? undefined,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined,
    SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? undefined,
    SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? undefined,
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY") ?? undefined,
    PDF_PROXY_TOKEN_TTL_SECONDS: Deno.env.get("PDF_PROXY_TOKEN_TTL_SECONDS") ?? undefined,
    PDF_PROXY_MAX_REDIRECTS: Deno.env.get("PDF_PROXY_MAX_REDIRECTS") ?? undefined,
    PDF_PROXY_CONNECT_TIMEOUT_MS: Deno.env.get("PDF_PROXY_CONNECT_TIMEOUT_MS") ?? undefined,
    PDF_PROXY_STREAM_IDLE_TIMEOUT_MS: Deno.env.get("PDF_PROXY_STREAM_IDLE_TIMEOUT_MS") ?? undefined,
    PDF_FALLBACK_MAX_BYTES_WITHOUT_RANGE: Deno.env.get("PDF_FALLBACK_MAX_BYTES_WITHOUT_RANGE") ?? undefined,
    PDF_PROXY_MAX_RANGE_RESPONSE_BYTES: Deno.env.get("PDF_PROXY_MAX_RANGE_RESPONSE_BYTES") ?? undefined,
    PDF_PROXY_MAX_REQUESTS_PER_SESSION: Deno.env.get("PDF_PROXY_MAX_REQUESTS_PER_SESSION") ?? undefined,
    PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT: Deno.env.get("PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT") ?? undefined,
    PDF_PROBE_MAX_REQUESTS_PER_WINDOW: Deno.env.get("PDF_PROBE_MAX_REQUESTS_PER_WINDOW") ?? undefined,
    PDF_PROBE_WINDOW_SECONDS: Deno.env.get("PDF_PROBE_WINDOW_SECONDS") ?? undefined,
    PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW: Deno.env.get("PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW") ?? undefined,
    PDF_TELEMETRY_WINDOW_SECONDS: Deno.env.get("PDF_TELEMETRY_WINDOW_SECONDS") ?? undefined,
    PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT: Deno.env.get("PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT") ?? undefined,
    PDF_PROXY_MAX_REQUEST_BODY_BYTES: Deno.env.get("PDF_PROXY_MAX_REQUEST_BODY_BYTES") ?? undefined,
    ENCRYPTION_KEY: Deno.env.get("ENCRYPTION_KEY") ?? undefined,
    GOOGLE_DRIVE_PUBLIC_API_KEY: Deno.env.get("GOOGLE_DRIVE_PUBLIC_API_KEY") ?? undefined,
    PDF_EXPORT_WORKER_URL: Deno.env.get("PDF_EXPORT_WORKER_URL") ?? undefined,
    PDF_EXPORT_WORKER_SECRET: Deno.env.get("PDF_EXPORT_WORKER_SECRET") ?? undefined,
    PDF_EXPORT_WORKER_ALLOW_HTTP_LOCAL: Deno.env.get("PDF_EXPORT_WORKER_ALLOW_HTTP_LOCAL") ?? undefined,
    PDF_EXPORT_MAX_REQUESTS_PER_WINDOW: Deno.env.get("PDF_EXPORT_MAX_REQUESTS_PER_WINDOW") ?? undefined,
    PDF_EXPORT_WINDOW_SECONDS: Deno.env.get("PDF_EXPORT_WINDOW_SECONDS") ?? undefined,
    PDF_EXPORT_MAX_PAGES: Deno.env.get("PDF_EXPORT_MAX_PAGES") ?? undefined,
    PDF_EXPORT_MAX_RESULT_BYTES: Deno.env.get("PDF_EXPORT_MAX_RESULT_BYTES") ?? undefined,
    PDF_EXPORT_WORKER_TIMEOUT_MS: Deno.env.get("PDF_EXPORT_WORKER_TIMEOUT_MS") ?? undefined,
  };
}

const REQUEST_IDS = new WeakMap<Request, string>();

function requestId(request: Request): string {
  const existing = REQUEST_IDS.get(request);
  if (existing) return existing;
  const created = crypto.randomUUID();
  REQUEST_IDS.set(request, created);
  return created;
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return "";
  }
}

function configuredAppOrigins(): Set<string> {
  return new Set(
    [Deno.env.get("APP_URL"), Deno.env.get("ALLOWED_ORIGIN")]
      .flatMap((value) => (value ?? "").split(","))
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

function isLoopbackDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
    return (url.protocol === "http:" || url.protocol === "https:")
      && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string): boolean {
  return configuredAppOrigins().has(origin) || isLoopbackDevelopmentOrigin(origin);
}

function isAllowedBrowserOrigin(request: Request): boolean {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  return !origin || isAllowedOrigin(origin);
}

function responseHeaders(request: Request): Record<string, string> {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, range, if-range",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, Last-Modified, X-Request-Id",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
    "X-Request-Id": requestId(request),
  };
  if (origin && isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  return /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]?.trim() ?? "";
}

async function authenticatedContext(request: Request) {
  const accessToken = bearerToken(request);
  if (!accessToken) {
    throw new PdfGatewayHttpError(401, "AUTH_REQUIRED", "Потрібна авторизація.");
  }
  const env = environment();
  const supabaseUrl = env.SUPABASE_URL?.trim() ?? "";
  const publishableKey = resolveSupabasePublishableKey(env);
  const secretKey = resolveSupabaseSecretKey(env);
  if (!supabaseUrl || !publishableKey || !secretKey) {
    throw new PdfGatewayHttpError(
      500,
      "SERVER_CONFIGURATION_MISSING",
      "Серверна функція налаштована неповністю.",
    );
  }

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await userClient.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new PdfGatewayHttpError(401, "AUTH_INVALID", "Не вдалося підтвердити користувача.");
  }
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: supabaseServerKeyHeaders(secretKey) },
  });
  return { user: data.user, userClient, admin };
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new PdfGatewayHttpError(413, "REQUEST_TOO_LARGE", "Запит завеликий.");
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request-too-large").catch(() => undefined);
        throw new PdfGatewayHttpError(413, "REQUEST_TOO_LARGE", "Запит завеликий.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new PdfGatewayHttpError(400, "REQUEST_INVALID", "Некоректний JSON-запит.");
  }
}

function requiredUuid(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new PdfGatewayHttpError(400, code, "Некоректний ідентифікатор документа.");
  }
  return normalized;
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredUuid(value, "DOCUMENT_SOURCE_ID_INVALID");
}

function optionalGoogleDriveAccessToken(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new PdfGatewayHttpError(400, "GOOGLE_DRIVE_TOKEN_INVALID", "Некоректний доступ до Google Drive.");
  }
  const token = value.trim();
  if (
    token.length < 20
    || token.length > 4096
    || /[\u0000-\u0020\u007f]/u.test(token)
  ) {
    throw new PdfGatewayHttpError(400, "GOOGLE_DRIVE_TOKEN_INVALID", "Некоректний доступ до Google Drive.");
  }
  return token;
}

function optionalOpaqueAccessSessionToken(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const token = typeof value === "string" ? value.trim() : "";
  if (!isValidOpaqueSessionToken(token)) {
    throw new PdfGatewayHttpError(400, "SESSION_INVALID", "Сесія перегляду недійсна.");
  }
  return token;
}

function requiredExportPages(value: unknown, maximumPages: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumPages) {
    throw new PdfGatewayHttpError(
      400,
      "EXPORT_PAGES_INVALID",
      `Оберіть від 1 до ${maximumPages} сторінок для експорту.`,
    );
  }
  const pages = [...new Set(value)];
  if (pages.some((page) => !Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 1_000_000)) {
    throw new PdfGatewayHttpError(400, "EXPORT_PAGES_INVALID", "Номери сторінок мають бути цілими числами від 1.");
  }
  return (pages as number[]).sort((left, right) => left - right);
}

function optionalExportFileName(value: unknown): string {
  const raw = typeof value === "string" ? value.normalize("NFKC") : "";
  const safe = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return `${(safe || "document-pages").replace(/\.pdf$/iu, "")}.pdf`;
}

function configuredPdfExportWorker(
  env: Record<string, string | undefined>,
): { url: URL; secret: string } {
  const rawUrl = env.PDF_EXPORT_WORKER_URL?.trim() ?? "";
  const secret = env.PDF_EXPORT_WORKER_SECRET?.trim() ?? "";
  if (!rawUrl || secret.length < 32) {
    throw new PdfGatewayHttpError(
      503,
      "SERVER_EXPORT_NOT_CONFIGURED",
      "Серверне формування великих PDF ще не налаштоване.",
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PdfGatewayHttpError(503, "SERVER_EXPORT_NOT_CONFIGURED", "Адреса сервісу PDF-експорту некоректна.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const dockerHost = hostname === "host.docker.internal";
  const localHttpAllowed = url.protocol === "http:"
    && (loopback || (dockerHost && env.PDF_EXPORT_WORKER_ALLOW_HTTP_LOCAL === "true"));
  if (
    (url.protocol !== "https:" && !localHttpAllowed)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new PdfGatewayHttpError(503, "SERVER_EXPORT_NOT_CONFIGURED", "Адреса сервісу PDF-експорту некоректна.");
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/export";
  return { url, secret };
}

function optionalConfiguredPdfStreamWorker(
  env: Record<string, string | undefined>,
): { url: URL; secret: string } | undefined {
  const rawUrl = env.PDF_EXPORT_WORKER_URL?.trim() ?? "";
  const secret = env.PDF_EXPORT_WORKER_SECRET?.trim() ?? "";
  if (!rawUrl && !secret) return undefined;
  const worker = configuredPdfExportWorker(env);
  worker.url.pathname = "/v1/stream";
  return worker;
}

async function signPdfExportWorkerBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}\n${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchPdfThroughPinnedWorker(options: {
  worker: { url: URL; secret: string };
  url: URL;
  method: "GET" | "HEAD";
  range: ReturnType<typeof rangeFromRequest>;
  ifRange?: string | null;
  authorization?: { bearerToken: string; allowedHosts: readonly string[] };
  allowedRedirectHosts?: readonly string[];
  clientSignal: AbortSignal;
  connectTimeoutMs: number;
}): Promise<Awaited<ReturnType<typeof fetchPublicPdfWithRedirects>>> {
  const workerBody = JSON.stringify({
    nonce: crypto.randomUUID(),
    sourceUrl: options.url.href,
    method: options.method,
    ...(options.range ? { range: options.range.header } : {}),
    ...(options.range && options.ifRange?.trim() ? { ifRange: options.ifRange.trim() } : {}),
    ...(options.authorization ? { authorization: `Bearer ${options.authorization.bearerToken}` } : {}),
    ...(options.allowedRedirectHosts?.length
      ? { allowedRedirectHosts: options.allowedRedirectHosts }
      : {}),
  });
  const timestamp = String(Date.now());
  const signature = await signPdfExportWorkerBody(
    options.worker.secret,
    timestamp,
    workerBody,
  );
  const controller = new AbortController();
  const abortFromClient = () => controller.abort(options.clientSignal.reason);
  options.clientSignal.addEventListener("abort", abortFromClient, { once: true });
  if (options.clientSignal.aborted) abortFromClient();
  const timeout = setTimeout(() => controller.abort("connect-timeout"), options.connectTimeoutMs);
  let response: Response;
  try {
    response = await fetch(options.worker.url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Tracker-Timestamp": timestamp,
        "X-Tracker-Signature": signature,
      },
      body: workerBody,
    });
  } catch {
    options.clientSignal.removeEventListener("abort", abortFromClient);
    if (controller.signal.aborted) throw new PdfGatewayUpstreamError("UPSTREAM_TIMEOUT");
    throw new PdfGatewayUpstreamError("UPSTREAM_FAILED");
  } finally {
    clearTimeout(timeout);
  }

  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US");
  if (mediaType === "application/json") {
    const payload = await readBoundedResponseJson(response, 16 * 1024).catch(() => null);
    options.clientSignal.removeEventListener("abort", abortFromClient);
    const workerCode = payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof (payload as Record<string, unknown>).error === "string"
      ? String((payload as Record<string, unknown>).error)
      : "UPSTREAM_FAILED";
    if (workerCode === "DNS_RESOLUTION_FAILED") {
      throw new PdfGatewaySecurityError("DNS_RESOLUTION_FAILED");
    }
    if (workerCode === "SSRF_HOST_BLOCKED" || workerCode === "SSRF_ADDRESS_BLOCKED") {
      throw new PdfGatewaySecurityError("SOURCE_URL_NOT_SAFE");
    }
    if (workerCode === "REDIRECT_HOST_BLOCKED") {
      throw new PdfGatewaySecurityError("REDIRECT_NOT_ALLOWED");
    }
    if (workerCode === "UPSTREAM_TIMEOUT" || workerCode === "CLIENT_ABORTED") {
      throw new PdfGatewayUpstreamError("UPSTREAM_TIMEOUT");
    }
    if (workerCode === "STREAM_RESPONSE_TOO_LARGE") {
      throw new PdfGatewayUpstreamError("RANGE_RESPONSE_TOO_LARGE");
    }
    throw new PdfGatewayUpstreamError("UPSTREAM_FAILED");
  }

  return {
    response,
    finalUrl: options.url,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => options.clientSignal.removeEventListener("abort", abortFromClient),
  };
}

function googleDriveApiUrl(fileId: string | null): URL {
  const normalized = fileId?.trim() ?? "";
  if (!/^[a-zA-Z0-9_-]{10,200}$/u.test(normalized)) {
    throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Ідентифікатор файла Google Drive недійсний.");
  }
  return new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(normalized)}?alt=media&supportsAllDrives=true`,
  );
}

function upstreamUrlForSource(
  source: DocumentSourceRow,
  env: Record<string, string | undefined>,
): URL {
  if (source.status !== "active" && source.status !== "changed") {
    throw new PdfGatewayHttpError(409, "SOURCE_UNAVAILABLE", "Джерело документа зараз недоступне.");
  }
  if (source.mime_type.toLocaleLowerCase("en-US") !== "application/pdf") {
    throw new PdfGatewayHttpError(415, "SOURCE_NOT_PDF", "Джерело не є PDF-документом.");
  }
  if (source.provider === "google_drive") {
    const expectedHost = source.provider_host?.trim().replace(/\.$/u, "").toLocaleLowerCase("en-US");
    if (expectedHost && expectedHost !== "drive.google.com") {
      throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Адреса Google Drive змінилася і потребує повторної перевірки.");
    }
    if (source.access_mode !== "google_drive_api" && source.access_mode !== "secure_proxy") {
      throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Спосіб доступу до Google Drive змінився.");
    }
    if (source.access_mode === "secure_proxy") {
      const apiKey = env.GOOGLE_DRIVE_PUBLIC_API_KEY?.trim() ?? "";
      try {
        return googleDrivePublicMediaUrl(source.provider_file_id ?? "", apiKey);
      } catch {
        throw new PdfGatewayHttpError(
          503,
          "GOOGLE_DRIVE_PUBLIC_GATEWAY_NOT_CONFIGURED",
          "Серверний перегляд публічних Google Drive PDF ще не налаштовано.",
        );
      }
    }
    return googleDriveApiUrl(source.provider_file_id);
  }
  const url = validatePublicPdfUrl(source.canonical_url ?? source.original_url);
  const expectedHost = source.provider_host?.trim().replace(/\.$/u, "").toLocaleLowerCase("en-US");
  const actualHost = url.hostname.trim().replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLocaleLowerCase("en-US");
  if (expectedHost && expectedHost.replace(/^\[|\]$/gu, "") !== actualHost) {
    throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Адреса джерела змінилася і потребує повторної перевірки.");
  }
  return url;
}

async function resolveDnsAddresses(hostname: string): Promise<readonly string[]> {
  const [ipv4, ipv6] = await Promise.all([
    Deno.resolveDns(hostname, "A").catch(() => [] as string[]),
    Deno.resolveDns(hostname, "AAAA").catch(() => [] as string[]),
  ]);
  return [...ipv4, ...ipv6];
}

async function requireCurrentProjectMembership(
  admin: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new PdfGatewayHttpError(403, "ACCESS_DENIED", "У вас немає доступу до цього документа.");
  }
  return String(data.role ?? "");
}

async function requireExternalPdfViewerEnabled(
  admin: ReturnType<typeof createClient>,
): Promise<void> {
  const { data, error } = await admin
    .from("app_feature_flags")
    .select("is_enabled")
    .eq("key", "external_pdf_viewer_v2")
    .maybeSingle();
  if (error) throw error;
  if (data?.is_enabled !== true) {
    throw new PdfGatewayHttpError(
      503,
      "FEATURE_DISABLED",
      "Новий переглядач PDF тимчасово вимкнено.",
    );
  }
}

async function requireCurrentProjectEditor(
  admin: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
): Promise<void> {
  const role = await requireCurrentProjectMembership(admin, projectId, userId);
  if (role !== "owner" && role !== "editor") {
    throw new PdfGatewayHttpError(
      403,
      "EDITOR_ACCESS_REQUIRED",
      "Для перевірки зовнішнього джерела потрібні права редактора.",
    );
  }
}

async function openSession(request: Request): Promise<Response> {
  const env = environment();
  const limits = pdfGatewayLimitsFromEnvironment(env);
  const { user, userClient, admin } = await authenticatedContext(request);
  await requireExternalPdfViewerEnabled(admin);
  const input = await readBoundedJson(request, limits.maxRequestBodyBytes);
  const projectId = requiredUuid(input.projectId, "PROJECT_ID_INVALID");
  const documentId = requiredUuid(input.documentId, "DOCUMENT_ID_INVALID");
  const sourceId = optionalUuid(input.documentSourceId ?? input.sourceId);
  const googleDriveAccessToken = optionalGoogleDriveAccessToken(input.googleDriveAccessToken);

  let sourceQuery = userClient
    .from("document_sources")
    .select(DOCUMENT_SOURCE_FIELDS)
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .in("status", ["active", "changed"]);
  if (sourceId) sourceQuery = sourceQuery.eq("id", sourceId);
  const { data, error } = await sourceQuery
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // RLS deliberately makes missing and unauthorized documents indistinguishable.
    throw new PdfGatewayHttpError(404, "SOURCE_NOT_FOUND", "Джерело документа не знайдено.");
  }
  const source = data as DocumentSourceRow;
  await requireCurrentProjectMembership(admin, source.project_id, user.id);
  const upstreamUrl = upstreamUrlForSource(source, env);
  await resolvePublicHostAddresses(upstreamUrl.hostname, resolveDnsAddresses);

  if (
    source.provider !== "wikimedia"
    && source.provider !== "direct_pdf"
    && source.provider !== "google_drive"
  ) {
    throw new PdfGatewayHttpError(400, "UNSUPPORTED_PROVIDER", "Це джерело потребує іншого способу доступу.");
  }

  if (source.access_mode === "direct_cors") {
    if (googleDriveAccessToken) {
      throw new PdfGatewayHttpError(400, "GOOGLE_DRIVE_TOKEN_UNEXPECTED", "Облікові дані Google Drive не потрібні для цього джерела.");
    }
    return json(request, {
      accessMode: "direct_cors",
      url: upstreamUrl.href,
      expiresAt: null,
      fingerprint: source.fingerprint ?? {},
      ...(source.initial_page ? { initialPage: source.initial_page } : {}),
    });
  }
  const isGoogleDrive = source.provider === "google_drive";
  const isPrivateGoogleDrive = isGoogleDrive && source.access_mode === "google_drive_api";
  const isPublicGoogleDrive = isGoogleDrive && source.access_mode === "secure_proxy";
  if (
    (!isGoogleDrive && source.access_mode !== "secure_proxy")
    || (isGoogleDrive && !isPrivateGoogleDrive && !isPublicGoogleDrive)
  ) {
    throw new PdfGatewayHttpError(400, "UNSUPPORTED_PROVIDER", "Це джерело потребує іншого способу доступу.");
  }
  if ((!isGoogleDrive || isPublicGoogleDrive) && googleDriveAccessToken) {
    throw new PdfGatewayHttpError(400, "GOOGLE_DRIVE_TOKEN_UNEXPECTED", "Облікові дані Google Drive не потрібні для цього джерела.");
  }

  let upstreamAuthorizationCiphertext: string | null = null;
  if (isPrivateGoogleDrive) {
    if (!googleDriveAccessToken) {
      throw new PdfGatewayHttpError(401, "OAUTH_REQUIRED", "Підключіть Google Drive і повторіть відкриття документа.");
    }
    const encryptionKey = env.ENCRYPTION_KEY?.trim();
    if (!encryptionKey) {
      throw new PdfGatewayHttpError(503, "GOOGLE_DRIVE_GATEWAY_NOT_CONFIGURED", "Серверний доступ до Google Drive ще не налаштовано.");
    }
    upstreamAuthorizationCiphertext = await encryptApiKey(googleDriveAccessToken, encryptionKey);
  }

  const token = createOpaqueSessionToken();
  const tokenHash = await hashOpaqueSessionToken(token);
  const expiresAt = new Date(Date.now() + limits.sessionTtlSeconds * 1000).toISOString();
  const { error: insertError } = await admin.rpc("create_pdf_access_session", {
    target_token_hash: tokenHash,
    target_project_id: source.project_id,
    target_document_id: source.document_id,
    target_document_source_id: source.id,
    target_user_id: user.id,
    target_provider: source.provider,
    target_upstream_access_mode: source.access_mode,
    target_upstream_host: upstreamUrl.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US"),
    target_source_fingerprint: source.fingerprint ?? {},
    target_max_requests: limits.maxRequestsPerSession,
    target_expires_at: expiresAt,
    target_max_active_sessions: limits.maxActiveSessionsPerUserProject,
    target_upstream_authorization_ciphertext: upstreamAuthorizationCiphertext,
  });
  if (insertError) {
    if (insertError.message?.includes("PDF_ACTIVE_SESSION_LIMIT")) {
      throw new PdfGatewayHttpError(
        429,
        "ACTIVE_SESSION_LIMIT",
        "Забагато одночасних сесій перегляду. Закрийте зайві вкладки або спробуйте згодом.",
      );
    }
    throw insertError;
  }

  return json(request, {
    accessMode: source.access_mode,
    streamUrl: streamUrl(request, token),
    expiresAt,
    fingerprint: source.fingerprint ?? {},
    requiresAuthorization: isPrivateGoogleDrive,
    ...(source.initial_page ? { initialPage: source.initial_page } : {}),
  });
}

async function requireProjectDocument(
  userClient: ReturnType<typeof createClient>,
  projectId: string,
  documentId: string,
): Promise<void> {
  const { data, error } = await userClient
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new PdfGatewayHttpError(404, "DOCUMENT_NOT_FOUND", "Документ не знайдено.");
  }
}

async function reserveSourceProbe(
  admin: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
  limits: PdfGatewayLimits,
): Promise<void> {
  const { data, error } = await admin.rpc("reserve_external_pdf_probe", {
    target_user_id: userId,
    target_project_id: projectId,
    target_max_requests: limits.probeRequestsPerWindow,
    target_window_seconds: limits.probeWindowSeconds,
  });
  if (error) throw error;
  if (data !== true) {
    throw new PdfGatewayHttpError(
      429,
      "PROBE_RATE_LIMIT",
      "Забагато перевірок зовнішніх PDF. Зачекайте хвилину та спробуйте ще раз.",
    );
  }
}

async function reserveTelemetryEvent(
  admin: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
  limits: PdfGatewayLimits,
): Promise<void> {
  const { data, error } = await admin.rpc("reserve_external_pdf_telemetry_event", {
    target_user_id: userId,
    target_project_id: projectId,
    target_max_requests: limits.telemetryRequestsPerWindow,
    target_window_seconds: limits.telemetryWindowSeconds,
  });
  if (error) throw error;
  if (data !== true) {
    throw new PdfGatewayHttpError(
      429,
      "TELEMETRY_RATE_LIMIT",
      "Забагато службових подій. Спробуйте пізніше.",
    );
  }
}

async function reserveServerExport(
  admin: ReturnType<typeof createClient>,
  projectId: string,
  userId: string,
  limits: PdfGatewayLimits,
): Promise<void> {
  const { data, error } = await admin.rpc("reserve_external_pdf_export", {
    target_user_id: userId,
    target_project_id: projectId,
    target_max_requests: limits.exportRequestsPerWindow,
    target_window_seconds: limits.exportWindowSeconds,
  });
  if (error) throw error;
  if (data !== true) {
    throw new PdfGatewayHttpError(
      429,
      "EXPORT_RATE_LIMIT",
      "Забагато одночасних PDF-експортів. Зачекайте хвилину та спробуйте ще раз.",
    );
  }
}

async function clientEvent(request: Request): Promise<Response> {
  const limits = pdfGatewayLimitsFromEnvironment(environment());
  const { user, admin } = await authenticatedContext(request);
  await requireExternalPdfViewerEnabled(admin);
  const input = await readBoundedJson(request, limits.maxRequestBodyBytes);
  let parsed: ReturnType<typeof parseClientPdfOperationalEvent>;
  try {
    parsed = parseClientPdfOperationalEvent(input);
  } catch {
    throw new PdfGatewayHttpError(
      400,
      "TELEMETRY_EVENT_INVALID",
      "Некоректна службова подія.",
    );
  }
  await requireCurrentProjectMembership(admin, parsed.projectId, user.id);
  await reserveTelemetryEvent(admin, parsed.projectId, user.id, limits);
  writePdfOperationalRecord(parsed.record);
  return json(request, { accepted: true }, 202);
}

async function exportPdfPages(request: Request): Promise<Response> {
  const env = environment();
  const limits = pdfGatewayLimitsFromEnvironment(env);
  const worker = configuredPdfExportWorker(env);
  const { user, userClient, admin } = await authenticatedContext(request);
  await requireExternalPdfViewerEnabled(admin);
  const input = await readBoundedJson(request, limits.maxRequestBodyBytes);
  const projectId = requiredUuid(input.projectId, "PROJECT_ID_INVALID");
  const documentId = requiredUuid(input.documentId, "DOCUMENT_ID_INVALID");
  const sourceId = requiredUuid(input.documentSourceId ?? input.sourceId, "DOCUMENT_SOURCE_ID_INVALID");
  const pages = requiredExportPages(input.pages, limits.exportMaxPages);
  const fileName = optionalExportFileName(input.fileName);
  const sessionToken = optionalOpaqueAccessSessionToken(input.sessionToken);

  const { data, error } = await userClient
    .from("document_sources")
    .select(DOCUMENT_SOURCE_FIELDS)
    .eq("id", sourceId)
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .in("status", ["active", "changed"])
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new PdfGatewayHttpError(404, "SOURCE_NOT_FOUND", "Джерело документа не знайдено.");
  }
  let source = data as DocumentSourceRow;
  await requireCurrentProjectMembership(admin, projectId, user.id);
  await reserveServerExport(admin, projectId, user.id, limits);

  let session: PdfAccessSessionRow | null = null;
  if (sessionToken) {
    session = await consumeSession(admin, sessionToken, user.id);
    if (
      session.project_id !== projectId
      || session.document_id !== documentId
      || session.document_source_id !== sourceId
    ) {
      throw new PdfGatewayHttpError(403, "ACCESS_DENIED", "Сесія належить іншому документу.");
    }
    source = await sourceForSession(admin, session, env);
  }
  if (source.provider === "google_drive" && source.access_mode === "google_drive_api" && !session) {
    throw new PdfGatewayHttpError(
      401,
      "OAUTH_REQUIRED",
      "Сесія Google Drive завершилася. Підключіть диск і відкрийте документ повторно.",
    );
  }

  const upstreamUrl = upstreamUrlForSource(source, env);
  await resolvePublicHostAddresses(upstreamUrl.hostname, resolveDnsAddresses);
  const upstreamAuthorization = session
    ? await upstreamAuthorizationForSession(source, session, env)
    : undefined;
  const allowedRedirectHosts = upstreamAuthorization?.allowedHosts
    ?? (source.provider === "google_drive"
      ? ["www.googleapis.com", "content.googleapis.com", "drive.usercontent.google.com"]
      : []);
  const workerBody = JSON.stringify({
    nonce: crypto.randomUUID(),
    sourceUrl: upstreamUrl.href,
    pages,
    fileName,
    ...(upstreamAuthorization ? { authorization: `Bearer ${upstreamAuthorization.bearerToken}` } : {}),
    ...(allowedRedirectHosts.length ? { allowedRedirectHosts } : {}),
  });
  const timestamp = String(Date.now());
  const signature = await signPdfExportWorkerBody(worker.secret, timestamp, workerBody);
  const workerController = new AbortController();
  const abortFromClient = () => workerController.abort(request.signal.reason);
  request.signal.addEventListener("abort", abortFromClient, { once: true });
  const timeout = setTimeout(() => workerController.abort("worker-timeout"), limits.exportWorkerTimeoutMs);
  let workerResponse: Response;
  try {
    workerResponse = await fetch(worker.url, {
      method: "POST",
      redirect: "error",
      signal: workerController.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Tracker-Timestamp": timestamp,
        "X-Tracker-Signature": signature,
      },
      body: workerBody,
    });
  } catch (cause) {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
    if (workerController.signal.aborted) {
      throw new PdfGatewayHttpError(504, "EXPORT_TIMEOUT", "Сервер не встиг сформувати PDF. Зменште діапазон сторінок.");
    }
    throw new PdfGatewayHttpError(502, "EXPORT_WORKER_UNAVAILABLE", "Сервіс формування PDF зараз недоступний.");
  }
  clearTimeout(timeout);

  if (!workerResponse.ok) {
    request.signal.removeEventListener("abort", abortFromClient);
    const payload = await readBoundedResponseJson(workerResponse, 16 * 1024).catch(() => null);
    const workerCode = payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof (payload as Record<string, unknown>).error === "string"
      ? String((payload as Record<string, unknown>).error)
      : "PDF_EXPORT_FAILED";
    if (workerResponse.status === 413) {
      throw new PdfGatewayHttpError(413, "SOURCE_TOO_LARGE", "PDF перевищує тимчасовий ліміт сервісу експорту.");
    }
    if (workerResponse.status === 429) {
      throw new PdfGatewayHttpError(429, "EXPORT_WORKER_BUSY", "Сервіс експорту зайнятий. Спробуйте трохи пізніше.");
    }
    if (workerResponse.status === 401 || workerResponse.status === 403) {
      throw new PdfGatewayHttpError(502, "EXPORT_WORKER_AUTH_FAILED", "Сервіс експорту відхилив службовий запит.");
    }
    throw new PdfGatewayHttpError(
      workerResponse.status === 422 ? 422 : 502,
      workerCode === "SOURCE_NOT_PDF" ? "SOURCE_NOT_PDF" : "PDF_EXPORT_FAILED",
      workerCode === "SOURCE_NOT_PDF"
        ? "Зовнішнє джерело більше не повертає PDF."
        : "Не вдалося сформувати вибрані сторінки PDF.",
    );
  }

  const contentType = workerResponse.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US");
  const contentLength = nonNegativeHeaderInteger(workerResponse.headers.get("content-length"));
  if (contentType !== "application/pdf" || (contentLength !== undefined && contentLength > limits.exportMaxResultBytes)) {
    request.signal.removeEventListener("abort", abortFromClient);
    await workerResponse.body?.cancel("invalid-export-response").catch(() => undefined);
    throw new PdfGatewayHttpError(502, "EXPORT_RESPONSE_INVALID", "Сервіс експорту повернув некоректний результат.");
  }
  const resultBody = createBoundedPdfStream(workerResponse.body, {
    maximumBytes: limits.exportMaxResultBytes,
    verifyMagicPrefix: true,
    idleTimeoutMs: limits.streamIdleTimeoutMs,
    abort: (reason) => workerController.abort(reason),
    dispose: () => request.signal.removeEventListener("abort", abortFromClient),
  });
  const resultHeaders = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  if (contentLength !== undefined) resultHeaders.set("Content-Length", String(contentLength));
  return pdfResponse(request, resultBody, 200, resultHeaders);
}

async function probeSource(request: Request): Promise<Response> {
  const limits = pdfGatewayLimitsFromEnvironment(environment());
  const { user, userClient, admin } = await authenticatedContext(request);
  await requireExternalPdfViewerEnabled(admin);
  const input = await readBoundedJson(request, limits.maxRequestBodyBytes);
  const projectId = requiredUuid(input.projectId, "PROJECT_ID_INVALID");
  const documentId = input.documentId === undefined || input.documentId === null || input.documentId === ""
    ? null
    : requiredUuid(input.documentId, "DOCUMENT_ID_INVALID");
  if (documentId) await requireProjectDocument(userClient, projectId, documentId);
  await requireCurrentProjectEditor(admin, projectId, user.id);
  await reserveSourceProbe(admin, projectId, user.id, limits);
  const requestedUrl = validatePublicPdfUrl(input.url);

  let headHeaders: Headers | null = null;
  const head = await fetchPublicPdfWithRedirects({
    url: requestedUrl,
    method: "HEAD",
    resolver: resolveDnsAddresses,
    limits,
    clientSignal: request.signal,
  });
  try {
    if (head.response.status !== 405 && head.response.status !== 501) {
      headHeaders = validatePdfHeadResponse(head.response);
      const headLength = nonNegativeHeaderInteger(headHeaders.get("Content-Length"));
      const acceptsRanges = headHeaders.get("Accept-Ranges")?.toLocaleLowerCase("en-US") === "bytes";
      if (
        !acceptsRanges
        && headLength !== undefined
        && headLength > limits.fallbackMaxBytesWithoutRange
      ) {
        throw new PdfGatewayUpstreamError("SOURCE_TOO_LARGE_WITHOUT_RANGE");
      }
    }
  } finally {
    await head.response.body?.cancel("probe-head-complete").catch(() => undefined);
    head.abort("probe-head-complete");
    head.dispose();
  }

  const probeRange = rangeFromRequest(new Request(request.url, {
    headers: { Range: "bytes=0-4" },
  }));
  const probe = await fetchPublicPdfWithRedirects({
    url: requestedUrl,
    method: "GET",
    range: probeRange,
    resolver: resolveDnsAddresses,
    limits,
    clientSignal: request.signal,
  });
  const validated = validatePdfUpstreamResponse(probe.response, probeRange, limits);
  const probeBody = createBoundedPdfStream(probe.response.body, {
    maximumBytes: validated.maximumBodyBytes,
    verifyMagicPrefix: true,
    idleTimeoutMs: limits.streamIdleTimeoutMs,
    abort: probe.abort,
    dispose: probe.dispose,
  });
  const reader = probeBody.getReader();
  try {
    const first = await reader.read();
    if (first.done || !first.value?.byteLength) {
      throw new PdfGatewayUpstreamError("EMPTY_RESPONSE");
    }
  } finally {
    await reader.cancel("probe-magic-complete").catch(() => undefined);
  }

  const contentRangeTotal = contentRangeTotalBytes(
    validated.headers.get("Content-Range"),
  );
  const fileSizeBytes = contentRangeTotal
    ?? nonNegativeHeaderInteger(headHeaders?.get("Content-Length") ?? null)
    ?? (validated.status === 200
      ? nonNegativeHeaderInteger(validated.headers.get("Content-Length"))
      : undefined);
  const etag = validated.headers.get("ETag") ?? headHeaders?.get("ETag") ?? undefined;
  const lastModified = validated.headers.get("Last-Modified")
    ?? headHeaders?.get("Last-Modified")
    ?? undefined;

  return json(request, {
    canonicalUrl: probe.finalUrl.href,
    displayName: displayNameFromUrl(probe.finalUrl),
    mimeType: "application/pdf",
    ...(fileSizeBytes === undefined ? {} : { fileSizeBytes }),
    acceptsRanges: validated.status === 206
      || headHeaders?.get("Accept-Ranges")?.toLocaleLowerCase("en-US") === "bytes",
    fingerprint: {
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(fileSizeBytes === undefined ? {} : { contentLength: fileSizeBytes }),
    },
  });
}

const GOOGLE_DRIVE_METADATA_MAX_BYTES = 64 * 1024;
const GOOGLE_DRIVE_METADATA_MAX_ATTEMPTS = 3;

async function probePublicGoogleDrive(request: Request): Promise<Response> {
  const env = environment();
  const limits = pdfGatewayLimitsFromEnvironment(env);
  const { user, userClient, admin } = await authenticatedContext(request);
  await requireExternalPdfViewerEnabled(admin);
  const input = await readBoundedJson(request, limits.maxRequestBodyBytes);
  const projectId = requiredUuid(input.projectId, "PROJECT_ID_INVALID");
  const documentId = input.documentId === undefined || input.documentId === null || input.documentId === ""
    ? null
    : requiredUuid(input.documentId, "DOCUMENT_ID_INVALID");
  if (documentId) await requireProjectDocument(userClient, projectId, documentId);
  await requireCurrentProjectEditor(admin, projectId, user.id);
  await reserveSourceProbe(admin, projectId, user.id, limits);

  let reference: ReturnType<typeof parseGoogleDrivePublicReference>;
  let metadataUrl: URL;
  let mediaUrl: URL;
  try {
    reference = parseGoogleDrivePublicReference(input.url);
    const apiKey = env.GOOGLE_DRIVE_PUBLIC_API_KEY?.trim() ?? "";
    metadataUrl = googleDrivePublicMetadataUrl(reference.fileId, apiKey);
    mediaUrl = googleDrivePublicMediaUrl(reference.fileId, apiKey);
  } catch (error) {
    if (error instanceof GoogleDrivePublicError && error.code === "API_KEY_INVALID") {
      throw new PdfGatewayHttpError(
        503,
        "GOOGLE_DRIVE_PUBLIC_GATEWAY_NOT_CONFIGURED",
        "Серверний перегляд публічних Google Drive PDF ще не налаштовано.",
      );
    }
    throw error;
  }

  const metadataResponse = await fetchGoogleDriveMetadataWithRetry(
    metadataUrl,
    request.signal,
    limits.connectTimeoutMs,
  );
  if (metadataResponse.status === 401 || metadataResponse.status === 403) {
    await metadataResponse.body?.cancel("google-drive-public-denied").catch(() => undefined);
    throw new PdfGatewayHttpError(
      403,
      "GOOGLE_DRIVE_PERMISSION_DENIED",
      "Файл не є публічним або Google Drive заборонив його завантаження.",
    );
  }
  if (metadataResponse.status === 404) {
    await metadataResponse.body?.cancel("google-drive-public-not-found").catch(() => undefined);
    throw new PdfGatewayHttpError(404, "SOURCE_NOT_FOUND", "Файл Google Drive не знайдено.");
  }
  if (!metadataResponse.ok) {
    await metadataResponse.body?.cancel("google-drive-public-metadata-failed").catch(() => undefined);
    throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive не повернув metadata файла.");
  }
  const metadataPayload = await readBoundedResponseJson(
    metadataResponse,
    GOOGLE_DRIVE_METADATA_MAX_BYTES,
  );
  const metadata = parseGoogleDrivePublicMetadata(metadataPayload, reference.fileId);

  const probeRange = rangeFromRequest(new Request(request.url, {
    headers: { Range: "bytes=0-4" },
  }));
  const probe = await fetchPublicPdfWithRedirects({
    url: mediaUrl,
    method: "GET",
    range: probeRange,
    resolver: resolveDnsAddresses,
    limits,
    clientSignal: request.signal,
  });
  if (probe.response.status === 401 || probe.response.status === 403) {
    await probe.response.body?.cancel("google-drive-public-download-denied").catch(() => undefined);
    probe.abort("google-drive-public-download-denied");
    probe.dispose();
    throw new PdfGatewayHttpError(
      403,
      "GOOGLE_DRIVE_PERMISSION_DENIED",
      "Google Drive не дозволив завантажити цей публічний файл.",
    );
  }
  const validated = validatePdfUpstreamResponse(probe.response, probeRange, limits);
  const probeBody = createBoundedPdfStream(probe.response.body, {
    maximumBytes: validated.maximumBodyBytes,
    verifyMagicPrefix: true,
    idleTimeoutMs: limits.streamIdleTimeoutMs,
    abort: probe.abort,
    dispose: probe.dispose,
  });
  const reader = probeBody.getReader();
  try {
    const first = await reader.read();
    if (first.done || !first.value?.byteLength) {
      throw new PdfGatewayUpstreamError("EMPTY_RESPONSE");
    }
  } finally {
    await reader.cancel("google-drive-public-probe-complete").catch(() => undefined);
  }

  return json(request, {
    canonicalUrl: reference.canonicalUrl,
    displayName: metadata.name,
    mimeType: "application/pdf",
    ...(metadata.size === undefined ? {} : { fileSizeBytes: metadata.size }),
    acceptsRanges: validated.status === 206,
    fingerprint: {
      ...(metadata.md5Checksum ? { md5: metadata.md5Checksum } : {}),
      ...(metadata.headRevisionId ? { revisionId: metadata.headRevisionId } : {}),
      ...(metadata.modifiedTime ? { modifiedTime: metadata.modifiedTime } : {}),
      ...(metadata.size === undefined ? {} : { contentLength: metadata.size }),
    },
  });
}

async function fetchGoogleDriveMetadataWithRetry(
  url: URL,
  clientSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GOOGLE_DRIVE_METADATA_MAX_ATTEMPTS; attempt += 1) {
    if (clientSignal.aborted) {
      throw new PdfGatewayHttpError(504, "UPSTREAM_TIMEOUT", "Запит скасовано.");
    }
    const addressesBefore = await resolvePublicHostAddresses(url.hostname, resolveDnsAddresses);
    const controller = new AbortController();
    const abortFromClient = () => controller.abort(clientSignal.reason);
    clientSignal.addEventListener("abort", abortFromClient, { once: true });
    const timeout = setTimeout(() => controller.abort("connect-timeout"), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "TrackerRodu-PdfGateway/1.0",
        },
      });
      const addressesAfter = await resolvePublicHostAddresses(url.hostname, resolveDnsAddresses);
      assertSameAddressSet(addressesBefore, addressesAfter);
      if (!isTransientUpstreamStatus(response.status) || attempt === GOOGLE_DRIVE_METADATA_MAX_ATTEMPTS) {
        return response;
      }
      await response.body?.cancel("retry-google-drive-metadata").catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (controller.signal.aborted && clientSignal.aborted) {
        throw new PdfGatewayHttpError(504, "UPSTREAM_TIMEOUT", "Запит скасовано.");
      }
      if (attempt === GOOGLE_DRIVE_METADATA_MAX_ATTEMPTS) break;
    } finally {
      clearTimeout(timeout);
      clientSignal.removeEventListener("abort", abortFromClient);
    }
    await boundedRetryDelay(attempt, clientSignal);
  }
  if (lastError instanceof PdfGatewaySecurityError) throw lastError;
  throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive не відповів на запит metadata.");
}

async function readBoundedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel("metadata-response-too-large").catch(() => undefined);
    throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive повернув завеликі metadata.");
  }
  if (!response.body) throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive не повернув metadata.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive повернув завеликі metadata.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel("metadata-read-complete").catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PdfGatewayHttpError(502, "UPSTREAM_FAILED", "Google Drive повернув некоректні metadata.");
  }
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500
    || status === 502 || status === 503 || status === 504;
}

function boundedRetryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.min(1_500, 180 * (2 ** Math.max(0, attempt - 1)));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new PdfGatewayHttpError(504, "UPSTREAM_TIMEOUT", "Запит скасовано."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function displayNameFromUrl(url: URL): string {
  const raw = url.pathname.split("/").filter(Boolean).at(-1) ?? "document.pdf";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the already bounded URL segment when percent encoding is malformed.
  }
  const safe = decoded.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 250);
  return safe || "document.pdf";
}

function nonNegativeHeaderInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentRangeTotalBytes(value: string | null): number | undefined {
  const raw = value ? /\/(\d+)$/u.exec(value.trim())?.[1] : undefined;
  return raw ? nonNegativeHeaderInteger(raw) : undefined;
}

function streamUrl(request: Request, token: string): string {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const functionIndex = segments.lastIndexOf("pdf-gateway");
  const prefix = functionIndex >= 0
    ? `/${segments.slice(0, functionIndex + 1).join("/")}`
    : "/functions/v1/pdf-gateway";
  url.pathname = `${prefix}/stream/${token}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function streamToken(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const streamIndex = segments.lastIndexOf("stream");
  const token = streamIndex >= 0 ? segments[streamIndex + 1] ?? "" : "";
  if (!isValidOpaqueSessionToken(token)) {
    throw new PdfGatewayHttpError(401, "SESSION_INVALID", "Сесія перегляду недійсна.");
  }
  return token;
}

async function consumeSession(
  admin: ReturnType<typeof createClient>,
  token: string,
  userId: string,
): Promise<PdfAccessSessionRow> {
  const tokenHash = await hashOpaqueSessionToken(token);
  const { data, error } = await admin.rpc("consume_pdf_access_session", {
    target_token_hash: tokenHash,
    target_user_id: userId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new PdfGatewayHttpError(401, "SESSION_EXPIRED", "Сесія перегляду завершилася. Відкрийте документ повторно.");
  }
  return row as PdfAccessSessionRow;
}

async function sourceForSession(
  admin: ReturnType<typeof createClient>,
  session: PdfAccessSessionRow,
  env: Record<string, string | undefined>,
): Promise<DocumentSourceRow> {
  const { data, error } = await admin
    .from("document_sources")
    .select(DOCUMENT_SOURCE_FIELDS)
    .eq("id", session.document_source_id)
    .eq("document_id", session.document_id)
    .eq("project_id", session.project_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new PdfGatewayHttpError(404, "SOURCE_NOT_FOUND", "Джерело документа не знайдено.");
  }
  const source = data as DocumentSourceRow;
  if (
    source.provider !== session.provider
    || canonicalFingerprint(source.fingerprint ?? {}) !== canonicalFingerprint(session.source_fingerprint ?? {})
  ) {
    throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Джерело змінилося. Оновіть його перед переглядом.");
  }
  if (source.access_mode !== session.upstream_access_mode) {
    throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Спосіб доступу до джерела змінився.");
  }
  const upstreamUrl = upstreamUrlForSource(source, env);
  if (
    upstreamUrl.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US")
      !== session.upstream_host.toLocaleLowerCase("en-US")
  ) {
    throw new PdfGatewayHttpError(409, "SOURCE_CHANGED", "Адреса джерела змінилася.");
  }
  return source;
}

async function upstreamAuthorizationForSession(
  source: DocumentSourceRow,
  session: PdfAccessSessionRow,
  env: Record<string, string | undefined>,
): Promise<{ bearerToken: string; allowedHosts: readonly string[] } | undefined> {
  if (source.provider !== "google_drive" || source.access_mode === "secure_proxy") return undefined;
  const ciphertext = session.upstream_authorization_ciphertext?.trim();
  const encryptionKey = env.ENCRYPTION_KEY?.trim();
  if (!ciphertext || !encryptionKey) {
    throw new PdfGatewayHttpError(401, "OAUTH_REQUIRED", "Сесія Google Drive завершилася. Підключіть диск повторно.");
  }
  try {
    const bearerToken = optionalGoogleDriveAccessToken(
      await decryptApiKey(ciphertext, encryptionKey),
    );
    if (!bearerToken) throw new Error("missing-token");
    return {
      bearerToken,
      allowedHosts: [
        "www.googleapis.com",
        "content.googleapis.com",
        "drive.usercontent.google.com",
      ],
    };
  } catch (cause) {
    if (cause instanceof PdfGatewayHttpError) throw cause;
    throw new PdfGatewayHttpError(401, "OAUTH_REQUIRED", "Сесія Google Drive завершилася. Підключіть диск повторно.");
  }
}

async function rejectGoogleDriveAuthorizationFailure(
  provider: string,
  accessMode: string,
  upstream: Awaited<ReturnType<typeof fetchPublicPdfWithRedirects>>,
  admin: ReturnType<typeof createClient>,
  sessionId: string,
): Promise<void> {
  if (provider !== "google_drive" || (upstream.response.status !== 401 && upstream.response.status !== 403)) {
    return;
  }
  await upstream.response.body?.cancel("google-drive-authorization-failed").catch(() => undefined);
  upstream.abort("google-drive-authorization-failed");
  upstream.dispose();
  try {
    await admin.from("pdf_access_sessions").delete().eq("id", sessionId);
  } catch {
    // The authorization error remains authoritative even if best-effort
    // session cleanup cannot reach the database.
  }
  if (accessMode === "google_drive_api" && upstream.response.status === 401) {
    throw new PdfGatewayHttpError(401, "OAUTH_REQUIRED", "Сесія Google Drive завершилася. Підключіть диск повторно.");
  }
  throw new PdfGatewayHttpError(403, "GOOGLE_DRIVE_PERMISSION_DENIED", "Google Drive не надав доступ до цього файла.");
}

async function streamPdf(request: Request): Promise<Response> {
  const env = environment();
  const limits = pdfGatewayLimitsFromEnvironment(env);
  const startedAt = performance.now();
  const gatewayRequestId = requestId(request);
  let provider: DocumentSourceRow["provider"] = "unknown";
  let accessMode: string | undefined;
  let telemetryFinalized = false;
  const finalizeTelemetry = (
    statusCode: number,
    errorCode?: string,
    transferredBytes = 0,
  ) => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    try {
      const record = createPdfProxyTelemetryRecord({
        requestId: gatewayRequestId,
        provider,
        accessMode,
        statusCode,
        ...(errorCode ? { errorCode } : {}),
        durationMs: performance.now() - startedAt,
        transferredBytes,
      });
      if (shouldWritePdfProxyRecord(record, limits.telemetrySuccessSamplePercent)) {
        writePdfOperationalRecord(record);
      }
    } catch {
      // Operational telemetry must never alter the proxy response.
    }
  };

  try {
    const { user, admin } = await authenticatedContext(request);
    await requireExternalPdfViewerEnabled(admin);
    const session = await consumeSession(admin, streamToken(request), user.id);
    await requireCurrentProjectMembership(admin, session.project_id, user.id);
    const source = await sourceForSession(admin, session, env);
    provider = source.provider;
    accessMode = source.access_mode;
    const upstreamUrl = upstreamUrlForSource(source, env);
    const upstreamAuthorization = await upstreamAuthorizationForSession(source, session, env);
    const range = rangeFromRequest(request);
    const pinnedWorker = optionalConfiguredPdfStreamWorker(env);
    const pinnedRedirectHosts = upstreamAuthorization?.allowedHosts
      ?? (source.provider === "google_drive"
        ? ["www.googleapis.com", "content.googleapis.com", "drive.usercontent.google.com"]
        : []);
    const fetchUpstream = (
      method: "GET" | "HEAD",
      requestedRange: ReturnType<typeof rangeFromRequest>,
    ) => pinnedWorker
      ? fetchPdfThroughPinnedWorker({
        worker: pinnedWorker,
        url: upstreamUrl,
        method,
        range: requestedRange,
        ifRange: request.headers.get("if-range"),
        allowedRedirectHosts: pinnedRedirectHosts,
        clientSignal: request.signal,
        connectTimeoutMs: limits.connectTimeoutMs,
        ...(upstreamAuthorization ? { authorization: upstreamAuthorization } : {}),
      })
      : fetchPublicPdfWithRedirects({
        url: upstreamUrl,
        method,
        range: requestedRange,
        ifRange: request.headers.get("if-range"),
        resolver: resolveDnsAddresses,
        limits,
        clientSignal: request.signal,
        ...(upstreamAuthorization ? { authorization: upstreamAuthorization } : {}),
      });

  let upstream = await fetchUpstream(request.method as "GET" | "HEAD", range);
  await rejectGoogleDriveAuthorizationFailure(provider, source.access_mode, upstream, admin, session.id);

  if (request.method === "HEAD") {
    if (upstream.response.status === 405 || upstream.response.status === 501) {
      await upstream.response.body?.cancel("head-not-supported").catch(() => undefined);
      upstream.abort("head-not-supported");
      upstream.dispose();
      const probeRange = rangeFromRequest(new Request(request.url, { headers: { Range: "bytes=0-4" } }));
      upstream = await fetchUpstream("GET", probeRange);
      await rejectGoogleDriveAuthorizationFailure(provider, source.access_mode, upstream, admin, session.id);
      const validated = validatePdfUpstreamResponse(upstream.response, probeRange, limits);
      const probeStream = createBoundedPdfStream(upstream.response.body, {
        maximumBytes: validated.maximumBodyBytes,
        verifyMagicPrefix: true,
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        abort: upstream.abort,
        dispose: upstream.dispose,
      });
      const probeReader = probeStream.getReader();
      await probeReader.read();
      await probeReader.cancel("head-probe-complete").catch(() => undefined);
      const headers = new Headers(validated.headers);
      const total = /\/(\d+)$/u.exec(headers.get("Content-Range") ?? "")?.[1];
      headers.delete("Content-Range");
      if (total) headers.set("Content-Length", total);
      else headers.delete("Content-Length");
      headers.set("Accept-Ranges", "bytes");
      finalizeTelemetry(200);
      return pdfResponse(request, null, 200, headers);
    }

    try {
      const headers = validatePdfHeadResponse(upstream.response);
      await upstream.response.body?.cancel("head-complete").catch(() => undefined);
      finalizeTelemetry(200);
      return pdfResponse(request, null, 200, headers);
    } finally {
      upstream.abort("head-complete");
      upstream.dispose();
    }
  }

  if (upstream.response.status === 416) {
    const headers = safePdfResponseHeaders(upstream.response.headers);
    await upstream.response.body?.cancel("range-not-satisfiable").catch(() => undefined);
    upstream.abort("range-not-satisfiable");
    upstream.dispose();
    finalizeTelemetry(416, "RANGE_NOT_SATISFIABLE");
    return pdfResponse(request, null, 416, headers);
  }

  const validated = validatePdfUpstreamResponse(upstream.response, range, limits);
  const body = createBoundedPdfStream(upstream.response.body, {
    maximumBytes: validated.maximumBodyBytes,
    verifyMagicPrefix: validated.verifyMagicPrefix,
    idleTimeoutMs: limits.streamIdleTimeoutMs,
    abort: upstream.abort,
    dispose: upstream.dispose,
    onFinalize: ({ transferredBytes, outcome, errorCode }) => {
      if (outcome === "failed") finalizeTelemetry(502, errorCode ?? "UPSTREAM_FAILED", transferredBytes);
      else finalizeTelemetry(validated.status, undefined, transferredBytes);
    },
  });
  return pdfResponse(request, body, validated.status, validated.headers);
  } catch (error) {
    const mapped = publicError(error);
    finalizeTelemetry(mapped.status, mapped.code);
    throw error;
  }
}

function pdfResponse(
  request: Request,
  body: BodyInit | null,
  status: number,
  pdfHeaders: Headers,
): Response {
  const headers = new Headers(responseHeaders(request));
  for (const [name, value] of pdfHeaders) headers.set(name, value);
  return new Response(body, { status, headers });
}

function route(request: Request): "open-session" | "probe-source" | "probe-google-drive-public" | "export-pages" | "client-event" | "stream" | "unknown" {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const functionIndex = segments.lastIndexOf("pdf-gateway");
  const remainder = functionIndex >= 0 ? segments.slice(functionIndex + 1) : segments;
  if (request.method === "POST" && (remainder.length === 0 || remainder[0] === "open-session")) {
    return "open-session";
  }
  if (request.method === "POST" && remainder[0] === "probe-source") {
    return "probe-source";
  }
  if (request.method === "POST" && remainder[0] === "probe-google-drive-public") {
    return "probe-google-drive-public";
  }
  if (request.method === "POST" && remainder[0] === "export-pages") {
    return "export-pages";
  }
  if (request.method === "POST" && remainder[0] === "client-event") {
    return "client-event";
  }
  if ((request.method === "GET" || request.method === "HEAD") && remainder[0] === "stream") {
    return "stream";
  }
  return "unknown";
}

function publicError(error: unknown): PdfGatewayHttpError {
  if (error instanceof PdfGatewayHttpError) return error;
  if (error instanceof GoogleDrivePublicError) {
    const mappings: Record<string, [number, string, string]> = {
      REFERENCE_INVALID: [400, "INVALID_URL", "Некоректне посилання Google Drive."],
      API_KEY_INVALID: [503, "GOOGLE_DRIVE_PUBLIC_GATEWAY_NOT_CONFIGURED", "Серверний перегляд публічних Google Drive PDF ще не налаштовано."],
      METADATA_INVALID: [502, "UPSTREAM_FAILED", "Google Drive повернув некоректні metadata файла."],
      SOURCE_NOT_PDF: [415, "SOURCE_NOT_PDF", "Файл Google Drive не є PDF-документом."],
      DOWNLOAD_FORBIDDEN: [403, "GOOGLE_DRIVE_PERMISSION_DENIED", "Google Drive не дозволяє завантажити цей файл."],
    };
    const [status, code, message] = mappings[error.code]
      ?? [502, "UPSTREAM_FAILED", "Не вдалося перевірити публічний файл Google Drive."];
    return new PdfGatewayHttpError(status, code, message);
  }
  if (error instanceof PdfGatewaySecurityError) {
    if (error.code === "RANGE_INVALID") {
      return new PdfGatewayHttpError(416, error.code, "Підтримується лише один коректний byte range.");
    }
    if (error.code === "DNS_RESOLUTION_FAILED" || error.code === "DNS_REBINDING_DETECTED") {
      return new PdfGatewayHttpError(502, error.code, "Не вдалося безпечно підключитися до джерела.");
    }
    return new PdfGatewayHttpError(403, error.code, "Зовнішня адреса документа не дозволена.");
  }
  if (error instanceof PdfGatewayUpstreamError) {
    const mappings: Record<string, [number, string]> = {
      UPSTREAM_TIMEOUT: [504, "Джерело не відповіло вчасно."],
      SOURCE_NOT_PDF: [415, "Джерело не повернуло PDF-документ."],
      SOURCE_TOO_LARGE_WITHOUT_RANGE: [413, "Джерело не підтримує часткове читання, а файл перевищує безпечний ліміт."],
      RANGE_RESPONSE_TOO_LARGE: [416, "Запитаний фрагмент PDF завеликий."],
      RANGE_RESPONSE_INVALID: [502, "Джерело повернуло некоректну відповідь на частковий запит."],
      UPSTREAM_AUTH_REDIRECT_BLOCKED: [502, "Google Drive перенаправив запит на недозволений сервер."],
      REDIRECT_LIMIT: [502, "Джерело виконало забагато перенаправлень."],
      EMPTY_RESPONSE: [502, "Джерело повернуло порожню відповідь."],
      UPSTREAM_FAILED: [502, "Не вдалося отримати PDF із зовнішнього джерела."],
    };
    const [status, message] = mappings[error.code] ?? [502, "Не вдалося отримати PDF із зовнішнього джерела."];
    return new PdfGatewayHttpError(status, error.code, message);
  }
  return new PdfGatewayHttpError(500, "PDF_GATEWAY_FAILED", "Не вдалося відкрити документ.");
}

Deno.serve(async (request) => {
  if (!isAllowedBrowserOrigin(request)) {
    return json(request, { error: "ORIGIN_NOT_ALLOWED", message: "Цей сайт не має доступу до шлюзу документів." }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(request) });
  }

  try {
    const selectedRoute = route(request);
    if (selectedRoute === "open-session") return await openSession(request);
    if (selectedRoute === "probe-source") return await probeSource(request);
    if (selectedRoute === "probe-google-drive-public") return await probePublicGoogleDrive(request);
    if (selectedRoute === "export-pages") return await exportPdfPages(request);
    if (selectedRoute === "client-event") return await clientEvent(request);
    if (selectedRoute === "stream") return await streamPdf(request);
    return json(request, { error: "METHOD_NOT_ALLOWED", message: "Маршрут або метод не підтримується." }, 405);
  } catch (error) {
    const mapped = publicError(error);
    return json(request, { error: mapped.code, message: mapped.message }, mapped.status);
  }
});
