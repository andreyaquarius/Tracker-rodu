import { useMemo } from "react";
import type { FamilyTreeAppearancePreferences } from "../../utils/familyTreeAppearance.ts";
import { useAppAppearance } from "./AppAppearanceProvider.tsx";

/** Display-only override. Returning to Standard restores each tree's saved palette and sky choice. */
export function useTreeSkyAppearance(saved: FamilyTreeAppearancePreferences) {
  const { appearance } = useAppAppearance();
  return useMemo(() => appearance.theme === "starry-dark" ? { ...saved, starryBackground: true,
    starryAnimation: saved.starryAnimation && appearance.skyMotion } : saved, [saved, appearance.theme, appearance.skyMotion]);
}
