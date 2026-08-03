import type {
  AccessContext,
  DocumentSourceFingerprint,
  PdfAccessDescriptor,
  ResolveSourceContext,
  StoredDocumentSource,
} from "./contracts.ts";
import { DocumentSourceError } from "./errors.ts";

export interface DirectPdfGatewayProbe {
  canonicalUrl: string;
  displayName?: string;
  mimeType: "application/pdf";
  fileSizeBytes?: number;
  pageCount?: number;
  acceptsRanges: boolean;
  fingerprint: DocumentSourceFingerprint;
}

export interface ServerPdfExportInput {
  pages: readonly number[];
  fileName: string;
  /** Ephemeral gateway stream URL from the current viewer session. */
  accessUrl?: string;
}

export interface DocumentSourceGatewayClient {
  /**
   * Server-side metadata probe for a URL already accepted by the registry.
   * Implementations must apply SSRF checks and validate every redirect.
   */
  probeDirectPdf(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<DirectPdfGatewayProbe>;

  /**
   * Probes a public Drive share through the server-only Drive API key. The
   * optional method keeps custom/test gateways compatible with the older
   * private-OAuth-only contract.
   */
  probePublicGoogleDrivePdf?(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<DirectPdfGatewayProbe>;

  /** Creates an opaque, short-lived stream session for a persisted source. */
  createAccessSession(
    source: StoredDocumentSource,
    context: AccessContext,
    providerAccess?: DocumentSourceProviderAccess,
  ): Promise<PdfAccessDescriptor>;

  /**
   * Uses the optional qpdf worker for a vector subset of a large source. A null
   * result means the worker is intentionally not configured and the viewer may
   * retain its bounded client fallback.
   */
  exportPdfPages?(
    source: StoredDocumentSource,
    context: AccessContext,
    input: ServerPdfExportInput,
  ): Promise<Blob | null>;
}

/**
 * Provider credential used once to mint an opaque gateway session. It is
 * deliberately separate from persisted source metadata and must never be
 * logged, placed in a URL, or returned to PDF.js.
 */
export type DocumentSourceProviderAccess = {
  googleDriveAccessToken: string;
};

export interface HttpDocumentSourceGatewayClientOptions {
  fetch?: typeof fetch;
  /** Supabase project URL or the full `/functions/v1/pdf-gateway` base URL. */
  baseUrl?: string;
  headers?: () => HeadersInit | Promise<HeadersInit>;
}

/**
 * Same-origin gateway client. It never sends an upstream URL when opening a
 * document; only the persisted source ID is sent to the document-scoped route.
 */
export class HttpDocumentSourceGatewayClient implements DocumentSourceGatewayClient {
  readonly #fetch: typeof fetch;
  readonly #functionBaseUrl: string;
  readonly #headers?: () => HeadersInit | Promise<HeadersInit>;

  constructor(options: HttpDocumentSourceGatewayClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#functionBaseUrl = gatewayFunctionBaseUrl(options.baseUrl);
    this.#headers = options.headers;
  }

  async probeDirectPdf(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<DirectPdfGatewayProbe> {
    return this.#probePdf("probe-source", inputUrl, context);
  }

  async probePublicGoogleDrivePdf(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<DirectPdfGatewayProbe> {
    return this.#probePdf("probe-google-drive-public", inputUrl, context, true);
  }

  async #probePdf(
    route: "probe-source" | "probe-google-drive-public",
    inputUrl: string,
    context: ResolveSourceContext,
    googleDrivePublic = false,
  ): Promise<DirectPdfGatewayProbe> {
    const endpoint = new URL(route, this.#functionBaseUrl);
    const additionalHeaders = this.#headers ? await this.#headers() : {};
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...headersRecord(additionalHeaders),
        },
        body: JSON.stringify({
          projectId: context.projectId,
          ...(context.documentId ? { documentId: context.documentId } : {}),
          url: inputUrl,
        }),
        signal: context.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) throw new DocumentSourceError("TIMEOUT", { cause });
      throw new DocumentSourceError("NETWORK_ERROR", { cause });
    }

    if (response.status === 401 || response.status === 403) {
      const payload = await readJson(response).catch(() => null);
      const errorCode = isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "";
      if (googleDrivePublic && errorCode === "GOOGLE_DRIVE_PERMISSION_DENIED") {
        throw new DocumentSourceError("GOOGLE_DRIVE_PERMISSION_DENIED");
      }
      throw new DocumentSourceError("ACCESS_DENIED");
    }
    if (response.status === 404) throw new DocumentSourceError("SOURCE_NOT_FOUND");
    if (response.status === 413) {
      throw new DocumentSourceError("SOURCE_TOO_LARGE_WITHOUT_RANGE");
    }
    if (response.status === 415) throw new DocumentSourceError("SOURCE_NOT_PDF");
    if (response.status === 504) throw new DocumentSourceError("TIMEOUT");
    if (!response.ok) throw new DocumentSourceError("NETWORK_ERROR");

    const payload = await readJson(response);
    if (!isRecord(payload)) throw new DocumentSourceError("NETWORK_ERROR");
    const canonicalUrl = safePublicPdfUrl(payload.canonicalUrl);
    const displayName = optionalNonEmptyString(payload.displayName, 250);
    const fileSizeBytes = optionalNonNegativeInteger(payload.fileSizeBytes);
    const pageCount = optionalPositiveInteger(payload.pageCount);
    if (
      payload.mimeType !== "application/pdf"
      || typeof payload.acceptsRanges !== "boolean"
      || !isRecord(payload.fingerprint)
    ) {
      throw new DocumentSourceError("NETWORK_ERROR");
    }

    return {
      canonicalUrl,
      ...(displayName ? { displayName } : {}),
      mimeType: "application/pdf",
      ...(fileSizeBytes === undefined ? {} : { fileSizeBytes }),
      ...(pageCount === undefined ? {} : { pageCount }),
      acceptsRanges: payload.acceptsRanges,
      fingerprint: sanitizeFingerprint(payload.fingerprint),
    };
  }

  async createAccessSession(
    source: StoredDocumentSource,
    context: AccessContext,
    providerAccess?: DocumentSourceProviderAccess,
  ): Promise<PdfAccessDescriptor> {
    if (source.documentId !== context.documentId) {
      throw new DocumentSourceError("ACCESS_DENIED");
    }
    const endpoint = new URL("open-session", this.#functionBaseUrl);
    const additionalHeaders = this.#headers ? await this.#headers() : {};
    const gatewayHeaders = headersRecord(additionalHeaders);
    const streamHeaders = pdfStreamHeaders(gatewayHeaders);
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        // Supabase Edge Functions authenticate through the explicit bearer
        // header. Sending browser cookies would break wildcard CORS responses.
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...gatewayHeaders,
        },
        body: JSON.stringify({
          documentId: context.documentId,
          documentSourceId: source.id,
          projectId: context.projectId,
          ...(context.requestId ? { requestId: context.requestId } : {}),
          ...(providerAccess
            ? { googleDriveAccessToken: providerAccess.googleDriveAccessToken }
            : {}),
        }),
        signal: context.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) throw new DocumentSourceError("TIMEOUT", { cause });
      throw new DocumentSourceError("NETWORK_ERROR", { cause });
    }

    if (response.status === 401 || response.status === 403) {
      const payload = await readJson(response).catch(() => null);
      const errorCode = isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "";
      if (source.provider === "google_drive" && errorCode === "OAUTH_REQUIRED") {
        throw new DocumentSourceError("OAUTH_REQUIRED");
      }
      if (
        source.provider === "google_drive"
        && errorCode === "GOOGLE_DRIVE_PERMISSION_DENIED"
      ) {
        throw new DocumentSourceError("GOOGLE_DRIVE_PERMISSION_DENIED");
      }
      throw new DocumentSourceError("ACCESS_DENIED");
    }
    if (response.status === 404) throw new DocumentSourceError("SOURCE_NOT_FOUND");
    if (!response.ok) throw new DocumentSourceError("NETWORK_ERROR");

    const payload = await readJson(response);
    if (!isRecord(payload)) throw new DocumentSourceError("NETWORK_ERROR");
    const accessMode = payload.accessMode;
    const rawStreamUrl = typeof payload.streamUrl === "string"
      ? payload.streamUrl
      : typeof payload.url === "string"
        ? payload.url
        : "";
    if (accessMode === "direct_cors") {
      const direct = directAccessDescriptor(source);
      if (!rawStreamUrl || rawStreamUrl !== direct.url || payload.expiresAt !== null) {
        throw new DocumentSourceError("NETWORK_ERROR");
      }
      return direct;
    }
    const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : "";
    if (
      (accessMode !== "secure_proxy" && accessMode !== "google_drive_api")
      || !rawStreamUrl
      || !isFutureIsoDate(expiresAt)
    ) {
      throw new DocumentSourceError("NETWORK_ERROR");
    }

    return {
      accessMode,
      url: safeGatewayStreamUrl(rawStreamUrl, this.#functionBaseUrl),
      expiresAt,
      fingerprint: isRecord(payload.fingerprint)
        ? sanitizeFingerprint(payload.fingerprint)
        : source.fingerprint,
      ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
      ...(Object.keys(streamHeaders).length ? { httpHeaders: streamHeaders } : {}),
    };
  }

  async exportPdfPages(
    source: StoredDocumentSource,
    context: AccessContext,
    input: ServerPdfExportInput,
  ): Promise<Blob | null> {
    if (source.documentId !== context.documentId) {
      throw new DocumentSourceError("ACCESS_DENIED");
    }
    const pages = [...new Set(input.pages)].sort((left, right) => left - right);
    if (!pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
      throw new DocumentSourceError("EXPORT_FAILED");
    }
    const sessionToken = input.accessUrl
      ? opaqueSessionTokenFromGatewayUrl(input.accessUrl, this.#functionBaseUrl)
      : undefined;
    const endpoint = new URL("export-pages", this.#functionBaseUrl);
    const additionalHeaders = this.#headers ? await this.#headers() : {};
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...headersRecord(additionalHeaders),
        },
        body: JSON.stringify({
          projectId: context.projectId,
          documentId: context.documentId,
          documentSourceId: source.id,
          pages,
          fileName: input.fileName,
          ...(sessionToken ? { sessionToken } : {}),
        }),
        signal: context.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) throw new DocumentSourceError("TIMEOUT", { cause });
      throw new DocumentSourceError("NETWORK_ERROR", { cause });
    }

    if (!response.ok) {
      const payload = await readJson(response).catch(() => null);
      const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
      if (response.status === 503 && code === "SERVER_EXPORT_NOT_CONFIGURED") return null;
      if (response.status === 401 && code === "OAUTH_REQUIRED") throw new DocumentSourceError("OAUTH_REQUIRED");
      if (response.status === 403 || response.status === 404) throw new DocumentSourceError("ACCESS_DENIED");
      if (response.status === 413) throw new DocumentSourceError("SOURCE_TOO_LARGE_WITHOUT_RANGE");
      if (response.status === 504) throw new DocumentSourceError("TIMEOUT");
      throw new DocumentSourceError("EXPORT_FAILED");
    }
    const mediaType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLocaleLowerCase("en-US");
    if (mediaType !== "application/pdf") {
      await response.body?.cancel("invalid-server-export").catch(() => undefined);
      throw new DocumentSourceError("EXPORT_FAILED");
    }
    const blob = await response.blob();
    if (blob.size < 5 || new TextDecoder("ascii").decode(await blob.slice(0, 5).arrayBuffer()) !== "%PDF-") {
      throw new DocumentSourceError("EXPORT_FAILED");
    }
    return blob;
  }
}

function safePublicPdfUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DocumentSourceError("NETWORK_ERROR");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new DocumentSourceError("NETWORK_ERROR");
  }
  return parsed.href;
}

function optionalNonEmptyString(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DocumentSourceError("NETWORK_ERROR");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new DocumentSourceError("NETWORK_ERROR");
  }
  return normalized;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DocumentSourceError("NETWORK_ERROR");
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const normalized = optionalNonNegativeInteger(value);
  if (normalized === undefined) return undefined;
  if (normalized < 1) throw new DocumentSourceError("NETWORK_ERROR");
  return normalized;
}

export function directAccessDescriptor(source: StoredDocumentSource): PdfAccessDescriptor {
  const target = source.canonicalUrl ?? source.originalUrl;
  const parsed = new URL(target);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new DocumentSourceError("INVALID_URL");
  }
  return {
    accessMode: "direct_cors",
    url: parsed.href,
    expiresAt: null,
    fingerprint: source.fingerprint,
    ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
  };
}

function gatewayFunctionBaseUrl(value: string | undefined): string {
  const candidate = value
    ?? viteSupabaseUrl()
    ?? (typeof globalThis.location === "object" ? globalThis.location.origin : "http://localhost");
  const parsed = new URL(candidate);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DocumentSourceError("INVALID_URL");
  }
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
    throw new DocumentSourceError("INVALID_URL");
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/gu, "");
  if (normalizedPath === "/functions/v1/pdf-gateway") {
    return `${parsed.origin}/functions/v1/pdf-gateway/`;
  }
  if (normalizedPath && normalizedPath !== "/") {
    throw new DocumentSourceError("INVALID_URL");
  }
  return `${parsed.origin}/functions/v1/pdf-gateway/`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function safeGatewayStreamUrl(value: string, functionBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value, functionBaseUrl);
  } catch (cause) {
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }
  const base = new URL(functionBaseUrl);
  if (
    parsed.origin !== base.origin
    || !parsed.pathname.startsWith("/functions/v1/pdf-gateway/stream/")
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new DocumentSourceError("NETWORK_ERROR");
  }
  return parsed.href;
}

function opaqueSessionTokenFromGatewayUrl(value: string, functionBaseUrl: string): string | undefined {
  const parsed = new URL(value, functionBaseUrl);
  const base = new URL(functionBaseUrl);
  if (parsed.origin !== base.origin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const streamIndex = segments.lastIndexOf("stream");
  const token = streamIndex >= 0 ? segments[streamIndex + 1] ?? "" : "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
}

function viteSupabaseUrl(): string | undefined {
  const metadata = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  const value = metadata.env?.VITE_SUPABASE_URL?.trim();
  return value || undefined;
}

function sanitizeFingerprint(value: Record<string, unknown>): DocumentSourceFingerprint {
  const result: DocumentSourceFingerprint = {};
  for (const key of ["sha1", "md5", "etag", "revisionId", "modifiedTime", "lastModified"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) result[key] = value[key].trim();
  }
  if (typeof value.contentLength === "number" && Number.isSafeInteger(value.contentLength) && value.contentLength >= 0) {
    result.contentLength = value.contentLength;
  }
  return result;
}

function headersRecord(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function pdfStreamHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name === "authorization" || name === "apikey"),
  );
}

function isFutureIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
