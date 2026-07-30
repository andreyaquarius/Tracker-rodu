import type {
  AccessContext,
  DocumentSourceFingerprint,
  DocumentSourceResolvedMetadata,
  SourceValidationResult,
  StoredDocumentSource,
} from "./document-sources/contracts.ts";
import type { DocumentSourceAdapterRegistry } from "./document-sources/registry.ts";
import type { DocumentSourceErrorCode } from "./document-sources/errors.ts";

export type RuntimeDocumentSourceVersionStatus = "unchanged" | "changed" | "unknown";

export interface RuntimeDocumentSourceValidation {
  source: StoredDocumentSource;
  versionStatus: RuntimeDocumentSourceVersionStatus;
  canConfirmVersion: boolean;
}

export interface RevalidateDocumentSourceOptions {
  source: StoredDocumentSource;
  registry: Pick<DocumentSourceAdapterRegistry, "revalidate">;
  context: AccessContext;
  canEdit: boolean;
  maximumAgeMs?: number;
  now?: () => Date;
  persist?: typeof persistDocumentSourceValidation;
}

export const DEFAULT_DOCUMENT_SOURCE_REVALIDATION_AGE_MS = 15 * 60 * 1000;

// OAuth and provider-permission failures belong to the current user session.
// Persisting them here would globally block a shared source for project members
// who still have valid Google Drive access.
const PERSISTABLE_VALIDATION_ERRORS = new Set<DocumentSourceErrorCode>([
  "INVALID_URL",
  "UNSUPPORTED_SCHEME",
  "SOURCE_NOT_FOUND",
  "SOURCE_NOT_PDF",
  "WIKIMEDIA_FILE_NOT_FOUND",
]);

export function documentSourceValidationIsDue(
  source: StoredDocumentSource,
  now = new Date(),
  maximumAgeMs = DEFAULT_DOCUMENT_SOURCE_REVALIDATION_AGE_MS,
): boolean {
  if (source.status === "changed") return false;
  if (!source.lastValidatedAt) return true;
  const lastValidatedAt = Date.parse(source.lastValidatedAt);
  return !Number.isFinite(lastValidatedAt)
    || now.getTime() - lastValidatedAt >= Math.max(0, maximumAgeMs);
}

/**
 * Revalidates only for editors. A viewer may open the already-authorized
 * source, but cannot trigger an outbound metadata probe or change source
 * state. Transient network/rate-limit failures never make a healthy source
 * unavailable.
 */
export async function revalidateDocumentSourceIfDue(
  options: RevalidateDocumentSourceOptions,
): Promise<RuntimeDocumentSourceValidation> {
  if (options.source.status === "changed") {
    return {
      source: options.source,
      versionStatus: "changed",
      canConfirmVersion: options.canEdit,
    };
  }
  const now = options.now?.() ?? new Date();
  if (
    !options.canEdit
    || !documentSourceValidationIsDue(
      options.source,
      now,
      options.maximumAgeMs ?? DEFAULT_DOCUMENT_SOURCE_REVALIDATION_AGE_MS,
    )
  ) {
    return {
      source: options.source,
      versionStatus: "unknown",
      canConfirmVersion: false,
    };
  }

  const result = await options.registry.revalidate(options.source, options.context);
  if (!validationResultShouldPersist(result)) {
    return {
      source: options.source,
      versionStatus: "unknown",
      canConfirmVersion: false,
    };
  }

  const persist = options.persist ?? persistDocumentSourceValidation;
  let persisted: StoredDocumentSource;
  try {
    persisted = await persist(
      options.context.projectId,
      options.source.id,
      result,
      options.source,
    );
  } catch {
    // Revalidation is advisory for opening an already-authorized source. A
    // rolling migration or temporary PostgREST failure must not take the
    // document viewer down; a detected change is still surfaced, but cannot
    // be confirmed until its pending fingerprint was persisted.
    return {
      source: options.source,
      versionStatus: result.status === "changed" ? "changed" : "unknown",
      canConfirmVersion: false,
    };
  }
  return {
    source: persisted,
    versionStatus: result.status === "changed" ? "changed" : "unchanged",
    canConfirmVersion: result.status === "changed",
  };
}

export function validationResultShouldPersist(result: SourceValidationResult): boolean {
  return result.status === "unchanged"
    || result.status === "changed"
    || PERSISTABLE_VALIDATION_ERRORS.has(result.errorCode);
}

export async function persistDocumentSourceValidation(
  projectId: string,
  documentSourceId: string,
  result: SourceValidationResult,
  expectedSource: StoredDocumentSource,
): Promise<StoredDocumentSource> {
  // Keep the pure revalidation policy importable in Node tests; browser-only
  // Supabase configuration is loaded only by the persistence path.
  const [{ getSupabaseClient }, { getDocumentSource }] = await Promise.all([
    import("./supabaseAuth.ts"),
    import("./documentSources.ts"),
  ]);
  const status = result.status === "unchanged" ? "active" : result.status;
  const { data, error } = await getSupabaseClient().rpc("record_document_source_validation", {
    target_project_id: projectId,
    target_document_source_id: documentSourceId,
    target_status: status,
    target_new_fingerprint: validationFingerprint(result),
    target_resolved_metadata: validationResolvedMetadata(result),
    target_expected_status: expectedSource.status,
    target_expected_fingerprint: expectedSource.fingerprint,
    target_expected_last_validated_at: expectedSource.lastValidatedAt ?? null,
    target_error_code: "errorCode" in result ? result.errorCode : null,
    target_validated_at: result.validatedAt,
  });
  if (error) throw error;
  if (data !== true) throw new Error("DOCUMENT_SOURCE_NOT_FOUND");
  const source = await getDocumentSource(projectId, documentSourceId);
  if (!source) throw new Error("DOCUMENT_SOURCE_NOT_FOUND");
  return source;
}

export async function confirmDocumentSourceVersion(
  projectId: string,
  documentSourceId: string,
  expectedPendingFingerprint: DocumentSourceFingerprint,
  expectedPendingResolvedMetadata: DocumentSourceResolvedMetadata,
): Promise<StoredDocumentSource> {
  const [{ getSupabaseClient }, { getDocumentSource }] = await Promise.all([
    import("./supabaseAuth.ts"),
    import("./documentSources.ts"),
  ]);
  const { data, error } = await getSupabaseClient().rpc("confirm_document_source_version", {
    target_project_id: projectId,
    target_document_source_id: documentSourceId,
    target_expected_pending_fingerprint: expectedPendingFingerprint,
    target_expected_pending_resolved_metadata: resolvedMetadataToRpc(
      expectedPendingResolvedMetadata,
    ),
  });
  if (error) throw error;
  if (data !== true) throw new Error("DOCUMENT_SOURCE_VERSION_NOT_PENDING");
  const source = await getDocumentSource(projectId, documentSourceId);
  if (!source) throw new Error("DOCUMENT_SOURCE_NOT_FOUND");
  return source;
}

function validationFingerprint(
  result: SourceValidationResult,
): DocumentSourceFingerprint | null {
  return result.status === "unchanged" || result.status === "changed"
    ? result.newFingerprint
    : null;
}

export function validationResolvedMetadata(
  result: SourceValidationResult,
): Record<string, string | number | null> | null {
  if (result.status !== "unchanged" && result.status !== "changed") return null;
  return resolvedMetadataToRpc(result.resolvedMetadata);
}

function resolvedMetadataToRpc(
  metadata: DocumentSourceResolvedMetadata,
): Record<string, string | number | null> {
  return {
    canonical_url: metadata.canonicalUrl,
    provider_host: metadata.providerHost,
    file_size_bytes: metadata.fileSizeBytes ?? null,
    page_count: metadata.pageCount ?? null,
    access_mode: metadata.accessMode,
  };
}
