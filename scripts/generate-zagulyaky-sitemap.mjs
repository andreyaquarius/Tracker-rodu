import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ZAGULYAKY_SITEMAP_ORIGIN = "https://trekerrodu.com.ua";
export const DEFAULT_ZAGULYAKY_SITEMAP_OUTPUT = "dist/sitemap-zagulyaky.xml";
export const ZAGULYAKY_SITEMAP_PAGE_SIZE = 50;
const MAX_PAGES_PER_KIND = 20_000;

const PUBLIC_RPC_BY_KIND = Object.freeze({
  person: "search_zagulyaky_people_v1",
  document: "search_zagulyaky_documents_v1",
});

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

  url.pathname = `/zahuliaky/${kind === "person" ? "people" : "documents"}/${encodeURIComponent(slug)}`;
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

export async function collectPublishedZagulyakyUrls({ requestRpc, siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN }) {
  if (typeof requestRpc !== "function") throw new Error("A public RPC requester is required.");

  const urls = [];
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
        urls.push(publicZagulyakaUrl(kind, item.slug, siteOrigin));
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

  return [...new Set(urls)].sort((left, right) => left.localeCompare(right, "en"));
}

export async function requestPublicZagulyakyRpc({ supabaseUrl, publishableKey, rpcName, parameters, fetchImpl = fetch }) {
  if (!Object.values(PUBLIC_RPC_BY_KIND).includes(rpcName)) {
    throw new Error("The sitemap generator may call only public Zagulyaky search RPCs.");
  }
  const endpoint = new URL(`/rest/v1/rpc/${rpcName}`, `${supabaseUrl}/`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parameters),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`The public ${rpcName} RPC returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`The public ${rpcName} RPC did not return JSON.`);
  }
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
