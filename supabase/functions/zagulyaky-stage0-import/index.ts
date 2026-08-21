import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";

// This endpoint deliberately accepts the exported Facebook JSON as its *raw*
// request body. Its SHA-256 therefore proves the exact bytes supplied by the
// operator rather than a re-serialized wrapper object.
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_POSTS = 5_000;
// Keep the client chunk width identical to the database provenance offset
// (`chunk_index * 250`) and its contract maximum.
const CHUNK_SIZE = 250;
const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

type ImportMode = "dry_run" | "commit";

type JsonObject = Record<string, unknown>;

type NormalizedAttachment = {
  sourceUrl: string | null;
  facebookUrl: string | null;
  facebookPhotoId: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
};

type NormalizedLink = {
  rawUrl: string;
  normalizedUrl: string | null;
  label: string | null;
  linkKind:
    | "facebook_profile"
    | "facebook_photo"
    | "facebook_group"
    | "facebook_hashtag"
    | "facebook_other"
    | "external_redirect"
    | "external"
    | "other";
  requiresSafeFetch: boolean;
};

type NormalizedItem = {
  inputError: string | null;
  externalId: string;
  sourceUrl: string | null;
  sourceCollectionUrl: string | null;
  sourceAuthorLabel: string | null;
  sourceDateText: string | null;
  sourcePublishedAt: string | null;
  sourceDatePrecision: "exact" | "unknown";
  rawText: string | null;
  rawPayload: JsonObject;
  scrapedAt: string | null;
  collectedAt: string | null;
  sourceUpdatedAt: string | null;
  candidateYears: number[];
  declaredAttachmentCount: number;
  normalizedTextSha256: string | null;
  sourceIncomplete: boolean;
  textTruncated: boolean;
  requiresOcr: boolean;
  requiresSourceRefetch: boolean;
  missingAuthor: boolean;
  missingPublicationDate: boolean;
  suspectedDuplicate: boolean;
  possibleLivingPerson: boolean;
  quarantined: boolean;
  attachments: NormalizedAttachment[];
  links: NormalizedLink[];
};

class RequestProblem extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function allowedOrigins(): Set<string> {
  const configured = [
    Deno.env.get("ALLOWED_ORIGINS"),
    Deno.env.get("ALLOWED_ORIGIN"),
    Deno.env.get("APP_URL"),
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const allowed = new Set(configured);
  for (const origin of localDevOrigins) allowed.add(origin);
  return allowed;
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins();
  return allowed.has("*") || allowed.has(normalizeOrigin(origin));
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins();
  const normalized = origin ? normalizeOrigin(origin) : "";
  return {
    "Access-Control-Allow-Origin": allowed.has("*")
      ? "*"
      : allowed.has(normalized)
      ? normalized
      : "null",
    "Access-Control-Allow-Headers": [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-zagulyaky-import-mode",
      "x-zagulyaky-source-file-name",
      "x-zagulyaky-source-checksum",
    ].join(", "),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  if (value.includes("\u0000") || value.length > maximum) return null;
  return value;
}

function trimString(value: unknown, maximum: number): string | null {
  const candidate = string(value, maximum);
  const trimmed = candidate?.trim() ?? "";
  return trimmed || null;
}

function httpUrl(value: unknown): string | null {
  const candidate = trimString(value, 4_000);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function timestamp(value: unknown): string | null {
  const candidate = trimString(value, 100);
  if (!candidate) return null;
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function uniqueCandidateYears(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const years = value
    .map((entry) => integer(entry, 1, 2_200))
    .filter((entry): entry is number => entry !== null);
  return [...new Set(years)].slice(0, 50);
}

function hasNul(value: unknown): boolean {
  // Do not use JSON.stringify() for this check. JSON serialisation turns an
  // actual U+0000 into the six printable characters "\\u0000", which made
  // the former check miss it. PostgreSQL rejects that character in jsonb, so
  // it must never reach the RPC payload, including through an unmodelled
  // field retained in rawPayload.
  try {
    const pending: unknown[] = [value];
    const visited = new Set<object>();

    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === "string") {
        if (current.includes("\u0000")) return true;
        continue;
      }
      if (!current || typeof current !== "object") continue;
      if (visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (const entry of current) pending.push(entry);
        continue;
      }

      // JSON object keys are stored in rawPayload too, so inspect them as
      // well as their values. This is iterative to remain safe for a deeply
      // nested but valid Facebook export.
      for (const [key, entry] of Object.entries(current)) {
        if (key.includes("\u0000")) return true;
        pending.push(entry);
      }
    }
    return false;
  } catch {
    // The request body is JSON, but fail closed if an unexpected value cannot
    // be safely walked rather than allowing it into the database payload.
    return true;
  }
}

function deriveFacebookPhotoId(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const candidate = parsed.searchParams.get("fbid") ?? parsed.searchParams.get("photo_id");
    return candidate && /^\d{1,64}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function normalizeAttachments(value: unknown): { attachments: NormalizedAttachment[]; error: string | null } {
  if (value == null) return { attachments: [], error: null };
  if (!Array.isArray(value)) return { attachments: [], error: "INVALID_IMAGES_ARRAY" };
  if (value.length > 1_000) return { attachments: [], error: "TOO_MANY_IMAGES" };

  const attachments: NormalizedAttachment[] = [];
  for (const entry of value) {
    const image = object(entry);
    if (!image) continue;
    const sourceUrl = httpUrl(image.url);
    const facebookUrl = httpUrl(image.facebookUrl);
    attachments.push({
      sourceUrl,
      facebookUrl,
      facebookPhotoId: deriveFacebookPhotoId(facebookUrl) ?? deriveFacebookPhotoId(sourceUrl),
      alt: string(image.alt, 10_000),
      width: integer(image.width, 1, 100_000),
      height: integer(image.height, 1, 100_000),
    });
  }
  return { attachments, error: null };
}

function facebookLinkKind(parsed: URL): NormalizedLink["linkKind"] {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const isFacebookHost = host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com";
  if (!isFacebookHost) return "external";
  if (path.includes("hashtag")) return "facebook_hashtag";
  if (path.includes("photo")) return "facebook_photo";
  if (path.includes("groups")) return "facebook_group";
  if (path.includes("profile") || parsed.searchParams.has("id")) return "facebook_profile";
  return "facebook_other";
}

function normalizeLink(value: unknown): NormalizedLink | null {
  const link = object(value);
  if (!link) return null;
  const rawUrl = httpUrl(link.url);
  if (!rawUrl) return null;
  const label = string(link.label, 2_000);
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete("fbclid");
    const host = parsed.hostname.toLowerCase();
    if ((host === "l.facebook.com" || host === "lm.facebook.com") && parsed.pathname === "/l.php") {
      const target = httpUrl(parsed.searchParams.get("u"));
      return {
        rawUrl,
        normalizedUrl: target,
        label,
        linkKind: "external_redirect",
        requiresSafeFetch: Boolean(target),
      };
    }
    const linkKind = facebookLinkKind(parsed);
    return {
      rawUrl,
      normalizedUrl: parsed.toString(),
      label,
      linkKind,
      requiresSafeFetch: linkKind === "external",
    };
  } catch {
    return null;
  }
}

function normalizeLinks(value: unknown): { links: NormalizedLink[]; error: string | null } {
  if (value == null) return { links: [], error: null };
  if (!Array.isArray(value)) return { links: [], error: "INVALID_LINKS_ARRAY" };
  if (value.length > 2_000) return { links: [], error: "TOO_MANY_LINKS" };
  const links = value.map(normalizeLink).filter((link): link is NormalizedLink => Boolean(link));
  return { links, error: null };
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/\s+/g, " ")
    .trim();
}

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return hexadecimal(await crypto.subtle.digest("SHA-256", bytes));
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function normalizePost(value: unknown): Promise<NormalizedItem> {
  const post = object(value);
  if (!post) {
    return {
      inputError: "INVALID_POST_OBJECT",
      externalId: "",
      sourceUrl: null,
      sourceCollectionUrl: null,
      sourceAuthorLabel: null,
      sourceDateText: null,
      sourcePublishedAt: null,
      sourceDatePrecision: "unknown",
      rawText: null,
      rawPayload: {},
      scrapedAt: null,
      collectedAt: null,
      sourceUpdatedAt: null,
      candidateYears: [],
      declaredAttachmentCount: 0,
      normalizedTextSha256: null,
      sourceIncomplete: true,
      textTruncated: false,
      requiresOcr: false,
      requiresSourceRefetch: false,
      missingAuthor: true,
      missingPublicationDate: true,
      suspectedDuplicate: false,
      possibleLivingPerson: false,
      quarantined: true,
      attachments: [],
      links: [],
    };
  }

  const externalId = trimString(post.postId, 255) ?? "";
  const rawText = string(post.text, 200_000);
  const sourceAuthorLabel = string(post.author, 1_000);
  const attachments = normalizeAttachments(post.images);
  const links = normalizeLinks(post.links);
  const sourcePublishedAt = timestamp(post.publishedAt);
  const embeddedNul = hasNul(post);
  const textTruncated = /(?:…|\.\.\.)\s*більше\b/iu.test(rawText ?? "");
  const sourceIncomplete = !rawText?.trim() && attachments.attachments.length === 0;
  const requiresOcr = attachments.attachments.length > 0 && (!rawText?.trim() || textTruncated);
  const requiresSourceRefetch = textTruncated && attachments.attachments.length === 0;
  const normalized = rawText?.trim() ? normalizedText(rawText) : "";

  const validationError = embeddedNul
    ? "EMBEDDED_NUL_NOT_ALLOWED"
    : !/^[A-Za-z0-9:_-]{1,255}$/.test(externalId)
    ? "INVALID_EXTERNAL_ID"
    : attachments.error ?? links.error;

  return {
    inputError: validationError,
    externalId,
    sourceUrl: httpUrl(post.url),
    sourceCollectionUrl: httpUrl(post.groupUrl),
    sourceAuthorLabel,
    sourceDateText: string(post.dateText, 1_000),
    sourcePublishedAt,
    sourceDatePrecision: sourcePublishedAt ? "exact" : "unknown",
    rawText,
    // A rejected item still travels in its source-order slot so the database
    // can record a per-item error. Never carry the offending raw object with
    // it: PostgreSQL rejects embedded NULs while decoding the RPC jsonb.
    rawPayload: embeddedNul ? {} : post,
    scrapedAt: timestamp(post.scrapedAt),
    collectedAt: timestamp(post.collectedAt),
    sourceUpdatedAt: timestamp(post.updatedAt),
    candidateYears: uniqueCandidateYears(post.years),
    declaredAttachmentCount: integer(post.imageCount, 0, 1_000) ?? attachments.attachments.length,
    normalizedTextSha256: normalized ? await sha256Text(normalized) : null,
    sourceIncomplete,
    textTruncated,
    requiresOcr,
    requiresSourceRefetch,
    missingAuthor: !sourceAuthorLabel?.trim(),
    missingPublicationDate: !sourcePublishedAt,
    suspectedDuplicate: false,
    // This is intentionally never inferred by the importer. A reviewer must
    // decide it later using the project policy and documentary evidence.
    possibleLivingPerson: false,
    quarantined: sourceIncomplete,
    attachments: attachments.attachments,
    links: links.links,
  };
}

function importMode(request: Request): ImportMode {
  const value = request.headers.get("x-zagulyaky-import-mode")?.trim();
  if (value === "dry_run" || value === "commit") return value;
  throw new RequestProblem("INVALID_IMPORT_MODE", 400);
}

function sourceFileName(request: Request): string {
  const value = request.headers.get("x-zagulyaky-source-file-name")?.trim() ?? "";
  if (!value || value.length > 255 || /[\\/\u0000]/u.test(value)) {
    throw new RequestProblem("INVALID_SOURCE_FILE_NAME", 400);
  }
  return value;
}

function requestedChecksum(request: Request): string {
  const value = request.headers.get("x-zagulyaky-source-checksum")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(value)) throw new RequestProblem("INVALID_SOURCE_CHECKSUM", 400);
  return value;
}

function authorizationToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);
  const token = authorization.slice(7).trim();
  if (!token) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);
  return token;
}

function parseExport(value: unknown): { exportedAt: string | null; posts: unknown[] } {
  const candidate = object(value);
  if (!candidate || !Array.isArray(candidate.posts)) throw new RequestProblem("INVALID_FACEBOOK_EXPORT_SHAPE", 400);
  if (candidate.posts.length < 1 || candidate.posts.length > MAX_POSTS) {
    throw new RequestProblem("INVALID_FACEBOOK_POST_COUNT", 400);
  }
  return { exportedAt: timestamp(candidate.exportedAt), posts: candidate.posts };
}

function profileSummary(items: NormalizedItem[]): JsonObject {
  return {
    schemaVersion: 1,
    itemCount: items.length,
    nonObjectCount: items.filter((item) => item.inputError === "INVALID_POST_OBJECT").length,
    textTruncatedCount: items.filter((item) => item.textTruncated).length,
    imageOnlyCount: items.filter((item) => !item.rawText?.trim() && item.attachments.length > 0).length,
    quarantinedCount: items.filter((item) => item.quarantined).length,
    requiresOcrCount: items.filter((item) => item.requiresOcr).length,
    requiresSourceRefetchCount: items.filter((item) => item.requiresSourceRefetch).length,
    missingAuthorCount: items.filter((item) => item.missingAuthor).length,
    missingPublicationDateCount: items.filter((item) => item.missingPublicationDate).length,
    attachmentCount: items.reduce((sum, item) => sum + item.attachments.length, 0),
    linkCount: items.reduce((sum, item) => sum + item.links.length, 0),
  };
}

function commonCollectionUrl(items: NormalizedItem[]): string | null {
  const urls = new Set(items.map((item) => item.sourceCollectionUrl).filter((url): url is string => Boolean(url)));
  return urls.size === 1 ? [...urls][0] ?? null : null;
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * Collapse the database's begin-import failure into a deliberately small,
 * stable public contract. PostgREST may include PostgreSQL messages, details,
 * hints, or RPC argument names in its error object; none of those may leave
 * this Edge Function or appear in its logs.
 */
function safeRpcErrorCode(error: unknown): string {
  const value = record(error).code;
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "";
}

/**
 * Unknown begin-RPC failures may be diagnosed only by an exact database
 * protocol code. PostgreSQL SQLSTATEs are five alphanumeric characters and
 * PostgREST codes use the PGRST + three digits form. Do not promote free-form
 * `code` values: those can be implementation-specific and are not a safe
 * public error contract.
 */
function safeDatabaseDiagnosticCode(code: string): string | null {
  if (/^[0-9A-Z]{5}$/.test(code)) return code;
  if (/^PGRST[0-9]{3}$/.test(code)) return code;
  return null;
}

function hasAdminPermissionMarker(error: unknown): boolean {
  const value = record(error).message;
  // The marker is raised intentionally by the permission gate. Do not return
  // or log the database message; an exact comparison prevents arbitrary text
  // from influencing the public error contract.
  return typeof value === "string" && value.trim() === "ADMIN_PERMISSION_REQUIRED";
}

function beginImportProblem(error: unknown): RequestProblem {
  const code = safeRpcErrorCode(error);
  if (code === "42501" || code === "ADMIN_PERMISSION_REQUIRED" || hasAdminPermissionMarker(error)) {
    return new RequestProblem("IMPORT_PERMISSION_REQUIRED", 403);
  }
  if (code === "PGRST202" || code === "42883" || code === "42P01") {
    return new RequestProblem("IMPORT_BEGIN_RPC_UNAVAILABLE", 503);
  }
  if (code === "22007" || code === "22023" || code === "23514") {
    return new RequestProblem("IMPORT_BEGIN_VALIDATION_FAILED", 422);
  }
  if (code === "23503") {
    return new RequestProblem("IMPORT_BEGIN_REQUESTER_PROFILE_REQUIRED", 409);
  }
  if (code === "23505") {
    return new RequestProblem("IMPORT_BEGIN_CONFLICT", 409);
  }
  const databaseCode = safeDatabaseDiagnosticCode(code);
  if (databaseCode) {
    return new RequestProblem(`IMPORT_BEGIN_DATABASE_ERROR_${databaseCode}`, 422);
  }
  return new RequestProblem("IMPORT_BEGIN_DATABASE_ERROR_UNKNOWN", 422);
}

async function runImport(request: Request): Promise<Response> {
  if (!requestOriginAllowed(request)) return json(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      throw new RequestProblem("REQUEST_TOO_LARGE", 413);
    }
    const mode = importMode(request);
    const fileName = sourceFileName(request);
    const expectedChecksum = requestedChecksum(request);
    const accessToken = authorizationToken(request);
    // `verify_jwt` is deliberately disabled only so browser CORS preflight can
    // reach this handler. Authenticate before reading a potentially 20 MiB
    // export, otherwise an unauthenticated caller could consume parsing work.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
    const publishableKey = resolveSupabasePublishableKey({
      SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
      SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
      SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    });
    const serverKey = resolveSupabaseSecretKey({
      SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
      SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS"),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    });
    if (!supabaseUrl || !publishableKey || !serverKey) {
      throw new RequestProblem("IMPORT_SERVICE_NOT_CONFIGURED", 503);
    }
    const callerClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser(accessToken);
    if (userError || !userData.user) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_REQUEST_BYTES) throw new RequestProblem("REQUEST_TOO_LARGE", 413);
    const actualChecksum = await sha256Bytes(bytes);
    if (actualChecksum !== expectedChecksum) throw new RequestProblem("SOURCE_CHECKSUM_MISMATCH", 422);

    let rawExport: unknown;
    try {
      rawExport = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new RequestProblem("INVALID_FACEBOOK_EXPORT_JSON", 400);
    }
    const exportData = parseExport(rawExport);
    const items: NormalizedItem[] = [];
    for (const post of exportData.posts) items.push(await normalizePost(post));

    // Permission is checked inside the SECURITY DEFINER implementation from
    // the caller's JWT. The service key is used only after that narrow check.
    const { data: beginData, error: beginError } = await callerClient.rpc(
      "admin_begin_zagulyaky_facebook_import_v1",
      {
        p_source_file_name: fileName,
        p_source_checksum: actualChecksum,
        p_source_exported_at: exportData.exportedAt,
        p_source_collection_url: commonCollectionUrl(items),
        p_expected_item_count: items.length,
        p_import_mode: mode,
        p_profile_summary: profileSummary(items),
      },
    );
    if (beginError) {
      throw beginImportProblem(beginError);
    }
    const batch = record(beginData);
    const batchId = typeof batch.batchId === "string" ? batch.batchId : "";
    if (!batchId) throw new RequestProblem("IMPORT_BATCH_REJECTED", 422);
    if (batch.replayed === true) return json(request, { accepted: true, replayed: true, batch }, 200);

    const serverClient = createClient(supabaseUrl, serverKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: supabaseServerKeyHeaders(serverKey) },
    });
    for (let offset = 0, chunkIndex = 0; offset < items.length; offset += CHUNK_SIZE, chunkIndex += 1) {
      const chunk = items.slice(offset, offset + CHUNK_SIZE);
      const checksum = await sha256Text(JSON.stringify(chunk));
      const { error: chunkError } = await serverClient.rpc(
        "service_ingest_zagulyaky_facebook_chunk_v1",
        {
          p_batch_id: batchId,
          p_items: chunk,
          p_import_mode: mode,
          p_chunk_index: chunkIndex,
          p_chunk_checksum: checksum,
        },
      );
      if (chunkError) throw new RequestProblem("IMPORT_CHUNK_REJECTED", 422);
    }
    const { data: finalData, error: finalError } = await serverClient.rpc(
      "service_finalize_zagulyaky_facebook_import_v1",
      { p_batch_id: batchId, p_import_mode: mode },
    );
    if (finalError) throw new RequestProblem("IMPORT_FINALIZATION_FAILED", 422);

    return json(request, { accepted: true, replayed: false, batch: record(finalData) }, 202);
  } catch (error) {
    const problem = error instanceof RequestProblem
      ? error
      : new RequestProblem("STAGE0_IMPORT_FAILED", 500);
    // Never log raw payloads, post text, author labels, CDN URLs, or access tokens.
    console.error("Zagulyaky Stage 0 import failed", { code: problem.code, status: problem.status });
    return json(request, { error: problem.code }, problem.status);
  }
}

Deno.serve(runImport);
