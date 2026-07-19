export interface SelectableFamilyTreeEntryPoint {
  id: string;
  rootPersonId: string | null;
  isDefault: boolean;
}

export function selectFamilyTreeEntryPointForPerson<
  TEntryPoint extends SelectableFamilyTreeEntryPoint,
>(
  entryPoints: readonly TEntryPoint[],
  memberTreeIds: readonly string[],
  preferredTreeId?: string,
): TEntryPoint | null {
  const eligibleTreeIds = new Set(memberTreeIds);
  const eligible = entryPoints.filter(
    (entryPoint) => Boolean(entryPoint.rootPersonId) && eligibleTreeIds.has(entryPoint.id),
  );
  const requestedTreeId = preferredTreeId?.trim();
  return eligible.find((entryPoint) => entryPoint.id === requestedTreeId) ??
    eligible.find((entryPoint) => entryPoint.isDefault) ??
    eligible[0] ??
    null;
}
