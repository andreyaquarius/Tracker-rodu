export const NOMINATIM_PROVIDER = "nominatim" as const;

export function normalizeNominatimSearchKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function nominatimSearchCacheKey(query: string, settlementOnly: boolean): string {
  const scope = settlementOnly ? "settlement" : "all";
  return `search:uk:${scope}:7:${normalizeNominatimSearchKey(query)}`;
}

export function nominatimReverseCacheKey(
  latitude: number,
  longitude: number,
  settlementOnly: boolean,
): string {
  const scope = settlementOnly ? "settlement" : "exact";
  const zoom = settlementOnly ? 15 : 18;
  return `reverse:uk:${scope}:${zoom}:${latitude.toFixed(6)}:${longitude.toFixed(6)}`;
}
