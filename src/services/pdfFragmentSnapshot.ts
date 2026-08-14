import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  normalizedCropToViewportRect,
  type NormalizedCropRect,
  type QuarterRotation,
} from "./pdfViewerCropGeometry.ts";

export const PDF_FRAGMENT_SNAPSHOT_LIMITS = Object.freeze({
  defaultScale: 3,
  maximumScale: 4,
  maximumOutputSide: 4_096,
  maximumCanvasSide: 8_192,
  maximumRenderPixels: 32_000_000,
});

export type PdfFragmentSnapshotMimeType = "image/png" | "image/jpeg";
export type PdfFragmentSnapshotPage = Pick<PDFPageProxy, "getViewport" | "render">;
export type PdfFragmentSnapshotDocument = Pick<PDFDocumentProxy, "getPage">;

export interface PdfSnapshotCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: unknown, ...coordinates: number[]): void;
}

/** Minimal structural canvas contract; a detached HTML canvas is used in production. */
export interface PdfSnapshotCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): PdfSnapshotCanvasContext | null;
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Blob>;
  toBlob?: (
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ) => void;
}

export type PdfSnapshotCanvasFactory = (width: number, height: number) => PdfSnapshotCanvas;

type PdfFragmentSnapshotCommonOptions = {
  /** Canonical, unrotated page-space crop in the 0..1 range. */
  crop: NormalizedCropRect;
  rotation: QuarterRotation;
  scale?: number;
  maxScale?: number;
  maxSide?: number;
  maxCanvasSide?: number;
  maxRenderPixels?: number;
  mimeType?: PdfFragmentSnapshotMimeType;
  jpegQuality?: number;
  background?: string;
  signal?: AbortSignal;
  canvasFactory?: PdfSnapshotCanvasFactory;
};

export type PdfFragmentSnapshotOptions = PdfFragmentSnapshotCommonOptions & (
  | {
      page: PdfFragmentSnapshotPage;
      document?: never;
      pageNumber?: never;
    }
  | {
      document: PdfFragmentSnapshotDocument;
      pageNumber: number;
      page?: never;
    }
);

/**
 * Renders exactly one PDF page into a detached canvas and returns only the
 * selected fragment. No viewer canvas or low-resolution thumbnail is reused.
 */
export async function renderPdfFragmentSnapshot(
  options: PdfFragmentSnapshotOptions,
): Promise<Blob> {
  throwIfAborted(options.signal);
  const page = "page" in options && options.page
    ? options.page
    : await getDocumentPage(options.document, options.pageNumber, options.signal);
  throwIfAborted(options.signal);

  const limits = normalizeLimits(options);
  const baseViewport = page.getViewport({ scale: 1, rotation: options.rotation });
  ensureViewport(baseViewport.width, baseViewport.height);
  const baseCrop = normalizedCropToViewportRect(
    options.crop,
    { width: baseViewport.width, height: baseViewport.height },
    options.rotation,
  );
  if (!(baseCrop.width > 0) || !(baseCrop.height > 0)) {
    throw new RangeError("PDF fragment crop must have a positive width and height");
  }

  const renderScale = chooseRenderScale(
    baseViewport.width,
    baseViewport.height,
    baseCrop.width,
    baseCrop.height,
    limits,
  );
  const viewport = page.getViewport({ scale: renderScale, rotation: options.rotation });
  ensureViewport(viewport.width, viewport.height);
  const renderWidth = boundedPixelDimension(viewport.width, limits.maxCanvasSide);
  const renderHeight = boundedPixelDimension(viewport.height, limits.maxCanvasSide);
  if (renderWidth * renderHeight > limits.maxRenderPixels) {
    throw new RangeError("PDF snapshot render exceeds the configured pixel budget");
  }

  const createCanvas = options.canvasFactory ?? createDetachedCanvas;
  const renderCanvas = createCanvas(renderWidth, renderHeight);
  const renderContext = renderCanvas.getContext("2d");
  if (!renderContext) {
    releaseCanvas(renderCanvas);
    throw new Error("Browser could not create a canvas context for the PDF snapshot");
  }

  let outputCanvas: PdfSnapshotCanvas | null = null;
  try {
    const renderTask = page.render({
      canvas: renderCanvas as unknown as HTMLCanvasElement,
      viewport,
      background: options.background ?? "rgb(255,255,255)",
    });
    await waitForRenderTask(renderTask, options.signal);
    throwIfAborted(options.signal);

    const crop = normalizedCropToViewportRect(
      options.crop,
      { width: viewport.width, height: viewport.height },
      options.rotation,
    );
    const outputSize = boundedOutputSize(crop.width, crop.height, limits.maxSide);
    outputCanvas = createCanvas(outputSize.width, outputSize.height);
    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) throw new Error("Browser could not create a canvas context for the PDF fragment");

    const mimeType = options.mimeType ?? "image/png";
    if (mimeType === "image/jpeg") {
      outputContext.fillStyle = options.background ?? "rgb(255,255,255)";
      outputContext.fillRect(0, 0, outputSize.width, outputSize.height);
    }
    outputContext.drawImage(
      renderCanvas,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      outputSize.width,
      outputSize.height,
    );
    throwIfAborted(options.signal);
    const blob = await canvasToBlob(
      outputCanvas,
      mimeType,
      clamp(options.jpegQuality ?? 0.9, 0, 1),
    );
    throwIfAborted(options.signal);
    return blob;
  } finally {
    releaseCanvas(renderCanvas);
    if (outputCanvas) releaseCanvas(outputCanvas);
  }
}

type SnapshotLimits = {
  scale: number;
  maxScale: number;
  maxSide: number;
  maxCanvasSide: number;
  maxRenderPixels: number;
};

function normalizeLimits(options: PdfFragmentSnapshotCommonOptions): SnapshotLimits {
  const scale = positiveNumber(options.scale ?? PDF_FRAGMENT_SNAPSHOT_LIMITS.defaultScale, "scale");
  const requestedMaxScale = positiveNumber(
    options.maxScale ?? PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumScale,
    "maxScale",
  );
  return {
    scale,
    maxScale: Math.min(requestedMaxScale, PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumScale),
    maxSide: boundedPositiveInteger(
      options.maxSide ?? PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumOutputSide,
      PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumOutputSide,
      "maxSide",
    ),
    maxCanvasSide: boundedPositiveInteger(
      options.maxCanvasSide ?? PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumCanvasSide,
      PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumCanvasSide,
      "maxCanvasSide",
    ),
    maxRenderPixels: boundedPositiveInteger(
      options.maxRenderPixels ?? PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumRenderPixels,
      PDF_FRAGMENT_SNAPSHOT_LIMITS.maximumRenderPixels,
      "maxRenderPixels",
    ),
  };
}

function chooseRenderScale(
  pageWidth: number,
  pageHeight: number,
  cropWidth: number,
  cropHeight: number,
  limits: SnapshotLimits,
): number {
  // A small safety margin accounts for fractional viewport dimensions being
  // rounded up to physical canvas pixels.
  const safety = 0.999;
  const maximumPageSideScale = limits.maxCanvasSide / Math.max(pageWidth, pageHeight) * safety;
  const maximumPixelScale = Math.sqrt(limits.maxRenderPixels / (pageWidth * pageHeight)) * safety;
  const maximumCropScale = limits.maxSide / Math.max(cropWidth, cropHeight);
  const result = Math.min(
    limits.scale,
    limits.maxScale,
    maximumPageSideScale,
    maximumPixelScale,
    maximumCropScale,
  );
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError("PDF page cannot be rendered within the configured resource limits");
  }
  return result;
}

function boundedOutputSize(width: number, height: number, maxSide: number): CropSize {
  if (!(width > 0) || !(height > 0)) throw new RangeError("PDF fragment crop is empty");
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.min(maxSide, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxSide, Math.round(height * scale))),
  };
}

type CropSize = { width: number; height: number };

function boundedPixelDimension(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.ceil(value)));
}

async function getDocumentPage(
  document: PdfFragmentSnapshotDocument,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<PdfFragmentSnapshotPage> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError("PDF page number must be a positive one-based integer");
  }
  throwIfAborted(signal);
  const page = await document.getPage(pageNumber);
  throwIfAborted(signal);
  return page;
}

async function waitForRenderTask(
  task: ReturnType<PdfFragmentSnapshotPage["render"]>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await task.promise;
    return;
  }
  if (signal.aborted) {
    task.cancel();
    throw abortError();
  }
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

function canvasToBlob(
  canvas: PdfSnapshotCanvas,
  type: PdfFragmentSnapshotMimeType,
  quality: number,
): Promise<Blob> {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  if (!canvas.toBlob) throw new Error("Browser cannot encode the PDF fragment canvas");
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob!((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Browser could not encode the PDF fragment"));
    }, type, quality);
  });
}

function createDetachedCanvas(width: number, height: number): PdfSnapshotCanvas {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PdfSnapshotCanvas;
  }
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height) as unknown as PdfSnapshotCanvas;
  }
  throw new Error("Canvas API is unavailable for the PDF snapshot");
}

function releaseCanvas(canvas: PdfSnapshotCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("PDF snapshot was cancelled", "AbortError");
  const error = new Error("PDF snapshot was cancelled");
  error.name = "AbortError";
  return error;
}

function ensureViewport(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("PDF page viewport dimensions must be finite and greater than zero");
  }
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${label} must be at least 1`);
  return Math.min(maximum, Math.trunc(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
