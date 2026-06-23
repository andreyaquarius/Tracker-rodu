import { createClient } from "npm:@supabase/supabase-js@2";

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
    "*",
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin(),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

type NominatimResult = {
  place_id?: number | string;
  osm_id?: number | string;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  address?: Record<string, string>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function placeDetails(address: Record<string, string> | undefined): string {
  if (!address) return "";
  return [
    address.village,
    address.town,
    address.city,
    address.municipality,
    address.county,
    address.state,
    address.country,
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(", ");
}

function mapNominatimResults(data: NominatimResult[], normalized: string) {
  return data
    .map((item) => {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const label = item.name || item.display_name || normalized;
      return {
        id: String(item.place_id ?? item.osm_id ?? `${latitude}:${longitude}`),
        label,
        details: placeDetails(item.address) || item.display_name || "",
        geo: {
          displayName: item.display_name || label,
          latitude,
          longitude,
          source: "search",
          precision: item.type === "house" || item.class === "building" ? "exact" : "settlement",
          provider: "OpenStreetMap Nominatim",
          externalId: String(item.place_id ?? item.osm_id ?? ""),
        },
      };
    })
    .filter(Boolean);
}

async function requireAuthenticatedUser(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("Потрібна авторизація.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Налаштування серверної функції неповні.");

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Не вдалося підтвердити користувача.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    await requireAuthenticatedUser(request);
    const { query } = await request.json() as { query?: unknown };
    const normalized = typeof query === "string" ? query.trim() : "";
    if (normalized.length < 3) return json({ suggestions: [] });
    if (normalized.length > 120) return json({ error: "Назва місця занадто довга." }, 400);

    const params = new URLSearchParams({
      q: normalized,
      format: "jsonv2",
      addressdetails: "1",
      limit: "7",
      "accept-language": "uk",
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const appUrl = Deno.env.get("APP_URL")?.trim() || "https://trekerrodu.com.ua";
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Language": "uk",
          "User-Agent": `Trekerrodu/1.0 (${appUrl})`,
        },
      });
      if (!response.ok) {
        return json({ error: "Сервіс пошуку місць тимчасово недоступний." }, 502);
      }
      const data = await response.json() as NominatimResult[];
      return json({ suggestions: mapNominatimResults(data, normalized) });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : "Не вдалося знайти місце.";
    return json({ error: message }, 400);
  }
});
