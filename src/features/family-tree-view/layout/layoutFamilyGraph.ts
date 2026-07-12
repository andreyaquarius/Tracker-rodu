import type { FamilyTreeLayoutInput, LayoutResult } from "../types.ts";
import { layoutGraphEngine } from "./layoutEngine.ts";

/**
 * Pedigree/family-corridor entry point. The descendant forest has a separate
 * public entry point and is dispatched explicitly by the worker.
 */
export function layoutFamilyGraph(input: FamilyTreeLayoutInput): LayoutResult {
  return layoutGraphEngine(input, "family-graph");
}
