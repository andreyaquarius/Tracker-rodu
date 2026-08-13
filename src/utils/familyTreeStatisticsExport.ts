import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import type {
  FamilyTreeStatisticsChart,
  FamilyTreeStatisticsFilters,
  FamilyTreeStatisticsPayload,
  FamilyTreeStatisticsTabId,
  FamilyTreeStatisticsTable,
} from "../services/familyTreeStatisticsService.ts";
import {
  createFamilyTreeStatisticsLineChartModel,
  familyTreeStatisticsChartForPresentation,
  familyTreeStatisticsRowDisplayValue,
  familyTreeStatisticsRowTotal,
} from "./familyTreeStatisticsChart.ts";

const TAB_LABELS: Record<FamilyTreeStatisticsTabId, string> = {
  overview: "Огляд",
  ancestry: "Родовід",
  demography: "Демографія",
  families: "Родини",
  names: "Імена",
  geography: "Географія",
  research: "Джерела",
  quality: "Якість даних",
};

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "статистика-дерева";
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "").replace(/^([=+\-@])/, "'$1");
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportStatisticsTableCsv(table: FamilyTreeStatisticsTable): void {
  const lines = [table.columns, ...table.rows]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n");
  download(new Blob(["\uFEFF", lines], { type: "text/csv;charset=utf-8" }), `${safeFileName(table.title)}.csv`);
}

function chartTable(chart: FamilyTreeStatisticsChart): FamilyTreeStatisticsTable {
  const hasSecondary = chart.rows.some((row) => row.secondary !== undefined);
  const hasTertiary = chart.rows.some((row) => row.tertiary !== undefined);
  const hasTotal = chart.rows.some((row) => row.total !== undefined);
  const hasPercent = chart.rows.some((row) => row.percent !== undefined);
  const labels = chart.seriesLabels ?? ["Значення", "Додатково", "Третій ряд"];
  return {
    id: `${chart.id}-data`,
    title: chart.title,
    columns: [
      "Категорія",
      labels[0] ?? "Значення",
      ...(hasSecondary ? [labels[1] ?? "Додатково"] : []),
      ...(hasTertiary ? [labels[2] ?? "Третій ряд"] : []),
      ...(hasTotal ? ["Усього"] : []),
      ...(hasPercent ? ["Частка, %"] : []),
    ],
    rows: chart.rows.map((row) => [
      row.label,
      row.value,
      ...(hasSecondary ? [row.secondary ?? null] : []),
      ...(hasTertiary ? [row.tertiary ?? null] : []),
      ...(hasTotal ? [row.total !== undefined ? familyTreeStatisticsRowTotal(row) : null] : []),
      ...(hasPercent ? [row.percent ?? null] : []),
    ]),
  };
}

export function exportStatisticsChartCsv(chart: FamilyTreeStatisticsChart): void {
  exportStatisticsTableCsv(chartTable(chart));
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number): string {
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function sheetXml(rows: unknown[][]): string {
  const rowMarkup = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
    const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
    return typeof cell === "number" && Number.isFinite(cell)
      ? `<c r="${ref}"><v>${cell}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowMarkup}</sheetData></worksheet>`;
}

export async function exportStatisticsExcel(
  payloads: Partial<Record<FamilyTreeStatisticsTabId, FamilyTreeStatisticsPayload>>,
): Promise<void> {
  const zip = new JSZip();
  const tabs = Object.entries(payloads).filter((entry): entry is [FamilyTreeStatisticsTabId, FamilyTreeStatisticsPayload] => Boolean(entry[1]));
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${tabs.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.folder("xl")?.file("workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map(([tab], index) => `<sheet name="${escapeXml(TAB_LABELS[tab])}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`);
  zip.folder("xl")?.folder("_rels")?.file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`);
  const sheetsFolder = zip.folder("xl")?.folder("worksheets");
  tabs.forEach(([tab, payload], index) => {
    const rows: unknown[][] = [[TAB_LABELS[tab]], ["Показник", "Значення", "Вибірка"]];
    payload.metrics.forEach((metric) => rows.push([metric.label, `${metric.value}${metric.suffix ?? ""}`, metric.sampleSize ?? ""]));
    payload.charts.forEach((chart) => {
      const table = chartTable(chart);
      rows.push([], [table.title], table.columns, ...table.rows);
    });
    payload.tables.forEach((table) => {
      rows.push([], [table.title], table.columns, ...table.rows);
    });
    sheetsFolder?.file(`sheet${index + 1}.xml`, sheetXml(rows));
  });
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const title = tabs[0]?.[1].meta.title ?? "Родове дерево";
  download(blob, `${safeFileName(title)} — статистика.xlsx`);
}

function statisticsLineChartSvg(chart: FamilyTreeStatisticsChart): string {
  const model = createFamilyTreeStatisticsLineChartModel(chart.rows);
  const headerHeight = 76;
  const canvasHeight = model.height + headerHeight;
  const linePath = model.points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${model.points.at(-1)?.x ?? model.plotRight} ${model.plotBottom} L ${model.points[0]?.x ?? model.plotLeft} ${model.plotBottom} Z`;
  const grid = model.yTicks.map((tick) => (
    `<line x1="${model.plotLeft}" y1="${tick.y}" x2="${model.plotRight}" y2="${tick.y}" stroke="#dbe4e0" stroke-width="1"/>`
  )).join("");
  const verticalGrid = model.xTicks.map((tick) => (
    `<line x1="${tick.x}" y1="${model.plotTop}" x2="${tick.x}" y2="${model.plotBottom}" stroke="#e9eeeb" stroke-width="1" stroke-dasharray="3 5"/>`
  )).join("");
  const yLabels = model.yTicks.map((tick) => (
    `<text x="${model.plotLeft - 11}" y="${tick.y + 4}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="#637974">${escapeXml(tick.label)}</text>`
  )).join("");
  const xLabels = model.xTicks.map((tick, index) => (
    `<text x="${tick.x}" y="${model.height - 18}" text-anchor="${index === 0 ? "start" : index === model.xTicks.length - 1 ? "end" : "middle"}" font-family="Arial,sans-serif" font-size="12" fill="#637974">${escapeXml(tick.label)}</text>`
  )).join("");
  const markers = model.points.length <= 48
    ? model.points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3.5" fill="#fffdf8" stroke="#17695f" stroke-width="2"><title>${escapeXml(point.row.label)}: ${escapeXml(point.row.value.toLocaleString("uk-UA"))}</title></circle>`).join("")
    : "";
  const subtitle = `Період: ${chart.rows[0]?.label ?? "—"} — ${chart.rows.at(-1)?.label ?? "—"} · Усього: ${model.total.toLocaleString("uk-UA")} · Максимум: ${model.peak.row.value.toLocaleString("uk-UA")} (${model.peak.row.label})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${Math.round(canvasHeight * 1.25)}" viewBox="0 0 ${model.width} ${canvasHeight}"><rect width="100%" height="100%" fill="#fbfaf5"/><text x="24" y="34" font-family="Georgia,serif" font-size="28" font-weight="700" fill="#0d3d36">${escapeXml(chart.title)}</text><text x="24" y="58" font-family="Arial,sans-serif" font-size="13" fill="#526b66">${escapeXml(subtitle)}</text><g transform="translate(0 ${headerHeight})">${grid}${verticalGrid}<line x1="${model.plotLeft}" y1="${model.plotTop}" x2="${model.plotLeft}" y2="${model.plotBottom}" stroke="#9db3ac" stroke-width="1.2"/><line x1="${model.plotLeft}" y1="${model.plotBottom}" x2="${model.plotRight}" y2="${model.plotBottom}" stroke="#9db3ac" stroke-width="1.2"/>${yLabels}${xLabels}<path d="${areaPath}" fill="#17695f" fill-opacity="0.08"/><path d="${linePath}" fill="none" stroke="#17695f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${markers}</g></svg>`;
}

export function statisticsChartSvg(chart: FamilyTreeStatisticsChart): string {
  const displayChart = familyTreeStatisticsChartForPresentation(chart);
  if (!displayChart.rows.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360"><rect width="100%" height="100%" fill="#fbfaf5"/><text x="28" y="48" font-family="Georgia,serif" font-size="32" font-weight="700" fill="#0d3d36">${escapeXml(displayChart.title)}</text><text x="28" y="110" font-family="Arial,sans-serif" font-size="20" fill="#637974">Недостатньо даних для діаграми.</text></svg>`;
  }
  if (displayChart.type === "line") return statisticsLineChartSvg(displayChart);
  const width = 1200;
  const rowHeight = 48;
  const height = Math.max(360, 120 + displayChart.rows.length * rowHeight);
  const max = Math.max(1, ...displayChart.rows.map(familyTreeStatisticsRowTotal));
  const body = displayChart.rows.map((row, index) => {
    const y = 95 + index * rowHeight;
    const primaryWidth = row.value ? Math.max(2, 760 * row.value / max) : 0;
    const secondaryWidth = row.secondary ? Math.max(2, 760 * row.secondary / max) : 0;
    const tertiaryWidth = row.tertiary ? Math.max(2, 760 * row.tertiary / max) : 0;
    return `<text x="28" y="${y + 20}" font-family="Arial,sans-serif" font-size="18" fill="#183a34">${escapeXml(row.label)}</text><rect x="330" y="${y}" width="760" height="28" rx="7" fill="#e7e8e2"/><rect x="330" y="${y}" width="${primaryWidth}" height="28" rx="7" fill="#17695f"/>${secondaryWidth ? `<rect x="${330 + primaryWidth}" y="${y}" width="${secondaryWidth}" height="28" fill="#d5a144"/>` : ""}${tertiaryWidth ? `<rect x="${330 + primaryWidth + secondaryWidth}" y="${y}" width="${tertiaryWidth}" height="28" fill="#9b638c"/>` : ""}<text x="1165" y="${y + 20}" text-anchor="end" font-family="Arial,sans-serif" font-size="17" fill="#183a34">${escapeXml(familyTreeStatisticsRowDisplayValue(displayChart, row))}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fbfaf5"/><text x="28" y="48" font-family="Georgia,serif" font-size="32" font-weight="700" fill="#0d3d36">${escapeXml(displayChart.title)}</text>${body}</svg>`;
}

export function exportStatisticsChartSvg(chart: FamilyTreeStatisticsChart): void {
  download(new Blob([statisticsChartSvg(chart)], { type: "image/svg+xml;charset=utf-8" }), `${safeFileName(chart.title)}.svg`);
}

export async function exportStatisticsChartPng(chart: FamilyTreeStatisticsChart): Promise<void> {
  const svg = statisticsChartSvg(chart);
  const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Не вдалося підготувати PNG."));
      image.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth * 2;
    canvas.height = image.naturalHeight * 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas недоступний.");
    context.scale(2, 2);
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG недоступний.")), "image/png"));
    download(blob, `${safeFileName(chart.title)}.png`);
  } finally {
    URL.revokeObjectURL(source);
  }
}

function filterSummary(filters: FamilyTreeStatisticsFilters): string {
  const labels = [
    `обсяг: ${filters.scope === "direct-ancestors" ? "прямі предки" : filters.scope === "descendants" ? "нащадки" : "усе дерево"}`,
    `гілка: ${filters.branch === "paternal" ? "батьківська" : filters.branch === "maternal" ? "материнська" : "усі"}`,
    filters.generationFrom !== undefined || filters.generationTo !== undefined ? `покоління: ${filters.generationFrom ?? "…"}–${filters.generationTo ?? "…"}` : "",
    filters.yearFrom !== undefined || filters.yearTo !== undefined ? `роки: ${filters.yearFrom ?? "…"}–${filters.yearTo ?? "…"}` : "",
    filters.sex !== "all" ? `стать: ${filters.sex}` : "",
    filters.lifeStatus !== "all" ? `статус: ${filters.lifeStatus}` : "",
    filters.relationshipType ? `тип зв’язку: ${filters.relationshipType}` : "",
    filters.evidenceStatuses.length ? `доказовість: ${filters.evidenceStatuses.join(", ")}` : "",
    filters.place ? `місце: ${filters.place}` : "",
    filters.importSourceKey ? `GEDCOM: ${filters.importSourceKey}` : "",
    filters.sourceFilter !== "all" ? `джерела: ${filters.sourceFilter === "with-sources" ? "є" : "немає"}` : "",
    filters.eventTypes.length ? `типи подій: ${filters.eventTypes.join(", ")}` : "",
    filters.surnameMode !== "displayed" ? `жіночі прізвища: ${filters.surnameMode === "birth" ? "при народженні" : "у шлюбі"}` : "",
  ].filter(Boolean);
  return labels.join("; ");
}

function reportSvg(payload: FamilyTreeStatisticsPayload, filters: FamilyTreeStatisticsFilters): string {
  const width = 1600;
  const height = Math.max(1800, 560 + payload.metrics.length * 54 + payload.charts.length * 310);
  const metrics = payload.metrics.map((metric, index) => `<text x="90" y="${360 + index * 54}" font-family="Arial,sans-serif" font-size="25" fill="#24443f">${escapeXml(metric.label)}: <tspan font-weight="700">${escapeXml(metric.value)}${escapeXml(metric.suffix ?? "")}</tspan></text>`).join("");
  const charts = payload.charts.map((chart, chartIndex) => {
    const y = 430 + payload.metrics.length * 54 + chartIndex * 310;
    const max = Math.max(1, ...chart.rows.map((row) => row.value));
    const rows = chart.rows.slice(0, 8).map((row, index) => `<text x="100" y="${y + 64 + index * 28}" font-family="Arial,sans-serif" font-size="18" fill="#24443f">${escapeXml(row.label)}</text><rect x="530" y="${y + 46 + index * 28}" width="${700 * row.value / max}" height="19" rx="5" fill="#17695f"/><text x="1260" y="${y + 63 + index * 28}" font-family="Arial,sans-serif" font-size="18" fill="#24443f">${row.value}</text>`).join("");
    return `<text x="90" y="${y + 24}" font-family="Georgia,serif" font-size="28" font-weight="700" fill="#0d3d36">${escapeXml(chart.title)}</text>${rows}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fbfaf5"/><text x="80" y="95" font-family="Georgia,serif" font-size="54" font-weight="700" fill="#0d3d36">Статистика родового дерева</text><text x="80" y="150" font-family="Arial,sans-serif" font-size="28" fill="#24443f">${escapeXml(payload.meta.title)}</text><text x="80" y="198" font-family="Arial,sans-serif" font-size="23" fill="#48645f">Коренева особа: ${escapeXml(payload.meta.rootPersonName)}</text><text x="80" y="238" font-family="Arial,sans-serif" font-size="20" fill="#48645f">Сформовано: ${escapeXml(new Date(payload.meta.calculatedAt).toLocaleString("uk-UA"))}</text><text x="80" y="274" font-family="Arial,sans-serif" font-size="18" fill="#48645f">Фільтри: ${escapeXml(filterSummary(filters))}</text>${metrics}${charts}<text x="80" y="${height - 90}" font-family="Arial,sans-serif" font-size="17" fill="#48645f">Методика: ${escapeXml(payload.meta.methodology)}</text></svg>`;
}

export async function exportStatisticsPdf(payload: FamilyTreeStatisticsPayload, filters: FamilyTreeStatisticsFilters): Promise<void> {
  const svg = reportSvg(payload, filters);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Не вдалося підготувати PDF-звіт."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas недоступний.");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF-зображення недоступне.")), "image/png"));
    const pdf = await PDFDocument.create();
    const embedded = await pdf.embedPng(await png.arrayBuffer());
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const scaledHeight = pageWidth * embedded.height / embedded.width;
    const pageCount = Math.max(1, Math.ceil(scaledHeight / pageHeight));
    for (let index = 0; index < pageCount; index += 1) {
      const page = pdf.addPage([pageWidth, pageHeight]);
      page.drawImage(embedded, { x: 0, y: pageHeight - scaledHeight + index * pageHeight, width: pageWidth, height: scaledHeight });
    }
    download(new Blob([await pdf.save()], { type: "application/pdf" }), `${safeFileName(payload.meta.title)} — статистика.pdf`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
