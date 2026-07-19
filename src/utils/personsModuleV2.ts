export function isPersonsModuleV2Enabled({
  envValue,
  remoteValue,
}: {
  envValue?: string | boolean;
  remoteValue?: boolean;
}): boolean {
  const normalizedEnv = typeof envValue === "string"
    ? envValue.trim().toLocaleLowerCase()
    : envValue;
  if (normalizedEnv === false || normalizedEnv === "false" || normalizedEnv === "0") {
    return false;
  }
  if (remoteValue === false) return false;
  if (normalizedEnv === true || normalizedEnv === "true" || normalizedEnv === "1") {
    return true;
  }
  // V2 intentionally stays opt-in until the later parity stages restore every
  // destructive and linked-record action from the legacy module.
  return remoteValue === true;
}

export function canUsePersonsModuleV2({
  rolloutEnabled,
  canUseFamilyTreeFeature,
}: {
  rolloutEnabled: boolean;
  canUseFamilyTreeFeature: boolean;
}): boolean {
  return rolloutEnabled && canUseFamilyTreeFeature;
}
