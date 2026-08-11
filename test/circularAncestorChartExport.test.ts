import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCircularAncestorPrintDocument,
  CIRCULAR_ANCESTOR_EXPORT_OPTIONS,
  circularAncestorExportFileName,
} from "../src/features/family-tree-view/circular/circularAncestorChartExport.ts";

const component = readFileSync(
  new URL(
    "../src/components/familyTree/CircularAncestorChartWindow.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("offers vector print, typography, and high-resolution screen formats", () => {
  assert.deepEqual(
    CIRCULAR_ANCESTOR_EXPORT_OPTIONS.map((option) => option.value),
    ["pdf-a0", "pdf-a1", "pdf-a2", "pdf-a3", "svg", "png-4k", "png-8k"],
  );
  assert.match(
    CIRCULAR_ANCESTOR_EXPORT_OPTIONS.find((option) => option.value === "svg")?.label ?? "",
    /типографії/,
  );
});

test("builds a single-page A0 vector print document with escaped metadata", () => {
  const html = buildCircularAncestorPrintDocument({
    svgMarkup: '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 10 10"><text>Вектор</text></svg>',
    paper: "A0",
    documentTitle: 'Діаграма <script>alert("x")</script>',
    focusLabel: "Каленський <Андрій>",
    generations: 7,
    ancestorCount: 126,
    generatedAtLabel: "11 серпня 2026 р.",
  });

  assert.match(html, /@page \{ size: 841mm 1189mm; margin: 0; \}/);
  assert.match(html, /<svg viewBox="0 0 10 10"><text>Вектор<\/text><\/svg>/);
  assert.doesNotMatch(html, /<\?xml/);
  assert.match(html, /Каленський &lt;Андрій&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Зберегти як PDF/);
  assert.match(html, /A0 · векторний макет/);
});

test("creates filesystem-safe descriptive export names", () => {
  assert.equal(
    circularAncestorExportFileName('Каленський: Андрій / "тест"', 7),
    "кругова-діаграма-Каленський-Андрій-тест-7-поколінь",
  );
});

test("the circular chart exports the full world instead of the current camera viewport", () => {
  assert.match(component, /exportCircularAncestorChart\(\{/);
  assert.match(component, /sourceSvg,/);
  assert.match(component, /worldSize,/);
  assert.match(component, /CIRCULAR_ANCESTOR_EXPORT_OPTIONS\.map/);
});
