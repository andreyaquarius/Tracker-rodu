import type { ScanAttachment } from "../types";
import type { PdfAccessDescriptor, StoredDocumentSource } from "./document-sources/contracts.ts";
import { createDefaultDocumentSourceRegistry } from "./document-sources/defaultRegistry.ts";
import { DocumentSourceError } from "./document-sources/errors.ts";
import { HttpDocumentSourceGatewayClient } from "./document-sources/gatewayClient.ts";
import { findDocumentSourceForAttachment } from "./documentSourceSync.ts";
import { migrateLegacyDocumentSource } from "./documentSourceLegacyMigration.ts";
import {
  DEFAULT_DOCUMENT_SOURCE_REVALIDATION_AGE_MS,
  revalidateDocumentSourceIfDue,
  type RuntimeDocumentSourceVersionStatus,
} from "./documentSourceRevalidation.ts";
import { listDocumentSources, saveDocumentSource } from "./documentSources.ts";
import { getSupabaseSession } from "./supabaseAuth.ts";

export interface DocumentSourceViewerRequest {
  projectId: string;
  documentId: string;
  userId: string;
  attachment: ScanAttachment;
  requestId?: string;
  signal?: AbortSignal;
  /** Only owners/editors may trigger provider probes or persist source state. */
  canEdit?: boolean;
}

export interface DocumentSourceViewerSession {
  access: PdfAccessDescriptor;
  /** Stable persisted metadata used for provenance; it never contains access tokens. */
  source: StoredDocumentSource;
  sourceVersionStatus: RuntimeDocumentSourceVersionStatus;
  canConfirmSourceVersion: boolean;
}

/**
 * Opens a persisted source through its provider adapter. A null result means
 * the legacy attachment has not been migrated yet and the caller may use the
 * existing preview path. Ephemeral gateway URLs never enter attachment JSON.
 */
export async function createDocumentSourceViewerAccess(
  request: DocumentSourceViewerRequest,
): Promise<PdfAccessDescriptor | null> {
  const session = await createDocumentSourceViewerSession(request);
  return session?.access ?? null;
}

export async function createDocumentSourceViewerSession(
  request: DocumentSourceViewerRequest,
): Promise<DocumentSourceViewerSession | null> {
  const sources = await listDocumentSources(request.projectId, request.documentId);
  const gateway = new HttpDocumentSourceGatewayClient({
    baseUrl: configuredGatewayBaseUrl(),
    headers: authenticatedGatewayHeaders,
  });
  const registry = createDefaultDocumentSourceRegistry({ gateway });
  const accessContext = {
    projectId: request.projectId,
    documentId: request.documentId,
    userId: request.userId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
  let source = findDocumentSourceForAttachment(sources, request.attachment);
  if (!source && request.canEdit === true) {
    source = await migrateLegacyDocumentSource(
      request,
      registry,
      accessContext,
      { listDocumentSources, saveDocumentSource },
    );
  }
  if (!source) return null;
  if (source.documentId !== request.documentId) {
    throw new DocumentSourceError("ACCESS_DENIED");
  }
  if (source.status === "invalid") throw new DocumentSourceError("SOURCE_NOT_PDF");

  const validation = await revalidateDocumentSourceIfDue({
    source,
    registry,
    context: accessContext,
    canEdit: request.canEdit === true,
    maximumAgeMs: configuredRevalidationAgeMs(),
  });
  const validatedSource = validation.source;
  if (validatedSource.status === "invalid") {
    throw new DocumentSourceError(validatedSource.validationErrorCode ?? "SOURCE_NOT_PDF");
  }
  if (validatedSource.status === "needs_auth") {
    throw new DocumentSourceError(validatedSource.validationErrorCode ?? "OAUTH_REQUIRED");
  }
  if (validatedSource.status === "unavailable") {
    throw new DocumentSourceError(validatedSource.validationErrorCode ?? "SOURCE_NOT_FOUND");
  }

  const access = await registry.createAccessDescriptor(validatedSource, accessContext);
  return {
    access,
    source: validatedSource,
    sourceVersionStatus: validation.versionStatus,
    canConfirmSourceVersion: validation.canConfirmVersion,
  };
}

function configuredRevalidationAgeMs(): number {
  const minutes = Number(import.meta.env.VITE_EXTERNAL_PDF_SOURCE_REVALIDATE_MINUTES);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
    return DEFAULT_DOCUMENT_SOURCE_REVALIDATION_AGE_MS;
  }
  return Math.round(minutes * 60 * 1000);
}

async function authenticatedGatewayHeaders(): Promise<HeadersInit> {
  const session = await getSupabaseSession();
  if (!session?.access_token) throw new DocumentSourceError("ACCESS_DENIED");
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  return {
    Authorization: `Bearer ${session.access_token}`,
    ...(publishableKey ? { apikey: publishableKey } : {}),
  };
}

function configuredGatewayBaseUrl(): string | undefined {
  const localFunctionsUrl = import.meta.env.VITE_LOCAL_EDGE_FUNCTIONS_URL?.trim();
  if (!localFunctionsUrl) return import.meta.env.VITE_SUPABASE_URL?.trim() || undefined;
  const base = localFunctionsUrl.replace(/\/+$/gu, "");
  return base.endsWith("/pdf-gateway") ? base : `${base}/pdf-gateway`;
}
