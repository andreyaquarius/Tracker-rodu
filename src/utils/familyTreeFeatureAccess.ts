export function resolveFamilyTreeFeatureAccess(input: {
  isAppAdmin: boolean;
  serverAllowed: boolean;
  serverLoading: boolean;
}): boolean {
  return input.isAppAdmin || (input.serverAllowed && !input.serverLoading);
}
