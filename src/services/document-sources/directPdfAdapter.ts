import { normalizeExternalDocumentUrl } from "../../utils/documentSourceUrlSecurity.ts";
import type {
  AccessContext,
  DocumentSourceAdapter,
  DocumentSourceFingerprint,
  PdfAccessMode,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  ResolveSourceContext,
  SourceValidationResult,
  StoredDocumentSource,
} from "./contracts.ts";
import { DocumentSourceError } from "./errors.ts";
import type { DirectPdfGatewayProbe, DocumentSourceGatewayClient } from "./gatewayClient.ts";
import { directAccessDescriptor } from "./gatewayClient.ts";
import { sourceValidationResult, validationResultForError } from "./adapterSupport.ts";
import { isSupportedMediaWikiHost } from "../mediaWikiPdfSource.ts";

export interface DirectPdfAdapterOptions {
  fetch?: typeof fetch;
  gateway?: DocumentSourceGatewayClient;
  now?: () => Date;
}

type DirectPdfProbe = DirectPdfGatewayProbe & {
  accessMode: PdfAccessMode;
};

/** Generic adapter must be registered after provider-specific adapters. */
export class DirectPdfSourceAdapter implements DocumentSourceAdapter {
  readonly provider = "direct_pdf" as const;
  readonly #fetch: typeof fetch;
  readonly #gateway?: DocumentSourceGatewayClient;
  readonly #now: () => Date;

  constructor(options: DirectPdfAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
  }

  canHandle(inputUrl: string): boolean {
    try {
      const url = new URL(inputUrl);
      const host = url.hostname.toLocaleLowerCase();
      return url.protocol === "https:"
        && host !== "drive.google.com"
        && !host.endsWith(".drive.google.com")
        && host !== "docs.google.com"
        && !host.endsWith(".docs.google.com")
        && !isSupportedMediaWikiHost(host);
    } catch {
      return false;
    }
  }

  async resolve(inputUrl: string, context: ResolveSourceContext): Promise<ResolvedPdfSource> {
    const normalized = normalizeExternalDocumentUrl(inputUrl);
    let probe: DirectPdfProbe;
    try {
      probe = await probeDirectPdfOverCors(normalized.url, this.#fetch, context.signal);
    } catch (error) {
      if (error instanceof DocumentSourceError && error.code !== "NETWORK_ERROR" && error.code !== "TIMEOUT") {
        throw error;
      }
      if (!this.#gateway?.probeDirectPdf) throw error;
      const gatewayProbe = await this.#gateway.probeDirectPdf(normalized.url, context);
      probe = { ...gatewayProbe, accessMode: "secure_proxy" };
    }

    const canonical = normalizeExternalDocumentUrl(probe.canonicalUrl);
    if (canonical.removedSensitiveParameters.length) {
      throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
    }
    const canonicalUrl = canonical.url;
    const initialPage = pageFromUrl(normalized.url);
    return {
      provider: this.provider,
      originalUrl: normalized.url,
      canonicalUrl,
      providerHost: new URL(canonicalUrl).hostname.toLocaleLowerCase(),
      displayName: probe.displayName || fileNameFromUrl(canonicalUrl),
      mimeType: "application/pdf",
      ...(probe.fileSizeBytes !== undefined ? { fileSizeBytes: probe.fileSizeBytes } : {}),
      ...(probe.pageCount !== undefined ? { pageCount: probe.pageCount } : {}),
      ...(initialPage !== undefined ? { initialPage } : {}),
      accessMode: probe.accessMode,
      fingerprint: probe.fingerprint,
      warnings: probe.acceptsRanges ? [] : ["Джерело не підтвердило підтримку HTTP Range."],
    };
  }

  createAccessDescriptor(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<PdfAccessDescriptor> {
    if (source.accessMode === "direct_cors") {
      return Promise.resolve(directAccessDescriptor(source));
    }
    if (!this.#gateway) return Promise.reject(new DocumentSourceError("ACCESS_DENIED"));
    return this.#gateway.createAccessSession(source, context);
  }

  async revalidate(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<SourceValidationResult> {
    const validatedAt = this.#now().toISOString();
    try {
      const resolved = await this.resolve(source.originalUrl, context);
      return sourceValidationResult(
        source,
        resolved,
        validatedAt,
      );
    } catch (error) {
      return validationResultForError(source, error, validatedAt);
    }
  }
}

export async function probeDirectPdfOverCors(
  inputUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<DirectPdfProbe> {
  const normalized = normalizeExternalDocumentUrl(inputUrl);
  let head: Response | null = null;
  try {
    head = await fetchImplementation(normalized.url, {
      method: "HEAD",
      credentials: "omit",
      mode: "cors",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal,
      headers: { Accept: "application/pdf" },
    });
    if (head.status === 401 || head.status === 403) throw new DocumentSourceError("ACCESS_DENIED");
    if (head.status === 404) throw new DocumentSourceError("SOURCE_NOT_FOUND");
    if (!head.ok && head.status !== 405 && head.status !== 501) {
      throw new DocumentSourceError("NETWORK_ERROR");
    }
  } catch (error) {
    if (error instanceof DocumentSourceError) throw error;
    // Some public PDF hosts reject HEAD while allowing a ranged GET.
    head = null;
  }

  let response: Response;
  try {
    response = await fetchImplementation(normalized.url, {
      method: "GET",
      credentials: "omit",
      mode: "cors",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal,
      headers: {
        Accept: "application/pdf",
        Range: "bytes=0-4",
      },
    });
  } catch (cause) {
    if (isAbortError(cause)) throw new DocumentSourceError("TIMEOUT", { cause });
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }

  if (response.status === 401 || response.status === 403) throw new DocumentSourceError("ACCESS_DENIED");
  if (response.status === 404) throw new DocumentSourceError("SOURCE_NOT_FOUND");
  if (!response.ok) throw new DocumentSourceError("NETWORK_ERROR");

  const prefix = await readResponsePrefix(response, 5);
  if (new TextDecoder("ascii").decode(prefix) !== "%PDF-") {
    throw new DocumentSourceError("SOURCE_NOT_PDF");
  }

  const responseUrl = response.url || head?.url || normalized.url;
  const canonical = normalizeExternalDocumentUrl(responseUrl);
  if (canonical.removedSensitiveParameters.length) {
    throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
  }
  const contentType = header(response, head, "content-type").toLocaleLowerCase();
  if (contentType && !contentType.includes("application/pdf") && !contentType.includes("octet-stream")) {
    throw new DocumentSourceError("SOURCE_NOT_PDF");
  }
  const contentLength = responseContentLength(response, head);
  const acceptsRanges = response.status === 206
    || header(response, head, "accept-ranges").toLocaleLowerCase().includes("bytes")
    || Boolean(response.headers.get("content-range"));
  const fingerprint: DocumentSourceFingerprint = {
    ...(header(response, head, "etag") ? { etag: header(response, head, "etag") } : {}),
    ...(header(response, head, "last-modified")
      ? { lastModified: header(response, head, "last-modified") }
      : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
  };
  return {
    canonicalUrl: canonical.url,
    displayName: fileNameFromUrl(canonical.url),
    mimeType: "application/pdf",
    ...(contentLength !== undefined ? { fileSizeBytes: contentLength } : {}),
    acceptsRanges,
    fingerprint,
    accessMode: "direct_cors",
  };
}

async function readResponsePrefix(response: Response, byteCount: number): Promise<Uint8Array> {
  if (!response.body) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (!Number.isFinite(declaredLength) || declaredLength > 64 * 1024) {
      throw new DocumentSourceError("SOURCE_TOO_LARGE_WITHOUT_RANGE");
    }
    return new Uint8Array(await response.arrayBuffer()).slice(0, byteCount);
  }

  const reader = response.body.getReader();
  const bytes: number[] = [];
  try {
    while (bytes.length < byteCount) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = byteCount - bytes.length;
      bytes.push(...next.value.slice(0, remaining));
    }
  } finally {
    await reader.cancel("metadata probe complete").catch(() => undefined);
  }
  return Uint8Array.from(bytes);
}

function responseContentLength(response: Response, head: Response | null): number | undefined {
  const contentRange = response.headers.get("content-range") ?? "";
  const totalMatch = /\/([0-9]+)$/u.exec(contentRange);
  const raw = totalMatch?.[1] ?? header(response, head, "content-length");
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function header(response: Response, fallback: Response | null, name: string): string {
  return response.headers.get(name) ?? fallback?.headers.get(name) ?? "";
}

function pageFromUrl(value: string): number | undefined {
  const raw = new URL(value).searchParams.get("page") ?? "";
  const page = Number(raw);
  return /^\d+$/u.test(raw) && Number.isSafeInteger(page) && page >= 1 ? page : undefined;
}

function fileNameFromUrl(value: string): string {
  const raw = new URL(value).pathname.split("/").filter(Boolean).pop() ?? "document.pdf";
  try {
    return decodeURIComponent(raw) || "document.pdf";
  } catch {
    return raw || "document.pdf";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
