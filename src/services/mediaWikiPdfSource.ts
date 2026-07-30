export type MediaWikiDocumentNamespace = "file" | "index" | "page";

export interface ParsedMediaWikiDocumentUrl {
  /** Original HTTPS reference without credentials or a fragment. */
  sourceUrl: string;
  sourceOrigin: string;
  apiUrl: string;
  namespace: MediaWikiDocumentNamespace;
  namespaceAlias: string;
  originalPageTitle: string;
  canonicalPageTitle: string;
  canonicalPageUrl: string;
  baseFileName: string;
  baseFileTitle: string;
  initialPage?: number;
  initialPageLabel?: string;
}

export interface ParsedMediaWikiArticleUrl {
  /** Stable ordinary Wikisource article URL; query noise and fragments removed. */
  sourceUrl: string;
  sourceOrigin: string;
  apiUrl: string;
  pageTitle: string;
  canonicalPageUrl: string;
}

export interface MediaWikiResolvedFile {
  canonicalFileTitle: string;
  fileName: string;
  fileUrl: string;
  descriptionUrl?: string;
  mimeType: string;
  size?: number;
  pageCount?: number;
  sha1?: string;
  timestamp?: string;
}

export interface ResolvedMediaWikiPdfCandidate {
  provider: "wikimedia";
  sourceUrl: string;
  sourceOrigin: string;
  sourceNamespace: MediaWikiDocumentNamespace;
  sourcePageTitle: string;
  sourcePageUrl: string;
  baseFileTitle: string;
  file: MediaWikiResolvedFile;
  initialPage?: number;
  initialPageLabel?: string;
}

const namespaceAliases: Readonly<Record<string, MediaWikiDocumentNamespace>> = {
  file: "file",
  "файл": "file",
  index: "index",
  "індекс": "index",
  page: "page",
  "сторінка": "page",
};

const canonicalNamespace: Readonly<Record<MediaWikiDocumentNamespace, string>> = {
  file: "File",
  index: "Index",
  page: "Page",
};

/**
 * Parses MediaWiki File/Index/Page references without making a network call.
 * The returned baseFileTitle can be sent directly to prop=imageinfo, while
 * initialPage/initialPageLabel preserve a Wikisource Page subpage target.
 */
export function parseMediaWikiDocumentUrl(input: string): ParsedMediaWikiDocumentUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !isSupportedMediaWikiHost(url.hostname)
  ) {
    return null;
  }

  const originalPageTitle = extractPageTitle(url);
  if (!originalPageTitle) return null;

  const separatorIndex = originalPageTitle.indexOf(":");
  if (separatorIndex <= 0) return null;
  const namespaceAlias = originalPageTitle.slice(0, separatorIndex).trim();
  const namespace = namespaceAliases[namespaceAlias.toLocaleLowerCase()];
  if (!namespace) return null;

  const titleBody = normalizeMediaWikiTitle(originalPageTitle.slice(separatorIndex + 1));
  if (!titleBody) return null;

  let baseFileName = titleBody;
  let initialPageLabel: string | undefined;
  let initialPage: number | undefined;
  if (namespace === "page") {
    const subpageSeparator = titleBody.lastIndexOf("/");
    if (subpageSeparator > 0 && subpageSeparator < titleBody.length - 1) {
      baseFileName = titleBody.slice(0, subpageSeparator).trim();
      initialPageLabel = titleBody.slice(subpageSeparator + 1).trim();
      if (/^\d+$/u.test(initialPageLabel)) {
        const numericPage = Number(initialPageLabel);
        if (Number.isSafeInteger(numericPage) && numericPage >= 1) {
          initialPage = numericPage;
        }
      }
    }
  }
  if (!baseFileName) return null;

  const canonicalPageTitle = `${canonicalNamespace[namespace]}:${baseFileName}${
    namespace === "page" && initialPageLabel ? `/${initialPageLabel}` : ""
  }`;
  const sourceOrigin = url.origin;
  const normalizedSource = new URL(url.href);
  normalizedSource.hash = "";
  if (!normalizedSource.pathname.toLocaleLowerCase().endsWith("/w/index.php")) {
    normalizedSource.search = "";
  }

  return {
    sourceUrl: normalizedSource.href,
    sourceOrigin,
    apiUrl: new URL("/w/api.php", sourceOrigin).href,
    namespace,
    namespaceAlias,
    originalPageTitle,
    canonicalPageTitle,
    canonicalPageUrl: mediaWikiPageUrl(sourceOrigin, canonicalPageTitle),
    baseFileName,
    baseFileTitle: `File:${baseFileName}`,
    ...(initialPage !== undefined ? { initialPage } : {}),
    ...(initialPageLabel ? { initialPageLabel } : {}),
  };
}

/**
 * Parses an ordinary Wikisource article. File/Index/Page references stay on
 * the deterministic single-file path above; article pages are resolved via
 * MediaWiki's bounded image generator and may yield several PDF candidates.
 */
export function parseMediaWikiArticleUrl(input: string): ParsedMediaWikiArticleUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.trim().toLocaleLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !(host === "wikisource.org" || host.endsWith(".wikisource.org"))
  ) {
    return null;
  }
  const pageTitle = extractPageTitle(url);
  if (!pageTitle) return null;
  const separatorIndex = pageTitle.indexOf(":");
  if (separatorIndex > 0) {
    const namespace = namespaceAliases[pageTitle.slice(0, separatorIndex).trim().toLocaleLowerCase()];
    if (namespace) return null;
  }

  const sourceOrigin = url.origin;
  const normalizedSource = new URL(url.href);
  normalizedSource.hash = "";
  if (normalizedSource.pathname.toLocaleLowerCase().endsWith("/w/index.php")) {
    normalizedSource.search = new URLSearchParams({ title: pageTitle }).toString();
  } else {
    normalizedSource.search = "";
  }
  return {
    sourceUrl: normalizedSource.href,
    sourceOrigin,
    apiUrl: new URL("/w/api.php", sourceOrigin).href,
    pageTitle,
    canonicalPageUrl: mediaWikiPageUrl(sourceOrigin, pageTitle),
  };
}

export function isSupportedMediaWikiHost(hostname: string): boolean {
  const host = hostname.trim().toLocaleLowerCase().replace(/\.$/u, "");
  return host === "wikisource.org"
    || host.endsWith(".wikisource.org")
    || host === "wikipedia.org"
    || host.endsWith(".wikipedia.org")
    || host === "wikimedia.org"
    || host.endsWith(".wikimedia.org");
}

export function buildMediaWikiImageInfoApiUrl(
  source: ParsedMediaWikiDocumentUrl,
  apiOrigin = source.sourceOrigin,
): string {
  const origin = new URL(apiOrigin);
  if (
    origin.protocol !== "https:"
    || origin.username
    || origin.password
    || !isSupportedMediaWikiHost(origin.hostname)
  ) {
    throw new Error("MediaWiki API origin is not supported.");
  }

  const apiUrl = new URL("/w/api.php", origin.origin);
  apiUrl.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    redirects: "1",
    prop: "imageinfo",
    titles: source.baseFileTitle,
    iiprop: "url|size|mime|sha1|timestamp",
  }).toString();
  return apiUrl.href;
}

/** Source-site request first, then Commons fallback when the source is not Commons. */
export function mediaWikiImageInfoApiCandidates(source: ParsedMediaWikiDocumentUrl): string[] {
  const primary = buildMediaWikiImageInfoApiUrl(source);
  if (new URL(source.sourceOrigin).hostname.toLocaleLowerCase() === "commons.wikimedia.org") {
    return [primary];
  }
  return [primary, buildMediaWikiImageInfoApiUrl(source, "https://commons.wikimedia.org")];
}

export function buildMediaWikiArticlePdfCandidatesApiUrl(
  source: ParsedMediaWikiArticleUrl,
  continuation?: string,
): string {
  const apiUrl = new URL(source.apiUrl);
  const search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    redirects: "1",
    generator: "images",
    titles: source.pageTitle,
    gimlimit: "max",
    prop: "imageinfo",
    iiprop: "url|size|mime|sha1|timestamp",
  });
  if (continuation) {
    search.set("continue", "");
    search.set("gimcontinue", continuation);
  }
  apiUrl.search = search.toString();
  return apiUrl.href;
}

export function mediaWikiArticleContinuation(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.continue)) return undefined;
  return nonEmptyString(payload.continue.gimcontinue);
}

/** Supports both formatversion=2 arrays and the legacy query.pages object. */
export function parseMediaWikiImageInfoResponse(payload: unknown): MediaWikiResolvedFile | null {
  return parseMediaWikiImageInfoResponses(payload)[0] ?? null;
}

/** Supports batched/generator imageinfo payloads while rejecting untrusted assets. */
export function parseMediaWikiImageInfoResponses(payload: unknown): MediaWikiResolvedFile[] {
  const resolved: MediaWikiResolvedFile[] = [];
  const pages = mediaWikiQueryPages(payload);
  for (const candidate of pages) {
    if (!isRecord(candidate)) continue;
    const imageInfo = Array.isArray(candidate.imageinfo) && isRecord(candidate.imageinfo[0])
      ? candidate.imageinfo[0]
      : null;
    if (!imageInfo || typeof imageInfo.url !== "string") continue;

    const fileUrl = safeMediaWikiAssetUrl(imageInfo.url);
    if (!fileUrl) continue;
    const rawTitle = typeof candidate.title === "string" ? normalizeMediaWikiTitle(candidate.title) : "";
    const titleBody = mediaWikiFileTitleBody(rawTitle)
      || decodeUrlComponent(new URL(fileUrl).pathname.split("/").filter(Boolean).pop() ?? "");
    if (!titleBody) continue;

    const mimeType = typeof imageInfo.mime === "string"
      ? imageInfo.mime.trim().toLocaleLowerCase()
      : inferMimeType(titleBody);
    const descriptionUrl = typeof imageInfo.descriptionurl === "string"
      ? safeMediaWikiPageUrl(imageInfo.descriptionurl)
      : null;
    const size = positiveInteger(imageInfo.size);
    const pageCount = positiveInteger(imageInfo.pagecount);
    const sha1 = nonEmptyString(imageInfo.sha1);
    const timestamp = nonEmptyString(imageInfo.timestamp);

    resolved.push({
      canonicalFileTitle: `File:${titleBody}`,
      fileName: titleBody,
      fileUrl,
      ...(descriptionUrl ? { descriptionUrl } : {}),
      mimeType,
      ...(size !== undefined ? { size } : {}),
      ...(pageCount !== undefined ? { pageCount } : {}),
      ...(sha1 ? { sha1 } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  return resolved;
}

/** Joins a parsed File/Index/Page reference with a pure imageinfo response. */
export function resolveMediaWikiPdfCandidate(
  source: ParsedMediaWikiDocumentUrl,
  imageInfoPayload: unknown,
): ResolvedMediaWikiPdfCandidate | null {
  const file = parseMediaWikiImageInfoResponse(imageInfoPayload);
  if (!file) return null;
  if (file.mimeType !== "application/pdf" && !file.fileName.toLocaleLowerCase().endsWith(".pdf")) {
    return null;
  }
  return {
    provider: "wikimedia",
    sourceUrl: source.sourceUrl,
    sourceOrigin: source.sourceOrigin,
    sourceNamespace: source.namespace,
    sourcePageTitle: source.canonicalPageTitle,
    sourcePageUrl: source.canonicalPageUrl,
    baseFileTitle: source.baseFileTitle,
    file,
    ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
    ...(source.initialPageLabel ? { initialPageLabel: source.initialPageLabel } : {}),
  };
}

function extractPageTitle(url: URL): string {
  const pathname = url.pathname.toLocaleLowerCase();
  let rawTitle = "";
  if (pathname.startsWith("/wiki/")) {
    rawTitle = decodeUrlComponent(url.pathname.slice("/wiki/".length));
  } else if (pathname.endsWith("/w/index.php")) {
    rawTitle = url.searchParams.get("title") ?? "";
  }
  return normalizeMediaWikiTitle(rawTitle);
}

function normalizeMediaWikiTitle(value: string): string {
  return value.replace(/_/gu, " ").replace(/\s+/gu, " ").trim();
}

function mediaWikiPageUrl(origin: string, pageTitle: string): string {
  const separatorIndex = pageTitle.indexOf(":");
  const namespace = separatorIndex > 0 ? pageTitle.slice(0, separatorIndex) : "";
  const titleBody = separatorIndex > 0 ? pageTitle.slice(separatorIndex + 1) : pageTitle;
  const encodedBody = titleBody
    .split("/")
    .map((segment) => encodeURIComponent(segment.replace(/ /gu, "_")))
    .join("/");
  const encodedTitle = namespace
    ? `${encodeURIComponent(namespace)}:${encodedBody}`
    : encodedBody;
  return new URL(`/wiki/${encodedTitle}`, origin).href;
}

function mediaWikiFileTitleBody(title: string): string {
  const separatorIndex = title.indexOf(":");
  if (separatorIndex <= 0) return "";
  const namespace = namespaceAliases[title.slice(0, separatorIndex).trim().toLocaleLowerCase()];
  return namespace === "file" ? title.slice(separatorIndex + 1).trim() : "";
}

function mediaWikiQueryPages(payload: unknown): unknown[] {
  if (!isRecord(payload) || !isRecord(payload.query)) return [];
  const pages = payload.query.pages;
  if (Array.isArray(pages)) return pages;
  return isRecord(pages) ? Object.values(pages) : [];
}

function safeMediaWikiAssetUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLocaleLowerCase();
    if (host !== "upload.wikimedia.org" && !isSupportedMediaWikiHost(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeMediaWikiPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || !isSupportedMediaWikiHost(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferMimeType(fileName: string): string {
  return fileName.toLocaleLowerCase().endsWith(".pdf") ? "application/pdf" : "";
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
