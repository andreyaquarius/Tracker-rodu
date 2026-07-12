/** Hard ceiling for mounted card/list items plus family controls. */
export const MAX_RENDERED_FAMILY_TREE_NODES = 600;

export function normalizeRenderedNodeLimit(value?: number): number {
  if (!Number.isFinite(value)) return MAX_RENDERED_FAMILY_TREE_NODES;
  return Math.min(
    MAX_RENDERED_FAMILY_TREE_NODES,
    Math.max(1, Math.floor(value!)),
  );
}

export interface InteractiveMountAllocation<TPrimary, TSecondary> {
  primary: readonly TPrimary[];
  secondary: readonly TSecondary[];
  mountedCount: number;
  omittedCount: number;
  limit: number;
}

/**
 * Applies one hard DOM budget to cards/list rows and their adjacent family
 * controls. Primary items keep their stable display order; controls use only
 * the slots that remain. No caller can accidentally mount 600 + controls.
 */
export function allocateInteractiveMountBudget<TPrimary, TSecondary>(
  primary: readonly TPrimary[],
  secondary: readonly TSecondary[],
  requestedLimit?: number,
): InteractiveMountAllocation<TPrimary, TSecondary> {
  const limit = normalizeRenderedNodeLimit(requestedLimit);
  const mountedPrimary = primary.slice(0, limit);
  const remaining = Math.max(0, limit - mountedPrimary.length);
  const mountedSecondary = secondary.slice(0, remaining);
  const mountedCount = mountedPrimary.length + mountedSecondary.length;
  return {
    primary: mountedPrimary,
    secondary: mountedSecondary,
    mountedCount,
    omittedCount: Math.max(0, primary.length + secondary.length - mountedCount),
    limit,
  };
}
