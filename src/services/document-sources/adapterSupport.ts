import type {
  DocumentSourceFingerprint,
  DocumentSourceResolvedMetadata,
  ResolvedPdfSource,
  SourceValidationResult,
  StoredDocumentSource,
} from "./contracts.ts";
import { DocumentSourceError, type DocumentSourceErrorCode } from "./errors.ts";

export function fingerprintsEqual(
  left: DocumentSourceFingerprint,
  right: DocumentSourceFingerprint,
): boolean {
  const keys: Array<keyof DocumentSourceFingerprint> = [
    "sha1",
    "md5",
    "etag",
    "revisionId",
    "modifiedTime",
    "lastModified",
    "contentLength",
  ];
  const comparable = keys.filter((key) => left[key] !== undefined || right[key] !== undefined);
  return comparable.length > 0 && comparable.every((key) => left[key] === right[key]);
}

export function validationResultForError(
  source: StoredDocumentSource,
  error: unknown,
  validatedAt: string,
): SourceValidationResult {
  const code: DocumentSourceErrorCode = error instanceof DocumentSourceError
    ? error.code
    : "NETWORK_ERROR";
  const status = code === "OAUTH_REQUIRED" || code === "GOOGLE_DRIVE_PERMISSION_DENIED"
    ? "needs_auth"
    : code === "INVALID_URL" || code === "UNSUPPORTED_SCHEME" || code === "SOURCE_NOT_PDF"
      ? "invalid"
      : "unavailable";
  return {
    status,
    oldFingerprint: source.fingerprint,
    validatedAt,
    errorCode: code,
  };
}

export function sourceValidationResult(
  source: StoredDocumentSource,
  resolved: ResolvedPdfSource,
  validatedAt: string,
): SourceValidationResult {
  const canonicalUrl = resolved.canonicalUrl ?? resolved.originalUrl;
  const resolvedMetadata = sourceResolvedMetadata(resolved, canonicalUrl);
  const fingerprintUnchanged = fingerprintsEqual(source.fingerprint, resolved.fingerprint)
    || (!hasFingerprint(source.fingerprint)
      && !hasFingerprint(resolved.fingerprint)
      && (source.canonicalUrl ?? source.originalUrl) === canonicalUrl);
  const unchanged = fingerprintUnchanged
    && resolvedMetadataEqual(source, resolvedMetadata);
  return unchanged
    ? {
        status: "unchanged",
        oldFingerprint: source.fingerprint,
        newFingerprint: resolved.fingerprint,
        resolvedMetadata,
        validatedAt,
      }
    : {
        status: "changed",
        oldFingerprint: source.fingerprint,
        newFingerprint: resolved.fingerprint,
        resolvedMetadata,
        validatedAt,
        requiresUserReview: true,
      };
}

function resolvedMetadataEqual(
  source: StoredDocumentSource,
  resolved: DocumentSourceResolvedMetadata,
): boolean {
  const sourceCanonicalUrl = source.canonicalUrl ?? source.originalUrl;
  const sourceProviderHost = (
    source.providerHost ?? new URL(sourceCanonicalUrl).hostname
  ).toLocaleLowerCase();
  return sourceCanonicalUrl === resolved.canonicalUrl
    && sourceProviderHost === resolved.providerHost
    && source.fileSizeBytes === resolved.fileSizeBytes
    && source.pageCount === resolved.pageCount
    && source.accessMode === resolved.accessMode;
}

function sourceResolvedMetadata(
  resolved: ResolvedPdfSource,
  canonicalUrl: string,
): DocumentSourceResolvedMetadata {
  const providerHost = (
    resolved.providerHost ?? new URL(canonicalUrl).hostname
  ).toLocaleLowerCase();
  return {
    canonicalUrl,
    providerHost,
    ...(resolved.fileSizeBytes !== undefined
      ? { fileSizeBytes: resolved.fileSizeBytes }
      : {}),
    ...(resolved.pageCount !== undefined ? { pageCount: resolved.pageCount } : {}),
    accessMode: resolved.accessMode,
  };
}

function hasFingerprint(value: DocumentSourceFingerprint): boolean {
  return Object.values(value).some((field) => field !== undefined && field !== "");
}
