import type { GeoPoint } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

export interface PlaceSuggestion {
  id: string;
  label: string;
  details: string;
  geo: GeoPoint;
}

/**
 * Ordinary map fields can represent a house or another exact point.  Some
 * catalogue fields instead need a reusable settlement pin, so they opt in to
 * this narrower Nominatim mode explicitly.
 */
export interface PlaceSearchOptions {
  settlementOnly?: boolean;
}

type PlaceSearchResponse = {
  suggestions?: PlaceSuggestion[];
  place?: PlaceSuggestion;
  error?: string;
};

function normalizeSuggestion(value: unknown): PlaceSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const geo = record.geo;
  if (!geo || typeof geo !== "object") return null;
  const geoRecord = geo as Record<string, unknown>;
  const latitude = Number(geoRecord.latitude);
  const longitude = Number(geoRecord.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: String(record.id ?? `${latitude}:${longitude}`),
    label: String(record.label ?? geoRecord.displayName ?? "Місце"),
    details: String(record.details ?? ""),
    geo: {
      displayName: String(geoRecord.displayName ?? record.label ?? "Місце"),
      latitude,
      longitude,
      source: geoRecord.source === "map_click" ? "map_click" : "search",
      precision: ["exact", "approximate", "settlement", "unknown"].includes(String(geoRecord.precision))
        ? String(geoRecord.precision) as GeoPoint["precision"]
        : "settlement",
      provider: String(geoRecord.provider ?? "OpenStreetMap Nominatim"),
      externalId: geoRecord.externalId == null ? null : String(geoRecord.externalId),
      markerColor: typeof geoRecord.markerColor === "string" ? geoRecord.markerColor : undefined,
    },
  };
}

async function searchPlacesViaServer(
  normalized: string,
  settlementOnly = false,
): Promise<PlaceSuggestion[]> {
  const { data, error } = await getSupabaseClient().functions.invoke("search-places", {
    body: { query: normalized, settlementOnly },
  });
  if (error) {
    const context = "context" in error ? error.context : null;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as PlaceSearchResponse;
        if (payload.error) throw new Error(payload.error);
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== "Unexpected end of JSON input") {
          throw contextError;
        }
      }
    }
    throw error;
  }
  const payload = data as PlaceSearchResponse | null;
  if (payload?.error) throw new Error(payload.error);
  return (payload?.suggestions ?? [])
    .map(normalizeSuggestion)
    .filter((item): item is PlaceSuggestion => Boolean(item));
}

async function reversePlaceViaServer(
  latitude: number,
  longitude: number,
  settlementOnly = false,
): Promise<PlaceSuggestion | null> {
  const { data, error } = await getSupabaseClient().functions.invoke("search-places", {
    body: { latitude, longitude, settlementOnly },
  });
  if (error) {
    const context = "context" in error ? error.context : null;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as PlaceSearchResponse;
        if (payload.error) throw new Error(payload.error);
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== "Unexpected end of JSON input") {
          throw contextError;
        }
      }
    }
    throw error;
  }
  const payload = data as PlaceSearchResponse | null;
  if (payload?.error) throw new Error(payload.error);
  return normalizeSuggestion(payload?.place) ?? null;
}

export async function searchPlaces(
  query: string,
  options: PlaceSearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 3) return [];
  const settlementOnly = options.settlementOnly === true;
  try {
    return await searchPlacesViaServer(normalized, settlementOnly);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message && !error.message.includes("Failed to fetch")
        ? error.message
        : "Не вдалося підключитися до пошуку місць. Спробуйте вибрати точку на карті вручну.",
    );
  }
}

export async function reversePlace(
  latitude: number,
  longitude: number,
  options: PlaceSearchOptions = {},
): Promise<PlaceSuggestion | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const settlementOnly = options.settlementOnly === true;
  try {
    return await reversePlaceViaServer(latitude, longitude, settlementOnly);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message && !error.message.includes("Failed to fetch")
        ? error.message
        : "Не вдалося підключитися до пошуку місць. Спробуйте ввести назву вручну.",
    );
  }
}
