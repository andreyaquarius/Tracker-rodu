import type { GeoPoint } from "../types";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseAuth";

export interface PlaceSuggestion {
  id: string;
  label: string;
  details: string;
  geo: GeoPoint;
}

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

type PlaceSearchResponse = {
  suggestions?: PlaceSuggestion[];
  error?: string;
};

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
      precision: geoRecord.precision === "exact" ? "exact" : "settlement",
      provider: String(geoRecord.provider ?? "OpenStreetMap Nominatim"),
      externalId: geoRecord.externalId == null ? null : String(geoRecord.externalId),
      markerColor: typeof geoRecord.markerColor === "string" ? geoRecord.markerColor : undefined,
    },
  };
}

function mapNominatimResults(data: NominatimResult[], normalized: string): PlaceSuggestion[] {
  return data
    .map((item): PlaceSuggestion | null => {
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
    .filter((item): item is PlaceSuggestion => Boolean(item));
}

async function searchPlacesViaServer(normalized: string): Promise<PlaceSuggestion[]> {
  const { data, error } = await getSupabaseClient().functions.invoke("search-places", {
    body: { query: normalized },
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

async function searchPlacesDirectly(normalized: string): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    q: normalized,
    format: "jsonv2",
    addressdetails: "1",
    limit: "7",
    "accept-language": "uk",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Не вдалося знайти місце.");
  }
  const data = await response.json() as NominatimResult[];
  return mapNominatimResults(data, normalized);
}

export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 3) return [];
  try {
    if (isSupabaseConfigured) {
      return await searchPlacesViaServer(normalized);
    }
    return await searchPlacesDirectly(normalized);
  } catch (error) {
    if (!isSupabaseConfigured) {
      throw new Error("Не вдалося підключитися до пошуку місць. Спробуйте вибрати точку на карті вручну.");
    }
    try {
      return await searchPlacesDirectly(normalized);
    } catch {
      throw new Error(
        error instanceof Error && error.message && !error.message.includes("Failed to fetch")
          ? error.message
          : "Не вдалося підключитися до пошуку місць. Спробуйте вибрати точку на карті вручну.",
      );
    }
  }
}
