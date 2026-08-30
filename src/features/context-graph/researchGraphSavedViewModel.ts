import type {
  ResearchGraphLayoutId,
  ResearchGraphSavedViewport,
  ResearchGraphSavedViewFilters,
} from "../../types/contextGraph.ts";

export const RESEARCH_GRAPH_SAVED_VIEW_CONFIG_VERSION = 1 as const;
export const RESEARCH_GRAPH_LAYOUT_IDS = ["radial", "hierarchical", "force"] as const satisfies readonly ResearchGraphLayoutId[];
export const RESEARCH_GRAPH_DEFAULT_LAYOUT_ID = "radial" as const satisfies ResearchGraphLayoutId;
/** @deprecated Use RESEARCH_GRAPH_DEFAULT_LAYOUT_ID. Kept for saved-view consumers from section 24. */
export const RESEARCH_GRAPH_CURRENT_LAYOUT_ID = RESEARCH_GRAPH_DEFAULT_LAYOUT_ID;
export const RESEARCH_GRAPH_MIN_ZOOM = 0.5;
export const RESEARCH_GRAPH_MAX_ZOOM = 2;
export const RESEARCH_GRAPH_ZOOM_STEP = 0.1;

export interface ResearchGraphCanvasMetrics {
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export function isResearchGraphLayoutId(value: unknown): value is ResearchGraphLayoutId {
  return typeof value === "string"
    && (RESEARCH_GRAPH_LAYOUT_IDS as readonly string[]).includes(value);
}

export function clampResearchGraphZoom(value: unknown): number {
  const parsed = Number(value);
  const finite = Number.isFinite(parsed) ? parsed : 1;
  return roundToHundredth(Math.min(RESEARCH_GRAPH_MAX_ZOOM, Math.max(RESEARCH_GRAPH_MIN_ZOOM, finite)));
}

/** Clamp persisted coordinates to the dimensions of the currently rendered canvas. */
export function clampResearchGraphViewport(
  viewport: ResearchGraphSavedViewport,
  metrics: ResearchGraphCanvasMetrics,
): ResearchGraphSavedViewport {
  const width = nonNegativeFinite(metrics.clientWidth);
  const height = nonNegativeFinite(metrics.clientHeight);
  const maximumX = Math.max(0, nonNegativeFinite(metrics.scrollWidth) - width);
  const maximumY = Math.max(0, nonNegativeFinite(metrics.scrollHeight) - height);
  return {
    x: Math.min(maximumX, nonNegativeFinite(viewport.x)),
    y: Math.min(maximumY, nonNegativeFinite(viewport.y)),
    width,
    height,
  };
}

/**
 * The current controls expose one relation, one evidence state, one assertion
 * kind and one canonical place at a time. A future schema must never be loaded
 * partially because silently dropping an unavailable filter broadens results.
 */
export function researchGraphSavedFiltersSupported(
  filters: ResearchGraphSavedViewFilters,
): boolean {
  return filters.entityTypes.length > 0
    && filters.relationTypeIds.length <= 1
    && filters.evidenceStatuses.length <= 1
    && filters.assertionKinds.length <= 1
    && filters.placeIds.length <= 1
    && !(filters.focusDate && filters.focusYear !== null)
    && filters.maxNodes === 100
    && filters.maxEdges === 220;
}

function nonNegativeFinite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}
