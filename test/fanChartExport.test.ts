import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFanChartPrintDocument,
  FAN_CHART_EXPORT_OPTIONS,
  fanChartExportFileName,
  fanChartExportViewBox,
  fanChartPaperDimensions,
  fanChartRasterDimensions,
} from "../src/features/family-tree-view/fan/fanChartExport.ts";
import { CIRCULAR_ANCESTOR_EXPORT_OPTIONS } from "../src/features/family-tree-view/circular/circularAncestorChartExport.ts";

test("fan charts expose the exact same PDF, SVG, and PNG formats as the circular chart", () => {
  assert.equal(FAN_CHART_EXPORT_OPTIONS, CIRCULAR_ANCESTOR_EXPORT_OPTIONS);
  assert.deepEqual(
    FAN_CHART_EXPORT_OPTIONS.map((option) => option.value),
    ["pdf-a0", "pdf-a1", "pdf-a2", "pdf-a3", "svg", "png-4k", "png-8k"],
  );
});

test("uses the complete rectangular world bounds instead of a square camera viewport", () => {
  const bounds = { x: -420, y: -118, width: 840, height: 596 };
  assert.equal(fanChartExportViewBox(bounds), "-420 -118 840 596");
  assert.throws(
    () => fanChartExportViewBox({ x: 0, y: 0, width: 0, height: 100 }),
    /повні межі/,
  );
});

test("fits 4K and 8K PNG exports to the longest side without stretching", () => {
  const landscape = { x: -420, y: -118, width: 840, height: 596 };
  assert.deepEqual(fanChartRasterDimensions(landscape, 4096), {
    width: 4096,
    height: 2906,
  });
  assert.deepEqual(fanChartRasterDimensions(landscape, 8192), {
    width: 8192,
    height: 5812,
  });

  assert.deepEqual(
    fanChartRasterDimensions({ x: 0, y: 0, width: 300, height: 600 }, 4096),
    { width: 2048, height: 4096 },
  );
});

test("creates safe descriptive file names for both fan directions", () => {
  assert.equal(
    fanChartExportFileName("ancestors", 'Каленський: Андрій / "тест"', 7),
    "віялова-діаграма-предків-Каленський-Андрій-тест-7-поколінь",
  );
  assert.equal(
    fanChartExportFileName("descendants", "Корзун Ігнат Іванович", 10),
    "віялова-діаграма-нащадків-Корзун-Ігнат-Іванович-10-поколінь",
  );
});

test("builds a landscape A0 ancestor poster with escaped metadata", () => {
  const bounds = { x: -420, y: -118, width: 840, height: 596 };
  const html = buildFanChartPrintDocument({
    svgMarkup: '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="-420 -118 840 596"><text>Вектор</text></svg>',
    paper: "A0",
    documentTitle: 'Діаграма <script>alert("x")</script>',
    direction: "ancestors",
    focusLabel: "Каленський <Андрій>",
    generations: 7,
    personCount: 126,
    generatedAtLabel: "30 серпня 2026 р.",
    worldBounds: bounds,
    legendColors: {
      paternal: "#123456",
      maternal: "#abcdef",
      duplicate: "#fedcba",
    },
  });

  assert.match(html, /@page \{ size: 1189mm 841mm; margin: 0; \}/);
  assert.match(html, /<svg viewBox="-420 -118 840 596"><text>Вектор<\/text><\/svg>/);
  assert.doesNotMatch(html, /<\?xml/);
  assert.match(html, /Каленський &lt;Андрій&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Віялова діаграма предків/);
  assert.match(html, /Батьківська гілка/);
  assert.match(html, /Материнська гілка/);
  assert.match(html, /Зберегти як PDF/);
  assert.match(html, /<meta name="generator" content="Трекер Роду">/);
  assert.match(html, /<strong>Трекер Роду<\/strong> · 30 серпня 2026 р\./);
  assert.match(html, /\.legend \.paternal \{ background: #123456; \}/);
  assert.match(html, /\.legend \.maternal \{ background: #abcdef; \}/);
});

test("builds a direction-specific descendant poster and respects portrait bounds", () => {
  const portraitBounds = { x: -200, y: -120, width: 400, height: 720 };
  assert.deepEqual(fanChartPaperDimensions("A3", portraitBounds), {
    width: 297,
    height: 420,
  });

  const html = buildFanChartPrintDocument({
    svgMarkup: "<svg></svg>",
    paper: "A3",
    documentTitle: "Віялова діаграма нащадків",
    direction: "descendants",
    focusLabel: "Корзун Ігнат Іванович",
    generations: 10,
    personCount: 48,
    worldBounds: portraitBounds,
  });

  assert.match(html, /@page \{ size: 297mm 420mm; margin: 0; \}/);
  assert.match(html, /Віялова діаграма нащадків/);
  assert.match(html, /Гілки дітей/);
  assert.match(html, /Повторна особа/);
  assert.doesNotMatch(html, /Материнська гілка/);
});
