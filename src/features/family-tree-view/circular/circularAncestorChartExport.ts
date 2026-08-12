export type CircularAncestorExportFormat =
  | "pdf-a0"
  | "pdf-a1"
  | "pdf-a2"
  | "pdf-a3"
  | "svg"
  | "png-4k"
  | "png-8k";

type CircularAncestorPaperFormat = "A0" | "A1" | "A2" | "A3";

interface CircularAncestorExportOption {
  value: CircularAncestorExportFormat;
  label: string;
  kind: "pdf" | "svg" | "png";
  paper?: CircularAncestorPaperFormat;
  pixelSize?: number;
}

export const DEFAULT_CIRCULAR_ANCESTOR_EXPORT_FORMAT: CircularAncestorExportFormat =
  "pdf-a0";

export const CIRCULAR_ANCESTOR_EXPORT_OPTIONS: readonly CircularAncestorExportOption[] = [
  { value: "pdf-a0", label: "PDF A0 · вектор", kind: "pdf", paper: "A0" },
  { value: "pdf-a1", label: "PDF A1 · вектор", kind: "pdf", paper: "A1" },
  { value: "pdf-a2", label: "PDF A2 · вектор", kind: "pdf", paper: "A2" },
  { value: "pdf-a3", label: "PDF A3 · вектор", kind: "pdf", paper: "A3" },
  { value: "svg", label: "SVG · вектор для типографії", kind: "svg" },
  { value: "png-4k", label: "PNG 4K · для екрана", kind: "png", pixelSize: 4096 },
  { value: "png-8k", label: "PNG 8K · високоякісний", kind: "png", pixelSize: 8192 },
] as const;

const PAPER_DIMENSIONS_MM: Record<
  CircularAncestorPaperFormat,
  { width: number; height: number }
> = {
  A0: { width: 841, height: 1189 },
  A1: { width: 594, height: 841 },
  A2: { width: 420, height: 594 },
  A3: { width: 297, height: 420 },
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const EXPORT_SVG_STYLES = `
  .circular-ancestor-ring-grid circle {
    fill: none;
    stroke: #b8c8c2;
    stroke-width: 1;
  }
  .circular-ancestor-ring-grid line {
    stroke: #9fb3ac;
    stroke-dasharray: 5 6;
    stroke-width: 1;
  }
  .circular-ancestor-sector > path {
    stroke: #476f64;
    stroke-width: .75;
  }
  .circular-ancestor-sector.is-paternal > path { fill: #cde5e3; }
  .circular-ancestor-sector.is-maternal > path { fill: #efd9e3; }
  .circular-ancestor-sector.is-focus > path { fill: #dce9df; }
  .circular-ancestor-sector.is-duplicate > path { stroke-dasharray: 4 2; }
  .circular-ancestor-sector text,
  .circular-ancestor-focus text {
    fill: #173f36;
    font-family: Arial, "Noto Sans", system-ui, sans-serif;
    letter-spacing: -.015em;
  }
  .circular-ancestor-label-name {
    fill: #173f36;
    font-weight: 700;
  }
  .circular-ancestor-label-life {
    fill: #536760;
    font-weight: 600;
    letter-spacing: 0;
  }
  .circular-ancestor-label-inline {
    fill: #173f36;
    font-weight: 700;
    letter-spacing: -.01em;
  }
  .circular-ancestor-duplicate-mark {
    fill: #b57d22;
    stroke: #fff8e8;
  }
  .circular-ancestor-focus circle {
    fill: #fffdfa;
    stroke: #497d6f;
    stroke-width: 2;
  }
  .circular-ancestor-focus-initials {
    fill: #1e6254;
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 700;
  }
`;

export interface CircularAncestorExportMetadata {
  focusLabel: string;
  generations: number;
  ancestorCount: number;
  generatedAtLabel?: string;
}

interface CircularAncestorExportRequest extends CircularAncestorExportMetadata {
  sourceSvg: SVGSVGElement;
  worldSize: number;
  format: CircularAncestorExportFormat;
}

interface CircularAncestorPrintDocumentInput extends CircularAncestorExportMetadata {
  svgMarkup: string;
  paper: CircularAncestorPaperFormat;
  documentTitle: string;
}

export async function exportCircularAncestorChart(
  request: CircularAncestorExportRequest,
): Promise<string> {
  const option = exportOption(request.format);
  const documentTitle = `Кругова діаграма предків — ${request.focusLabel}`;
  const svgMarkup = createCircularAncestorExportSvg(request.sourceSvg, {
    worldSize: request.worldSize,
    title: documentTitle,
    description: `${request.generations} поколінь, ${request.ancestorCount} позицій предків`,
  });
  const baseFileName = circularAncestorExportFileName(
    request.focusLabel,
    request.generations,
  );

  if (option.kind === "pdf" && option.paper) {
    const html = buildCircularAncestorPrintDocument({
      svgMarkup,
      paper: option.paper,
      documentTitle,
      focusLabel: request.focusLabel,
      generations: request.generations,
      ancestorCount: request.ancestorCount,
      generatedAtLabel: request.generatedAtLabel,
    });
    openCircularAncestorPrintWindow(html);
    return `Відкрито векторний макет ${option.paper}. У вікні друку виберіть «Зберегти як PDF».`;
  }

  if (option.kind === "svg") {
    downloadBlob(
      new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" }),
      `${baseFileName}.svg`,
    );
    return "SVG завантажено. Він зберігає векторну чіткість у будь-якому масштабі.";
  }

  if (option.kind === "png" && option.pixelSize) {
    const png = await rasterizeCircularAncestorSvg(svgMarkup, option.pixelSize);
    downloadBlob(png, `${baseFileName}-${option.pixelSize}px.png`);
    return `PNG ${option.pixelSize} × ${option.pixelSize} пікселів завантажено.`;
  }

  throw new Error("Обраний формат експорту не підтримується.");
}

export function createCircularAncestorExportSvg(
  sourceSvg: SVGSVGElement,
  options: { worldSize: number; title: string; description: string },
): string {
  if (!Number.isFinite(options.worldSize) || options.worldSize <= 0) {
    throw new Error("Не вдалося визначити повний розмір діаграми.");
  }

  const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
  const ownerDocument = sourceSvg.ownerDocument;
  const origin = -options.worldSize / 2;

  clone.setAttribute("xmlns", SVG_NAMESPACE);
  clone.setAttribute("version", "1.1");
  clone.setAttribute("viewBox", `${origin} ${origin} ${options.worldSize} ${options.worldSize}`);
  clone.setAttribute("width", String(options.worldSize));
  clone.setAttribute("height", String(options.worldSize));
  clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
  clone.setAttribute("role", "img");
  clone.setAttribute("aria-label", options.title);
  clone.setAttribute("shape-rendering", "geometricPrecision");
  clone.setAttribute("text-rendering", "geometricPrecision");
  clone.setAttribute("class", "circular-ancestor-export-chart");

  clone.querySelectorAll(".is-selected").forEach((element) => {
    element.classList.remove("is-selected");
  });
  clone.querySelectorAll(".circular-ancestor-sector").forEach((element) => {
    element.classList.add("is-highlighted");
  });

  let rootDefs = clone.querySelector(":scope > defs");
  if (!rootDefs) {
    rootDefs = ownerDocument.createElementNS(SVG_NAMESPACE, "defs");
    clone.insertBefore(rootDefs, clone.firstChild);
  }
  const style = ownerDocument.createElementNS(SVG_NAMESPACE, "style");
  style.textContent = EXPORT_SVG_STYLES;
  rootDefs.appendChild(style);

  const title = ownerDocument.createElementNS(SVG_NAMESPACE, "title");
  title.textContent = options.title;
  const description = ownerDocument.createElementNS(SVG_NAMESPACE, "desc");
  description.textContent = options.description;
  const background = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
  background.setAttribute("x", String(origin));
  background.setAttribute("y", String(origin));
  background.setAttribute("width", String(options.worldSize));
  background.setAttribute("height", String(options.worldSize));
  background.setAttribute("fill", "#f7f5ee");

  clone.insertBefore(background, clone.firstChild);
  clone.insertBefore(description, background);
  clone.insertBefore(title, description);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

export function buildCircularAncestorPrintDocument(
  input: CircularAncestorPrintDocumentInput,
): string {
  const dimensions = PAPER_DIMENSIONS_MM[input.paper];
  const title = escapeHtml(input.documentTitle);
  const focusLabel = escapeHtml(input.focusLabel);
  const generatedAt = escapeHtml(input.generatedAtLabel ?? "");
  const embeddedSvg = input.svgMarkup.replace(/^<\?xml[^>]*>\s*/i, "");

  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    .legend { display: flex; align-items: center; gap: 6mm; }
    .legend span { display: inline-flex; align-items: center; gap: 1.6mm; }
    .legend i { width: 4mm; height: 4mm; border: .35mm solid #78978e; border-radius: 50%; }
    .legend .paternal { background: #cde5e3; }
    .legend .maternal { background: #efd9e3; }
    .legend .duplicate { background: #f2d89e; border-style: dashed; }
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
        <h1>Кругова діаграма прямих предків</h1>
        <p>${focusLabel} · поколінь: ${input.generations} · позицій предків: ${input.ancestorCount}</p>
      </div>
      <span class="poster-format">${input.paper} · векторний макет</span>
    </header>
    <section class="chart-frame" aria-label="Кругова діаграма предків">
      ${embeddedSvg}
    </section>
    <footer class="poster-footer">
      <div class="legend">
        <span><i class="paternal"></i>Батьківська гілка</span>
        <span><i class="maternal"></i>Материнська гілка</span>
        <span><i class="duplicate"></i>Повторний предок</span>
      </div>
      <span>${generatedAt}</span>
    </footer>
  </main>
</body>
</html>`;
}

export function circularAncestorExportFileName(
  focusLabel: string,
  generations: number,
): string {
  const safeLabel = focusLabel
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "особа";
  return `кругова-діаграма-${safeLabel}-${generations}-поколінь`;
}

function exportOption(format: CircularAncestorExportFormat): CircularAncestorExportOption {
  const option = CIRCULAR_ANCESTOR_EXPORT_OPTIONS.find((item) => item.value === format);
  if (!option) throw new Error("Невідомий формат експорту.");
  return option;
}

function openCircularAncestorPrintWindow(html: string): void {
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

async function rasterizeCircularAncestorSvg(
  svgMarkup: string,
  pixelSize: number,
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
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Браузер не підтримує створення PNG потрібного розміру.");

    context.fillStyle = "#f7f5ee";
    context.fillRect(0, 0, pixelSize, pixelSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, pixelSize, pixelSize);

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

function downloadBlob(blob: Blob, fileName: string): void {
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
