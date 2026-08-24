import type { ZagulyakaKind } from "../types/zagulyaky";

export const ZAGULYAKA_TITLE_MAX_LENGTH = 180;

/**
 * A title follows the normalized Ukrainian full name only while the author has
 * not supplied a title of their own.  Keeping this as pure logic avoids a
 * `useEffect` feedback loop between the two controlled inputs.
 */
export function isZagulyakaTitleAutofillActive(
  kind: ZagulyakaKind,
  title: string,
): boolean {
  return kind === "person" && !title.trim();
}

export function nextZagulyakaTitleFromNormalizedName(
  currentTitle: string,
  normalizedNameUk: string,
  autofillActive: boolean,
): string {
  return autofillActive ? normalizedNameUk.slice(0, ZAGULYAKA_TITLE_MAX_LENGTH) : currentTitle;
}
