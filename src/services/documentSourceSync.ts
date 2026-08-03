import type { DocumentRecord, ScanAttachment } from "../types";
import type { StoredDocumentSource } from "./document-sources/contracts.ts";
import type { SaveDocumentSourceInput } from "./documentSources.ts";
import type {
  DocumentSourceAddContext,
  DocumentSourceAddResolution,
} from "./documentSourceAddFlow.ts";
import { DocumentSourceError } from "./document-sources/errors.ts";
import { normalizeExternalDocumentUrl } from "../utils/documentSourceUrlSecurity.ts";

export const EXTERNAL_PDF_VIEWER_V2_FLAG = "external_pdf_viewer_v2";

type AttachmentSourceCandidate = {
  attachmentId: string;
  source: SaveDocumentSourceInput;
};

export interface DocumentSourceSyncFailure {
  attachmentId: string;
  message: string;
}

export interface DocumentSourceSyncResult {
  sources: StoredDocumentSource[];
  skippedAttachmentIds: string[];
  failures: DocumentSourceSyncFailure[];
}

export interface DocumentSourceSyncPersistence {
  listDocumentSources: (projectId: string, documentId: string) => Promise<StoredDocumentSource[]>;
  saveDocumentSource: (
    projectId: string,
    input: SaveDocumentSourceInput,
  ) => Promise<StoredDocumentSource>;
}

export interface DocumentSourceSyncOptions {
  /** The resolver probe is editor-scoped and must never run anonymously. */
  userId: string;
  signal?: AbortSignal;
  now?: () => Date;
  resolveSource?: (
    inputUrl: string,
    context: DocumentSourceAddContext,
  ) => Promise<DocumentSourceAddResolution>;
}

export function isExternalPdfViewerV2Enabled(
  flags: Readonly<Record<string, boolean>>,
): boolean {
  return flags[EXTERNAL_PDF_VIEWER_V2_FLAG] === true;
}

/**
 * Projects legacy attachment JSON into the normalized source registry without
 * copying PDF bytes or persisting provider credentials. Non-PDF attachments
 * and legacy secret-bearing URLs are deliberately skipped.
 */
export function documentSourceFromAttachment(
  documentId: string,
  attachment: ScanAttachment,
): SaveDocumentSourceInput | null {
  if (!isPdfAttachment(attachment)) return null;

  if (attachment.storage === "google-drive") {
    const providerFileId = attachment.storagePath.trim();
    if (!providerFileId) return null;
    const canonicalUrl = googleDriveFilePageUrl(providerFileId);
    return {
      documentId,
      provider: "google_drive",
      originalUrl: canonicalUrl,
      canonicalUrl,
      providerHost: "drive.google.com",
      providerFileId,
      displayName: attachment.name,
      mimeType: "application/pdf",
      ...(attachment.size > 0 ? { fileSizeBytes: attachment.size } : {}),
      ...(attachment.sourcePageCount ? { pageCount: attachment.sourcePageCount } : {}),
      ...(attachment.initialPage ? { initialPage: attachment.initialPage } : {}),
      accessMode: attachment.sourceAccessMode ?? "google_drive_api",
      fingerprint: {
        ...(attachment.driveMd5Checksum ? { md5: attachment.driveMd5Checksum } : {}),
        ...(attachment.driveRevisionId ? { revisionId: attachment.driveRevisionId } : {}),
        ...(attachment.driveModifiedTime ? { modifiedTime: attachment.driveModifiedTime } : {}),
        ...(attachment.size > 0 ? { contentLength: attachment.size } : {}),
      },
      warnings: attachment.sourceWarnings ?? [],
    };
  }

  const originalUrl = persistableAttachmentUrl(
    attachment.sourcePageUrl || attachment.webViewLink || attachment.storagePath,
  );
  if (!originalUrl) return null;
  const canonicalUrl = persistableAttachmentUrl(attachment.canonicalSourceUrl ?? "");
  const provider = attachment.sourceProvider === "wikimedia" ? "wikimedia" : "direct_pdf";
  const providerUrl = canonicalUrl || originalUrl;

  return {
    documentId,
    provider,
    originalUrl,
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(attachment.sourcePageUrl ? { sourcePageUrl: originalUrl } : {}),
    providerHost: new URL(providerUrl).hostname,
    ...(attachment.providerFileTitle
      ? { providerFileTitle: attachment.providerFileTitle }
      : {}),
    displayName: attachment.name,
    mimeType: "application/pdf",
    ...(attachment.size > 0 ? { fileSizeBytes: attachment.size } : {}),
    ...(attachment.initialPage ? { initialPage: attachment.initialPage } : {}),
    ...(attachment.sourcePageCount ? { pageCount: attachment.sourcePageCount } : {}),
    accessMode: attachment.sourceAccessMode
      ?? (provider === "wikimedia" ? "direct_cors" : "secure_proxy"),
    fingerprint: {
      ...(attachment.sourceFingerprint ?? {}),
      ...(attachment.size > 0 && attachment.sourceFingerprint?.contentLength === undefined
        ? { contentLength: attachment.size }
        : {}),
    },
    warnings: attachment.sourceWarnings ?? [],
  };
}

export function findDocumentSourceForAttachment(
  sources: readonly StoredDocumentSource[],
  attachment: ScanAttachment,
): StoredDocumentSource | null {
  if (attachment.documentSourceId) {
    const byId = sources.find((source) => source.id === attachment.documentSourceId);
    if (byId) return byId;
  }

  const candidate = documentSourceFromAttachment(
    sources[0]?.documentId ?? "legacy-document",
    attachment,
  );
  if (!candidate) return null;
  return sources.find((source) => sourceIdentityMatches(source, candidate)) ?? null;
}

export async function syncDocumentSourcesForDocument(
  projectId: string,
  document: DocumentRecord,
  persistence?: DocumentSourceSyncPersistence,
  options?: DocumentSourceSyncOptions,
): Promise<DocumentSourceSyncResult> {
  // Keep pure source projection usable in Node tests and defer the browser
  // Supabase client until an enabled rollout actually performs persistence.
  const { listDocumentSources, saveDocumentSource } = persistence
    ?? await import("./documentSources.ts");
  const existing = await listDocumentSources(projectId, document.id);
  const candidates: AttachmentSourceCandidate[] = [];
  const skippedAttachmentIds: string[] = [];

  for (const attachment of document.scans) {
    const source = documentSourceFromAttachment(document.id, attachment);
    if (source) candidates.push({ attachmentId: attachment.id, source });
    else if (isPdfAttachment(attachment)) skippedAttachmentIds.push(attachment.id);
  }

  const resolveSource = options?.resolveSource
    ?? (options?.userId
      ? (await import("./documentSourceAddFlow.ts")).resolveDocumentSourceForAdd
      : undefined);
  const outcomes = await Promise.all(candidates.map(async (candidate) => {
    const matched = existing.find((source) =>
      source.id === document.scans.find((scan) => scan.id === candidate.attachmentId)?.documentSourceId
      || sourceIdentityMatches(source, candidate.source)
    );
    // A validated registry row is authoritative. Legacy attachment JSON can be
    // stale and must never roll confirmed/pending/changed state backwards.
    if (matched) return { source: matched, failure: null };
    if (!resolveSource || !options?.userId.trim()) {
      return {
        source: null,
        failure: {
          attachmentId: candidate.attachmentId,
          message: "SOURCE_VALIDATION_REQUIRED",
        },
      };
    }
    try {
      const resolution = await resolveSource(candidate.source.originalUrl, {
        userId: options.userId,
        projectId,
        documentId: document.id,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const validated = selectValidatedSource(resolution, candidate.source);
      if (!validated) throw new DocumentSourceError("MULTIPLE_SOURCE_CANDIDATES");
      return {
        source: await saveDocumentSource(projectId, {
          ...validated,
          documentId: document.id,
          lastValidatedAt: (options.now?.() ?? new Date()).toISOString(),
        }),
        failure: null,
      };
    } catch (error) {
      return {
        source: null,
        failure: {
          attachmentId: candidate.attachmentId,
          message: safeSyncErrorMessage(error),
        },
      };
    }
  }));

  return {
    sources: outcomes.flatMap((outcome) => outcome.source ? [outcome.source] : []),
    skippedAttachmentIds,
    failures: outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : []),
  };
}

function selectValidatedSource(
  resolution: DocumentSourceAddResolution,
  candidate: SaveDocumentSourceInput,
): SaveDocumentSourceInput | null {
  const resolved = resolution.candidates.map(({ source }) => ({
    ...source,
    documentId: candidate.documentId,
  }));
  const exact = resolved.find((source) => sourceIdentityMatches(source, candidate));
  if (exact) return exact;
  return resolved.length === 1 ? resolved[0]! : null;
}

function isPdfAttachment(attachment: ScanAttachment): boolean {
  const mimeType = attachment.mimeType.trim().toLowerCase();
  return mimeType === "application/pdf" || attachment.name.trim().toLowerCase().endsWith(".pdf");
}

function googleDriveFilePageUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

function persistableAttachmentUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const normalized = normalizeExternalDocumentUrl(value);
    return normalized.removedSensitiveParameters.length ? null : normalized.url;
  } catch {
    return null;
  }
}

function sourceIdentityMatches(
  stored: Pick<
    StoredDocumentSource,
    "provider" | "providerFileId" | "canonicalUrl" | "originalUrl"
  >,
  candidate: SaveDocumentSourceInput,
): boolean {
  if (stored.provider !== candidate.provider) return false;
  if (stored.providerFileId && candidate.providerFileId) {
    return stored.providerFileId === candidate.providerFileId;
  }
  return comparableSourceUrl(stored.canonicalUrl || stored.originalUrl)
    === comparableSourceUrl(candidate.canonicalUrl || candidate.originalUrl);
}

function comparableSourceUrl(value: string): string {
  try {
    return normalizeExternalDocumentUrl(value).url;
  } catch {
    return value.trim();
  }
}

function safeSyncErrorMessage(error: unknown): string {
  if (error instanceof DocumentSourceError) return error.code;
  return "Не вдалося синхронізувати зовнішнє джерело PDF.";
}
