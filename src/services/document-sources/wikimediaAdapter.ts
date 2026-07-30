import { normalizeExternalDocumentUrl } from "../../utils/documentSourceUrlSecurity.ts";
import {
  buildMediaWikiArticlePdfCandidatesApiUrl,
  mediaWikiImageInfoApiCandidates,
  mediaWikiArticleContinuation,
  parseMediaWikiArticleUrl,
  parseMediaWikiDocumentUrl,
  parseMediaWikiImageInfoResponse,
  parseMediaWikiImageInfoResponses,
  type MediaWikiResolvedFile,
} from "../mediaWikiPdfSource.ts";
import { sourceValidationResult, validationResultForError } from "./adapterSupport.ts";
import type {
  AccessContext,
  DocumentSourceAdapter,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  ResolveSourceContext,
  SourceValidationResult,
  StoredDocumentSource,
} from "./contracts.ts";
import { probeDirectPdfOverCors } from "./directPdfAdapter.ts";
import { DocumentSourceError } from "./errors.ts";
import {
  directAccessDescriptor,
  type DirectPdfGatewayProbe,
  type DocumentSourceGatewayClient,
} from "./gatewayClient.ts";

export interface WikimediaPdfAdapterOptions {
  fetch?: typeof fetch;
  gateway?: DocumentSourceGatewayClient;
  now?: () => Date;
}

/** Resolves Wikimedia/Wikisource page references before the generic URL adapter. */
export class WikimediaPdfSourceAdapter implements DocumentSourceAdapter {
  readonly provider = "wikimedia" as const;
  readonly #fetch: typeof fetch;
  readonly #gateway?: DocumentSourceGatewayClient;
  readonly #now: () => Date;

  constructor(options: WikimediaPdfAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
  }

  canHandle(inputUrl: string): boolean {
    return Boolean(parseMediaWikiDocumentUrl(inputUrl))
      || Boolean(parseMediaWikiArticleUrl(inputUrl))
      || isDirectWikimediaPdfUrl(inputUrl);
  }

  async resolve(inputUrl: string, context: ResolveSourceContext): Promise<ResolvedPdfSource> {
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
    const normalized = normalizeExternalDocumentUrl(inputUrl);
    const parsed = parseMediaWikiDocumentUrl(normalized.url);
    if (parsed) return [await this.#resolveDocumentPage(normalized.url, parsed, context)];

    const article = parseMediaWikiArticleUrl(normalized.url);
    if (article) return this.#resolveArticlePage(normalized.url, article, context);

    return [await this.#resolveDirectUpload(normalized.url, context)];
  }

  async #resolveDocumentPage(
    originalUrl: string,
    parsed: NonNullable<ReturnType<typeof parseMediaWikiDocumentUrl>>,
    context: ResolveSourceContext,
  ): Promise<ResolvedPdfSource> {

    for (const apiUrl of mediaWikiImageInfoApiCandidates(parsed)) {
      const payload = await fetchMediaWikiJson(apiUrl, this.#fetch, context.signal);
      const file = parseMediaWikiImageInfoResponse(payload);
      if (!file) continue;
      return this.#resolvedSourceFromFile({
        originalUrl,
        sourcePageUrl: parsed.canonicalPageUrl,
        file,
        initialPage: parsed.initialPage,
        context,
      });
    }

    throw new DocumentSourceError("WIKIMEDIA_FILE_NOT_FOUND");
  }

  async #resolveArticlePage(
    originalUrl: string,
    article: NonNullable<ReturnType<typeof parseMediaWikiArticleUrl>>,
    context: ResolveSourceContext,
  ): Promise<readonly ResolvedPdfSource[]> {
    const files: MediaWikiResolvedFile[] = [];
    const identities = new Set<string>();
    let continuation: string | undefined;
    let truncated = false;

    for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
      const payload = await fetchMediaWikiJson(
        buildMediaWikiArticlePdfCandidatesApiUrl(article, continuation),
        this.#fetch,
        context.signal,
      );
      for (const file of parseMediaWikiImageInfoResponses(payload)) {
        if (file.mimeType !== "application/pdf" && !file.fileName.toLocaleLowerCase().endsWith(".pdf")) {
          continue;
        }
        const identity = `${file.canonicalFileTitle}\n${file.fileUrl}`;
        if (identities.has(identity)) continue;
        identities.add(identity);
        files.push(file);
        if (files.length >= 50) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      continuation = mediaWikiArticleContinuation(payload);
      if (!continuation) break;
      if (requestIndex === 3) truncated = true;
    }
    if (!files.length) throw new DocumentSourceError("WIKIMEDIA_FILE_NOT_FOUND");

    const candidates: ResolvedPdfSource[] = [];
    for (const file of files) {
      const source = await this.#resolvedSourceFromFile({
        originalUrl,
        sourcePageUrl: article.canonicalPageUrl,
        file,
        context,
      });
      candidates.push(truncated
        ? { ...source, warnings: [...source.warnings, "Показано перші 50 PDF із цієї сторінки."] }
        : source);
    }
    return candidates;
  }

  async #resolvedSourceFromFile({
    originalUrl,
    sourcePageUrl,
    file,
    initialPage,
    context,
  }: {
    originalUrl: string;
    sourcePageUrl: string;
    file: MediaWikiResolvedFile;
    initialPage?: number;
    context: ResolveSourceContext;
  }): Promise<ResolvedPdfSource> {
    const verified = file.mimeType === "application/pdf"
      ? undefined
      : await this.#probePdf(file.fileUrl, context);
    const canonical = normalizeExternalDocumentUrl(verified?.probe.canonicalUrl ?? file.fileUrl);
    if (canonical.removedSensitiveParameters.length) {
      throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
    }
    const fileSizeBytes = file.size ?? verified?.probe.fileSizeBytes;
    return {
      provider: this.provider,
      originalUrl,
      canonicalUrl: canonical.url,
      sourcePageUrl: file.descriptionUrl ?? sourcePageUrl,
      providerHost: new URL(canonical.url).hostname.toLocaleLowerCase(),
      providerFileTitle: file.canonicalFileTitle,
      displayName: file.fileName,
      mimeType: "application/pdf",
      ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
      ...(file.pageCount !== undefined ? { pageCount: file.pageCount } : {}),
      ...(initialPage !== undefined ? { initialPage } : {}),
      accessMode: verified?.accessMode ?? "direct_cors",
      fingerprint: {
        ...verified?.probe.fingerprint,
        ...(file.sha1 ? { sha1: file.sha1 } : {}),
        ...(file.timestamp ? { lastModified: file.timestamp } : {}),
        ...(fileSizeBytes !== undefined ? { contentLength: fileSizeBytes } : {}),
      },
      warnings: verified && !verified.probe.acceptsRanges
        ? ["Джерело не підтвердило підтримку HTTP Range."]
        : [],
    };
  }

  createAccessDescriptor(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<PdfAccessDescriptor> {
    if (source.accessMode === "direct_cors") {
      return Promise.resolve(directAccessDescriptor(source));
    }
    if (!this.#gateway) return Promise.reject(new DocumentSourceError("ACCESS_DENIED"));
    return this.#gateway.createAccessSession(source, context);
  }

  async revalidate(
    source: StoredDocumentSource,
    context: AccessContext,
  ): Promise<SourceValidationResult> {
    const validatedAt = this.#now().toISOString();
    try {
      const candidates = await this.resolveCandidates(source.originalUrl, context);
      const resolved = candidates.find((candidate) => (
        source.providerFileTitle
          ? candidate.providerFileTitle === source.providerFileTitle
          : candidate.canonicalUrl === source.canonicalUrl
      ));
      if (!resolved) throw new DocumentSourceError("WIKIMEDIA_FILE_NOT_FOUND");
      return sourceValidationResult(
        source,
        resolved,
        validatedAt,
      );
    } catch (error) {
      return validationResultForError(source, error, validatedAt);
    }
  }

  async #resolveDirectUpload(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<ResolvedPdfSource> {
    if (!isDirectWikimediaPdfUrl(inputUrl)) {
      throw new DocumentSourceError("UNSUPPORTED_PROVIDER");
    }

    const verified = await this.#probePdf(inputUrl, context);
    return directUploadSource(inputUrl, verified.probe, verified.accessMode);
  }

  async #probePdf(
    inputUrl: string,
    context: ResolveSourceContext,
  ): Promise<{
    probe: DirectPdfGatewayProbe;
    accessMode: "direct_cors" | "secure_proxy";
  }> {
    try {
      const probe = await probeDirectPdfOverCors(inputUrl, this.#fetch, context.signal);
      return { probe, accessMode: "direct_cors" };
    } catch (error) {
      if (error instanceof DocumentSourceError && error.code !== "NETWORK_ERROR" && error.code !== "TIMEOUT") {
        throw error;
      }
      if (!this.#gateway?.probeDirectPdf) throw error;
      const probe = await this.#gateway.probeDirectPdf(inputUrl, context);
      return { probe, accessMode: "secure_proxy" };
    }
  }
}

function directUploadSource(
  inputUrl: string,
  probe: DirectPdfGatewayProbe,
  accessMode: "direct_cors" | "secure_proxy",
): ResolvedPdfSource {
  const canonical = normalizeExternalDocumentUrl(probe.canonicalUrl);
  if (canonical.removedSensitiveParameters.length) {
    throw new DocumentSourceError("SENSITIVE_URL_NOT_PERSISTABLE");
  }
  const displayName = probe.displayName ?? fileNameFromUrl(canonical.url);
  return {
    provider: "wikimedia",
    originalUrl: inputUrl,
    canonicalUrl: canonical.url,
    providerHost: new URL(canonical.url).hostname.toLocaleLowerCase(),
    providerFileTitle: `File:${displayName}`,
    displayName,
    mimeType: "application/pdf",
    ...(probe.fileSizeBytes !== undefined ? { fileSizeBytes: probe.fileSizeBytes } : {}),
    ...(probe.pageCount !== undefined ? { pageCount: probe.pageCount } : {}),
    accessMode,
    fingerprint: probe.fingerprint,
    warnings: probe.acceptsRanges ? [] : ["Джерело не підтвердило підтримку HTTP Range."],
  };
}

function isDirectWikimediaPdfUrl(inputUrl: string): boolean {
  try {
    const url = new URL(inputUrl);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.hostname.toLocaleLowerCase() === "upload.wikimedia.org"
      && url.pathname.toLocaleLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

async function fetchMediaWikiJson(
  apiUrl: string,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(apiUrl, {
      method: "GET",
      credentials: "omit",
      mode: "cors",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (isAbortError(cause)) throw new DocumentSourceError("TIMEOUT", { cause });
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }
  if (response.status === 401 || response.status === 403) {
    throw new DocumentSourceError("ACCESS_DENIED");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new DocumentSourceError("NETWORK_ERROR");
  try {
    return await response.json();
  } catch (cause) {
    throw new DocumentSourceError("NETWORK_ERROR", { cause });
  }
}

function fileNameFromUrl(value: string): string {
  const raw = new URL(value).pathname.split("/").filter(Boolean).pop() ?? "document.pdf";
  try {
    return decodeURIComponent(raw) || "document.pdf";
  } catch {
    return raw || "document.pdf";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
