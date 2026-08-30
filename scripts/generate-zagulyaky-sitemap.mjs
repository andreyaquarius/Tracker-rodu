import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ZAGULYAKY_SITEMAP_ORIGIN = "https://trekerrodu.com.ua";
export const DEFAULT_ZAGULYAKY_SITEMAP_OUTPUT = "dist/sitemap-zagulyaky.xml";
export const ZAGULYAKY_SITEMAP_PAGE_SIZE = 50;
export const DEFAULT_ZAGULYAKY_RPC_MAX_ATTEMPTS = 6;
export const DEFAULT_ZAGULYAKY_RPC_RETRY_BASE_DELAY_MS = 2_000;
export const DEFAULT_ZAGULYAKY_RPC_RETRY_MAX_DELAY_MS = 15_000;
export const DEFAULT_ZAGULYAKY_RPC_TIMEOUT_MS = 30_000;
const MAX_PAGES_PER_KIND = 20_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_POSTGREST_CODES = new Set(["PGRST000", "PGRST001", "PGRST002"]);

export const PUBLIC_RPC_BY_KIND = Object.freeze({
  person: "search_zagulyaky_people_v1",
  document: "search_zagulyaky_documents_v1",
});
// All requests made from CI use the anonymous, intentionally public API
// surface.  Keep this allow-list narrow: the static renderer needs list pages
// plus the existing redacted detail facade, never tables or private helpers.
export const PUBLIC_ZAGULYAKY_INDEXING_RPCS = Object.freeze([
  ...Object.values(PUBLIC_RPC_BY_KIND),
  "list_public_zagulyaky_indexing_v1",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstObject(value) {
  return Array.isArray(value) ? object(value[0]) : object(value);
}

function loopbackHost(hostname) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function jwtRole(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Accept only the same class of keys that is safe to put in the browser.
 * The script never reads SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.
 */
export function assertPublishableSupabaseKey(rawKey) {
  const key = text(rawKey);
  if (!key) {
    throw new Error(
      "A public Supabase key is required. Set ZAGULYAKY_SITEMAP_PUBLISHABLE_KEY or VITE_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  const normalized = key.toLowerCase();
  if (normalized.startsWith("sb_secret_") || normalized.includes("service_role")) {
    throw new Error("Refusing a secret or service-role Supabase key. Use a publishable/anon key only.");
  }

  const role = jwtRole(key);
  if (role && role !== "anon") {
    throw new Error("Refusing a non-anon Supabase JWT. Use a publishable/anon key only.");
  }

  if (normalized.startsWith("sb_publishable_") || role === "anon") return key;
  throw new Error("The sitemap generator accepts only a publishable or legacy anon Supabase key.");
}

export function normalizeSupabaseUrl(rawUrl) {
  const value = text(rawUrl);
  if (!value) {
    throw new Error("A Supabase URL is required. Set ZAGULYAKY_SITEMAP_SUPABASE_URL or VITE_SUPABASE_URL.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Supabase URL is invalid.");
  }

  const localHttp = url.protocol === "http:" && loopbackHost(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The Supabase URL must use HTTPS, except for a local loopback Supabase instance.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The Supabase URL must be a bare project origin without credentials, path, query, or hash.");
  }
  return url.origin;
}

export function readSitemapEnvironment(env = process.env) {
  const supabaseUrl = normalizeSupabaseUrl(
    env.ZAGULYAKY_SITEMAP_SUPABASE_URL ?? env.VITE_SUPABASE_URL,
  );
  const publishableKey = assertPublishableSupabaseKey(
    env.ZAGULYAKY_SITEMAP_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );
  return { supabaseUrl, publishableKey };
}

export function publicZagulyakaUrl(kind, rawSlug, siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN) {
  if (kind !== "person" && kind !== "document") {
    throw new Error(`Unsupported Zagulyaky sitemap kind: ${String(kind)}`);
  }
  const slug = text(rawSlug);
  if (slug.length < 3 || slug.length > 180) {
    throw new Error("A public Zagulyaky sitemap record has an invalid slug.");
  }

  let url;
  try {
    url = new URL(siteOrigin);
  } catch {
    throw new Error("The public sitemap origin is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The public sitemap origin must be a bare HTTPS origin.");
  }

  url.pathname = `/zahuliaky/${kind === "person" ? "people" : "documents"}/${encodeURIComponent(slug)}/`;
  return url.toString();
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderZagulyakySitemap(urls) {
  const uniqueUrls = [...new Set(urls)].sort((left, right) => left.localeCompare(right, "en"));
  const entries = uniqueUrls.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}

function searchPayload(rawPayload) {
  const payload = firstObject(rawPayload);
  const items = Array.isArray(payload.items) ? payload.items.map(object) : null;
  if (!items) {
    throw new Error("A public Zagulyaky search RPC returned an invalid sitemap payload.");
  }
  const cursor = object(payload.nextCursor ?? payload.next_cursor);
  const publishedAt = text(cursor.publishedAt ?? cursor.published_at);
  const id = text(cursor.id);
  if ((publishedAt && !id) || (!publishedAt && id)) {
    throw new Error("A public Zagulyaky search RPC returned an incomplete sitemap cursor.");
  }
  return { items, nextCursor: publishedAt && id ? { publishedAt, id } : null };
}

/**
 * Collects only the public search projection that is already safe for an
 * anonymous catalogue visitor.  Keep the original RPC row available to the
 * static SEO renderer, but never put it into the sitemap itself.
 */
export async function collectPublishedZagulyakyEntries({
  requestRpc,
  siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN,
}) {
  if (typeof requestRpc !== "function") throw new Error("A public RPC requester is required.");

  const entriesByUrl = new Map();
  for (const [kind, rpcName] of Object.entries(PUBLIC_RPC_BY_KIND)) {
    let cursor = null;
    const seenCursors = new Set();

    for (let page = 0; page < MAX_PAGES_PER_KIND; page += 1) {
      const rawPayload = await requestRpc(rpcName, {
        p_query: null,
        p_filters: {},
        p_limit: ZAGULYAKY_SITEMAP_PAGE_SIZE,
        p_cursor_published_at: cursor?.publishedAt ?? null,
        p_cursor_id: cursor?.id ?? null,
      });
      const payload = searchPayload(rawPayload);

      for (const item of payload.items) {
        // Do not put title, source, contributor, record id, or any other
        // returned field into the sitemap. A canonical public URL needs only a slug.
        const url = publicZagulyakaUrl(kind, item.slug, siteOrigin);
        entriesByUrl.set(url, {
          kind,
          slug: text(item.slug),
          url,
          item,
        });
      }

      if (!payload.nextCursor) break;
      if (payload.items.length === 0) {
        throw new Error("A public Zagulyaky search RPC returned a cursor without any records.");
      }
      const cursorKey = `${payload.nextCursor.publishedAt}\u0000${payload.nextCursor.id}`;
      if (seenCursors.has(cursorKey)) {
        throw new Error("A public Zagulyaky search RPC repeated a sitemap cursor.");
      }
      seenCursors.add(cursorKey);
      cursor = payload.nextCursor;
    }

    if (cursor && seenCursors.size >= MAX_PAGES_PER_KIND) {
      throw new Error("The Zagulyaky sitemap exceeded the safe pagination limit.");
    }
  }

  return [...entriesByUrl.values()].sort((left, right) => left.url.localeCompare(right.url, "en"));
}

export async function collectPublishedZagulyakyUrls(options) {
  const entries = await collectPublishedZagulyakyEntries(options);
  return entries.map((entry) => entry.url);
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs, random) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const boundedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.min(maxDelayMs, Math.round(exponential * (0.85 + boundedRandom * 0.3)));
}

function retryAfterDelay(response, attempt, baseDelayMs, maxDelayMs, random) {
  const retryAfter = response.headers?.get?.("retry-after")?.trim() ?? "";
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxDelayMs, Math.round(seconds * 1_000));
  }
  const retryAt = Date.parse(retryAfter);
  if (retryAfter && Number.isFinite(retryAt)) {
    return Math.min(maxDelayMs, Math.max(0, retryAt - Date.now()));
  }
  return exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs, random);
}

function delay(delayMs) {
  return delayMs > 0
    ? new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, delayMs))
    : Promise.resolve();
}

function errorMessage(error) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error || "Unknown network error.");
}

async function rpcHttpFailure(response, rpcName, attempts) {
  let diagnostic = "";
  let code = "";
  try {
    const payload = await response.json();
    const row = payload && typeof payload === "object" ? payload : {};
    code = typeof row.code === "string" ? row.code.trim() : "";
    const message = typeof row.message === "string" ? row.message.trim() : "";
    const hint = typeof row.hint === "string" ? row.hint.trim() : "";
    diagnostic = [code, message, hint].filter(Boolean).join(" — ").slice(0, 600);
  } catch {
    // The HTTP status remains useful when a gateway did not return JSON.
  }
  const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
  return {
    code,
    message: `The public ${rpcName} RPC returned HTTP ${response.status}${suffix}${diagnostic ? `: ${diagnostic}` : "."}`,
  };
}

/**
 * Calls only allow-listed, read-only public RPCs. Although PostgREST exposes
 * them as POST requests, replaying these particular list/search calls is safe.
 * Bounded retries bridge short database restarts and schema-cache reloads
 * without hiding permanent authentication, contract, or payload failures.
 */
export async function requestPublicZagulyakyRpc({
  supabaseUrl,
  publishableKey,
  rpcName,
  parameters,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  if (!PUBLIC_ZAGULYAKY_INDEXING_RPCS.includes(rpcName)) {
    throw new Error("The public indexing generator may call only approved public Zagulyaky RPCs.");
  }
  const endpoint = new URL(`/rest/v1/rpc/${rpcName}`, `${supabaseUrl}/`);
  const maxAttempts = boundedInteger(
    retryOptions.maxAttempts,
    DEFAULT_ZAGULYAKY_RPC_MAX_ATTEMPTS,
    1,
    10,
  );
  const baseDelayMs = boundedInteger(
    retryOptions.baseDelayMs,
    DEFAULT_ZAGULYAKY_RPC_RETRY_BASE_DELAY_MS,
    0,
    60_000,
  );
  const maxDelayMs = boundedInteger(
    retryOptions.maxDelayMs,
    Math.max(baseDelayMs, DEFAULT_ZAGULYAKY_RPC_RETRY_MAX_DELAY_MS),
    baseDelayMs,
    60_000,
  );
  const timeoutMs = boundedInteger(
    retryOptions.timeoutMs,
    DEFAULT_ZAGULYAKY_RPC_TIMEOUT_MS,
    1_000,
    120_000,
  );
  const sleep = typeof retryOptions.sleep === "function" ? retryOptions.sleep : delay;
  const random = typeof retryOptions.random === "function" ? retryOptions.random : Math.random;
  const onRetry = typeof retryOptions.onRetry === "function" ? retryOptions.onRetry : () => undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${publishableKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = errorMessage(error).slice(0, 600);
      if (attempt === maxAttempts) {
        throw new Error(`The public ${rpcName} RPC request failed after ${attempt} attempts: ${reason}`, { cause: error });
      }
      const delayMs = exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry({ rpcName, attempt, maxAttempts, delayMs, reason });
      await sleep(delayMs);
      continue;
    }

    if (!response.ok) {
      const failure = await rpcHttpFailure(response, rpcName, attempt);
      // A database statement timeout is deterministic for this page shape.
      // Replaying it six times only keeps PostgreSQL busy and delays the safe
      // catalogue fallback used by the static renderer.
      const databaseStatementTimeout = failure.code === "57014";
      const retryable = !databaseStatementTimeout && (
        TRANSIENT_HTTP_STATUSES.has(response.status)
        || TRANSIENT_POSTGREST_CODES.has(failure.code)
      );
      if (!retryable || attempt === maxAttempts) throw new Error(failure.message);
      const delayMs = retryAfterDelay(response, attempt, baseDelayMs, maxDelayMs, random);
      onRetry({ rpcName, attempt, maxAttempts, delayMs, reason: failure.message });
      await sleep(delayMs);
      continue;
    }

    try {
      return await response.json();
    } catch {
      throw new Error(`The public ${rpcName} RPC did not return JSON.`);
    }
  }

  throw new Error(`The public ${rpcName} RPC exhausted its retry budget.`);
}

export function writeSitemapAtomically(outputPath, contents) {
  const target = resolve(outputPath);
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, target);
  return target;
}

export async function generateZagulyakySitemap({
  requestRpc,
  outputPath = DEFAULT_ZAGULYAKY_SITEMAP_OUTPUT,
  siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN,
}) {
  const urls = await collectPublishedZagulyakyUrls({ requestRpc, siteOrigin });
  const output = writeSitemapAtomically(outputPath, renderZagulyakySitemap(urls));
  return { output, count: urls.length, urls };
}

export function parseSitemapArguments(argumentsList) {
  let outputPath = DEFAULT_ZAGULYAKY_SITEMAP_OUTPUT;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires an XML file path.");
      outputPath = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true, outputPath };
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, outputPath };
}

export async function main({ argumentsList = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const options = parseSitemapArguments(argumentsList);
  if (options.help) {
    log("Usage: node scripts/generate-zagulyaky-sitemap.mjs [--output dist/sitemap-zagulyaky.xml]");
    return null;
  }

  const config = readSitemapEnvironment(env);
  const result = await generateZagulyakySitemap({
    outputPath: options.outputPath,
    requestRpc: (rpcName, parameters) => requestPublicZagulyakyRpc({
      ...config,
      rpcName,
      parameters,
      retryOptions: {
        onRetry: ({ attempt, maxAttempts, delayMs, reason }) => log(
          `Retrying public ${rpcName} RPC after a transient failure (${attempt}/${maxAttempts}); waiting ${delayMs} ms. ${reason}`,
        ),
      },
    }),
  });
  log(`Generated ${result.count} public Zagulyaky detail URL(s) in ${result.output}.`);
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown sitemap generation error.";
    console.error(`Zagulyaky sitemap generation failed: ${message}`);
    process.exitCode = 1;
  });
}
