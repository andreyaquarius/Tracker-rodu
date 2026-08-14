import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";
import {
  parseProductAnalyticsPayload,
  PRODUCT_ANALYTICS_CONSENT_VERSION,
} from "./payload.ts";

const MAX_REQUEST_BYTES = 32 * 1024;

function environment() {
  return {
    SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
    SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS"),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  };
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
  const raw = Deno.env.get("ALLOWED_ORIGINS")?.trim()
    || Deno.env.get("ALLOWED_ORIGIN")?.trim()
    || Deno.env.get("APP_URL")?.trim()
    || "https://trekerrodu.com.ua";
  return new Set(raw.split(",").map(normalizeOrigin).filter(Boolean));
}

function requestOriginAllowed(request: Request): boolean {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return true;
  const allowed = allowedOrigins();
  return allowed.has("*") || allowed.has(normalizeOrigin(requestOrigin));
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const normalized = origin ? normalizeOrigin(origin) : "";
  const allowed = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.has("*") ? "*" : (allowed.has(normalized) ? normalized : "null"),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function actorKeyFor(userId: string): Promise<string> {
  const secret = Deno.env.get("ANALYTICS_HASH_SECRET")?.trim()
    || Deno.env.get("ENCRYPTION_KEY")?.trim()
    || "";
  if (!secret) throw new Error("ANALYTICS_HASH_SECRET_MISSING");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`treker-rodu:product-analytics:v1:${userId}`),
  );
  return hex(new Uint8Array(signature));
}

Deno.serve(async (request) => {
  if (!requestOriginAllowed(request)) return json(request, { error: "Origin is not allowed." }, 403);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json(request, { error: "Request is too large." }, 413);
  }

  const authorization = request.headers.get("Authorization")?.trim() || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const publishableKey = resolveSupabasePublishableKey(environment());
  const secretKey = resolveSupabaseSecretKey(environment());
  if (!authorization || !supabaseUrl || !publishableKey) {
    return json(request, { error: "Authentication required." }, 401);
  }
  if (!secretKey) return json(request, { error: "Analytics service is not configured." }, 503);

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData.user;
  if (userError || !user) return json(request, { error: "Authentication required." }, 401);

  let rawPayload: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return json(request, { error: "Request is too large." }, 413);
    }
    rawPayload = JSON.parse(rawBody);
  } catch {
    return json(request, { error: "Invalid analytics payload." }, 400);
  }
  const parsed = parseProductAnalyticsPayload(rawPayload);
  if (!parsed.ok) return json(request, { error: parsed.error }, 400);

  const { data: consent, error: consentError } = await userClient
    .rpc("get_my_product_analytics_consent");
  const consentRecord = consent && typeof consent === "object" && !Array.isArray(consent)
    ? consent as Record<string, unknown>
    : null;
  if (consentError
    || consentRecord?.granted !== true
    || Number(consentRecord.consentVersion) !== PRODUCT_ANALYTICS_CONSENT_VERSION) {
    return json(request, { error: "Analytics consent is not active." }, 403);
  }

  const { data: context } = await userClient.rpc("get_my_subscription_context", {
    p_project_id: null,
  });
  const contextRecord = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {};

  let actorKey: string;
  try {
    actorKey = await actorKeyFor(user.id);
  } catch {
    return json(request, { error: "Analytics service is not configured." }, 503);
  }

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false },
    global: { headers: supabaseServerKeyHeaders(secretKey) },
  });
  const payload = parsed.value;
  const { data, error } = await adminClient.rpc("ingest_product_analytics_batch", {
    p_actor_key_hex: actorKey,
    p_session_id: payload.sessionId,
    p_is_internal: contextRecord.isAdmin === true,
    p_plan_code: typeof contextRecord.effectivePlanCode === "string"
      ? contextRecord.effectivePlanCode
      : null,
    p_device_class: payload.deviceClass,
    p_viewport_bucket: payload.viewportBucket,
    p_app_version: payload.appVersion,
    p_consent_version: payload.consentVersion,
    p_events: payload.events,
  });
  if (error) {
    const rateLimited = String(error.message || "").includes("ANALYTICS_RATE_LIMIT");
    return json(request, { error: rateLimited ? "Too many requests." : "Analytics event was not accepted." }, rateLimited ? 429 : 400);
  }

  return json(request, { accepted: true, result: data });
});
