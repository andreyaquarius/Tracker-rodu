import type { ScanAttachment } from "../types/index.ts";
import { createId } from "../utils/id.ts";
import type {
  DocumentSourceProvider,
  ResolveSourceContext,
  ResolvedPdfSource,
} from "./document-sources/contracts.ts";
import { createDefaultDocumentSourceRegistry } from "./document-sources/defaultRegistry.ts";
import type { DocumentSourceAdapterRegistry } from "./document-sources/registry.ts";
import { HttpDocumentSourceGatewayClient } from "./document-sources/gatewayClient.ts";
import { nowIso } from "../utils/dateHelpers.ts";

export interface DocumentSourceAddContext {
  userId: string;
  projectId: string;
  /** Existing documents keep document-scoped verification; new drafts omit it. */
  documentId?: string;
  signal?: AbortSignal;
}

export interface DocumentSourceAddCandidate {
  id: string;
  source: ResolvedPdfSource;
}

export interface DocumentSourceAddResolution {
  provider: DocumentSourceProvider;
  candidates: readonly DocumentSourceAddCandidate[];
  requestId: string;
}

export interface DocumentSourceAddFlowOptions {
  registry?: DocumentSourceAdapterRegistry;
  requestId?: () => string;
}

/**
 * Canonical pre-save source resolution. It validates metadata only and never
 * downloads the complete PDF. Browser CORS failures use the editor-authorized
 * and rate-limited gateway probe, which also works before the document row is
 * created.
 */
export async function resolveDocumentSourceForAdd(
  inputUrl: string,
  context: DocumentSourceAddContext,
  options: DocumentSourceAddFlowOptions = {},
): Promise<DocumentSourceAddResolution> {
  const requestId = options.requestId?.() ?? createRequestId();
  const registry = options.registry ?? defaultAddRegistry();
  const inspection = registry.inspect(inputUrl);
  const requestContext: ResolveSourceContext = {
    userId: context.userId,
    projectId: context.projectId,
    requestId,
    ...(context.documentId ? { documentId: context.documentId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
  const resolved = await registry.resolveCandidates(inspection.url, requestContext);
  return {
    provider: inspection.provider,
    requestId,
    candidates: resolved.map((source) => ({
      id: documentSourceCandidateId(source),
      source,
    })),
  };
}

/** Converts already-validated metadata to the legacy attachment bridge. */
export function attachmentFromResolvedDocumentSource(source: ResolvedPdfSource): ScanAttachment {
  const providerFileId = source.providerFileId?.trim();
  const googleDrive = source.provider === "google_drive" && Boolean(providerFileId);
  const stableSourceUrl = source.sourcePageUrl ?? source.originalUrl;
  return {
    id: createId(),
    name: source.displayName?.trim() || source.providerFileTitle?.replace(/^File:/u, "") || "document.pdf",
    mimeType: "application/pdf",
    size: source.fileSizeBytes ?? 0,
    createdAt: nowIso(),
    storage: googleDrive ? "google-drive" : "external-url",
    storagePath: googleDrive ? providerFileId! : stableSourceUrl,
    webViewLink: stableSourceUrl,
    deleteOnRemove: false,
    availability: "available",
    sourceProvider: source.provider,
    ...(source.sourcePageUrl ? { sourcePageUrl: source.sourcePageUrl } : {}),
    ...(source.canonicalUrl ? { canonicalSourceUrl: source.canonicalUrl } : {}),
    ...(source.providerFileTitle ? { providerFileTitle: source.providerFileTitle } : {}),
    ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
    ...(source.pageCount !== undefined ? { sourcePageCount: source.pageCount } : {}),
    sourceAccessMode: source.accessMode,
    sourceWarnings: [...source.warnings],
    sourceFingerprint: { ...source.fingerprint },
    ...(googleDrive && source.fingerprint.md5
      ? { driveMd5Checksum: source.fingerprint.md5 }
      : {}),
    ...(googleDrive && source.fingerprint.modifiedTime
      ? { driveModifiedTime: source.fingerprint.modifiedTime }
      : {}),
    ...(googleDrive && source.fingerprint.revisionId
      ? { driveRevisionId: source.fingerprint.revisionId }
      : {}),
  };
}

export function documentSourceCandidateId(source: ResolvedPdfSource): string {
  return [
    source.provider,
    source.providerFileId,
    source.providerFileTitle,
    source.canonicalUrl,
    source.originalUrl,
  ].filter(Boolean).join(":");
}

function defaultAddRegistry(): DocumentSourceAdapterRegistry {
  return createDefaultDocumentSourceRegistry({
    gateway: new HttpDocumentSourceGatewayClient({
      baseUrl: configuredGatewayBaseUrl(),
      headers: authenticatedGatewayHeaders,
    }),
  });
}

async function authenticatedGatewayHeaders(): Promise<HeadersInit> {
  const { getSupabaseSession } = await import("./supabaseAuth.ts");
  const session = await getSupabaseSession();
  if (!session?.access_token) return {};
  const publishableKey = runtimeEnv()?.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  return {
    Authorization: `Bearer ${session.access_token}`,
    ...(publishableKey ? { apikey: publishableKey } : {}),
  };
}

function configuredGatewayBaseUrl(): string | undefined {
  const env = runtimeEnv();
  const localFunctionsUrl = env?.VITE_LOCAL_EDGE_FUNCTIONS_URL?.trim();
  if (!localFunctionsUrl) return env?.VITE_SUPABASE_URL?.trim() || undefined;
  const base = localFunctionsUrl.replace(/\/+$/gu, "");
  return base.endsWith("/pdf-gateway") ? base : `${base}/pdf-gateway`;
}

function runtimeEnv(): Readonly<Record<string, string | undefined>> | undefined {
  return (import.meta as ImportMeta & {
    env?: Readonly<Record<string, string | undefined>>;
  }).env;
}

function createRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `pdf-source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
