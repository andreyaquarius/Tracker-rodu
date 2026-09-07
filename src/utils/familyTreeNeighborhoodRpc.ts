import type { NeighborhoodRequest } from "../features/family-tree-view/data/neighborhoodClient.ts";

/** Compatibility fallback is not a retry policy. v2 already calls v1, so
 * repeating v1 after a timeout doubles the same work on an overloaded server. */
export function shouldFallbackFamilyTreeNeighborhoodRpc(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const code = (payload as { code?: unknown }).code;
  return code === "PGRST202" || code === "42883";
}

export function familyTreeNeighborhoodRpcCandidates(
  request: Pick<NeighborhoodRequest, "structuralOnly">,
): readonly string[] {
  return request.structuralOnly
    ? [
        "get_family_tree_root_lineage_v1",
        "get_family_tree_neighborhood_v1",
      ]
    : [
        "get_family_tree_neighborhood_v2",
        "get_family_tree_neighborhood_v1",
      ];
}
