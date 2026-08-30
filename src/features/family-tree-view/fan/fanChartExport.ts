import {
  CIRCULAR_ANCESTOR_EXPORT_OPTIONS,
  DEFAULT_CIRCULAR_ANCESTOR_EXPORT_FORMAT,
  type CircularAncestorExportFormat,
} from "../circular/circularAncestorChartExport.ts";
import {
  loadTrackerRoduChartLogoDataUrl,
  prepareFamilyTreeChartBrandForExport,
} from "../export/familyTreeChartBrand.ts";

export type FanChartExportDirection = "ancestors" | "descendants";
export type FanChartExportFormat = CircularAncestorExportFormat;
export type FanChartPaperFormat = "A0" | "A1" | "A2" | "A3";

export interface FanChartExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FanChartExportMetadata {
  direction: FanChartExportDirection;
  focusLabel: string;
  generations: number;
  personCount: number;
  generatedAtLabel?: string;
}

export interface FanChartExportRequest extends FanChartExportMetadata {
  sourceSvg: SVGSVGElement;
  worldBounds: FanChartExportBounds;
  format: FanChartExportFormat;
}

export interface FanChartPrintDocumentInput extends FanChartExportMetadata {
  svgMarkup: string;
  paper: FanChartPaperFormat;
  documentTitle: string;
  worldBounds: FanChartExportBounds;
  legendColors?: {
    paternal: string;
    maternal: string;
    duplicate: string;
  };
}

/**
 * Fan charts deliberately share the exact same format catalogue as the
 * circular ancestor chart. Keeping the same object also prevents the two
 * menus from drifting when a format is added or renamed later.
 */
export const FAN_CHART_EXPORT_OPTIONS = CIRCULAR_ANCESTOR_EXPORT_OPTIONS;

export const DEFAULT_FAN_CHART_EXPORT_FORMAT: FanChartExportFormat =
  DEFAULT_CIRCULAR_ANCESTOR_EXPORT_FORMAT;

const PAPER_DIMENSIONS_MM: Record<
  FanChartPaperFormat,
  { shortSide: number; longSide: number }
> = {
  A0: { shortSide: 841, longSide: 1189 },
  A1: { shortSide: 594, longSide: 841 },
  A2: { shortSide: 420, longSide: 594 },
  A3: { shortSide: 297, longSide: 420 },
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const FAN_EXPORT_SVG_STYLES = `
  .fan-genealogy-grid path,
  .fan-genealogy-grid line {
    fill: none;
    stroke: var(--family-tree-chart-grid, #b8c8c2);
    stroke-width: 1;
  }
  .fan-genealogy-grid line {
    stroke: var(--family-tree-chart-grid, #9fb3ac);
    stroke-dasharray: 5 6;
  }
  .fan-genealogy-sector > path {
    fill: var(--ancestor-sector-fill, #d8e9df);
    stroke: var(--ancestor-sector-stroke, #476f64);
    stroke-width: .75;
  }
  .fan-genealogy-sector.is-duplicate > path {
    stroke: var(--family-tree-chart-duplicate-stroke, #b57d22);
    stroke-dasharray: 4 2;
  }
  .fan-genealogy-sector text,
  .fan-genealogy-focus text {
    fill: var(--ancestor-sector-foreground, var(--family-tree-chart-text, #173f36));
    font-family: Arial, "Noto Sans", system-ui, sans-serif;
    letter-spacing: -.015em;
  }
  .circular-ancestor-label-name,
  .fan-genealogy-label-name,
  .fan-genealogy-focus-name {
    fill: var(--ancestor-sector-foreground, var(--family-tree-chart-text, #173f36));
    font-weight: 700;
  }
  .circular-ancestor-label-life,
  .fan-genealogy-label-life,
  .fan-genealogy-focus-life {
    fill: var(--ancestor-sector-foreground, var(--family-tree-chart-muted-text, #536760));
    font-weight: 600;
    letter-spacing: 0;
  }
  .fan-genealogy-duplicate-mark {
    fill: var(--family-tree-chart-duplicate-fill, #b57d22);
    stroke: var(--family-tree-chart-duplicate-foreground, #fff8e8);
  }
  .fan-genealogy-focus circle {
    fill: var(--ancestor-sector-fill, var(--family-tree-chart-focus-fill, #fffdfa));
    stroke: var(--ancestor-sector-stroke, var(--family-tree-chart-focus-stroke, #497d6f));
    stroke-width: 2;
  }
`;

export async function exportFanChart(
  request: FanChartExportRequest,
): Promise<string> {
  const option = fanExportOption(request.format);
  const heading = fanChartHeading(request.direction);
  const documentTitle = `${heading} — ${request.focusLabel}`;
  const brandLogoDataUrl = await loadTrackerRoduChartLogoDataUrl();
  const svgMarkup = createFanChartExportSvg(request.sourceSvg, {
    worldBounds: request.worldBounds,
    direction: request.direction,
    title: documentTitle,
    description: `${request.generations} поколінь, ${request.personCount} позицій на діаграмі`,
    brandLogoDataUrl,
  });
  const baseFileName = fanChartExportFileName(
    request.direction,
    request.focusLabel,
    request.generations,
  );

  if (option.kind === "pdf" && option.paper) {
    const html = buildFanChartPrintDocument({
      svgMarkup,
      paper: option.paper,
      documentTitle,
      direction: request.direction,
      focusLabel: request.focusLabel,
      generations: request.generations,
      personCount: request.personCount,
      generatedAtLabel: request.generatedAtLabel,
      worldBounds: request.worldBounds,
      legendColors: {
        paternal: svgChartColor(
          request.sourceSvg,
          "--family-tree-chart-paternal-fill",
          "#cde5e3",
        ),
        maternal: svgChartColor(
          request.sourceSvg,
          "--family-tree-chart-maternal-fill",
          "#efd9e3",
        ),
        duplicate: svgChartColor(
          request.sourceSvg,
          "--family-tree-chart-duplicate-fill",
          "#f2d89e",
        ),
      },
    });
    openFanChartPrintWindow(html);
    return `Відкрито векторний макет ${option.paper}. У вікні друку виберіть «Зберегти як PDF».`;
  }

  if (option.kind === "svg") {
    downloadFanChartBlob(
      new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" }),
      `${baseFileName}.svg`,
    );
    return "SVG завантажено. Він містить усю діаграму та зберігає векторну чіткість.";
  }

  if (option.kind === "png" && option.pixelSize) {
    const dimensions = fanChartRasterDimensions(request.worldBounds, option.pixelSize);
    const png = await rasterizeFanChartSvg(svgMarkup, dimensions);
    downloadFanChartBlob(
      png,
      `${baseFileName}-${dimensions.width}x${dimensions.height}px.png`,
    );
    return `PNG ${dimensions.width} × ${dimensions.height} пікселів завантажено.`;
  }

  throw new Error("Обраний формат експорту не підтримується.");
}

export function createFanChartExportSvg(
  sourceSvg: SVGSVGElement,
  options: {
    worldBounds: FanChartExportBounds;
    direction: FanChartExportDirection;
    title: string;
    description: string;
    brandLogoDataUrl: string;
  },
): string {
  const bounds = normalizeFanChartExportBounds(options.worldBounds);
  const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
  const ownerDocument = sourceSvg.ownerDocument;

  clone.setAttribute("xmlns", SVG_NAMESPACE);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("version", "1.1");
  clone.setAttribute("data-generator", "Трекер Роду");
  clone.setAttribute("viewBox", fanChartExportViewBox(bounds));
  clone.setAttribute("width", String(bounds.width));
  clone.setAttribute("height", String(bounds.height));
  clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
  clone.setAttribute("role", "img");
  clone.setAttribute("aria-label", options.title);
  clone.setAttribute("shape-rendering", "geometricPrecision");
  clone.setAttribute("text-rendering", "geometricPrecision");
  clone.setAttribute("class", "fan-genealogy-export-chart");

  clone.querySelectorAll(".is-selected").forEach((element) => {
    element.classList.remove("is-selected");
  });
  clone.querySelectorAll(".fan-genealogy-sector").forEach((element) => {
    element.classList.add("is-highlighted");
  });

  let rootDefs = clone.querySelector(":scope > defs");
  if (!rootDefs) {
    rootDefs = ownerDocument.createElementNS(SVG_NAMESPACE, "defs");
    clone.insertBefore(rootDefs, clone.firstChild);
  }
  const style = ownerDocument.createElementNS(SVG_NAMESPACE, "style");
  style.textContent = FAN_EXPORT_SVG_STYLES;
  rootDefs.appendChild(style);

  const title = ownerDocument.createElementNS(SVG_NAMESPACE, "title");
  title.textContent = options.title;
  const description = ownerDocument.createElementNS(SVG_NAMESPACE, "desc");
  description.textContent = options.description;
  const metadata = ownerDocument.createElementNS(SVG_NAMESPACE, "metadata");
  metadata.textContent = "Створено у вебзастосунку «Трекер Роду»";
  const background = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
  background.setAttribute("x", String(bounds.x));
  background.setAttribute("y", String(bounds.y));
  background.setAttribute("width", String(bounds.width));
  background.setAttribute("height", String(bounds.height));
  background.setAttribute(
    "fill",
    sourceSvg.style.getPropertyValue("--family-tree-chart-background").trim() ||
      "#f7f5ee",
  );

  clone.insertBefore(background, clone.firstChild);
  clone.insertBefore(metadata, background);
  clone.insertBefore(description, background);
  clone.insertBefore(title, description);

  prepareFamilyTreeChartBrandForExport(
    clone,
    bounds,
    options.brandLogoDataUrl,
    options.direction === "descendants" ? "top-right" : "bottom-right",
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

export function buildFanChartPrintDocument(
  input: FanChartPrintDocumentInput,
): string {
  const dimensions = fanChartPaperDimensions(input.paper, input.worldBounds);
  const title = escapeHtml(input.documentTitle);
  const focusLabel = escapeHtml(input.focusLabel);
  const generatedAt = escapeHtml(input.generatedAtLabel ?? "");
  const paternalLegendColor = safeExportColor(input.legendColors?.paternal, "#cde5e3");
  const maternalLegendColor = safeExportColor(input.legendColors?.maternal, "#efd9e3");
  const duplicateLegendColor = safeExportColor(input.legendColors?.duplicate, "#f2d89e");
  const embeddedSvg = input.svgMarkup.replace(/^<\?xml[^>]*>\s*/i, "");
  const heading = fanChartHeading(input.direction);
  const chartAriaLabel = input.direction === "ancestors"
    ? "Віялова діаграма предків"
    : "Віялова діаграма нащадків";
  const legend = input.direction === "ancestors"
    ? `<span><i class="paternal"></i>Батьківська гілка</span>
        <span><i class="maternal"></i>Материнська гілка</span>
        <span><i class="duplicate"></i>Повторний предок</span>`
    : `<span><i class="descendant"></i>Гілки дітей</span>
        <span><i class="duplicate"></i>Повторна особа</span>`;

  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="author" content="Трекер Роду">
  <meta name="generator" content="Трекер Роду">
  <title>${title}</title>
  <style>
    @page { size: ${dimensions.width}mm ${dimensions.height}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #e8ece9; }
    body { color: #173f36; font-family: Arial, "Noto Sans", system-ui, sans-serif; }
    .poster-page {
      width: 100vw;
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 4mm;
      padding: 10mm;
      overflow: hidden;
      background: #fffdfa;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .poster-header { display: flex; align-items: end; justify-content: space-between; gap: 12mm; }
    .poster-header h1 { margin: 0 0 1.5mm; font: 700 7mm/1.08 Georgia, "Times New Roman", serif; }
    .poster-header p { margin: 0; color: #536760; font-size: 3.4mm; }
    .poster-format { flex: 0 0 auto; color: #536760; font-size: 3.2mm; font-weight: 700; }
    .chart-frame { min-width: 0; min-height: 0; display: grid; place-items: center; }
    .chart-frame svg { display: block; width: 100%; height: 100%; }
    .poster-footer { display: flex; align-items: center; justify-content: space-between; gap: 8mm; color: #536760; font-size: 3mm; }
    .poster-brand { display: inline-flex; align-items: center; gap: 2mm; white-space: nowrap; }
    .poster-brand strong { color: #174c40; font-family: Georgia, "Times New Roman", serif; font-size: 3.5mm; }
    .legend { display: flex; align-items: center; gap: 6mm; }
    .legend span { display: inline-flex; align-items: center; gap: 1.6mm; }
    .legend i { width: 4mm; height: 4mm; border: .35mm solid #78978e; border-radius: 50%; }
    .legend .paternal { background: ${paternalLegendColor}; }
    .legend .maternal { background: ${maternalLegendColor}; }
    .legend .descendant { background: #d8e9df; }
    .legend .duplicate { background: ${duplicateLegendColor}; border-style: dashed; }
    .screen-help {
      position: fixed;
      z-index: 5;
      right: 18px;
      top: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      color: #fff;
      background: #173f36;
      box-shadow: 0 12px 30px rgba(0,0,0,.22);
      font-size: 13px;
    }
    .screen-help button { padding: 8px 12px; border: 0; border-radius: 7px; color: #173f36; background: #fff; font-weight: 700; cursor: pointer; }
    @media print {
      html, body { width: 100%; height: 100%; background: #fff; }
      .screen-help { display: none; }
    }
  </style>
</head>
<body>
  <div class="screen-help">
    <span>Оберіть принтер або «Зберегти як PDF».</span>
    <button type="button" onclick="window.print()">Друк / PDF</button>
  </div>
  <main class="poster-page">
    <header class="poster-header">
      <div>
        <h1>${heading}</h1>
        <p>${focusLabel} · поколінь: ${input.generations} · позицій: ${input.personCount}</p>
      </div>
      <span class="poster-format">${input.paper} · векторний макет</span>
    </header>
    <section class="chart-frame" aria-label="${chartAriaLabel}">
      ${embeddedSvg}
    </section>
    <footer class="poster-footer">
      <div class="legend">
        ${legend}
      </div>
      <span class="poster-brand"><strong>Трекер Роду</strong>${generatedAt ? ` · ${generatedAt}` : ""}</span>
    </footer>
  </main>
</body>
</html>`;
}

export function fanChartExportFileName(
  direction: FanChartExportDirection,
  focusLabel: string,
  generations: number,
): string {
  const safeLabel = focusLabel
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "особа";
  const directionLabel = direction === "ancestors" ? "предків" : "нащадків";
  return `віялова-діаграма-${directionLabel}-${safeLabel}-${generations}-поколінь`;
}

export function fanChartExportViewBox(bounds: FanChartExportBounds): string {
  const normalized = normalizeFanChartExportBounds(bounds);
  return [normalized.x, normalized.y, normalized.width, normalized.height].join(" ");
}

/** The selected resolution is applied to the longest side without distortion. */
export function fanChartRasterDimensions(
  bounds: FanChartExportBounds,
  longestSide: number,
): { width: number; height: number } {
  const normalized = normalizeFanChartExportBounds(bounds);
  if (!Number.isFinite(longestSide) || longestSide <= 0) {
    throw new Error("Некоректна роздільна здатність PNG.");
  }
  if (normalized.width >= normalized.height) {
    return {
      width: Math.round(longestSide),
      height: Math.max(1, Math.round(longestSide * normalized.height / normalized.width)),
    };
  }
  return {
    width: Math.max(1, Math.round(longestSide * normalized.width / normalized.height)),
    height: Math.round(longestSide),
  };
}

export function fanChartPaperDimensions(
  paper: FanChartPaperFormat,
  bounds: FanChartExportBounds,
): { width: number; height: number } {
  const normalized = normalizeFanChartExportBounds(bounds);
  const paperDimensions = PAPER_DIMENSIONS_MM[paper];
  if (normalized.width >= normalized.height) {
    return { width: paperDimensions.longSide, height: paperDimensions.shortSide };
  }
  return { width: paperDimensions.shortSide, height: paperDimensions.longSide };
}

function normalizeFanChartExportBounds(
  bounds: FanChartExportBounds,
): FanChartExportBounds {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error("Не вдалося визначити повні межі віялової діаграми.");
  }
  return bounds;
}

function fanChartHeading(direction: FanChartExportDirection): string {
  return direction === "ancestors"
    ? "Віялова діаграма предків"
    : "Віялова діаграма нащадків";
}

function fanExportOption(format: FanChartExportFormat) {
  const option = FAN_CHART_EXPORT_OPTIONS.find((item) => item.value === format);
  if (!option) throw new Error("Невідомий формат експорту.");
  return option;
}

function svgChartColor(
  sourceSvg: SVGSVGElement,
  property: string,
  fallback: string,
): string {
  return safeExportColor(sourceSvg.style.getPropertyValue(property), fallback);
}

function safeExportColor(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function openFanChartPrintWindow(html: string): void {
  const printWindow = window.open("", "_blank", "popup,width=1280,height=900");
  if (!printWindow) {
    throw new Error("Браузер заблокував вікно друку. Дозвольте спливні вікна для Трекера Роду й повторіть спробу.");
  }
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 450);
}

async function rasterizeFanChartSvg(
  svgMarkup: string,
  dimensions: { width: number; height: number },
): Promise<Blob> {
  const source = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const sourceUrl = URL.createObjectURL(source);
  const image = new Image();

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Не вдалося підготувати SVG для PNG."));
      image.src = sourceUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Браузер не підтримує створення PNG потрібного розміру.");

    context.fillStyle = "#f7f5ee";
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);

    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob
          ? resolve(blob)
          : reject(new Error("Браузеру не вистачило пам’яті для створення PNG.")),
        "image/png",
      );
    });
    canvas.width = 1;
    canvas.height = 1;
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function downloadFanChartBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
