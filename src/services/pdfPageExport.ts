import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

export type PdfPageImageFormat = "png" | "jpeg";
export type PdfExportFormat = "pdf" | PdfPageImageFormat | "zip-png" | "zip-jpeg";
export type PdfSubsetExportStrategy = "vector" | "server" | "rasterized";

export interface PdfClientExportLimits {
  maxSourceBytes: number;
  maxPages: number;
  maxImageSide: number;
  imageScale: number;
  maxZipTotalPixels: number;
  maxZipMemoryBytes: number;
}

export interface PdfZipBudgetUsage {
  totalPixels: number;
  largestPagePixels: number;
  encodedBytes: number;
}

export interface PdfPageImageExportOptions {
  /** Requested render scale. It is still capped by the configured scale and maximum side. */
  scale?: number;
  /** JPEG encoder quality in the inclusive range 0.1..1. Ignored for PNG. */
  jpegQuality?: number;
}

export interface PdfExportDeduplicationInput {
  documentId: string;
  sourceIdentity: string;
  sourceVersion: string;
  pages: readonly number[];
  format: PdfExportFormat;
  destinationPath?: readonly string[];
  renderMode?: PdfSubsetExportStrategy;
  imageScale?: number;
  jpegQuality?: number;
}

export const DEFAULT_PDF_CLIENT_EXPORT_LIMITS: PdfClientExportLimits = {
  maxSourceBytes: 128 * 1024 * 1024,
  maxPages: 100,
  maxImageSide: 4_096,
  imageScale: 2,
  maxZipTotalPixels: 80_000_000,
  maxZipMemoryBytes: 384 * 1024 * 1024,
};

export function pdfClientExportLimits(
  env: Readonly<Record<string, string | undefined>> = import.meta.env,
): PdfClientExportLimits {
  return {
    maxSourceBytes: positiveEnvironmentInteger(
      env.VITE_PDF_CLIENT_EXPORT_MAX_BYTES,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.maxSourceBytes,
    ),
    maxPages: positiveEnvironmentInteger(
      env.VITE_PDF_CLIENT_EXPORT_MAX_PAGES,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.maxPages,
    ),
    maxImageSide: positiveEnvironmentInteger(
      env.VITE_PDF_EXPORT_MAX_IMAGE_SIDE,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.maxImageSide,
    ),
    imageScale: positiveEnvironmentNumber(
      env.VITE_PDF_EXPORT_IMAGE_SCALE,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.imageScale,
    ),
    maxZipTotalPixels: positiveEnvironmentInteger(
      env.VITE_PDF_EXPORT_MAX_ZIP_PIXELS,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.maxZipTotalPixels,
    ),
    maxZipMemoryBytes: positiveEnvironmentInteger(
      env.VITE_PDF_EXPORT_MAX_ZIP_MEMORY_BYTES,
      DEFAULT_PDF_CLIENT_EXPORT_LIMITS.maxZipMemoryBytes,
    ),
  };
}

/** Returns the first usable byte size without letting a persisted zero hide a later fallback. */
export function firstKnownPositiveSize(
  ...candidates: ReadonlyArray<number | null | undefined>
): number | undefined {
  return candidates.find((value): value is number => (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
  ));
}

/** Parses a 1-based page expression such as `1-5, 8, 12-15`. */
export function parsePageRange(
  input: string,
  totalPages: number,
  maxPages = Number.POSITIVE_INFINITY,
): number[] {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
    throw new Error("Документ не містить доступних сторінок для експорту.");
  }
  const value = input.trim();
  if (!value) throw new Error("Укажіть сторінку або діапазон сторінок.");

  const pages = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error("Перевірте діапазон: між комами пропущено номер сторінки.");
    const single = /^(\d+)$/u.exec(part);
    const range = /^(\d+)\s*-\s*(\d+)$/u.exec(part);
    if (!single && !range) {
      throw new Error(`Некоректний фрагмент діапазону «${part}». Використайте формат 1-5, 8.`);
    }
    const first = Number(single?.[1] ?? range?.[1]);
    const last = Number(single?.[1] ?? range?.[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1) {
      throw new Error("Номери сторінок мають бути цілими числами від 1.");
    }
    if (first > last) {
      throw new Error(`У діапазоні «${part}» початкова сторінка більша за кінцеву.`);
    }
    if (last > totalPages) {
      throw new Error(`Сторінка ${last} виходить за межі документа (${totalPages} стор.).`);
    }
    for (let page = first; page <= last; page += 1) {
      pages.add(page);
      if (pages.size > maxPages) {
        throw new Error(`За одну операцію можна експортувати не більше ${maxPages} сторінок.`);
      }
    }
  }
  return [...pages].sort((left, right) => left - right);
}

export function pdfExportFileName(
  documentTitle: string,
  pages: readonly number[],
  extension: "pdf" | "png" | "jpg" | "zip",
): string {
  if (!pages.length) throw new Error("Для назви експорту потрібна хоча б одна сторінка.");
  const base = sanitizeFileName(documentTitle) || "документ";
  const suffix = pages.length === 1
    ? `сторінка-${padPage(pages[0]!)}`
    : `сторінки-${padPage(Math.min(...pages))}-${padPage(Math.max(...pages))}`;
  return `${base}_${suffix}.${extension}`;
}

export async function createPdfSubsetBlob(
  sourceBytes: Uint8Array,
  pages: readonly number[],
  limits: PdfClientExportLimits = DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  validateClientExportSize(sourceBytes.byteLength, pages.length, limits);
  const { PDFDocument } = await import("pdf-lib");
  throwIfAborted(signal);
  const source = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  const totalPages = source.getPageCount();
  validatePageNumbers(pages, totalPages);
  const result = await PDFDocument.create();
  const copied = await result.copyPages(source, pages.map((page) => page - 1));
  throwIfAborted(signal);
  for (const page of copied) result.addPage(page);
  const bytes = await result.save({ useObjectStreams: true });
  throwIfAborted(signal);
  return new Blob([bytes], { type: "application/pdf" });
}

/**
 * Chooses the only client strategy that may materialize the complete source.
 * Large and unknown-size sources stay inside PDF.js range loading and are
 * rebuilt from selected, sequentially rendered pages.
 */
export function choosePdfSubsetExportStrategy(
  sourceBytes: number | null | undefined,
  selectedPages: number,
  limits: PdfClientExportLimits = DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
): PdfSubsetExportStrategy {
  validateSelectedPageCount(selectedPages, limits.maxPages);
  return typeof sourceBytes === "number"
    && Number.isSafeInteger(sourceBytes)
    && sourceBytes > 0
    && sourceBytes <= limits.maxSourceBytes
    ? "vector"
    : "rasterized";
}

/**
 * Builds a new PDF without calling `PDFDocumentProxy.getData()`. PDF.js loads
 * only the ranges required for each selected page, while one canvas is kept in
 * memory at a time. The resulting pages are JPEG-backed to keep large scans
 * bounded and portable.
 */
export async function createRasterizedPdfSubsetBlob(
  document: PDFDocumentProxy,
  pages: readonly number[],
  limits: PdfClientExportLimits = DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
  signal?: AbortSignal,
  options: PdfPageImageExportOptions = {},
): Promise<Blob> {
  throwIfAborted(signal);
  validatePageNumbers(pages, document.numPages);
  validateSelectedPageCount(pages.length, limits.maxPages);
  const { PDFDocument } = await import("pdf-lib");
  const result = await PDFDocument.create();
  let usage: PdfZipBudgetUsage = { totalPixels: 0, largestPagePixels: 0, encodedBytes: 0 };

  for (const pageNumber of pages) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber);
    try {
      const pagePixels = pdfPageRenderPixels(page, limits, options);
      usage = {
        ...usage,
        totalPixels: usage.totalPixels + pagePixels,
        largestPagePixels: Math.max(usage.largestPagePixels, pagePixels),
      };
      validateRasterExportBudget(usage, limits, "PDF");

      const image = await renderLoadedPdfPageImage(page, "jpeg", limits, signal, options);
      usage = { ...usage, encodedBytes: usage.encodedBytes + image.size };
      validateRasterExportBudget(usage, limits, "PDF");
      throwIfAborted(signal);

      const viewport = page.getViewport({ scale: 1 });
      const width = Math.max(1, viewport.width);
      const height = Math.max(1, viewport.height);
      const embedded = await result.embedJpg(await image.arrayBuffer());
      const outputPage = result.addPage([width, height]);
      outputPage.drawImage(embedded, { x: 0, y: 0, width, height });
    } finally {
      page.cleanup();
    }
  }

  throwIfAborted(signal);
  const bytes = await result.save({ useObjectStreams: true });
  throwIfAborted(signal);
  return new Blob([bytes], { type: "application/pdf" });
}

export async function renderPdfPageImage(
  document: PDFDocumentProxy,
  pageNumber: number,
  format: PdfPageImageFormat,
  limits: PdfClientExportLimits = DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
  signal?: AbortSignal,
  options: PdfPageImageExportOptions = {},
): Promise<Blob> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
    throw new Error(`Сторінка ${pageNumber} недоступна в цьому PDF.`);
  }
  const page = await document.getPage(pageNumber);
  try {
    return await renderLoadedPdfPageImage(page, format, limits, signal, options);
  } finally {
    page.cleanup();
  }
}

async function renderLoadedPdfPageImage(
  page: PDFPageProxy,
  format: PdfPageImageFormat,
  limits: PdfClientExportLimits,
  signal?: AbortSignal,
  options: PdfPageImageExportOptions = {},
): Promise<Blob> {
  throwIfAborted(signal);
  const unscaled = page.getViewport({ scale: 1 });
  const requestedScale = normalizedImageScale(options.scale, limits.imageScale);
  const longestSide = Math.max(unscaled.width, unscaled.height);
  const scale = longestSide > 0
    ? Math.min(requestedScale, limits.maxImageSide / longestSide)
    : requestedScale;
  const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
  const canvas = documentCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не зміг підготувати сторінку для експорту.");
  const task = page.render({ canvas, viewport, background: "rgb(255,255,255)" });
  try {
    await waitForRenderTask(task, signal);
    throwIfAborted(signal);
    const blob = await canvasToBlob(canvas, format, options.jpegQuality);
    throwIfAborted(signal);
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function createPageImagesZip(
  document: PDFDocumentProxy,
  pages: readonly number[],
  format: PdfPageImageFormat,
  documentTitle: string,
  limits: PdfClientExportLimits = DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
  signal?: AbortSignal,
  options: PdfPageImageExportOptions = {},
): Promise<Blob> {
  throwIfAborted(signal);
  validatePageNumbers(pages, document.numPages);
  validateSelectedPageCount(pages.length, limits.maxPages);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const extension = format === "jpeg" ? "jpg" : "png";
  const base = sanitizeFileName(documentTitle) || "документ";
  let usage: PdfZipBudgetUsage = { totalPixels: 0, largestPagePixels: 0, encodedBytes: 0 };
  for (const pageNumber of pages) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber);
    let image: Blob;
    try {
      const pagePixels = pdfPageRenderPixels(page, limits, options);
      usage = {
        ...usage,
        totalPixels: usage.totalPixels + pagePixels,
        largestPagePixels: Math.max(usage.largestPagePixels, pagePixels),
      };
      validateZipExportBudget(usage, limits);
      image = await renderLoadedPdfPageImage(page, format, limits, signal, options);
    } finally {
      page.cleanup();
    }
    usage = { ...usage, encodedBytes: usage.encodedBytes + image.size };
    validateZipExportBudget(usage, limits);
    zip.file(`${base}_сторінка-${padPage(pageNumber)}.${extension}`, image);
  }
  return zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    () => throwIfAborted(signal),
  );
}

/**
 * Must be called before `PDFDocumentProxy.getData()`. Unknown sizes are not a
 * safe client-side strategy and must be routed to the server export path.
 */
export function validateKnownClientExportSize(
  sourceBytes: number | null | undefined,
  selectedPages: number,
  limits: PdfClientExportLimits,
): number {
  if (typeof sourceBytes !== "number" || !Number.isSafeInteger(sourceBytes) || sourceBytes <= 0) {
    throw new Error(
      "Розмір PDF невідомий. Для безпечного експорту використайте серверне формування файла.",
    );
  }
  validateClientExportSize(sourceBytes, selectedPages, limits);
  return sourceBytes;
}

export function validateZipExportBudget(
  usage: PdfZipBudgetUsage,
  limits: PdfClientExportLimits,
): void {
  validateRasterExportBudget(usage, limits, "ZIP");
}

function validateRasterExportBudget(
  usage: PdfZipBudgetUsage,
  limits: PdfClientExportLimits,
  output: "PDF" | "ZIP",
): void {
  const values = [usage.totalPixels, usage.largestPagePixels, usage.encodedBytes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Не вдалося безпечно оцінити розмір ${output}-експорту.`);
  }
  if (usage.totalPixels > limits.maxZipTotalPixels) {
    throw new Error(
      `Вибрані сторінки завеликі для ${output}-експорту у браузері. `
      + `Сумарний ліміт: ${limits.maxZipTotalPixels.toLocaleString("uk-UA")} пікселів.`,
    );
  }
  const estimatedMemoryBytes = usage.largestPagePixels * 4 + usage.encodedBytes * 3;
  if (estimatedMemoryBytes > limits.maxZipMemoryBytes) {
    throw new Error(
      `${output}-експорт потребує забагато пам’яті браузера (оцінка ${formatBytes(estimatedMemoryBytes)}). `
      + `Ліміт: ${formatBytes(limits.maxZipMemoryBytes)}.`,
    );
  }
}

/** Stable, non-secret Google Drive appProperty for one logical export. */
export function pdfExportDeduplicationKey(input: PdfExportDeduplicationInput): string {
  const documentId = requiredDeduplicationPart(input.documentId, "documentId");
  const sourceIdentity = requiredDeduplicationPart(input.sourceIdentity, "sourceIdentity");
  const sourceVersion = requiredDeduplicationPart(input.sourceVersion, "sourceVersion");
  const pages = [...new Set(input.pages)].sort((left, right) => left - right);
  if (!pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error("Для ключа повторного експорту потрібні коректні номери сторінок.");
  }
  const imageScale = normalizedOptionalNumber(input.imageScale);
  const jpegQuality = normalizedOptionalNumber(input.jpegQuality);
  const payload = JSON.stringify({
    documentId,
    sourceIdentity,
    sourceVersion,
    pages,
    format: input.format,
    destinationPath: (input.destinationPath ?? []).map((part) => part.trim()).filter(Boolean),
    ...(input.renderMode ? { renderMode: input.renderMode } : {}),
    ...(imageScale === null ? {} : { imageScale }),
    ...(jpegQuality === null ? {} : { jpegQuality }),
  });
  return `pdf-export:v1:${fnv1a64(payload)}`;
}

export function downloadGeneratedFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function validateClientExportSize(
  sourceBytes: number,
  selectedPages: number,
  limits: PdfClientExportLimits,
): void {
  if (sourceBytes > limits.maxSourceBytes) {
    throw new Error(
      `PDF завеликий для безпечного експорту у браузері (${formatBytes(sourceBytes)}). `
      + `Ліміт: ${formatBytes(limits.maxSourceBytes)}.`,
    );
  }
  validateSelectedPageCount(selectedPages, limits.maxPages);
}

function validateSelectedPageCount(selectedPages: number, maxPages: number): void {
  if (!Number.isSafeInteger(selectedPages) || selectedPages < 1) {
    throw new Error("Для експорту потрібно вибрати хоча б одну сторінку.");
  }
  if (selectedPages > maxPages) {
    throw new Error(`За одну операцію можна експортувати не більше ${maxPages} сторінок.`);
  }
}

function pdfPageRenderPixels(
  page: PDFPageProxy,
  limits: PdfClientExportLimits,
  options: PdfPageImageExportOptions = {},
): number {
  const unscaled = page.getViewport({ scale: 1 });
  const longestSide = Math.max(unscaled.width, unscaled.height);
  const scale = longestSide > 0
    ? Math.min(normalizedImageScale(options.scale, limits.imageScale), limits.maxImageSide / longestSide)
    : normalizedImageScale(options.scale, limits.imageScale);
  const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) {
    throw new Error("Розмір сторінки перевищує можливості браузера.");
  }
  return pixels;
}

function requiredDeduplicationPart(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Для ключа повторного експорту не вказано ${field}.`);
  return normalized;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function validatePageNumbers(pages: readonly number[], totalPages: number): void {
  if (!pages.length) throw new Error("Не вибрано сторінки для експорту.");
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) {
      throw new Error(`Сторінка ${page} виходить за межі документа (${totalPages} стор.).`);
    }
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: PdfPageImageFormat,
  jpegQuality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Не вдалося сформувати зображення сторінки.")),
      mimeType,
      format === "jpeg" ? normalizedJpegQuality(jpegQuality) : undefined,
    );
  });
}

function normalizedImageScale(requested: number | undefined, configuredMaximum: number): number {
  const scale = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : configuredMaximum;
  return Math.max(0.1, Math.min(scale, configuredMaximum));
}

function normalizedJpegQuality(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.9;
  return Math.max(0.1, Math.min(1, value));
}

function normalizedOptionalNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(4))
    : null;
}

async function waitForRenderTask(task: RenderTask, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await task.promise;
    return;
  }
  throwIfAborted(signal);
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  throwIfAborted(signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("Операцію скасовано.", "AbortError");
}

function documentCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new Error("Експорт зображень доступний лише у браузері.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function sanitizeFileName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 120);
}

function padPage(value: number): string {
  return String(value).padStart(3, "0");
}

function positiveEnvironmentInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveEnvironmentNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}
