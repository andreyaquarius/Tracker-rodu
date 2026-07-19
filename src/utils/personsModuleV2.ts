export function canUsePersonsModuleV2({
  canUseFamilyTreeFeature,
}: {
  canUseFamilyTreeFeature: boolean;
}): boolean {
  // Persons V2 deliberately shares one entitlement with Family Tree. Keeping
  // a second rollout switch would let the two audiences drift apart.
  return canUseFamilyTreeFeature;
}
