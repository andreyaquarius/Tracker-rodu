export function shouldUseProductionFamilyTreeRenderer(
  _featureFlags: Readonly<Record<string, boolean>>,
  _isDevelopment = false,
): boolean {
  return true;
}
