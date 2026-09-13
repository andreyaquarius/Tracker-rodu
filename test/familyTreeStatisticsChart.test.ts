import assert from "node:assert/strict";
import test from "node:test";
import type { FamilyTreeStatisticsChart } from "../src/services/familyTreeStatisticsService.ts";
import {
  createFamilyTreeStatisticsLineChartModel,
  familyTreeStatisticsChartForPresentation,
  familyTreeStatisticsRowBreakdown,
  familyTreeStatisticsRowDisplayValue,
  familyTreeStatisticsRowTotal,
} from "../src/utils/familyTreeStatisticsChart.ts";

test("stacked decade rows display the total instead of only exact dates", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "birth-decades",
    title: "Народження за десятиліттями",
    type: "bar",
    seriesLabels: ["Точні дати", "Приблизні дати"],
    rows: [{ label: "1700-ті", value: 0, secondary: 12, total: 12 }],
  };
  const row = chart.rows[0];

  assert.equal(familyTreeStatisticsRowTotal(row), 12);
  assert.equal(familyTreeStatisticsRowDisplayValue(chart, row), "12");
  assert.equal(
    familyTreeStatisticsRowBreakdown(chart, row),
    "Точні дати: 0 · Приблизні дати: 12 · Усього: 12",
  );
});

test("stacked progress rows keep the found versus possible meaning", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "generation-completeness",
    title: "Заповненість поколінь",
    type: "stacked-progress",
    rows: [{ label: "Покоління 4", value: 13, secondary: 3, total: 16, percent: 81.3 }],
  };

  assert.equal(familyTreeStatisticsRowDisplayValue(chart, chart.rows[0]), "13 із 16 · 81.3%");
});

test("line chart creates an exact readable scale with a rounded maximum", () => {
  const rows = [
    { label: "1850", value: 3 },
    { label: "1860", value: 17 },
    { label: "1900", value: 9 },
    { label: "2024", value: 4 },
  ];
  const model = createFamilyTreeStatisticsLineChartModel(rows);

  assert.equal(model.axisMaximum, 20);
  assert.deepEqual(model.yTicks.map((tick) => tick.value), [20, 15, 10, 5, 0]);
  assert.equal(model.total, 33);
  assert.equal(model.peak.row.label, "1860");
  assert.equal(model.peak.row.value, 17);
  assert.equal(model.xTicks[0].label, "1850");
  assert.equal(model.xTicks.at(-1)?.label, "2024");
});

test("line chart positions years by the actual time gap and limits axis labels", () => {
  const rows = Array.from({ length: 160 }, (_, index) => ({
    label: String(1800 + index),
    value: index % 19,
  }));
  const model = createFamilyTreeStatisticsLineChartModel(rows);

  assert.equal(model.points.length, 160);
  assert.ok(model.xTicks.length <= 7);
  assert.ok(model.xTicks.length >= 2);
  assert.equal(model.xTicks[0].index, 0);
  assert.equal(model.xTicks.at(-1)?.index, 159);
});

test("name and decade pairs use category bars instead of a misleading line", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "name-decades",
    title: "Популярність імен за десятиліттями",
    type: "line",
    rows: [{ label: "1900-ті · Іван", value: 12 }],
  };

  assert.equal(familyTreeStatisticsChartForPresentation(chart).type, "horizontal-bar");
  assert.equal(chart.type, "line");
});
