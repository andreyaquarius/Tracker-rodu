import { createClient } from "npm:@supabase/supabase-js@2";
import {
  parseAuthenticatedEngagementPayload,
  type AuthenticatedEngagementPayload,
} from "./payload.ts";

const DEFAULT_MEASUREMENT_ID = "G-SF2725LS4P";
const MAX_REQUEST_BYTES = 1_024;

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function allowedOrigin(): string {
  return normalizeOrigin(
    Deno.env.get("ALLOWED_ORIGIN")?.trim() ||
    Deno.env.get("APP_URL")?.trim() ||
    "https://trekerrodu.com.ua",
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin(),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function requestOriginAllowed(request: Request): boolean {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigin = allowedOrigin();
  if (!requestOrigin || configuredOrigin === "*") return true;
  return normalizeOrigin(requestOrigin) === configuredOrigin;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAuthenticated(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!authorization || !supabaseUrl || !anonKey) return false;

  try {
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data, error } = await supabase.auth.getUser();
    return !error && Boolean(data.user);
  } catch {
    return false;
  }
}

function measurementConfiguration(): { measurementId: string; apiSecret: string } | null {
  const measurementId = Deno.env.get("GA4_MEASUREMENT_ID")?.trim() || DEFAULT_MEASUREMENT_ID;
  const apiSecret = Deno.env.get("GA4_API_SECRET")?.trim() || "";
  if (!/^G-[A-Z0-9]+$/.test(measurementId) || !apiSecret) return null;
  return { measurementId, apiSecret };
}

async function sendToGoogleAnalytics(
  payload: AuthenticatedEngagementPayload,
): Promise<boolean> {
  const configuration = measurementConfiguration();
  if (!configuration) return false;

  const endpoint = new URL("https://region1.google-analytics.com/mp/collect");
  endpoint.searchParams.set("measurement_id", configuration.measurementId);
  endpoint.searchParams.set("api_secret", configuration.apiSecret);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: payload.clientId,
        non_personalized_ads: true,
        events: [{
          name: "authenticated_active_time",
          params: {
            active_seconds: payload.activeSeconds,
            engagement_time_msec: payload.activeSeconds * 1_000,
            session_id: payload.sessionId,
          },
        }],
      }),
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (request) => {
  if (!requestOriginAllowed(request)) {
    return json({ error: "Origin is not allowed." }, 403);
  }
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }
  if (!(await isAuthenticated(request))) {
    return json({ error: "Authentication required." }, 401);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Invalid analytics payload." }, 400);
  }

  const payload = parseAuthenticatedEngagementPayload(input);
  if (!payload.ok) return json({ error: payload.error }, 400);
  if (!measurementConfiguration()) {
    return json({ error: "Analytics service is not configured." }, 503);
  }
  if (!(await sendToGoogleAnalytics(payload.value))) {
    return json({ error: "Analytics service is temporarily unavailable." }, 502);
  }
  return json({ accepted: true });
});
