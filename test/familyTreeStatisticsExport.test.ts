import assert from "node:assert/strict";
import test from "node:test";
import type { FamilyTreeStatisticsChart, FamilyTreeStatisticsFilters, FamilyTreeStatisticsPayload } from "../src/services/familyTreeStatisticsService.ts";
import { statisticsChartSvg, statisticsReportSvg } from "../src/utils/familyTreeStatisticsExport.ts";

const chart: FamilyTreeStatisticsChart = {
  id: "generation-completeness", title: "Заповненість поколінь", type: "stacked-progress",
  rows: [
    { label: "Покоління 3", value: 8, secondary: 0, total: 8, percent: 100 },
    { label: "Покоління 4", value: 8, secondary: 8, total: 16, percent: 50 },
    { label: "Покоління 16", value: 0, secondary: 65536, total: 65536, percent: 0 },
  ],
};

function barWidths(svg: string, height: number): number[] {
  return [...svg.matchAll(/<rect\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((rect) => rect.includes(`height="${height}"`) && rect.includes('fill="#17695f"'))
    .map((rect) => Number(rect.match(/\bwidth="([^"]+)"/)?.[1]));
}

test("SVG and PNG source uses full, half and empty progress with no missing-data fill", () => {
  const svg = statisticsChartSvg(chart);
  assert.deepEqual(barWidths(svg, 28), [600, 300, 0]);
  assert.doesNotMatch(svg, /fill="#d5a144"/);
  assert.match(svg, /Відомі предки/);
  assert.match(svg, /Невідомі предки/);
  assert.match(svg, /8 із 8 · 100%/);
  assert.match(svg, /8 із 16 · 50%/);
});

test("PDF report source uses the same progress geometry and labels as the screen", () => {
  const payload: FamilyTreeStatisticsPayload = {
    meta: {
      treeId: "tree", projectId: "project", title: "Тестове дерево", rootPersonId: "root", rootPersonName: "Тест",
      graphVersion: "1", treeUpdatedAt: "2026-09-13T00:00:00Z", calculatedAt: "2026-09-13T00:00:00Z",
      canViewPrivate: true, filteredPeople: 16, scope: "all", branch: "all", methodology: "Тест",
    },
    metrics: [], charts: [chart], tables: [],
  };
  const filters: FamilyTreeStatisticsFilters = {
    scope: "all", branch: "all", sex: "all", lifeStatus: "all", eventTypes: [], surnameMode: "displayed", evidenceStatuses: [], sourceFilter: "all",
  };
  const svg = statisticsReportSvg(payload, filters);
  assert.deepEqual(barWidths(svg, 19), [700, 350, 0]);
  assert.doesNotMatch(svg, /fill="#d5a144"/);
  assert.match(svg, /8 із 8 · 100%/);
  assert.match(svg, /8 із 16 · 50%/);
});

test("count exports keep tiny values proportional instead of enforcing two pixels", () => {
  const svg = statisticsChartSvg({ id: "counts", title: "Counts", type: "bar", rows: [
    { label: "Large", value: 100000 }, { label: "Small", value: 1 }, { label: "Empty", value: 0 },
  ] });
  const widths = barWidths(svg, 28);
  assert.equal(widths[0], 600);
  assert.ok(Math.abs(widths[1] - 0.006) < 1e-10);
  assert.equal(widths[2], 0);
});

test("donut exports retain real shares rather than scaling the largest slice to 100%", () => {
  const svg = statisticsChartSvg({ id: "shares", title: "Shares", type: "donut", rows: [
    { label: "A", value: 3 }, { label: "B", value: 1 }, { label: "C", value: 0 },
  ] });
  assert.deepEqual(barWidths(svg, 28), [450, 150, 0]);
});
