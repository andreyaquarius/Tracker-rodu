/** Pure crop-overlay geometry shared by the PDF viewer and export pipeline. */

export type CropPoint = {
  x: number;
  y: number;
};

export type CropSize = {
  width: number;
  height: number;
};

export type CropRect = CropPoint & CropSize;

export type NormalizedCropRect = CropRect;

export type QuarterRotation = 0 | 90 | 180 | 270;

export const CROP_RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type CropResizeHandle = typeof CROP_RESIZE_HANDLES[number];

export const DEFAULT_MINIMUM_CROP_SIZE = 12;

export type RenderedPageBounds = CropRect;

type MinimumCropSize = number | CropSize;

/**
 * Creates a selection in page-viewport pixels. Dragging works in every
 * direction and the result always fits the page, including near its edges.
 */
export function createCropRect(
  anchor: CropPoint,
  pointer: CropPoint,
  pageSize: CropSize,
  minimumSize: MinimumCropSize = DEFAULT_MINIMUM_CROP_SIZE,
): CropRect {
  const page = validPageSize(pageSize);
  const minimum = effectiveMinimumSize(minimumSize, page);
  const start = clampPoint(anchor, page);
  const end = clampPoint(pointer, page);
  const horizontal = createAxisSelection(start.x, end.x, page.width, minimum.width);
  const vertical = createAxisSelection(start.y, end.y, page.height, minimum.height);
  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.end - horizontal.start,
    height: vertical.end - vertical.start,
  };
}

/** Moves a crop without allowing any edge to leave the page. */
export function moveCropRect(
  rect: CropRect,
  delta: CropPoint,
  pageSize: CropSize,
  minimumSize: MinimumCropSize = DEFAULT_MINIMUM_CROP_SIZE,
): CropRect {
  const page = validPageSize(pageSize);
  const fitted = fitCropRect(rect, page, minimumSize);
  return {
    x: clamp(fitted.x + finite(delta.x), 0, page.width - fitted.width),
    y: clamp(fitted.y + finite(delta.y), 0, page.height - fitted.height),
    width: fitted.width,
    height: fitted.height,
  };
}

/**
 * Resizes from one of the eight handles. Opposing edges remain fixed; a handle
 * stops at the configured minimum instead of crossing or flipping the crop.
 */
export function resizeCropRect(
  rect: CropRect,
  handle: CropResizeHandle,
  delta: CropPoint,
  pageSize: CropSize,
  minimumSize: MinimumCropSize = DEFAULT_MINIMUM_CROP_SIZE,
): CropRect {
  const page = validPageSize(pageSize);
  const minimum = effectiveMinimumSize(minimumSize, page);
  const fitted = fitCropRect(rect, page, minimum);
  let left = fitted.x;
  let top = fitted.y;
  let right = fitted.x + fitted.width;
  let bottom = fitted.y + fitted.height;
  const dx = finite(delta.x);
  const dy = finite(delta.y);

  if (handle.includes("w")) left = clamp(left + dx, 0, right - minimum.width);
  if (handle.includes("e")) right = clamp(right + dx, left + minimum.width, page.width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minimum.height);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + minimum.height, page.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Bounds an arbitrary rectangle to the page; negative sizes are normalized. */
export function clampCropRect(rect: CropRect, pageSize: CropSize): CropRect {
  const page = validPageSize(pageSize);
  const x1 = finite(rect.x);
  const y1 = finite(rect.y);
  const x2 = x1 + finite(rect.width);
  const y2 = y1 + finite(rect.height);
  const left = clamp(Math.min(x1, x2), 0, page.width);
  const top = clamp(Math.min(y1, y2), 0, page.height);
  const right = clamp(Math.max(x1, x2), 0, page.width);
  const bottom = clamp(Math.max(y1, y2), 0, page.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Maps a browser client point into intrinsic page-viewport pixels. This keeps
 * crop geometry independent of CSS zoom and device-pixel ratio.
 */
export function screenPointToPagePoint(
  point: CropPoint,
  renderedPage: RenderedPageBounds,
  pageSize: CropSize,
): CropPoint {
  const page = validPageSize(pageSize);
  if (!Number.isFinite(renderedPage.width) || !Number.isFinite(renderedPage.height)
    || !(renderedPage.width > 0) || !(renderedPage.height > 0)) {
    throw new RangeError("rendered page dimensions must be greater than zero");
  }
  return clampPoint({
    x: (finite(point.x) - finite(renderedPage.x)) / renderedPage.width * page.width,
    y: (finite(point.y) - finite(renderedPage.y)) / renderedPage.height * page.height,
  }, page);
}

/**
 * Converts a crop in the rotated PDF.js viewport to canonical unrotated page
 * coordinates in the 0..1 range. The returned rectangle is scale-independent.
 */
export function viewportRectToNormalizedCrop(
  viewportRect: CropRect,
  viewportSize: CropSize,
  rotation: QuarterRotation,
): NormalizedCropRect {
  const viewport = validPageSize(viewportSize);
  const bounded = clampCropRect(viewportRect, viewport);
  const rotated = clampNormalizedRect({
    x: bounded.x / viewport.width,
    y: bounded.y / viewport.height,
    width: bounded.width / viewport.width,
    height: bounded.height / viewport.height,
  });
  return clampNormalizedRect(unrotateNormalizedRect(rotated, rotation));
}

/** Restores a canonical normalized crop into a rotated PDF.js viewport. */
export function normalizedCropToViewportRect(
  normalizedRect: NormalizedCropRect,
  viewportSize: CropSize,
  rotation: QuarterRotation,
): CropRect {
  const viewport = validPageSize(viewportSize);
  const rotated = rotateNormalizedRect(clampNormalizedRect(normalizedRect), rotation);
  return clampCropRect({
    x: rotated.x * viewport.width,
    y: rotated.y * viewport.height,
    width: rotated.width * viewport.width,
    height: rotated.height * viewport.height,
  }, viewport);
}

/** Accepts positive/negative turns while producing a supported PDF rotation. */
export function normalizeQuarterRotation(rotation: number): QuarterRotation {
  if (!Number.isInteger(rotation) || rotation % 90 !== 0) {
    throw new RangeError("rotation must be a multiple of 90 degrees");
  }
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized as QuarterRotation;
}

function rotateNormalizedRect(rect: NormalizedCropRect, rotation: QuarterRotation): NormalizedCropRect {
  switch (rotation) {
    case 0:
      return { ...rect };
    case 90:
      return {
        x: 1 - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width,
      };
    case 180:
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    case 270:
      return {
        x: rect.y,
        y: 1 - rect.x - rect.width,
        width: rect.height,
        height: rect.width,
      };
  }
}

function unrotateNormalizedRect(rect: NormalizedCropRect, rotation: QuarterRotation): NormalizedCropRect {
  switch (rotation) {
    case 0:
      return { ...rect };
    case 90:
      return {
        x: rect.y,
        y: 1 - rect.x - rect.width,
        width: rect.height,
        height: rect.width,
      };
    case 180:
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    case 270:
      return {
        x: 1 - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width,
      };
  }
}

function clampNormalizedRect(rect: NormalizedCropRect): NormalizedCropRect {
  const x1 = finite(rect.x);
  const y1 = finite(rect.y);
  const x2 = x1 + finite(rect.width);
  const y2 = y1 + finite(rect.height);
  const left = clamp(Math.min(x1, x2), 0, 1);
  const top = clamp(Math.min(y1, y2), 0, 1);
  const right = clamp(Math.max(x1, x2), 0, 1);
  const bottom = clamp(Math.max(y1, y2), 0, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function fitCropRect(
  rect: CropRect,
  pageSize: CropSize,
  minimumSize: MinimumCropSize,
): CropRect {
  const bounded = clampCropRect(rect, pageSize);
  const minimum = effectiveMinimumSize(minimumSize, pageSize);
  const width = Math.min(pageSize.width, Math.max(minimum.width, bounded.width));
  const height = Math.min(pageSize.height, Math.max(minimum.height, bounded.height));
  return {
    x: clamp(bounded.x, 0, pageSize.width - width),
    y: clamp(bounded.y, 0, pageSize.height - height),
    width,
    height,
  };
}

function createAxisSelection(
  anchor: number,
  pointer: number,
  limit: number,
  minimum: number,
): { start: number; end: number } {
  let start = Math.min(anchor, pointer);
  let end = Math.max(anchor, pointer);
  if (end - start >= minimum) return { start, end };

  if (pointer < anchor) {
    start = Math.max(0, anchor - minimum);
    end = Math.min(limit, start + minimum);
    if (end - start < minimum) start = Math.max(0, end - minimum);
  } else {
    end = Math.min(limit, anchor + minimum);
    start = Math.max(0, end - minimum);
    if (end - start < minimum) end = Math.min(limit, start + minimum);
  }
  return { start, end };
}

function clampPoint(point: CropPoint, pageSize: CropSize): CropPoint {
  return {
    x: clamp(finite(point.x), 0, pageSize.width),
    y: clamp(finite(point.y), 0, pageSize.height),
  };
}

function validPageSize(size: CropSize): CropSize {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new RangeError("page dimensions must be finite and greater than zero");
  }
  return { width: size.width, height: size.height };
}

function effectiveMinimumSize(minimum: MinimumCropSize, pageSize: CropSize): CropSize {
  const requested = typeof minimum === "number"
    ? { width: minimum, height: minimum }
    : minimum;
  if (!Number.isFinite(requested.width) || !Number.isFinite(requested.height)
    || requested.width <= 0 || requested.height <= 0) {
    throw new RangeError("minimum crop dimensions must be finite and greater than zero");
  }
  return {
    width: Math.min(requested.width, pageSize.width),
    height: Math.min(requested.height, pageSize.height),
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
