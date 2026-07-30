import type {
  DocumentSourceErrorCode,
} from "./document-sources/errors.ts";
import type {
  DocumentSourceFingerprint,
  DocumentSourceProvider,
  DocumentSourceStatus,
  PdfAccessMode,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "./document-sources/contracts.ts";
import { DocumentSourceError } from "./document-sources/errors.ts";
import { normalizeExternalDocumentUrl } from "../utils/documentSourceUrlSecurity.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

type DocumentSourceRow = {
  id: string;
  project_id: string;
  document_id: string;
  provider: DocumentSourceProvider;
  original_url: string;
  canonical_url: string | null;
  source_page_url: string | null;
  provider_host: string | null;
  provider_file_id: string | null;
  provider_file_title: string | null;
  display_name: string | null;
  mime_type: string;
  file_size_bytes: number | null;
  page_count: number | null;
  initial_page: number | null;
  access_mode: PdfAccessMode;
  fingerprint: DocumentSourceFingerprint | null;
  pending_fingerprint: DocumentSourceFingerprint | null;
  pending_resolved_metadata: {
    canonical_url: string;
    provider_host: string;
    file_size_bytes: number | null;
    page_count: number | null;
    access_mode: PdfAccessMode;
  } | null;
  status: DocumentSourceStatus;
  last_validated_at: string | null;
  validation_error_code: DocumentSourceErrorCode | null;
  validation_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

const DOCUMENT_SOURCE_SELECT = [
  "id",
  "project_id",
  "document_id",
  "provider",
  "original_url",
  "canonical_url",
  "source_page_url",
  "provider_host",
  "provider_file_id",
  "provider_file_title",
  "display_name",
  "mime_type",
  "file_size_bytes",
  "page_count",
  "initial_page",
  "access_mode",
  "fingerprint",
  "pending_fingerprint",
  "pending_resolved_metadata",
  "status",
  "last_validated_at",
  "validation_error_code",
  "validation_metadata",
  "created_at",
  "updated_at",
].join(", ");

export interface SaveDocumentSourceInput extends ResolvedPdfSource {
  id?: string;
  documentId: string;
  status?: DocumentSourceStatus;
  lastValidatedAt?: string;
  validationErrorCode?: DocumentSourceErrorCode;
  validationMetadata?: Record<string, unknown>;
}

export type { FindingDocumentReference } from "./findingDocumentReferences.ts";

export async function listDocumentSources(
  projectId: string,
  documentId?: string,
): Promise<StoredDocumentSource[]> {
  let query = getSupabaseClient()
    .from("document_sources")
    .select(DOCUMENT_SOURCE_SELECT)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (documentId) query = query.eq("document_id", documentId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as unknown as DocumentSourceRow[]).map(documentSourceFromRow);
}

export async function getDocumentSource(
  projectId: string,
  documentSourceId: string,
): Promise<StoredDocumentSource | null> {
  const { data, error } = await getSupabaseClient()
    .from("document_sources")
    .select(DOCUMENT_SOURCE_SELECT)
    .eq("project_id", projectId)
    .eq("id", documentSourceId)
    .maybeSingle();
  if (error) throw error;
  return data ? documentSourceFromRow(data as unknown as DocumentSourceRow) : null;
}

export async function saveDocumentSource(
  projectId: string,
  source: SaveDocumentSourceInput,
): Promise<StoredDocumentSource> {
  const row = documentSourceToRow(projectId, source);
  const { data, error } = await getSupabaseClient()
    .from("document_sources")
    .upsert(row, { onConflict: "id" })
    .select(DOCUMENT_SOURCE_SELECT)
    .single();
  if (error) throw error;
  return documentSourceFromRow(data as unknown as DocumentSourceRow);
}

export async function deleteDocumentSource(
  projectId: string,
  documentSourceId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("document_sources")
    .delete()
    .eq("project_id", projectId)
    .eq("id", documentSourceId);
  if (error) throw error;
}

export function documentSourceFingerprintEquals(
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
  const comparableKeys = keys.filter((key) => left[key] !== undefined || right[key] !== undefined);
  return comparableKeys.length > 0 && comparableKeys.every((key) => left[key] === right[key]);
}

function documentSourceFromRow(row: DocumentSourceRow): StoredDocumentSource {
  return {
    id: row.id,
    documentId: row.document_id,
    provider: row.provider,
    originalUrl: row.original_url,
    ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
    ...(row.source_page_url ? { sourcePageUrl: row.source_page_url } : {}),
    ...(row.provider_host ? { providerHost: row.provider_host } : {}),
    ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
    ...(row.provider_file_title ? { providerFileTitle: row.provider_file_title } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    mimeType: "application/pdf",
    ...(row.file_size_bytes !== null ? { fileSizeBytes: row.file_size_bytes } : {}),
    ...(row.page_count !== null ? { pageCount: row.page_count } : {}),
    ...(row.initial_page !== null ? { initialPage: row.initial_page } : {}),
    accessMode: row.access_mode,
    fingerprint: row.fingerprint ?? {},
    warnings: [],
    status: row.status,
    ...(row.pending_fingerprint
      ? { pendingFingerprint: row.pending_fingerprint }
      : {}),
    ...(row.pending_resolved_metadata
      ? {
          pendingResolvedMetadata: {
            canonicalUrl: row.pending_resolved_metadata.canonical_url,
            providerHost: row.pending_resolved_metadata.provider_host,
            ...(row.pending_resolved_metadata.file_size_bytes !== null
              ? { fileSizeBytes: row.pending_resolved_metadata.file_size_bytes }
              : {}),
            ...(row.pending_resolved_metadata.page_count !== null
              ? { pageCount: row.pending_resolved_metadata.page_count }
              : {}),
            accessMode: row.pending_resolved_metadata.access_mode,
          },
        }
      : {}),
    ...(row.last_validated_at ? { lastValidatedAt: row.last_validated_at } : {}),
    ...(row.validation_error_code ? { validationErrorCode: row.validation_error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function documentSourceToRow(projectId: string, source: SaveDocumentSourceInput) {
  const originalUrl = persistableSourceUrl(source.originalUrl);
  const canonicalUrl = source.canonicalUrl ? persistableSourceUrl(source.canonicalUrl) : null;
  const sourcePageUrl = source.sourcePageUrl ? persistableSourceUrl(source.sourcePageUrl) : null;
  return {
    ...(source.id ? { id: source.id } : {}),
    project_id: projectId,
    document_id: source.documentId,
    provider: source.provider,
    original_url: originalUrl,
    canonical_url: canonicalUrl,
    source_page_url: sourcePageUrl,
    provider_host: source.providerHost ?? null,
    provider_file_id: source.providerFileId ?? null,
    provider_file_title: source.providerFileTitle ?? null,
    display_name: source.displayName ?? null,
    mime_type: source.mimeType,
    file_size_bytes: source.fileSizeBytes ?? null,
    page_count: source.pageCount ?? null,
    initial_page: source.initialPage ?? null,
    access_mode: source.accessMode,
    fingerprint: source.fingerprint ?? {},
    status: source.status ?? "active",
    last_validated_at: source.lastValidatedAt ?? null,
    validation_error_code: source.validationErrorCode ?? null,
    validation_metadata: source.validationMetadata ?? {},
  };
}

function persistableSourceUrl(value: string): string {
  const normalized = normalizeExternalDocumentUrl(value);
  if (normalized.removedSensitiveParameters.length) {
    throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
  }
  return normalized.url;
}
