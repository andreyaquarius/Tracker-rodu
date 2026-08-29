import { createClient } from "npm:@supabase/supabase-js@2";
import {
  NOMINATIM_PROVIDER,
  nominatimReverseCacheKey,
  nominatimSearchCacheKey,
} from "./contract.ts";

type CacheEnvelope = {
  hit: boolean;
  payload: unknown;
};

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const NOMINATIM_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const NOMINATIM_MIN_INTERVAL_MS = 1_050;

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function configuredAllowedOrigins(): Set<string> {
  const values = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = new Set(values);
  for (const origin of localDevOrigins) origins.add(origin);
  if (!origins.size) origins.add("*");
  return origins;
}

function corsHeadersForRequest(request: Request): HeadersInit {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowedOrigins = configuredAllowedOrigins();
  const allowOrigin = allowedOrigins.has("*")
    ? "*"
    : origin && allowedOrigins.has(origin)
      ? origin
      : [...allowedOrigins][0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

type NominatimResult = {
  place_id?: number | string;
  osm_id?: number | string;
  osm_type?: string;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  address?: Record<string, string>;
};

function stableExternalId(item: NominatimResult): string {
  const osmId = item.osm_id == null ? "" : String(item.osm_id).trim();
  const prefix = ({
    node: "N",
    way: "W",
    relation: "R",
  } as Record<string, string | undefined>)[String(item.osm_type ?? "").trim().toLowerCase()];
  if (prefix && osmId) return `${prefix}${osmId}`;
  const placeId = item.place_id == null ? "" : String(item.place_id).trim();
  return placeId;
}

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersForRequest(request), "Content-Type": "application/json" },
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

function placeLabel(address: Record<string, string> | undefined, fallback: string): string {
  if (!address) return fallback;
  return [
    address.village,
    address.hamlet,
    address.town,
    address.city,
    address.municipality,
    address.county,
    address.state,
  ].find((value) => typeof value === "string" && value.trim()) ?? fallback;
}

function mapNominatimResults(
  data: NominatimResult[],
  normalized: string,
  settlementOnly = false,
) {
  return data
    .map((item) => {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const label = item.name || item.display_name || normalized;
      const externalId = stableExternalId(item);
      return {
        id: externalId || `${latitude}:${longitude}`,
        label,
        details: placeDetails(item.address) || item.display_name || "",
        geo: {
          displayName: item.display_name || label,
          latitude,
          longitude,
          source: "search",
          precision: settlementOnly || (item.type !== "house" && item.class !== "building")
            ? "settlement"
            : "exact",
          provider: "OpenStreetMap Nominatim",
          externalId: externalId || null,
        },
      };
    })
    .filter(Boolean);
}

function mapNominatimReverseResult(
  item: NominatimResult,
  latitude: number,
  longitude: number,
  settlementOnly = false,
) {
  // For a catalogue settlement we save Nominatim's own point, never the
  // arbitrary raw map click used to look it up.
  const resultLatitude = settlementOnly ? Number(item.lat) : latitude;
  const resultLongitude = settlementOnly ? Number(item.lon) : longitude;
  if (!Number.isFinite(resultLatitude) || !Number.isFinite(resultLongitude)) return null;
  const label = placeLabel(item.address, item.name || item.display_name || "Позначка на карті");
  const externalId = stableExternalId(item);
  return {
    id: externalId || `${resultLatitude}:${resultLongitude}`,
    label,
    details: placeDetails(item.address) || item.display_name || "",
    geo: {
      displayName: item.display_name || label,
      latitude: resultLatitude,
      longitude: resultLongitude,
      source: settlementOnly ? "search" : "map_click",
      precision: settlementOnly
        ? "settlement"
        : item.type === "house" || item.class === "building"
          ? "exact"
          : "approximate",
      provider: "OpenStreetMap Nominatim",
      externalId: externalId || null,
    },
  };
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function cacheEnvelope(value: unknown): CacheEnvelope {
  const row = firstRow(value);
  if (!row) return { hit: false, payload: null };
  const payload = row.payload ?? row.result ?? row.value ?? null;
  const hit = row.hit === true || row.found === true || payload !== null;
  return { hit, payload };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function acquireNominatimSlot(admin: ReturnType<typeof createClient>): Promise<void> {
  const { data, error } = await admin.rpc("acquire_historical_place_provider_slot_v1", {
    p_provider: NOMINATIM_PROVIDER,
    p_min_interval_ms: NOMINATIM_MIN_INTERVAL_MS,
  });
  if (error) throw error;
  const row = firstRow(data);
  const waitMs = Number(row?.wait_ms ?? row?.waitMs ?? data ?? 0);
  if (Number.isFinite(waitMs) && waitMs > 12_000) {
    throw new Error("Nominatim provider queue is busy");
  }
  if (Number.isFinite(waitMs) && waitMs > 0) await wait(waitMs);
}

async function cachedNominatimRequest(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  sourceUrl: string,
  operation: "search" | "reverse",
  loader: () => Promise<unknown>,
): Promise<unknown> {
  const { data: cached, error: cacheError } = await admin.rpc(
    "get_historical_place_discovery_cache_v1",
    { p_provider: NOMINATIM_PROVIDER, p_cache_key: cacheKey },
  );
  if (cacheError) throw cacheError;
  const envelope = cacheEnvelope(cached);
  if (envelope.hit) return envelope.payload;

  await acquireNominatimSlot(admin);
  const payload = await loader();
  const { error: writeError } = await admin.rpc(
    "put_historical_place_discovery_cache_v1",
    {
      p_provider: NOMINATIM_PROVIDER,
      p_cache_key: cacheKey,
      p_payload: payload,
      p_ttl_seconds: NOMINATIM_CACHE_TTL_SECONDS,
      p_source_url: sourceUrl,
      p_metadata: { consumer: "search-places", operation },
    },
  );
  if (writeError) throw writeError;
  return payload;
}

async function fetchNominatim(url: string): Promise<unknown> {
  const appUrl = Deno.env.get("APP_URL")?.trim() || "https://trekerrodu.com.ua";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Accept-Language": "uk",
        "User-Agent": `TrekerRodu/1.0 (${appUrl}; search-places)`,
      },
    });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requireAuthenticatedUser(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("Потрібна авторизація.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Налаштування серверної функції неповні.");
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Не вдалося підтвердити користувача.");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersForRequest(request) });
  }
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  try {
    const admin = await requireAuthenticatedUser(request);
    const { query, latitude, longitude, settlementOnly } = await request.json() as {
      query?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      settlementOnly?: unknown;
    };
    const reverseLatitude = Number(latitude);
    const reverseLongitude = Number(longitude);
    const canonicalSettlement = settlementOnly === true;

    if (isValidCoordinate(reverseLatitude, reverseLongitude)) {
      const params = new URLSearchParams({
        lat: String(reverseLatitude),
        lon: String(reverseLongitude),
        format: "jsonv2",
        addressdetails: "1",
        zoom: canonicalSettlement ? "15" : "18",
        "accept-language": "uk",
      });
      if (canonicalSettlement) params.set("layer", "address");

      const sourceUrl = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
      const data = await cachedNominatimRequest(
        admin,
        nominatimReverseCacheKey(reverseLatitude, reverseLongitude, canonicalSettlement),
        sourceUrl,
        "reverse",
        () => fetchNominatim(sourceUrl),
      ) as NominatimResult;
      return json(request, {
        place: mapNominatimReverseResult(
          data,
          reverseLatitude,
          reverseLongitude,
          canonicalSettlement,
        ),
      });
    }

    const normalized = typeof query === "string" ? query.trim() : "";
    if (normalized.length < 3) return json(request, { suggestions: [] });
    if (normalized.length > 120) {
      return json(request, { error: "Назва місця занадто довга." }, 400);
    }

    const params = new URLSearchParams({
      q: normalized,
      format: "jsonv2",
      addressdetails: "1",
      limit: "7",
      "accept-language": "uk",
    });
    if (canonicalSettlement) {
      params.set("featureType", "settlement");
      params.set("namedetails", "1");
      params.set("extratags", "1");
    }

    const sourceUrl = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const data = await cachedNominatimRequest(
      admin,
      nominatimSearchCacheKey(normalized, canonicalSettlement),
      sourceUrl,
      "search",
      () => fetchNominatim(sourceUrl),
    ) as NominatimResult[];
    return json(request, {
      suggestions: mapNominatimResults(data, normalized, canonicalSettlement),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("search-places failed", message);
    if (message === "Потрібна авторизація." || message === "Не вдалося підтвердити користувача.") {
      return json(request, { error: message }, 401);
    }
    if (message === "Налаштування серверної функції неповні.") {
      return json(request, { error: message }, 500);
    }
    return json(request, { error: "Сервіс пошуку місць тимчасово недоступний." }, 502);
  }
});
