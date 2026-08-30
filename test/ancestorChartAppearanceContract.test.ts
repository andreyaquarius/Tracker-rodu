import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const page = source("../src/pages/ProductionFamilyTreePage.tsx");
const circular = source("../src/components/familyTree/CircularAncestorChartWindow.tsx");
const fan = source("../src/components/familyTree/FanGenealogyChartWindow.tsx");
const controls = source("../src/components/familyTree/AncestorChartColorControls.tsx");
const circularExport = source(
  "../src/features/family-tree-view/circular/circularAncestorChartExport.ts",
);
const fanExport = source(
  "../src/features/family-tree-view/fan/fanChartExport.ts",
);

test("both ancestor diagrams inherit the saved tree appearance and expose a local reset", () => {
  assert.equal(
    page.match(/appearancePreferences=\{treeAppearance\}/g)?.length,
    2,
  );
  assert.match(circular, /resolveFamilyTreeChartColorScheme\(chartAppearance\)/);
  assert.match(fan, /resolveFamilyTreeChartColorScheme\(chartAppearance\)/);
  assert.match(circular, /ancestorChartToneForOccurrence\(chartColorScheme, occurrence\)/);
  assert.match(fan, /ancestorChartToneForOccurrence\(chartColorScheme/);
  assert.match(controls, /Повернути кольори дерева/);
  assert.match(controls, /Зміни діють лише до закриття вікна/);
});

test("fan labels stay vector-readable through deep generations", () => {
  assert.match(fan, /const MAX_ZOOM = 1024/);
  assert.match(fan, /TARGET_LABEL_SCREEN_SIZE/);
  assert.match(fan, /Читати · \{Math\.round\(readableLabelZoom \* 100\)\}%/);
});

test("both export paths retain inline chart colors instead of restoring old fills", () => {
  for (const exportSource of [circularExport, fanExport]) {
    assert.match(exportSource, /--ancestor-sector-fill/);
    assert.match(exportSource, /--family-tree-chart-background/);
    assert.match(exportSource, /--family-tree-chart-paternal-fill/);
    assert.match(exportSource, /--family-tree-chart-maternal-fill/);
  }
});
