import type { GeoPoint } from "../types";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseAuth";

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

type PlaceSearchResponse = {
  suggestions?: PlaceSuggestion[];
  place?: PlaceSuggestion;
  error?: string;
};

function placeDetails(address: Record<string, string> | undefined): string {
  if (!address) return "";
  return [
    address.village,
    address.hamlet,
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

function mapNominatimResults(
  data: NominatimResult[],
  normalized: string,
  settlementOnly = false,
): PlaceSuggestion[] {
  return data
    .map((item): PlaceSuggestion | null => {
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
    .filter((item): item is PlaceSuggestion => Boolean(item));
}

function mapNominatimReverseResult(
  item: NominatimResult,
  latitude: number,
  longitude: number,
  settlementOnly = false,
): PlaceSuggestion | null {
  // A settlement result is a catalogue entity.  Its own Nominatim geometry is
  // deliberately retained instead of the arbitrary point that was clicked
  // somewhere within (or near) that settlement.
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

async function searchPlacesDirectly(
  normalized: string,
  settlementOnly = false,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    q: normalized,
    format: "jsonv2",
    addressdetails: "1",
    limit: "7",
    "accept-language": "uk",
  });
  if (settlementOnly) params.set("featureType", "settlement");
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Не вдалося знайти місце.");
  }
  const data = await response.json() as NominatimResult[];
  return mapNominatimResults(data, normalized, settlementOnly);
}

async function reversePlaceDirectly(
  latitude: number,
  longitude: number,
  settlementOnly = false,
): Promise<PlaceSuggestion | null> {
  const params = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    format: "jsonv2",
    addressdetails: "1",
    zoom: settlementOnly ? "15" : "18",
    "accept-language": "uk",
  });
  if (settlementOnly) params.set("layer", "address");
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Не вдалося визначити назву місця.");
  }
  const item = await response.json() as NominatimResult;
  return mapNominatimReverseResult(item, latitude, longitude, settlementOnly);
}

export async function searchPlaces(
  query: string,
  options: PlaceSearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 3) return [];
  const settlementOnly = options.settlementOnly === true;
  try {
    if (isSupabaseConfigured) {
      return await searchPlacesViaServer(normalized, settlementOnly);
    }
    return await searchPlacesDirectly(normalized, settlementOnly);
  } catch (error) {
    if (!isSupabaseConfigured) {
      throw new Error("Не вдалося підключитися до пошуку місць. Спробуйте вибрати точку на карті вручну.");
    }
    try {
      return await searchPlacesDirectly(normalized, settlementOnly);
    } catch {
      throw new Error(
        error instanceof Error && error.message && !error.message.includes("Failed to fetch")
          ? error.message
          : "Не вдалося підключитися до пошуку місць. Спробуйте вибрати точку на карті вручну.",
      );
    }
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
    if (isSupabaseConfigured) {
      return await reversePlaceViaServer(latitude, longitude, settlementOnly);
    }
    return await reversePlaceDirectly(latitude, longitude, settlementOnly);
  } catch (error) {
    if (!isSupabaseConfigured) throw error;
    return reversePlaceDirectly(latitude, longitude, settlementOnly);
  }
}
