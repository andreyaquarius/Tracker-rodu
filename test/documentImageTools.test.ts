import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
  DOCUMENT_IMAGE_PRESETS,
  documentImageCssFilter,
  documentSharpenKernel,
  normalizeDocumentImageAdjustments,
  normalizeSignedRotation,
  rotatedDocumentBounds,
  splitPdfRotation,
} from "../src/services/documentImageTools.ts";

test("document image adjustments are bounded and preserve a neutral original", () => {
  assert.equal(documentImageCssFilter({ ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS }), "none");
  assert.deepEqual(normalizeDocumentImageAdjustments({
    brightness: 999,
    contrast: 5,
    invert: 47.6,
    sharpness: Number.NaN,
  }), {
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
    brightness: 200,
    contrast: 40,
    invert: 48,
  });
});

test("manuscript presets expose grayscale, faded-text, high-contrast, negative and sepia workflows", () => {
  assert.equal(DOCUMENT_IMAGE_PRESETS.grayscale.grayscale, 100);
  assert.ok(DOCUMENT_IMAGE_PRESETS["faded-text"].contrast > 100);
  assert.ok(DOCUMENT_IMAGE_PRESETS["high-contrast"].sharpness > 0);
  assert.equal(DOCUMENT_IMAGE_PRESETS.negative.invert, 100);
  assert.ok(DOCUMENT_IMAGE_PRESETS.sepia.sepia > 0);

  const filter = documentImageCssFilter(
    { ...DOCUMENT_IMAGE_PRESETS["faded-text"] },
    "document-sharpen",
  );
  assert.match(filter, /grayscale\(100%\)/u);
  assert.match(filter, /brightness\(112%\)/u);
  assert.match(filter, /contrast\(175%\)/u);
  assert.match(filter, /url\("#document-sharpen"\)/u);
  assert.equal(documentSharpenKernel(0), "0 0 0 0 1 0 0 0 0");
  assert.equal(documentSharpenKernel(100), "0 -0.9 0 -0.9 4.6 -0.9 0 -0.9 0");
});

test("arbitrary PDF rotation stays visually continuous while PDF.js receives quarter turns", () => {
  assert.deepEqual(splitPdfRotation(37), {
    normalizedRotation: 37,
    renderRotation: 0,
    cssRotation: 37,
  });
  assert.deepEqual(splitPdfRotation(52), {
    normalizedRotation: 52,
    renderRotation: 90,
    cssRotation: -38,
  });
  assert.deepEqual(splitPdfRotation(181), {
    normalizedRotation: 181,
    renderRotation: 180,
    cssRotation: 1,
  });
  assert.equal(normalizeSignedRotation(270), -90);
  assert.equal(normalizeSignedRotation(-15), -15);
});

test("rotated document bounds keep the page centered and fully measurable at any angle", () => {
  assert.deepEqual(rotatedDocumentBounds(800, 600, 0), { width: 800, height: 600 });
  assert.deepEqual(rotatedDocumentBounds(800, 600, 90), { width: 600, height: 800 });

  const diagonal = rotatedDocumentBounds(800, 600, 45);
  assert.ok(Math.abs(diagonal.width - 989.949) < 0.01);
  assert.ok(Math.abs(diagonal.height - 989.949) < 0.01);
});
