import {
  createGoogleDriveDownloadAccess,
  getGoogleDriveFileMetadata,
  type GoogleDriveDownloadAccess,
  type GoogleDriveFileMetadata,
} from "../googleDriveStorage.ts";
import { normalizeExternalDocumentUrl } from "../../utils/documentSourceUrlSecurity.ts";
import { sourceValidationResult, validationResultForError } from "./adapterSupport.ts";
import type {
  AccessContext,
  DocumentSourceAdapter,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  ResolveSourceContext,
  SourceValidationResult,
  StoredDocumentSource,
} from "./contracts.ts";
import { DocumentSourceError, type DocumentSourceErrorCode } from "./errors.ts";
import type { DocumentSourceGatewayClient } from "./gatewayClient.ts";

const GOOGLE_DRIVE_PDF_MIME_TYPE = "application/pdf";
const GOOGLE_DRIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,200}$/u;

export interface GoogleDriveFileReference {
  fileId: string;
  canonicalUrl: string;
}

export interface GoogleDrivePdfSourceAdapterOptions {
  getFileMetadata?: (
    fileId: string,
    resourceKey?: string,
  ) => Promise<GoogleDriveFileMetadata>;
  createDownloadAccess?: (
    fileId: string,
    resourceKey?: string,
  ) => Promise<GoogleDriveDownloadAccess>;
  gateway?: DocumentSourceGatewayClient;
  now?: () => Date;
}

/**
 * Resolves stable Google Drive file pages through the existing OAuth-backed
 * Drive service. OAuth tokens remain inside googleDriveStorage and are never
 * returned in source metadata or access URLs.
 */
export class GoogleDrivePdfSourceAdapter implements DocumentSourceAdapter {
  readonly provider = "google_drive" as const;
  readonly #getFileMetadata: NonNullable<GoogleDrivePdfSourceAdapterOptions["getFileMetadata"]>;
  readonly #createDownloadAccess: NonNullable<GoogleDrivePdfSourceAdapterOptions["createDownloadAccess"]>;
  readonly #gateway?: DocumentSourceGatewayClient;
  readonly #now: () => Date;

  constructor(options: GoogleDrivePdfSourceAdapterOptions = {}) {
    this.#getFileMetadata = options.getFileMetadata ?? getGoogleDriveFileMetadata;
    this.#createDownloadAccess = options.createDownloadAccess ?? createGoogleDriveDownloadAccess;
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
  }

  canHandle(inputUrl: string): boolean {
    return parseGoogleDriveFileReference(inputUrl) !== null;
  }

  async resolve(inputUrl: string, context: ResolveSourceContext): Promise<ResolvedPdfSource> {
    const normalized = normalizeExternalDocumentUrl(inputUrl);
    if (normalized.removedSensitiveParameters.length) {
      throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
    }
    const reference = parseGoogleDriveFileReference(normalized.url);
    if (!reference) throw new DocumentSourceError("INVALID_URL");
    throwIfAborted(context.signal);

    let metadata: GoogleDriveFileMetadata;
    try {
      metadata = await this.#getFileMetadata(reference.fileId);
    } catch (error) {
      throw mapGoogleDriveSourceError(error);
    }
    throwIfAborted(context.signal);

    if (metadata.mimeType.trim().toLocaleLowerCase() !== GOOGLE_DRIVE_PDF_MIME_TYPE) {
      throw new DocumentSourceError("SOURCE_NOT_PDF");
    }

    const fileSizeBytes = safeFileSize(metadata.size);
    return {
      provider: this.provider,
      originalUrl: normalized.url,
      canonicalUrl: reference.canonicalUrl,
      sourcePageUrl: reference.canonicalUrl,
      providerHost: "drive.google.com",
      providerFileId: reference.fileId,
      displayName: metadata.name.trim() || "Google Drive PDF",
      mimeType: GOOGLE_DRIVE_PDF_MIME_TYPE,
      ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
      accessMode: "google_drive_api",
      fingerprint: {
        ...(metadata.md5Checksum ? { md5: metadata.md5Checksum } : {}),
        ...(metadata.headRevisionId ? { revisionId: metadata.headRevisionId } : {}),
        ...(metadata.modifiedTime ? { modifiedTime: metadata.modifiedTime } : {}),
        ...(fileSizeBytes !== undefined ? { contentLength: fileSizeBytes } : {}),
      },
      warnings: [],
    };
  }

  async createAccessDescriptor(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<PdfAccessDescriptor> {
    if (source.provider !== this.provider || source.documentId !== context.documentId) {
      throw new DocumentSourceError("ACCESS_DENIED");
    }
    const fileId = source.providerFileId
      || parseGoogleDriveFileReference(source.canonicalUrl ?? source.originalUrl)?.fileId;
    if (!fileId || !isGoogleDriveFileId(fileId)) {
      throw new DocumentSourceError("INVALID_URL");
    }
    throwIfAborted(context.signal);

    let access: GoogleDriveDownloadAccess;
    try {
      access = await this.#createDownloadAccess(fileId);
    } catch (error) {
      throw mapGoogleDriveSourceError(error);
    }
    throwIfAborted(context.signal);
    const accessToken = bearerToken(access.httpHeaders);
    if (!isGoogleDriveApiMediaUrl(access.url) || !accessToken) {
      throw new DocumentSourceError("NETWORK_ERROR");
    }
    if (this.#gateway) {
      return this.#gateway.createAccessSession(source, context, {
        googleDriveAccessToken: accessToken,
      });
    }
    return {
      accessMode: "google_drive_api",
      url: access.url,
      expiresAt: access.expiresAt,
      httpHeaders: access.httpHeaders,
      fingerprint: source.fingerprint,
      ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
    };
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

/** Extracts a stable Drive file ID from supported share/view URL shapes. */
export function parseGoogleDriveFileReference(inputUrl: string): GoogleDriveFileReference | null {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLocaleLowerCase().replace(/^www\./u, "");
  let fileId = "";

  if (host === "drive.google.com") {
    const pathMatch = /^\/file\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/u.exec(url.pathname);
    if (pathMatch?.[1]) fileId = decodeUrlSegment(pathMatch[1]);
    if (!fileId && /^\/(?:open|uc)\/?$/u.test(url.pathname)) {
      fileId = url.searchParams.get("id")?.trim() ?? "";
    }
  } else if (host === "docs.google.com") {
    const pathMatch = /^\/(?:document|spreadsheets|presentation|drawings)\/d\/([^/]+)(?:\/|$)/u.exec(
      url.pathname,
    );
    if (pathMatch?.[1]) fileId = decodeUrlSegment(pathMatch[1]);
  }

  if (!isGoogleDriveFileId(fileId)) return null;
  return {
    fileId,
    canonicalUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
  };
}

export function mapGoogleDriveSourceError(error: unknown): DocumentSourceError {
  if (error instanceof DocumentSourceError) return error;
  if (isAbortError(error)) return new DocumentSourceError("TIMEOUT", { cause: error });

  const status = errorStatus(error);
  const message = errorMessage(error).toLocaleLowerCase();
  let code: DocumentSourceErrorCode = "NETWORK_ERROR";
  if (status === 401 || matchesAny(message, [
    "oauth", "access token", "authorization", "not signed in",
    "авторизац", "підключ", "обліков", "сеанс заверш",
  ])) {
    code = "OAUTH_REQUIRED";
  } else if (status === 429 || matchesAny(message, [
    "quota", "rate limit", "ratelimit", "userratelimitexceeded", "downloadquotaexceeded",
    "квот", "забагато запит",
  ])) {
    code = "GOOGLE_DRIVE_QUOTA_EXCEEDED";
  } else if (status === 404 || matchesAny(message, [
    "not found", "file not found", "trashed", "не знайден", "у кошику",
  ])) {
    code = "SOURCE_NOT_FOUND";
  } else if (status === 403 || matchesAny(message, [
    "permission", "forbidden", "insufficient", "access denied",
    "немає доступ", "не надав доступ", "недоступн",
  ])) {
    code = "GOOGLE_DRIVE_PERMISSION_DENIED";
  }
  return new DocumentSourceError(code, { cause: error });
}

function safeFileSize(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isGoogleDriveFileId(value: string): boolean {
  return GOOGLE_DRIVE_ID_PATTERN.test(value);
}

function decodeUrlSegment(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DocumentSourceError("TIMEOUT", { cause: signal.reason });
}

function isGoogleDriveApiMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.googleapis.com"
      && /^\/drive\/v3\/files\/[a-zA-Z0-9_-]+$/u.test(url.pathname)
      && url.searchParams.get("alt") === "media";
  } catch {
    return false;
  }
}

function bearerToken(headers: Readonly<Record<string, string>>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLocaleLowerCase() !== "authorization") continue;
    const match = /^Bearer\s+([^\s]+)$/u.exec(value.trim());
    if (match?.[1] && match[1].length <= 4096) return match[1];
  }
  return null;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const key of ["status", "statusCode", "code"] as const) {
    const value = Number((error as Record<string, unknown>)[key]);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function matchesAny(value: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => value.includes(fragment));
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined"
    && error instanceof DOMException
    && error.name === "AbortError";
}
