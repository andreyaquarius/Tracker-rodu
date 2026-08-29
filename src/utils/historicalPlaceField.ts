import type {
  HistoricalPlaceFieldValue,
  PlaceSummary,
} from "../types/historicalPlaces";

export function historicalPlaceOptionLabel(place: PlaceSummary): string {
  const context = [historicalPlaceTypeLabel(place.placeType), historicalPlaceAdministrativeLabel(place)]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" · ");
  return context ? `${place.displayName || place.canonicalName} — ${context}` : place.displayName;
}

export function historicalPlaceAdministrativeLabel(place: PlaceSummary): string {
  const hierarchy = place.hierarchy
    .map((node) => node.place.displayName || node.place.canonicalName)
    .map((label) => label.trim())
    .filter(Boolean);
  return hierarchy.length > 0
    ? hierarchy.join(" → ")
    : place.currentAdmin || place.currentCountry;
}

export function historicalPlaceTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    settlement: "населений пункт", urban_settlement: "селище", hamlet: "хутір", small_settlement: "присілок",
    village: "село", town: "містечко", city: "місто", sloboda: "слобода",
    colony: "колонія", folwark: "фільварок", estate: "маєток",
    manor: "маєток / двір", parish: "парафія", volost: "волость",
    county: "повіт", governorate: "губернія", okrug: "округ",
    district: "район", region: "область", community: "громада",
    country: "держава", cemetery: "кладовище", church: "церква",
    monastery: "монастир", military_unit: "військова частина", other: "інше",
  };
  return labels[value] ?? (value.replaceAll("_", " ") || "тип не вказано");
}

export function changeHistoricalPlaceOriginalText(
  current: HistoricalPlaceFieldValue,
  originalText: string,
): HistoricalPlaceFieldValue {
  if (originalText === current.originalText) return current;
  return { placeId: null, originalText, place: null };
}

export function selectHistoricalPlace(
  current: HistoricalPlaceFieldValue,
  place: PlaceSummary,
): HistoricalPlaceFieldValue {
  return {
    placeId: place.id,
    originalText: current.originalText,
    place,
    placeDisplayName: place.displayName || place.canonicalName,
  };
}

/** Ignore responses from a request that was aborted or superseded by a newer date/profile request. */
export function isCurrentHistoricalPlaceRequest(
  currentRequestId: number,
  responseRequestId: number,
  aborted: boolean,
): boolean {
  return !aborted && currentRequestId === responseRequestId;
}

/** A dated profile must not render the hierarchy cached for a different date. */
export function historicalPlaceProfileMatchesDate(
  profileAtDate: string | null | undefined,
  requestedAtDate: string,
): boolean {
  return (profileAtDate ?? "") === requestedAtDate;
}
