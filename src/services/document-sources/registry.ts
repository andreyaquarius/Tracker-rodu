import type {
  AccessContext,
  DocumentSourceAdapter,
  DocumentSourceProvider,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  ResolveSourceContext,
  SourceValidationResult,
  StoredDocumentSource,
} from "./contracts.ts";
import { DocumentSourceError } from "./errors.ts";
import {
  normalizeExternalDocumentUrl,
  type NormalizedExternalDocumentUrl,
} from "../../utils/documentSourceUrlSecurity.ts";
import {
  createPdfOperationalRequestId,
  emitPdfOperationalEvent,
  pdfFileSizeBucket,
  safePdfOperationalErrorCode,
} from "../pdfOperationalTelemetry.ts";

export interface DocumentSourceInspection extends NormalizedExternalDocumentUrl {
  provider: DocumentSourceProvider;
}

export class DocumentSourceAdapterRegistry {
  readonly #adapters: DocumentSourceAdapter[] = [];
  readonly #adaptersByProvider = new Map<DocumentSourceProvider, DocumentSourceAdapter>();

  constructor(adapters: readonly DocumentSourceAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: DocumentSourceAdapter): this {
    if (this.#adaptersByProvider.has(adapter.provider)) {
      throw new Error(`Document source adapter already registered: ${adapter.provider}`);
    }
    this.#adapters.push(adapter);
    this.#adaptersByProvider.set(adapter.provider, adapter);
    return this;
  }

  providers(): readonly DocumentSourceProvider[] {
    return this.#adapters.map((adapter) => adapter.provider);
  }

  inspect(inputUrl: string): DocumentSourceInspection {
    const normalized = normalizeExternalDocumentUrl(inputUrl);
    if (normalized.removedSensitiveParameters.length) {
      // Until the secure access-session gateway exists, accepting a signed
      // URL here would either persist its secret or save a stripped, broken
      // reference. Reject it explicitly instead of doing either.
      throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
    }
    const adapter = this.#adapters.find((candidate) => {
      try {
        return candidate.canHandle(normalized.url);
      } catch {
        return false;
      }
    });
    if (!adapter) throw new DocumentSourceError("UNSUPPORTED_PROVIDER");
    return { ...normalized, provider: adapter.provider };
  }

  async resolve(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<ResolvedPdfSource> {
    const candidates = await this.resolveCandidates(inputUrl, context);
    if (candidates.length !== 1) {
      throw new DocumentSourceError("MULTIPLE_SOURCE_CANDIDATES");
    }
    return candidates[0]!;
  }

  async resolveCandidates(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<readonly ResolvedPdfSource[]> {
    const telemetryRequestId = createPdfOperationalRequestId(context.requestId);
    const startedAt = performance.now();
    let provider: DocumentSourceProvider | "unknown" = "unknown";
    void emitPdfOperationalEvent(context.projectId, {
      event: "document_source_resolve_started",
      requestId: telemetryRequestId,
      provider,
    });
    try {
      const inspection = this.inspect(inputUrl);
      provider = inspection.provider;
      const adapter = this.adapterFor(inspection.provider);
      const resolvedCandidates = adapter.resolveCandidates
        ? await adapter.resolveCandidates(inspection.url, context)
        : [await adapter.resolve(inspection.url, context)];
      if (!resolvedCandidates.length) throw new DocumentSourceError("SOURCE_NOT_FOUND");

      // Force the persisted origin back to the already-scrubbed input. Provider
      // adapters may only add canonical/source-page URLs after the same scrub.
      const sanitized = resolvedCandidates.map((resolved) => {
        if (resolved.provider !== adapter.provider) {
          throw new DocumentSourceError("UNSUPPORTED_PROVIDER");
        }
        if (resolved.mimeType !== "application/pdf") {
          throw new DocumentSourceError("SOURCE_NOT_PDF");
        }
        return {
          ...resolved,
          originalUrl: inspection.url,
          ...(resolved.canonicalUrl
            ? { canonicalUrl: normalizeExternalDocumentUrl(resolved.canonicalUrl).url }
            : {}),
          ...(resolved.sourcePageUrl
            ? { sourcePageUrl: normalizeExternalDocumentUrl(resolved.sourcePageUrl).url }
            : {}),
        };
      });
      const representative = sanitized[0];
      void emitPdfOperationalEvent(context.projectId, {
        event: "document_source_resolve_succeeded",
        requestId: telemetryRequestId,
        provider,
        ...(representative?.accessMode ? { accessMode: representative.accessMode } : {}),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(representative?.pageCount ? { pageCount: representative.pageCount } : {}),
        fileSizeBucket: pdfFileSizeBucket(representative?.fileSizeBytes),
      });
      return sanitized;
    } catch (error) {
      void emitPdfOperationalEvent(context.projectId, {
        event: "document_source_resolve_failed",
        requestId: telemetryRequestId,
        provider,
        errorCode: safePdfOperationalErrorCode(error),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      throw error;
    }
  }

  createAccessDescriptor(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<PdfAccessDescriptor> {
    return this.adapterFor(source.provider).createAccessDescriptor(source, context);
  }

  revalidate(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<SourceValidationResult> {
    return this.adapterFor(source.provider).revalidate(source, context);
  }

  private adapterFor(provider: DocumentSourceProvider): DocumentSourceAdapter {
    const adapter = this.#adaptersByProvider.get(provider);
    if (!adapter) throw new DocumentSourceError("UNSUPPORTED_PROVIDER");
    return adapter;
  }
}
