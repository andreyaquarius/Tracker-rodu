import type { DocumentRecord, ScanAttachment } from "../types/index.ts";
import type {
  DocumentSourceFingerprint,
  DocumentSourceStatus,
  StoredDocumentSource,
} from "./document-sources/contracts.ts";
import {
  listFindingDocumentReferences,
  type FindingDocumentReference,
  type FindingDocumentSnapshotReference,
  type NormalizedPageSelection,
} from "./findingDocumentReferences.ts";
import {
  normalizedCropToViewportRect,
  type CropRect,
  type CropSize,
} from "./pdfViewerCropGeometry.ts";

export type FindingDocumentSourceVersionStatus = "unchanged" | "changed" | "unknown";

export type FindingDocumentReopenIssueCode =
  | "reference_not_found"
  | "document_not_loaded"
  | "source_not_found"
  | "source_document_mismatch"
  | "source_invalid"
  | "source_lookup_failed";

export interface FindingDocumentReopenIssue {
  code: FindingDocumentReopenIssueCode;
  findingId: string;
  referenceId?: string;
  documentId?: string;
  documentSourceId?: string;
  message: string;
}

/**
 * Structural equivalent of the document viewer context. It deliberately lives
 * outside the React viewer so finding reopen logic stays testable and does not
 * depend on a component module.
 */
export interface FindingDocumentViewerContext {
  source: "documents";
  document: {
    id: string;
    title: string;
    researchId: string;
    documentType: string;
    archive: string;
    fund: string;
    description: string;
    file: string;
    place: string;
  };
}

export interface FindingDocumentRestoreState {
  /** One-based physical page number in the PDF; never a thumbnail-array index. */
  pageIndex: number;
  pageLabel?: string;
  /** Canonical, zoom-independent crop. Apply it only after the PDF viewport exists. */
  selection?: NormalizedPageSelection;
}

export interface FindingDocumentReopenTarget {
  findingId: string;
  referenceId: string;
  documentId: string;
  documentSourceId: string;
  viewer: {
    scan: ScanAttachment;
    scans: [ScanAttachment];
    pageIndex: 0;
    context: FindingDocumentViewerContext;
  };
  restore: FindingDocumentRestoreState;
  source: {
    status: DocumentSourceStatus;
    versionStatus: FindingDocumentSourceVersionStatus;
    originalUrl: string;
    canonicalUrl?: string;
    capturedFingerprint: DocumentSourceFingerprint;
    currentFingerprint: DocumentSourceFingerprint;
  };
  /** Optional derivative. The original PDF remains the authoritative reopen target. */
  snapshot?: {
    reference: FindingDocumentSnapshotReference;
    scan: ScanAttachment;
  };
}

export interface FindingDocumentReopenResolution {
  targets: FindingDocumentReopenTarget[];
  issues: FindingDocumentReopenIssue[];
}

export type FindingDocumentReopenLaunchMode = "source" | "snapshot" | "unavailable";

export interface FindingDocumentReopenDependencies {
  listReferences(
    projectId: string,
    filters: { findingId: string },
  ): Promise<FindingDocumentReference[]>;
  getSource(projectId: string, documentSourceId: string): Promise<StoredDocumentSource | null>;
}

const defaultDependencies: FindingDocumentReopenDependencies = {
  listReferences: listFindingDocumentReferences,
  async getSource(projectId, documentSourceId) {
    // Keep pure reopen helpers importable in Node tests. The browser Supabase
    // client is loaded only when the production resolver actually needs it.
    const { getDocumentSource } = await import("./documentSources.ts");
    return getDocumentSource(projectId, documentSourceId);
  },
};

/**
 * Resolves every persisted PDF provenance row for a finding. Broken rows are
 * reported individually so one unavailable external source cannot hide another
 * valid reference attached to the same finding.
 */
export async function resolveFindingDocumentReopenTargets(
  projectId: string,
  findingId: string,
  documents: readonly DocumentRecord[],
  dependencies: FindingDocumentReopenDependencies = defaultDependencies,
): Promise<FindingDocumentReopenResolution> {
  const references = await dependencies.listReferences(projectId, { findingId });
  if (!references.length) {
    return {
      targets: [],
      issues: [{
        code: "reference_not_found",
        findingId,
        message: "Для цієї знахідки не збережено прив’язку до сторінки PDF.",
      }],
    };
  }

  const targets: FindingDocumentReopenTarget[] = [];
  const issues: FindingDocumentReopenIssue[] = [];

  for (const reference of references) {
    const document = documents.find((candidate) => candidate.id === reference.documentId);
    if (!document) {
      issues.push(issue(reference, "document_not_loaded", "Пов’язаний документ недоступний у поточному проєкті."));
      continue;
    }

    let source: StoredDocumentSource | null;
    try {
      source = await dependencies.getSource(projectId, reference.documentSourceId);
    } catch {
      issues.push(issue(reference, "source_lookup_failed", "Не вдалося завантажити джерело документа."));
      continue;
    }
    if (!source) {
      issues.push(issue(reference, "source_not_found", "Збережене джерело PDF більше не існує."));
      continue;
    }
    if (source.documentId !== reference.documentId) {
      issues.push(issue(reference, "source_document_mismatch", "Джерело PDF належить іншому документу."));
      continue;
    }

    try {
      targets.push(buildFindingDocumentReopenTarget(document, source, reference));
    } catch {
      issues.push(issue(reference, "source_invalid", "Джерело PDF має неповні або некоректні метадані."));
    }
  }

  return { targets, issues };
}

/** Builds a viewer launch object without creating or persisting an access URL. */
export function buildFindingDocumentReopenTarget(
  document: DocumentRecord,
  source: StoredDocumentSource,
  reference: FindingDocumentReference,
): FindingDocumentReopenTarget {
  if (document.id !== reference.documentId || source.documentId !== reference.documentId) {
    throw new RangeError("finding reference, document and source must belong to the same document");
  }
  const selection = reference.selection ? cloneSelection(reference.selection) : undefined;
  if (selection && selection.pageIndex !== reference.pageIndex) {
    throw new RangeError("finding selection must belong to the referenced physical page");
  }
  const scan = scanFromDocumentSource(source, reference.pageIndex, document.title);
  const snapshot = reference.snapshot
    ? {
        reference: cloneSnapshot(reference.snapshot),
        scan: scanFromSnapshot(reference, document.title),
      }
    : undefined;

  return {
    findingId: reference.findingId,
    referenceId: reference.id,
    documentId: reference.documentId,
    documentSourceId: reference.documentSourceId,
    viewer: {
      scan,
      scans: [scan],
      pageIndex: 0,
      context: {
        source: "documents",
        document: {
          id: document.id,
          title: document.title,
          researchId: document.researchId,
          documentType: document.documentType,
          archive: document.archive,
          fund: document.fund,
          description: document.description,
          file: document.file,
          place: document.place,
        },
      },
    },
    restore: {
      pageIndex: reference.pageIndex,
      ...(reference.pageLabel ? { pageLabel: reference.pageLabel } : {}),
      ...(selection ? { selection } : {}),
    },
    source: {
      status: source.status,
      versionStatus: findingDocumentSourceVersionStatus(
        reference.sourceFingerprint,
        source.fingerprint,
        source.status,
      ),
      originalUrl: source.originalUrl,
      ...(source.canonicalUrl ? { canonicalUrl: source.canonicalUrl } : {}),
      capturedFingerprint: { ...reference.sourceFingerprint },
      currentFingerprint: { ...source.fingerprint },
    },
    ...(snapshot ? { snapshot } : {}),
  };
}

/**
 * Converts the canonical saved crop to the currently rendered PDF viewport.
 * The caller should first display `target.restore.pageIndex`, render it using
 * `selection.rotation`, then apply this rectangle as a non-destructive overlay.
 */
export function findingDocumentSelectionViewportRect(
  target: Pick<FindingDocumentReopenTarget, "restore">,
  viewportSize: CropSize,
): CropRect | null {
  const selection = target.restore.selection;
  if (!selection) return null;
  return normalizedCropToViewportRect(
    {
      x: selection.x,
      y: selection.y,
      width: selection.width,
      height: selection.height,
    },
    viewportSize,
    selection.rotation,
  );
}

export function findingDocumentSourceVersionStatus(
  captured: DocumentSourceFingerprint,
  current: DocumentSourceFingerprint,
  sourceStatus: DocumentSourceStatus = "active",
): FindingDocumentSourceVersionStatus {
  if (sourceStatus === "changed") return "changed";
  if (!hasFingerprintValue(captured) || !hasFingerprintValue(current)) return "unknown";
  return fingerprintEquals(captured, current) ? "unchanged" : "changed";
}

/**
 * Chooses a deterministic launch path when a previously referenced source is
 * already known to be unavailable. `needs_auth` deliberately keeps the source
 * flow so the viewer can offer Google Drive reconnection.
 */
export function findingDocumentReopenLaunchMode(
  target: FindingDocumentReopenTarget,
): FindingDocumentReopenLaunchMode {
  if (target.source.status !== "unavailable" && target.source.status !== "invalid") {
    return "source";
  }
  return target.snapshot ? "snapshot" : "unavailable";
}

/** Selects a one-based item from the short native prompt used by the CRUD shell. */
export function selectFindingDocumentReopenTarget(
  targets: readonly FindingDocumentReopenTarget[],
  input: string,
): FindingDocumentReopenTarget | null {
  const normalized = input.trim();
  if (!/^\d+$/u.test(normalized)) return null;
  const selectedIndex = Number(normalized) - 1;
  return targets[selectedIndex] ?? null;
}

export function findingDocumentReopenTargetLabel(
  target: FindingDocumentReopenTarget,
  index: number,
): string {
  const pageLabel = promptText(target.restore.pageLabel ?? "", 48);
  const page = pageLabel && pageLabel !== String(target.restore.pageIndex)
    ? `${target.restore.pageIndex} (${pageLabel})`
    : String(target.restore.pageIndex);
  const documentTitle = promptText(target.viewer.context.document.title, 120) || "Документ без назви";
  return `${index + 1}. ${documentTitle} — сторінка ${page}`;
}

function scanFromDocumentSource(
  source: StoredDocumentSource,
  physicalPageIndex: number,
  fallbackName: string,
): ScanAttachment {
  const name = source.displayName || source.providerFileTitle || fallbackName || "document.pdf";
  const fingerprint = { ...source.fingerprint };
  if (source.provider === "google_drive") {
    const fileId = source.providerFileId?.trim();
    if (!fileId) throw new RangeError("Google Drive document source requires providerFileId");
    return {
      id: `document-source:${source.id}`,
      name,
      mimeType: "application/pdf",
      size: source.fileSizeBytes ?? 0,
      createdAt: source.createdAt,
      storage: "google-drive",
      storagePath: fileId,
      webViewLink: source.originalUrl,
      documentSourceId: source.id,
      sourceProvider: source.provider,
      initialPage: physicalPageIndex,
      sourceFingerprint: fingerprint,
      ...(fingerprint.md5 ? { driveMd5Checksum: fingerprint.md5 } : {}),
      ...(fingerprint.revisionId ? { driveRevisionId: fingerprint.revisionId } : {}),
      ...(fingerprint.modifiedTime ? { driveModifiedTime: fingerprint.modifiedTime } : {}),
    };
  }

  const stableOpenUrl = source.sourcePageUrl || source.originalUrl;
  const stablePdfUrl = source.canonicalUrl || source.originalUrl;
  if (!stableOpenUrl || !stablePdfUrl) throw new RangeError("external PDF source requires a stable URL");
  return {
    id: `document-source:${source.id}`,
    name,
    mimeType: "application/pdf",
    size: source.fileSizeBytes ?? 0,
    createdAt: source.createdAt,
    storage: "external-url",
    storagePath: stablePdfUrl,
    webViewLink: stableOpenUrl,
    documentSourceId: source.id,
    sourceProvider: source.provider,
    sourcePageUrl: stableOpenUrl,
    ...(source.canonicalUrl ? { canonicalSourceUrl: source.canonicalUrl } : {}),
    ...(source.providerFileTitle ? { providerFileTitle: source.providerFileTitle } : {}),
    initialPage: physicalPageIndex,
    sourceFingerprint: fingerprint,
  };
}

function scanFromSnapshot(
  reference: FindingDocumentReference,
  fallbackName: string,
): ScanAttachment {
  const snapshot = reference.snapshot;
  if (!snapshot) throw new RangeError("snapshot is required");
  const mimeType = snapshot.mimeType ?? "image/png";
  const name = `${fallbackName || "document"}-сторінка-${reference.pageIndex}-фрагмент${snapshotExtension(mimeType)}`;
  if (snapshot.provider === "google_drive") {
    return {
      id: `finding-snapshot:${reference.id}`,
      name,
      mimeType,
      size: 0,
      createdAt: reference.createdAt,
      storage: "google-drive",
      storagePath: snapshot.fileId,
      ...(snapshot.url ? { webViewLink: snapshot.url } : {}),
    };
  }
  return {
    id: `finding-snapshot:${reference.id}`,
    name,
    mimeType,
    size: 0,
    createdAt: reference.createdAt,
    storage: "external-url",
    storagePath: snapshot.url,
    webViewLink: snapshot.url,
  };
}

function cloneSelection(selection: NormalizedPageSelection): NormalizedPageSelection {
  return { ...selection };
}

function cloneSnapshot(snapshot: FindingDocumentSnapshotReference): FindingDocumentSnapshotReference {
  return { ...snapshot };
}

function hasFingerprintValue(fingerprint: DocumentSourceFingerprint): boolean {
  return Object.values(fingerprint).some((value) => value !== undefined && value !== null && value !== "");
}

function fingerprintEquals(
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
  return keys.every((key) => left[key] === right[key]);
}

function snapshotExtension(mimeType: string): string {
  if (mimeType === "application/pdf") return ".pdf";
  return mimeType === "image/jpeg" ? ".jpg" : ".png";
}

function promptText(value: string, maxLength: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function issue(
  reference: FindingDocumentReference,
  code: Exclude<FindingDocumentReopenIssueCode, "reference_not_found">,
  message: string,
): FindingDocumentReopenIssue {
  return {
    code,
    findingId: reference.findingId,
    referenceId: reference.id,
    documentId: reference.documentId,
    documentSourceId: reference.documentSourceId,
    message,
  };
}
