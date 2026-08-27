import {
  assertSameAddressSet,
  isRedirectStatus,
  resolvePublicHostAddresses,
  resolveValidatedRedirect,
  type HostAddressResolver,
  validatePublicPdfUrl,
} from "../pdf-gateway/security.ts";

const MAX_SOURCE_URL_CHARS = 2_048;
const MAX_TITLE_CHARS = 240;
const MAX_BODY_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_200;
const HARD_MAX_HTML_BYTES = 256 * 1024;
const HARD_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 2_500;
const PREVIEW_USER_AGENT = "TrackerRodu-LinkPreview/1.0";

export type PublicWebPreview = {
  title: string | null;
  description: string | null;
};

export type PublicWebPreviewResult = {
  title: string;
  bodyText: string;
  fetched: boolean;
};

export type PublicWebPreviewFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PublicWebPreviewFetchOptions = {
  resolver: HostAddressResolver;
  fetcher?: PublicWebPreviewFetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

/**
 * Finds the first direct web link in a private Telegram message. Forwarded
 * Telegram provenance remains authoritative and must not be replaced by a
 * secondary URL mentioned inside the forwarded post.
 */
export function directExternalUrlForPreview(
  messageText: string,
  hasForwardSource: boolean,
): string | null {
  if (hasForwardSource || typeof messageText !== "string") return null;
  const candidate = trimTrailingUrlPunctuation(messageText.trim());
  if (!/^https?:\/\/[^\s<>"'`]+$/iu.test(candidate)) return null;
  const normalized = normalizeDirectHttpUrl(candidate);
  if (!normalized) return null;
  try {
    const hostname = new URL(normalized).hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
    if (
      hostname === "t.me"
      || hostname.endsWith(".t.me")
      || hostname === "telegram.me"
      || hostname.endsWith(".telegram.me")
      || hostname === "telegram.org"
      || hostname.endsWith(".telegram.org")
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return normalized;
}

/**
 * Extracts a small, inert preview from already bounded HTML. Nothing from the
 * page is rendered as HTML: callers persist only normalized plain text.
 */
export function parsePublicWebPreviewHtml(
  html: string,
  pageUrl: string | URL,
): PublicWebPreview {
  if (typeof html !== "string" || !html) {
    return { title: null, description: null };
  }

  const safePageUrl = parsePageUrl(pageUrl);
  const withoutExecutableSections = stripExecutableSections(html);
  const metadata = collectMetadata(withoutExecutableSections);
  const documentTitle = firstTagText(withoutExecutableSections, "title");

  const title = firstUsefulText([
    metadata.get("property:og:title"),
    metadata.get("name:og:title"),
    metadata.get("name:twitter:title"),
    metadata.get("property:twitter:title"),
    documentTitle,
    firstTagText(withoutExecutableSections, "h1"),
  ], safePageUrl, MAX_TITLE_CHARS);

  const metadataDescription = firstUsefulText([
    metadata.get("property:og:description"),
    metadata.get("name:og:description"),
    metadata.get("name:twitter:description"),
    metadata.get("property:twitter:description"),
    metadata.get("name:description"),
  ], safePageUrl, MAX_DESCRIPTION_CHARS);

  const description = metadataDescription ?? firstUsefulText(
    paragraphCandidates(withoutExecutableSections),
    safePageUrl,
    MAX_DESCRIPTION_CHARS,
  );

  return { title, description };
}

/**
 * Fetches a private link preview without turning the Edge Function into an
 * arbitrary proxy. Invalid, unsafe, non-HTTPS and failed sources always
 * degrade to a useful local fallback and never expose fetch diagnostics.
 */
export async function fetchPublicWebPreview(
  sourceUrl: string,
  options: PublicWebPreviewFetchOptions,
): Promise<PublicWebPreviewResult> {
  const normalizedSource = normalizeDirectHttpUrl(sourceUrl);
  const fallback = fallbackPreview(normalizedSource ?? sourceUrl);
  if (!normalizedSource) return fallback;

  let parsedSource: URL;
  try {
    parsedSource = new URL(normalizedSource);
  } catch {
    return fallback;
  }
  // HTTP links remain useful private bookmarks, but the server never sends
  // clear-text requests on the user's behalf.
  if (parsedSource.protocol !== "https:") return fallback;

  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10_000);
  const maximumBytes = boundedPositiveInteger(options.maxBytes, HARD_MAX_HTML_BYTES, HARD_MAX_HTML_BYTES);
  const maximumRedirects = boundedNonNegativeInteger(
    options.maxRedirects,
    HARD_MAX_REDIRECTS,
    HARD_MAX_REDIRECTS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("public-web-preview-timeout"), timeoutMs);

  try {
    let currentUrl = networkRequestUrl(normalizedSource);
    let redirectCount = 0;

    while (true) {
      const addressesBefore = await resolvePublicHostAddressesWithAbort(
        currentUrl.hostname,
        options.resolver,
        controller.signal,
      );
      let response: Response;
      try {
        response = await fetcher(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml;q=0.9",
            "Accept-Encoding": "identity",
            "User-Agent": PREVIEW_USER_AGENT,
          },
        });
      } catch {
        return fallback;
      }

      try {
        const addressesAfter = await resolvePublicHostAddressesWithAbort(
          currentUrl.hostname,
          options.resolver,
          controller.signal,
        );
        assertSameAddressSet(addressesBefore, addressesAfter);

        if (isRedirectStatus(response.status)) {
          if (redirectCount >= maximumRedirects) return fallback;
          const location = response.headers.get("location") ?? "";
          currentUrl = stripTrackingParameters(resolveValidatedRedirect(currentUrl, location));
          redirectCount += 1;
          continue;
        }

        if (response.status < 200 || response.status >= 300) return fallback;
        const mediaType = response.headers.get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLocaleLowerCase("en-US") ?? "";
        if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
          return fallback;
        }
        const declaredLength = response.headers.get("content-length")?.trim() ?? "";
        if (/^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
          return fallback;
        }

        const html = await readBoundedHtml(
          response,
          maximumBytes,
          controller.signal,
        );
        if (!html) return fallback;
        const preview = parsePublicWebPreviewHtml(html, currentUrl);
        const fetched = Boolean(preview.title || preview.description);
        if (!fetched) return fallback;

        const title = preview.title ?? fallback.title;
        const previewText = preview.description
          ?? (preview.title && preview.title !== fallback.title ? preview.title : "");
        return {
          title: boundedPlainText(title, MAX_TITLE_CHARS) || fallback.title,
          bodyText: previewBody(previewText, normalizedSource),
          fetched: true,
        };
      } finally {
        await response.body?.cancel("public-web-preview-complete").catch(() => undefined);
      }
    }
  } catch {
    // A note is more important than its optional preview. Fail closed for the
    // network request and retain an informative, private bookmark fallback.
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function networkRequestUrl(originalSource: string): URL {
  return stripTrackingParameters(validatePublicPdfUrl(originalSource));
}

function resolvePublicHostAddressesWithAbort(
  hostname: string,
  resolver: HostAddressResolver,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (signal.aborted) return Promise.reject(new Error("PUBLIC_WEB_PREVIEW_TIMEOUT"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error("PUBLIC_WEB_PREVIEW_TIMEOUT"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void resolvePublicHostAddresses(hostname, resolver).then(
      (addresses) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(addresses);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function stripTrackingParameters(url: URL): URL {
  for (const name of [...url.searchParams.keys()]) {
    const normalizedName = name.toLocaleLowerCase("en-US");
    if (
      normalizedName === "fbclid"
      || normalizedName === "gclid"
      || normalizedName === "mc_cid"
      || normalizedName === "mc_eid"
      || normalizedName.startsWith("utm_")
    ) {
      url.searchParams.delete(name);
    }
  }
  return url;
}

function normalizeDirectHttpUrl(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > MAX_SOURCE_URL_CHARS || hasControlCharacter(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || !parsed.hostname
    ) {
      return null;
    }
    // Keep the exact cleaned text: the database stores the regex-captured
    // source rather than URL.href (which would, for example, append `/`). URL
    // parsing is validation only; the hardened fetch path canonicalizes its
    // own ephemeral request URL separately.
    return trimmed;
  } catch {
    return null;
  }
}

function fallbackPreview(sourceUrl: string): PublicWebPreviewResult {
  const normalized = normalizeDirectHttpUrl(sourceUrl);
  let title = "Вебпосилання";
  if (normalized) {
    try {
      title = displayHostname(new URL(normalized).hostname) || title;
    } catch {
      // Retain the deterministic generic label.
    }
  }
  const safeSource = normalized ?? boundedPlainText(sourceUrl, MAX_SOURCE_URL_CHARS);
  return {
    title: boundedPlainText(title, MAX_TITLE_CHARS) || "Вебпосилання",
    bodyText: previewBody(`Збережене посилання з ресурсу ${title}.`, safeSource),
    fetched: false,
  };
}

function previewBody(previewText: string, sourceUrl: string): string {
  const safeSource = boundedPlainText(sourceUrl, MAX_SOURCE_URL_CHARS);
  const sourceLine = safeSource ? `Джерело: ${safeSource}` : "Джерело не вказано.";
  const separator = previewText ? "\n\n" : "";
  const available = Math.max(0, MAX_BODY_CHARS - Array.from(sourceLine).length - separator.length);
  const summary = boundedPlainText(previewText, available);
  return summary ? `${summary}${separator}${sourceLine}` : sourceLine;
}

async function readBoundedHtml(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > maximumBytes) return "";
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (signal.aborted) {
      await reader.cancel("public-web-preview-timeout").catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // A hostile custom stream may keep a read pending even after abort. The
      // outer response cancellation still prevents further useful transfer.
    }
  }
  if (!total) return "";
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeHtmlBytes(bytes, response.headers.get("content-type") ?? "");
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("PUBLIC_WEB_PREVIEW_TIMEOUT"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void reader.cancel("public-web-preview-timeout").then(
        () => reject(new Error("PUBLIC_WEB_PREVIEW_TIMEOUT")),
        () => reject(new Error("PUBLIC_WEB_PREVIEW_TIMEOUT")),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function decodeHtmlBytes(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1]?.trim() || "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function collectMetadata(html: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = parseTagAttributes(match[0]);
    const content = attributes.get("content") ?? "";
    if (!content) continue;
    for (const keyName of ["property", "name"] as const) {
      const keyValue = attributes.get(keyName)?.trim().toLocaleLowerCase("en-US");
      if (keyValue && !values.has(`${keyName}:${keyValue}`)) {
        values.set(`${keyName}:${keyValue}`, content);
      }
    }
  }
  return values;
}

function parseTagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<\s*[^\s>]+/u, "").replace(/\/?>\s*$/u, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of body.matchAll(pattern)) {
    const name = (match[1] ?? "").toLocaleLowerCase("en-US");
    if (!name || attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function firstTagText(html: string, tagName: string): string | null {
  const escaped = tagName.replace(/[^a-z0-9]/giu, "");
  if (!escaped) return null;
  const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, "iu").exec(html);
  return match?.[1] ?? null;
}

function paragraphCandidates(html: string): string[] {
  const preferred: string[] = [];
  for (const container of html.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)) {
    preferred.push(...paragraphsIn(container[2] ?? ""));
  }
  const selected = preferred.length ? preferred : paragraphsIn(html);
  return selected.length > 1 ? [selected.join(" "), ...selected] : selected;
}

function paragraphsIn(html: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/giu)) {
    values.push(match[1] ?? "");
    if (values.length >= 12) break;
  }
  return values;
}

function firstUsefulText(
  candidates: readonly (string | null | undefined)[],
  pageUrl: URL | null,
  maximumChars: number,
): string | null {
  for (const candidate of candidates) {
    const normalized = boundedPlainText(stripMarkup(candidate ?? ""), maximumChars);
    if (!normalized || looksLikeUrlOnly(normalized) || isGenericBlockedPreview(normalized, pageUrl)) continue;
    return normalized;
  }
  return null;
}

function stripExecutableSections(html: string): string {
  let result = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ");
  // Malformed pages occasionally leave one of these elements unclosed. Drop
  // the remaining tail rather than mistaking script or consent text for an
  // article excerpt.
  result = result.replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*$/iu, " ");
  return result;
}

function stripMarkup(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, " "));
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    raquo: "»",
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu, (entity, decimal, hex, name) => {
    if (decimal || hex) {
      const codePoint = Number.parseInt(decimal || hex, hex ? 16 : 10);
      if (
        Number.isInteger(codePoint)
        && codePoint > 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return " ";
    }
    return named[String(name).toLocaleLowerCase("en-US")] ?? entity;
  });
}

function boundedPlainText(value: string, maximumChars: number): string {
  if (maximumChars <= 0) return "";
  return Array.from(
    value
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ).slice(0, maximumChars).join("");
}

function isGenericBlockedPreview(value: string, pageUrl: URL | null): boolean {
  const normalized = value.toLocaleLowerCase("uk-UA").replace(/\s+/gu, " ").trim();
  if (!normalized) return true;
  if (/^(?:facebook|log ?in|sign ?in|увійти|вхід|access denied|forbidden)$/iu.test(normalized)) return true;
  if (
    /(?:access denied|permission denied|доступ заборонено|доступ обмежено|403 forbidden|security check|перевірка безпеки|checkpoint|just a moment|checking your browser|robot check|captcha)/iu
      .test(normalized)
  ) return true;
  const facebookHost = pageUrl
    ? pageUrl.hostname === "facebook.com" || pageUrl.hostname.endsWith(".facebook.com")
    : false;
  if (facebookHost && (
    /(?:log (?:in|into)|sign up|увійти|зареєструватися|page isn't available|content isn't available|контент недоступний)/iu
      .test(normalized)
    || /facebook helps you connect/iu.test(normalized)
  )) return true;
  return false;
}

function looksLikeUrlOnly(value: string): boolean {
  return /^https?:\/\/\S+$/iu.test(value.trim());
}

function parsePageUrl(value: string | URL): URL | null {
  try {
    return value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
}

function displayHostname(hostname: string): string {
  return hostname.replace(/^www\./iu, "").replace(/\.$/u, "").toLocaleLowerCase("en-US");
}

function trimTrailingUrlPunctuation(value: string): string {
  // Keep this exactly aligned with the SQL rtrim used when source_url is
  // persisted, otherwise the service-role enrichment fence cannot match the
  // just-created note.
  return value.replace(/[),.;:!?\]}]+$/u, "");
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(value as number, maximum);
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) return fallback;
  return Math.min(value as number, maximum);
}
