import type { NeighborhoodRequest } from "../features/family-tree-view/data/neighborhoodClient.ts";

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
