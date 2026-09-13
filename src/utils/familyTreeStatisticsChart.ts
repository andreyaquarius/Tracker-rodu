import type {
  FamilyTreeStatisticsChart,
  FamilyTreeStatisticsChartRow,
} from "../services/familyTreeStatisticsService.ts";

const DEFAULT_SERIES_LABELS = ["Значення", "Додатково", "Третій ряд"] as const;

function localized(value: number): string {
  return value.toLocaleString("uk-UA");
}

export function familyTreeStatisticsRowTotal(row: FamilyTreeStatisticsChartRow): number {
  if (row.total !== undefined && Number.isFinite(row.total)) return row.total;
  return row.value + (row.secondary ?? 0) + (row.tertiary ?? 0);
}

export function familyTreeStatisticsRowDisplayValue(
  chart: FamilyTreeStatisticsChart,
  row: FamilyTreeStatisticsChartRow,
): string {
  const total = familyTreeStatisticsRowTotal(row);
  if (chart.type === "stacked-progress" && row.total !== undefined) {
    return `${localized(row.value)} із ${localized(total)}${row.percent !== undefined ? ` · ${row.percent}%` : ""}`;
  }
  const displayedValue = row.total !== undefined ? total : row.value;
  return `${localized(displayedValue)}${row.percent !== undefined ? ` · ${row.percent}%` : ""}`;
}

export function familyTreeStatisticsRowBreakdown(
  chart: FamilyTreeStatisticsChart,
  row: FamilyTreeStatisticsChartRow,
): string | undefined {
  if (row.secondary === undefined && row.tertiary === undefined && row.total === undefined) return undefined;

  const labels = chart.seriesLabels ?? DEFAULT_SERIES_LABELS;
  const parts = [`${labels[0] ?? DEFAULT_SERIES_LABELS[0]}: ${localized(row.value)}`];
  if (row.secondary !== undefined) {
    parts.push(`${labels[1] ?? DEFAULT_SERIES_LABELS[1]}: ${localized(row.secondary)}`);
  }
  if (row.tertiary !== undefined) {
    parts.push(`${labels[2] ?? DEFAULT_SERIES_LABELS[2]}: ${localized(row.tertiary)}`);
  }
  if (row.total !== undefined) parts.push(`Усього: ${localized(familyTreeStatisticsRowTotal(row))}`);
  return parts.join(" · ");
}

export interface FamilyTreeStatisticsLineChartPoint {
  index: number;
  row: FamilyTreeStatisticsChartRow;
  x: number;
  y: number;
}

export interface FamilyTreeStatisticsLineChartTick {
  value: number;
  label: string;
  y: number;
}

export interface FamilyTreeStatisticsLineChartXAxisTick {
  index: number;
  label: string;
  x: number;
}

export interface FamilyTreeStatisticsLineChartModel {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  axisMaximum: number;
  points: FamilyTreeStatisticsLineChartPoint[];
  yTicks: FamilyTreeStatisticsLineChartTick[];
  xTicks: FamilyTreeStatisticsLineChartXAxisTick[];
  total: number;
  peak: FamilyTreeStatisticsLineChartPoint;
}

const LINE_CHART_WIDTH = 960;
const LINE_CHART_HEIGHT = 340;
const LINE_CHART_PADDING = { left: 66, right: 24, top: 22, bottom: 52 } as const;

function niceLineChartStep(maximum: number, targetIntervals = 5): number {
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  const roughStep = maximum / Math.max(1, targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, factor * magnitude);
}

function numericTimelineValue(label: string): number | undefined {
  const match = label.match(/(?:^|\D)(\d{3,4})(?:\D|$)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function lineChartXAxisIndices(values: readonly number[] | undefined, rowCount: number, targetTicks = 7): number[] {
  if (rowCount <= 0) return [];
  const tickCount = Math.min(targetTicks, rowCount);
  if (tickCount === 1) return [0];

  if (values && values.length === rowCount && values.at(-1)! > values[0]) {
    const minimum = values[0];
    const range = values.at(-1)! - minimum;
    const selected = new Set<number>();
    for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
      const target = minimum + range * tickIndex / (tickCount - 1);
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      values.forEach((value, index) => {
        const distance = Math.abs(value - target);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      selected.add(closestIndex);
    }
    selected.add(0);
    selected.add(rowCount - 1);
    return [...selected].sort((left, right) => left - right);
  }

  return [...new Set(Array.from({ length: tickCount }, (_, index) => (
    Math.round(index * (rowCount - 1) / Math.max(1, tickCount - 1))
  )))];
}

/**
 * Creates one shared, deterministic geometry model for the interactive chart
 * and its SVG/PNG exports. Dense timelines retain every value, while labels
 * and visible markers can be sampled independently by the renderer.
 */
export function createFamilyTreeStatisticsLineChartModel(
  rows: readonly FamilyTreeStatisticsChartRow[],
): FamilyTreeStatisticsLineChartModel {
  if (!rows.length) throw new Error("Для лінійного графіка потрібен щонайменше один рядок.");

  const width = LINE_CHART_WIDTH;
  const height = LINE_CHART_HEIGHT;
  const plotLeft = LINE_CHART_PADDING.left;
  const plotRight = width - LINE_CHART_PADDING.right;
  const plotTop = LINE_CHART_PADDING.top;
  const plotBottom = height - LINE_CHART_PADDING.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const maximum = Math.max(0, ...rows.map((row) => Number.isFinite(row.value) ? row.value : 0));
  const step = niceLineChartStep(maximum);
  const axisMaximum = Math.max(step, Math.ceil(maximum / step) * step);
  const timelineValues = rows.map((row) => numericTimelineValue(row.label));
  const chronologicalValues = timelineValues.every((value): value is number => value !== undefined)
    && timelineValues.every((value, index) => index === 0 || value >= (timelineValues[index - 1] ?? value));
  const numericValues = chronologicalValues ? timelineValues as number[] : undefined;
  const domainMinimum = numericValues?.[0] ?? 0;
  const domainMaximum = numericValues?.at(-1) ?? Math.max(1, rows.length - 1);
  const domainRange = Math.max(1, domainMaximum - domainMinimum);

  const points = rows.map((row, index): FamilyTreeStatisticsLineChartPoint => {
    const domainValue = numericValues?.[index] ?? index;
    const x = rows.length === 1
      ? plotLeft + plotWidth / 2
      : plotLeft + (domainValue - domainMinimum) / domainRange * plotWidth;
    const safeValue = Number.isFinite(row.value) ? Math.max(0, row.value) : 0;
    return {
      index,
      row,
      x,
      y: plotBottom - safeValue / axisMaximum * plotHeight,
    };
  });

  const intervalCount = Math.max(1, Math.round(axisMaximum / step));
  const yTicks = Array.from({ length: intervalCount + 1 }, (_, index) => {
    const value = step * index;
    return {
      value,
      label: value.toLocaleString("uk-UA"),
      y: plotBottom - value / axisMaximum * plotHeight,
    };
  }).reverse();
  const xTicks = lineChartXAxisIndices(numericValues, rows.length).map((index) => ({
    index,
    label: rows[index].label,
    x: points[index].x,
  }));
  const peak = points.reduce((current, point) => point.row.value > current.row.value ? point : current, points[0]);

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    axisMaximum,
    points,
    yTicks,
    xTicks,
    total: rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0),
    peak,
  };
}

/** A line implies one ordered numeric series. Name/decade pairs are categories. */
export function familyTreeStatisticsChartForPresentation(
  chart: FamilyTreeStatisticsChart,
): FamilyTreeStatisticsChart {
  if (chart.id === "name-decades" && chart.type === "line") {
    return { ...chart, type: "horizontal-bar" };
  }
  return chart;
}
