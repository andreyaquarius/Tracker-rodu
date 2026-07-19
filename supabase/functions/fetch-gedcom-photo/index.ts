import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveSupabasePublishableKey } from "../_shared/supabaseApiKeys.ts";
import {
  GEDCOM_PHOTO_MAX_BYTES,
  GEDCOM_PHOTO_MAX_REDIRECTS,
  GedcomPhotoSourceValidationError,
  isGedcomPhotoRedirectStatus,
  resolveGedcomPhotoRedirect,
  validateGedcomPhotoSource,
} from "./security.ts";

const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const ORIGINAL_CONTENT_TYPE_HEADER = "X-Gedcom-Photo-Content-Type";

class PhotoProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PhotoProxyError";
  }
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return "";
  }
}

function configuredAppOrigins(): Set<string> {
  return new Set(
    [Deno.env.get("APP_URL"), Deno.env.get("ALLOWED_ORIGIN")]
      .flatMap((value) => (value ?? "").split(","))
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

function requestOrigin(request: Request): string {
  return normalizeOrigin(request.headers.get("Origin") ?? "");
}

function isLoopbackDevelopmentOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string): boolean {
  return configuredAppOrigins().has(origin) || isLoopbackDevelopmentOrigin(origin);
}

function isAllowedBrowserOrigin(request: Request): boolean {
  const origin = requestOrigin(request);
  if (!origin) return true;
  return isAllowedOrigin(origin);
}

function corsHeadersForRequest(request: Request): Record<string, string> {
  const origin = requestOrigin(request);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": ORIGINAL_CONTENT_TYPE_HEADER,
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function responseHeaders(request: Request): Record<string, string> {
  return {
    ...corsHeadersForRequest(request),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? "";
}

async function requireAuthenticatedUser(request: Request): Promise<void> {
  const accessToken = bearerToken(request);
  if (!accessToken) {
    throw new PhotoProxyError(401, "AUTH_REQUIRED", "Потрібна авторизація.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const publishableKey = resolveSupabasePublishableKey({
    SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  });
  if (!supabaseUrl || !publishableKey) {
    throw new PhotoProxyError(
      500,
      "SERVER_CONFIGURATION_MISSING",
      "Серверна функція налаштована неповністю.",
    );
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new PhotoProxyError(401, "AUTH_INVALID", "Не вдалося підтвердити користувача.");
  }
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES) {
    throw new PhotoProxyError(413, "REQUEST_TOO_LARGE", "Запит завеликий.");
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > MAX_REQUEST_BYTES) {
        await reader.cancel("request-size-limit").catch(() => undefined);
        throw new PhotoProxyError(413, "REQUEST_TOO_LARGE", "Запит завеликий.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = concatenateChunks(chunks, received);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PhotoProxyError(400, "REQUEST_INVALID", "Некоректний JSON-запит.");
  }
}

async function fetchAllowedPhoto(initialUrl: URL, signal: AbortSignal): Promise<Response> {
  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "Accept": "image/*",
        "User-Agent": "TrackerRodu-GedcomPhotoProxy/1.0",
      },
    });

    if (!isGedcomPhotoRedirectStatus(response.status)) return response;
    if (redirectCount >= GEDCOM_PHOTO_MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new PhotoProxyError(502, "REDIRECT_LIMIT", "Джерело зробило забагато перенаправлень.");
    }

    const location = response.headers.get("location") ?? "";
    await response.body?.cancel().catch(() => undefined);
    try {
      currentUrl = resolveGedcomPhotoRedirect(currentUrl, location);
    } catch {
      throw new PhotoProxyError(400, "REDIRECT_NOT_ALLOWED", "Джерело перенаправило запит на недозволену адресу.");
    }
    redirectCount += 1;
  }
}

async function readBoundedImage(response: Response): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > GEDCOM_PHOTO_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PhotoProxyError(413, "PHOTO_TOO_LARGE", "Фотографія перевищує дозволені 25 МБ.");
  }
  if (!response.body) {
    throw new PhotoProxyError(502, "EMPTY_RESPONSE", "Джерело не повернуло файл.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > GEDCOM_PHOTO_MAX_BYTES) {
        await reader.cancel("photo-size-limit").catch(() => undefined);
        throw new PhotoProxyError(413, "PHOTO_TOO_LARGE", "Фотографія перевищує дозволені 25 МБ.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!received) {
    throw new PhotoProxyError(502, "EMPTY_RESPONSE", "Джерело повернуло порожній файл.");
  }
  return concatenateChunks(chunks, received);
}

function concatenateChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

Deno.serve(async (request) => {
  if (!isAllowedBrowserOrigin(request)) {
    return json(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    await requireAuthenticatedUser(request);
    const input = await readBoundedJson(request);
    const sourceUrl = validateGedcomPhotoSource(input.url);
    const upstream = await fetchAllowedPhoto(sourceUrl, timeoutController.signal);

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      const unavailable = [401, 403, 404, 410].includes(upstream.status);
      throw new PhotoProxyError(
        unavailable ? 410 : 502,
        unavailable ? "PHOTO_SOURCE_EXPIRED" : "PHOTO_SOURCE_FAILED",
        unavailable
          ? "Зовнішнє посилання на фотографію більше недоступне."
          : "Зовнішнє джерело не повернуло фотографію.",
      );
    }

    const contentType = upstream.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLocaleLowerCase("en-US") ?? "";
    if (!contentType.startsWith("image/")) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new PhotoProxyError(415, "PHOTO_TYPE_INVALID", "Джерело повернуло не зображення.");
    }

    const body = await readBoundedImage(upstream);
    return new Response(body, {
      status: 200,
      headers: {
        ...responseHeaders(request),
        // supabase-js decodes application/octet-stream as Blob. The validated
        // upstream image MIME remains available in a CORS-exposed header so
        // the browser can restore it before Google Drive validation/upload.
        "Content-Type": "application/octet-stream",
        [ORIGINAL_CONTENT_TYPE_HEADER]: contentType,
        "Content-Length": String(body.byteLength),
      },
    });
  } catch (error) {
    if (error instanceof PhotoProxyError) {
      return json(request, { error: error.code, message: error.message }, error.status);
    }
    if (error instanceof GedcomPhotoSourceValidationError) {
      return json(request, { error: error.code, message: error.message }, 400);
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return json(request, { error: "PHOTO_SOURCE_TIMEOUT", message: "Джерело не відповіло вчасно." }, 504);
    }
    return json(
      request,
      { error: "PHOTO_PROXY_FAILED", message: "Не вдалося отримати фотографію із зовнішнього джерела." },
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
});
