export function shouldUseProductionFamilyTreeRenderer(
  featureFlags: Readonly<Record<string, boolean>>,
  isDevelopment = false,
): boolean {
  return isDevelopment || featureFlags.family_tree_renderer_v2 === true;
}
