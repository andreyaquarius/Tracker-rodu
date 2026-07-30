import type { ScanAttachment } from "../types/index.ts";
import type {
  AccessContext,
  StoredDocumentSource,
} from "./document-sources/contracts.ts";
import type { DocumentSourceAdapterRegistry } from "./document-sources/registry.ts";
import {
  documentSourceFromAttachment,
  findDocumentSourceForAttachment,
} from "./documentSourceSync.ts";
import type { SaveDocumentSourceInput } from "./documentSources.ts";

export interface LegacyDocumentSourceMigrationRequest {
  projectId: string;
  documentId: string;
  attachment: ScanAttachment;
  signal?: AbortSignal;
}

export interface LegacyDocumentSourceMigrationPersistence {
  listDocumentSources: (
    projectId: string,
    documentId: string,
  ) => Promise<StoredDocumentSource[]>;
  saveDocumentSource: (
    projectId: string,
    source: SaveDocumentSourceInput,
  ) => Promise<StoredDocumentSource>;
}

/**
 * Validates and normalizes one legacy attachment on first editor open. The
 * unverified attachment projection is never persisted. If another tab wins a
 * concurrent migration, the already-created registry row is reused.
 *
 * A null result deliberately keeps the legacy preview path available during
 * rolling migrations, unsupported/ambiguous sources, and temporary database
 * outages.
 */
export async function migrateLegacyDocumentSource(
  request: LegacyDocumentSourceMigrationRequest,
  registry: Pick<DocumentSourceAdapterRegistry, "resolve">,
  context: AccessContext,
  persistence: LegacyDocumentSourceMigrationPersistence,
): Promise<StoredDocumentSource | null> {
  const legacyCandidate = documentSourceFromAttachment(
    request.documentId,
    request.attachment,
  );
  if (!legacyCandidate) return null;

  try {
    const resolved = await registry.resolve(legacyCandidate.originalUrl, context);
    return await persistence.saveDocumentSource(request.projectId, {
      ...resolved,
      documentId: request.documentId,
      lastValidatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const refreshed = await persistence.listDocumentSources(
      request.projectId,
      request.documentId,
    ).catch(() => [] as StoredDocumentSource[]);
    return findDocumentSourceForAttachment(refreshed, request.attachment);
  }
}
