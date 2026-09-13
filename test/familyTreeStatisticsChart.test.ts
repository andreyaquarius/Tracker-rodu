import assert from "node:assert/strict";
import test from "node:test";
import type { FamilyTreeStatisticsChart } from "../src/services/familyTreeStatisticsService.ts";
import {
  createFamilyTreeStatisticsBarChartModel,
  createFamilyTreeStatisticsDonutChartModel,
  createFamilyTreeStatisticsLineChartModel,
  familyTreeStatisticsChartForPresentation,
  familyTreeStatisticsRowBreakdown,
  familyTreeStatisticsRowDisplayValue,
  familyTreeStatisticsRowTotal,
} from "../src/utils/familyTreeStatisticsChart.ts";

test("generation progress uses each generation's capacity, not 65,536 slots", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "generation-completeness", title: "Заповненість поколінь", type: "stacked-progress",
    rows: [
      { label: "Покоління 3", value: 8, secondary: 0, total: 8, percent: 100 },
      { label: "Покоління 4", value: 15, secondary: 1, total: 16, percent: 93.8 },
      { label: "Покоління 10", value: 19, secondary: 1005, total: 1024, percent: 1.9 },
      { label: "Покоління 11", value: 5, secondary: 2043, total: 2048, percent: 0.2 },
      { label: "Покоління 16", value: 0, secondary: 65536, total: 65536, percent: 0 },
    ],
  };
  const bars = createFamilyTreeStatisticsBarChartModel(chart);
  assert.deepEqual(bars.map((bar) => bar.primaryPercent), [100, 93.75, 19 / 1024 * 100, 5 / 2048 * 100, 0]);
  assert.ok(bars.every((bar) => bar.secondaryPercent === 0 && bar.tertiaryPercent === 0));
  assert.equal(familyTreeStatisticsRowDisplayValue(chart, chart.rows[0]), "8 із 8 · 100%");
  assert.deepEqual(familyTreeStatisticsChartForPresentation(chart).seriesLabels, ["Відомі предки", "Невідомі предки"]);
  assert.equal(chart.seriesLabels, undefined, "presentation must not mutate API data");
});

test("evidence progress shows the same share for different generation sizes", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "evidence-generations", title: "Особи з доказами", type: "stacked-progress",
    rows: [
      { label: "Мале", value: 1, secondary: 1, total: 2, percent: 50 },
      { label: "Велике", value: 512, secondary: 512, total: 1024, percent: 50 },
    ],
  };
  assert.deepEqual(createFamilyTreeStatisticsBarChartModel(chart).map((bar) => bar.primaryPercent), [50, 50]);
  assert.deepEqual(familyTreeStatisticsChartForPresentation(chart).seriesLabels, ["З доказами", "Без доказів"]);
});

test("progress handles missing totals and invalid input without overfilling", () => {
  const chart: FamilyTreeStatisticsChart = {
    id: "progress", title: "Progress", type: "stacked-progress",
    rows: [
      { label: "Percent only", value: 6, percent: 25 },
      { label: "Inferred total", value: 3, secondary: 1 },
      { label: "Zero total", value: 0, total: 0, percent: 100 },
      { label: "Over capacity", value: 12, total: 8 },
      { label: "Negative", value: -3, total: 8 },
      { label: "Invalid", value: Number.NaN, total: 8 },
      { label: "Invalid capacity", value: 3, total: Number.POSITIVE_INFINITY },
    ],
  };
  assert.deepEqual(createFamilyTreeStatisticsBarChartModel(chart).map((bar) => bar.primaryPercent), [25, 75, 0, 100, 0, 0, 0]);
});

test("count charts retain a common scale and never inflate small or zero series", () => {
  for (const type of ["bar", "horizontal-bar", "multi-bar", "distribution"] as const) {
    const chart: FamilyTreeStatisticsChart = {
      id: "counts", title: "Counts", type,
      rows: [
        { label: "Large", value: 100000, total: 100000 },
        { label: "Small", value: 1, secondary: 2, tertiary: 3, total: 6 },
        { label: "Empty", value: 0, secondary: 0, tertiary: 0, total: 0 },
      ],
    };
    const bars = createFamilyTreeStatisticsBarChartModel(chart);
    assert.equal(bars[0].primaryPercent, 100);
    assert.equal(bars[1].primaryPercent, 1 / 100000 * 100);
    assert.equal(bars[1].secondaryPercent, 2 / 100000 * 100);
    assert.equal(bars[1].tertiaryPercent, 3 / 100000 * 100);
    assert.equal(bars[2].primaryPercent + bars[2].secondaryPercent + bars[2].tertiaryPercent, 0);
  }
});

test("zero donut data stays zero and actual slices cover the whole", () => {
  const empty = createFamilyTreeStatisticsDonutChartModel([{ label: "A", value: 0 }, { label: "B", value: 0 }]);
  assert.equal(empty.total, 0);
  assert.ok(empty.segments.every((segment) => segment.length === 0));
  const rows = [{ label: "A", value: 3 }, { label: "B", value: 1 }, { label: "C", value: 0 }];
  const model = createFamilyTreeStatisticsDonutChartModel(rows);
  assert.equal(model.total, 4);
  assert.deepEqual(model.segments.map(({ length, offset }) => ({ length, offset })), [
    { length: 75, offset: 0 }, { length: 25, offset: 75 }, { length: 0, offset: 100 },
  ]);
  assert.deepEqual(createFamilyTreeStatisticsBarChartModel({ id: "shares", title: "Shares", type: "donut", rows }).map((bar) => bar.primaryPercent), [75, 25, 0]);
});

test("all-zero line charts keep every point on the baseline", () => {
  const model = createFamilyTreeStatisticsLineChartModel([{ label: "2024", value: 0 }, { label: "2025", value: 0 }]);
  assert.equal(model.total, 0);
  assert.ok(model.points.every((point) => point.y === model.plotBottom));
});

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
