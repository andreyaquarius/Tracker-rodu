import type { FamilyTreeLayoutInput, LayoutResult } from "../types.ts";
import { layoutGraphEngine } from "./layoutEngine.ts";

/**
 * Dedicated descendants-only layout. It uses bottom-up family contours and
 * never runs the direct-ancestor/general barycentric coordinate solver.
 */
export function layoutDescendantForest(
  input: FamilyTreeLayoutInput,
): LayoutResult {
  return layoutGraphEngine(
    {
      ...input,
      options: { ...input.options, layoutMode: "descendant-forest" },
    },
    "descendant-forest",
  );
}
