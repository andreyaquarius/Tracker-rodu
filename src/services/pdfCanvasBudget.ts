export interface PdfCanvasBudgetInput {
  /** PDF.js viewport width at scale 1 for the requested rotation. */
  baseWidth: number;
  /** PDF.js viewport height at scale 1 for the requested rotation. */
  baseHeight: number;
  requestedScale: number;
  maxPixels: number;
  maxSide: number;
}

export interface BoundedPdfCanvasViewport {
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  limited: boolean;
}

/** Raised before allocating a canvas when PDF page geometry cannot be bounded safely. */
export class PdfCanvasBudgetError extends Error {
  readonly code = "PDF_CANVAS_RESOURCE_LIMIT";

  constructor() {
    super("PDF canvas dimensions cannot be bounded safely");
    this.name = "PdfCanvasBudgetError";
  }
}

/**
 * Reduces a requested PDF.js viewport scale so the resulting canvas fits both
 * a per-side and a total-pixel budget. Integer dimensions use floor because
 * those are the exact backing-store dimensions assigned to the canvas.
 */
export function boundPdfViewportScale(
  input: PdfCanvasBudgetInput,
): BoundedPdfCanvasViewport {
  const baseWidth = positiveFinite(input.baseWidth);
  const baseHeight = positiveFinite(input.baseHeight);
  const requestedScale = positiveFinite(input.requestedScale);
  const maxPixels = positiveInteger(input.maxPixels);
  const maxSide = positiveInteger(input.maxSide);
  if (!baseWidth || !baseHeight || !requestedScale || !maxPixels || !maxSide) {
    throw new PdfCanvasBudgetError();
  }

  // Divide sequentially to avoid overflowing baseWidth * baseHeight for a
  // malformed PDF with extreme MediaBox dimensions.
  const scaleByPixels = Math.sqrt(maxPixels / baseWidth / baseHeight);
  const scaleBySide = Math.min(maxSide / baseWidth, maxSide / baseHeight);
  let scale = Math.min(requestedScale, scaleByPixels, scaleBySide);
  if (!Number.isFinite(scale) || scale <= 0) throw new PdfCanvasBudgetError();

  let pixelWidth = Math.max(1, Math.floor(baseWidth * scale));
  let pixelHeight = Math.max(1, Math.floor(baseHeight * scale));

  // Floating-point rounding at the boundary must never allocate one pixel
  // beyond either configured budget.
  if (pixelWidth > maxSide || pixelHeight > maxSide || pixelWidth * pixelHeight > maxPixels) {
    const correction = Math.min(
      maxSide / pixelWidth,
      maxSide / pixelHeight,
      Math.sqrt(maxPixels / pixelWidth / pixelHeight),
    );
    scale *= correction;
    pixelWidth = Math.max(1, Math.floor(baseWidth * scale));
    pixelHeight = Math.max(1, Math.floor(baseHeight * scale));
  }

  if (
    !Number.isFinite(scale)
    || scale <= 0
    || pixelWidth > maxSide
    || pixelHeight > maxSide
    || pixelWidth * pixelHeight > maxPixels
  ) {
    throw new PdfCanvasBudgetError();
  }

  return {
    scale,
    pixelWidth,
    pixelHeight,
    limited: scale < requestedScale,
  };
}

function positiveFinite(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(value: number): number | null {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}
