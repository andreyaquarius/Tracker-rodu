import type { GeoPoint } from "../types";

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

export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 3) return [];
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
