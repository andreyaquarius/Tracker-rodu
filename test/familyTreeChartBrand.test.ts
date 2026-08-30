import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  familyTreeChartBrandExportPlacement,
  familyTreeChartBrandScreenPlacement,
} from "../src/features/family-tree-view/export/familyTreeChartBrand.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const brandComponent = source(
  "../src/components/familyTree/FamilyTreeChartBrand.tsx",
);
const circularComponent = source(
  "../src/components/familyTree/CircularAncestorChartWindow.tsx",
);
const fanComponent = source(
  "../src/components/familyTree/FanGenealogyChartWindow.tsx",
);
const circularExport = source(
  "../src/features/family-tree-view/circular/circularAncestorChartExport.ts",
);
const fanExport = source(
  "../src/features/family-tree-view/fan/fanChartExport.ts",
);

test("the same visible Tracker Rodu mark is rendered inside every chart SVG", () => {
  assert.match(brandComponent, /data-family-tree-chart-brand="true"/);
  assert.match(brandComponent, /data-family-tree-chart-brand-logo="true"/);
  assert.match(brandComponent, /TRACKER_RODU_CHART_BRAND_NAME/);
  assert.match(brandComponent, /Створено у Трекері Роду/);
  assert.match(circularComponent, /<FamilyTreeChartBrand placement=\{chartBrandPlacement\} \/>/);
  assert.match(fanComponent, /<FamilyTreeChartBrand placement=\{chartBrandPlacement\} \/>/);
});

test("the on-screen brand stays at a stable readable pixel size after zoom", () => {
  const viewport = { width: 900, height: 600 };
  const fittedBounds = { x: -500, y: -500, width: 1000, height: 1000 };
  const zoomedBounds = { x: 120, y: -80, width: 10, height: 10 };
  const fitted = familyTreeChartBrandScreenPlacement(fittedBounds, viewport);
  const zoomed = familyTreeChartBrandScreenPlacement(zoomedBounds, viewport);
  const fittedPixelsPerWorld = Math.min(
    viewport.width / fittedBounds.width,
    viewport.height / fittedBounds.height,
  );
  const zoomedPixelsPerWorld = Math.min(
    viewport.width / zoomedBounds.width,
    viewport.height / zoomedBounds.height,
  );

  assert.ok(Math.abs(fitted.width * fittedPixelsPerWorld - 184) < 0.01);
  assert.ok(Math.abs(zoomed.width * zoomedPixelsPerWorld - 184) < 0.1);
  assert.ok(fitted.x + fitted.width <= fittedBounds.x + fittedBounds.width);
  assert.ok(zoomed.y + zoomed.height <= zoomedBounds.y + zoomedBounds.height);
});

test("export reanchors the brand inside circular and rectangular full bounds", () => {
  for (const bounds of [
    { x: -1250, y: -1250, width: 2500, height: 2500 },
    { x: -420, y: -118, width: 840, height: 596 },
  ]) {
    const placement = familyTreeChartBrandExportPlacement(bounds);
    assert.ok(placement.x >= bounds.x);
    assert.ok(placement.y >= bounds.y);
    assert.ok(placement.x + placement.width <= bounds.x + bounds.width);
    assert.ok(placement.y + placement.height <= bounds.y + bounds.height);
  }

  const descendantBounds = { x: -200, y: -120, width: 400, height: 720 };
  const descendantPlacement = familyTreeChartBrandExportPlacement(
    descendantBounds,
    "top-right",
  );
  assert.ok(descendantPlacement.y > descendantBounds.y);
  assert.ok(descendantPlacement.y < descendantBounds.y + 40);
});

test("all export paths embed the canonical logo and declare the generator", () => {
  for (const exportSource of [circularExport, fanExport]) {
    assert.match(exportSource, /await loadTrackerRoduChartLogoDataUrl\(\)/);
    assert.match(exportSource, /prepareFamilyTreeChartBrandForExport\(/);
    assert.match(exportSource, /data-generator", "Трекер Роду"/);
    assert.match(exportSource, /<meta name="generator" content="Трекер Роду">/);
  }
  assert.match(fanExport, /options\.direction === "descendants" \? "top-right"/);
});
