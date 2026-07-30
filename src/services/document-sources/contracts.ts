import type { DocumentSourceErrorCode } from "./errors.ts";

export type DocumentSourceProvider = "wikimedia" | "google_drive" | "direct_pdf";

export type PdfAccessMode = "direct_cors" | "secure_proxy" | "google_drive_api";

export type DocumentSourceStatus =
  | "active"
  | "needs_auth"
  | "unavailable"
  | "changed"
  | "invalid";

export interface DocumentSourceFingerprint {
  sha1?: string;
  md5?: string;
  etag?: string;
  revisionId?: string;
  modifiedTime?: string;
  lastModified?: string;
  contentLength?: number;
}

/**
 * Persistence-safe resolved fields that can change together with an external
 * PDF version. They remain pending until an editor explicitly accepts the
 * newly observed version, so the confirmed source and finding provenance are
 * never assembled from two different provider revisions.
 */
export interface DocumentSourceResolvedMetadata {
  canonicalUrl: string;
  providerHost: string;
  fileSizeBytes?: number;
  pageCount?: number;
  accessMode: PdfAccessMode;
}

export interface DocumentSourceRequestContext {
  userId: string;
  projectId: string;
  documentId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export type ResolveSourceContext = DocumentSourceRequestContext;

export interface AccessContext extends DocumentSourceRequestContext {
  documentId: string;
}

/**
 * Metadata safe to persist. It must never contain provider OAuth credentials,
 * a signed download URL, or a short-lived access-session URL.
 */
export interface ResolvedPdfSource {
  provider: DocumentSourceProvider;
  originalUrl: string;
  canonicalUrl?: string;
  sourcePageUrl?: string;
  providerHost?: string;
  providerFileId?: string;
  providerFileTitle?: string;
  displayName?: string;
  mimeType: "application/pdf";
  fileSizeBytes?: number;
  pageCount?: number;
  initialPage?: number;
  accessMode: PdfAccessMode;
  fingerprint: DocumentSourceFingerprint;
  warnings: readonly string[];
}

export interface StoredDocumentSource extends ResolvedPdfSource {
  id: string;
  documentId: string;
  status: DocumentSourceStatus;
  pendingFingerprint?: DocumentSourceFingerprint;
  pendingResolvedMetadata?: DocumentSourceResolvedMetadata;
  lastValidatedAt?: string;
  validationErrorCode?: DocumentSourceErrorCode;
  createdAt: string;
  updatedAt: string;
}

/**
 * Ephemeral viewer descriptor. Proxy URLs and their opaque tokens must never
 * be written to document metadata, analytics, or application logs.
 */
export type PdfAccessDescriptor =
  | {
      accessMode: "direct_cors";
      url: string;
      expiresAt: null;
      fingerprint: DocumentSourceFingerprint;
      initialPage?: number;
    }
  | {
      accessMode: "secure_proxy" | "google_drive_api";
      url: string;
      expiresAt: string;
      fingerprint: DocumentSourceFingerprint;
      initialPage?: number;
      /** Ephemeral request headers for PDF.js; never persist or log them. */
      httpHeaders?: Readonly<Record<string, string>>;
    };

export type SourceValidationResult =
  | {
      status: "unchanged";
      oldFingerprint: DocumentSourceFingerprint;
      newFingerprint: DocumentSourceFingerprint;
      resolvedMetadata: DocumentSourceResolvedMetadata;
      validatedAt: string;
    }
  | {
      status: "changed";
      oldFingerprint: DocumentSourceFingerprint;
      newFingerprint: DocumentSourceFingerprint;
      resolvedMetadata: DocumentSourceResolvedMetadata;
      validatedAt: string;
      requiresUserReview: true;
    }
  | {
      status: "needs_auth" | "unavailable" | "invalid";
      oldFingerprint: DocumentSourceFingerprint;
      validatedAt: string;
      errorCode: DocumentSourceErrorCode;
    };

/**
 * Source-specific resolution is deliberately separated from the PDF viewer.
 * Register specific providers before the generic direct-PDF adapter.
 */
export interface DocumentSourceAdapter {
  readonly provider: DocumentSourceProvider;

  canHandle(inputUrl: string): boolean;

  resolve(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<ResolvedPdfSource>;

  /**
   * Some provider pages (notably an ordinary Wikisource article) can point to
   * more than one PDF.  Add-document flows use this method to require an
   * explicit user choice, while existing single-source callers keep using
   * `resolve`.
   */
  resolveCandidates?(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<readonly ResolvedPdfSource[]>;

  createAccessDescriptor(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<PdfAccessDescriptor>;

  revalidate(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<SourceValidationResult>;
}
