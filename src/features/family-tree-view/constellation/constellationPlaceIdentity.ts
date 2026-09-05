import type { PersonEvent } from "../../../types/index.ts";

export interface ConstellationPlaceReference {
  /** Original place wording is always retained, even with a confirmed canonical identity. */
  place: string;
  placeId?: string;
  placeCanonicalName?: string;
}
export const normalizeConstellationPlaceText = (text: string) => text.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("uk");

export function constellationPlaceReference(event: PersonEvent): ConstellationPlaceReference {
  const place = event.placeOriginalText?.trim() || event.placeName?.trim() || event.placeCanonicalName?.trim() || "";
  return { place, ...(event.placeResolutionStatus === "confirmed" && event.placeId?.trim()
    ? { placeId: event.placeId.trim(), placeCanonicalName: event.placeCanonicalName?.trim() || undefined } : {}) };
}
export function constellationPlaceKey(place: ConstellationPlaceReference): string {
  return place.placeId ? `place:${place.placeId}` : `text:${normalizeConstellationPlaceText(place.place)}`;
}
export function compatibleConstellationPlaces(a: ConstellationPlaceReference, b: ConstellationPlaceReference): boolean {
  if (a.placeId && b.placeId) return a.placeId === b.placeId;
  return !a.place.trim() || !b.place.trim() || normalizeConstellationPlaceText(a.place) === normalizeConstellationPlaceText(b.place);
}
