import assert from "node:assert/strict";
import test from "node:test";
import {
  clampResearchGraphViewport,
  clampResearchGraphZoom,
  isResearchGraphLayoutId,
  RESEARCH_GRAPH_CURRENT_LAYOUT_ID,
  RESEARCH_GRAPH_DEFAULT_LAYOUT_ID,
  RESEARCH_GRAPH_LAYOUT_IDS,
  researchGraphSavedFiltersSupported,
} from "../src/features/context-graph/researchGraphSavedViewModel.ts";
import type { ResearchGraphSavedViewFilters } from "../src/types/contextGraph.ts";

test("saved graph zoom is finite and bounded", () => {
  assert.equal(clampResearchGraphZoom(-20), 0.5);
  assert.equal(clampResearchGraphZoom(1.234), 1.23);
  assert.equal(clampResearchGraphZoom(50), 2);
  assert.equal(clampResearchGraphZoom(Number.NaN), 1);
});

test("saved graph layout contract supports all section 26 layouts and keeps radial as the legacy default", () => {
  assert.deepEqual(RESEARCH_GRAPH_LAYOUT_IDS, ["radial", "hierarchical", "force"]);
  assert.equal(RESEARCH_GRAPH_DEFAULT_LAYOUT_ID, "radial");
  assert.equal(RESEARCH_GRAPH_CURRENT_LAYOUT_ID, RESEARCH_GRAPH_DEFAULT_LAYOUT_ID);
  for (const layoutId of RESEARCH_GRAPH_LAYOUT_IDS) {
    assert.equal(isResearchGraphLayoutId(layoutId), true);
  }
  for (const unsupported of ["grid", "", null, undefined, 1]) {
    assert.equal(isResearchGraphLayoutId(unsupported), false);
  }
});

test("restored viewport is clamped to the actual canvas", () => {
  assert.deepEqual(
    clampResearchGraphViewport(
      { x: 9_000, y: 4_000, width: 1_900, height: 1_100 },
      { scrollWidth: 1_500, scrollHeight: 900, clientWidth: 700, clientHeight: 500 },
    ),
    { x: 800, y: 400, width: 700, height: 500 },
  );
  assert.deepEqual(
    clampResearchGraphViewport(
      { x: -1, y: Number.NaN, width: 0, height: 0 },
      { scrollWidth: 500, scrollHeight: 300, clientWidth: 700, clientHeight: 500 },
    ),
    { x: 0, y: 0, width: 700, height: 500 },
  );
});

test("unsupported multi-select and future-cap configurations fail closed", () => {
  const base = savedFilters();
  assert.equal(researchGraphSavedFiltersSupported(base), true);
  assert.equal(researchGraphSavedFiltersSupported({ ...base, placeIds: ["one", "two"] }), false);
  assert.equal(researchGraphSavedFiltersSupported({ ...base, relationTypeIds: ["one", "two"] }), false);
  assert.equal(researchGraphSavedFiltersSupported({ ...base, focusDate: "1900-01-01", focusYear: 1900 }), false);
  assert.equal(researchGraphSavedFiltersSupported({ ...base, maxNodes: 80 }), false);
  assert.equal(researchGraphSavedFiltersSupported({ ...base, entityTypes: [] }), false);
});

function savedFilters(): ResearchGraphSavedViewFilters {
  return {
    depth: 2,
    entityTypes: ["person", "hypothesis", "place"],
    relationTypeIds: [],
    evidenceStatuses: [],
    assertionKinds: ["research_hypothesis"],
    validFrom: "",
    validTo: "",
    minConfidence: 0,
    hasEvidence: null,
    focusDate: "",
    focusYear: null,
    placeIds: [],
    includeUndated: false,
    maxNodes: 100,
    maxEdges: 220,
  };
}
