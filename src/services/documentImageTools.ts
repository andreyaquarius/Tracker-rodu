import type { QuarterRotation } from "./pdfViewerCropGeometry.ts";

export type DocumentImageAdjustments = {
  brightness: number;
  contrast: number;
  grayscale: number;
  sepia: number;
  invert: number;
  saturation: number;
  sharpness: number;
};

export type DocumentImagePresetId =
  | "original"
  | "grayscale"
  | "faded-text"
  | "high-contrast"
  | "negative"
  | "sepia";

export const DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS: Readonly<DocumentImageAdjustments> = Object.freeze({
  brightness: 100,
  contrast: 100,
  grayscale: 0,
  sepia: 0,
  invert: 0,
  saturation: 100,
  sharpness: 0,
});

export const DOCUMENT_IMAGE_PRESETS: Readonly<Record<DocumentImagePresetId, Readonly<DocumentImageAdjustments>>> = Object.freeze({
  original: DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
  grayscale: Object.freeze({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    grayscale: 100,
    contrast: 125,
  }),
  "faded-text": Object.freeze({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    brightness: 112,
    contrast: 175,
    grayscale: 100,
    sharpness: 38,
  }),
  "high-contrast": Object.freeze({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    brightness: 108,
    contrast: 235,
    grayscale: 100,
    sharpness: 52,
  }),
  negative: Object.freeze({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    contrast: 145,
    grayscale: 100,
    invert: 100,
    sharpness: 24,
  }),
  sepia: Object.freeze({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    brightness: 106,
    contrast: 125,
    sepia: 58,
    saturation: 82,
    sharpness: 14,
  }),
});

const ADJUSTMENT_LIMITS: Readonly<Record<keyof DocumentImageAdjustments, readonly [number, number]>> = Object.freeze({
  brightness: [40, 200],
  contrast: [40, 300],
  grayscale: [0, 100],
  sepia: [0, 100],
  invert: [0, 100],
  saturation: [0, 200],
  sharpness: [0, 100],
});

export function normalizeDocumentImageAdjustments(
  input: Partial<DocumentImageAdjustments>,
): DocumentImageAdjustments {
  const result = { ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS };
  for (const key of Object.keys(result) as Array<keyof DocumentImageAdjustments>) {
    const [minimum, maximum] = ADJUSTMENT_LIMITS[key];
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    result[key] = clamp(Math.round(value), minimum, maximum);
  }
  return result;
}

export function documentImageCssFilter(
  adjustments: DocumentImageAdjustments,
  sharpenFilterId?: string,
): string {
  const normalized = normalizeDocumentImageAdjustments(adjustments);
  const filters: string[] = [];
  if (normalized.grayscale !== 0) filters.push(`grayscale(${normalized.grayscale}%)`);
  if (normalized.sepia !== 0) filters.push(`sepia(${normalized.sepia}%)`);
  if (normalized.invert !== 0) filters.push(`invert(${normalized.invert}%)`);
  if (normalized.brightness !== 100) filters.push(`brightness(${normalized.brightness}%)`);
  if (normalized.contrast !== 100) filters.push(`contrast(${normalized.contrast}%)`);
  if (normalized.saturation !== 100) filters.push(`saturate(${normalized.saturation}%)`);
  if (normalized.sharpness > 0 && sharpenFilterId) {
    filters.push(`url("#${sharpenFilterId}")`);
  }
  return filters.length ? filters.join(" ") : "none";
}

export function documentSharpenKernel(sharpness: number): string {
  const normalized = normalizeDocumentImageAdjustments({ sharpness }).sharpness;
  const strength = Math.round((normalized / 100) * 90) / 100;
  return [
    0, -strength, 0,
    -strength, 1 + strength * 4, -strength,
    0, -strength, 0,
  ].map(compactNumber).join(" ");
}

export function splitPdfRotation(rotation: number): {
  normalizedRotation: number;
  renderRotation: QuarterRotation;
  cssRotation: number;
} {
  const normalizedRotation = normalizeDocumentRotation(rotation);
  const renderRotation = normalizeQuarter(
    Math.round(normalizedRotation / 90) * 90,
  );
  return {
    normalizedRotation,
    renderRotation,
    cssRotation: normalizeSignedRotation(normalizedRotation - renderRotation),
  };
}

export function normalizeDocumentRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  const normalized = ((rotation % 360) + 360) % 360;
  return Math.round(normalized * 10) / 10;
}

export function normalizeSignedRotation(rotation: number): number {
  const normalized = normalizeDocumentRotation(rotation);
  const signed = normalized > 180 ? normalized - 360 : normalized;
  return Object.is(signed, -0) ? 0 : signed;
}

export function rotatedDocumentBounds(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const radians = (normalizeDocumentRotation(rotation) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return {
    width: width * cosine + height * sine,
    height: width * sine + height * cosine,
  };
}

function normalizeQuarter(rotation: number): QuarterRotation {
  const normalized = normalizeDocumentRotation(rotation);
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
