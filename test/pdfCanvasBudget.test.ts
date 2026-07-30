import assert from "node:assert/strict";
import test from "node:test";
import {
  boundPdfViewportScale,
  PdfCanvasBudgetError,
} from "../src/services/pdfCanvasBudget.ts";

test("canvas scale remains unchanged when the requested viewport fits the budget", () => {
  assert.deepEqual(boundPdfViewportScale({
    baseWidth: 612,
    baseHeight: 792,
    requestedScale: 2,
    maxPixels: 16_777_216,
    maxSide: 8_192,
  }), {
    scale: 2,
    pixelWidth: 1_224,
    pixelHeight: 1_584,
    limited: false,
  });
});

test("canvas scale is bounded by the maximum side", () => {
  const result = boundPdfViewportScale({
    baseWidth: 10_000,
    baseHeight: 1_000,
    requestedScale: 2,
    maxPixels: 100_000_000,
    maxSide: 4_096,
  });

  assert.equal(result.scale, 0.4096);
  assert.equal(result.pixelWidth, 4_096);
  assert.equal(result.pixelHeight, 409);
  assert.equal(result.limited, true);
});

test("canvas scale is bounded by the total pixel budget", () => {
  const result = boundPdfViewportScale({
    baseWidth: 4_000,
    baseHeight: 3_000,
    requestedScale: 2,
    maxPixels: 3_000_000,
    maxSide: 10_000,
  });

  assert.equal(result.scale, 0.5);
  assert.equal(result.pixelWidth, 2_000);
  assert.equal(result.pixelHeight, 1_500);
  assert.equal(result.pixelWidth * result.pixelHeight, 3_000_000);
  assert.equal(result.limited, true);
});

test("bounded integer dimensions never cross either configured resource limit", () => {
  const result = boundPdfViewportScale({
    baseWidth: 10_001.25,
    baseHeight: 7_777.75,
    requestedScale: 8,
    maxPixels: 1_048_576,
    maxSide: 1_500,
  });

  assert.ok(result.pixelWidth <= 1_500);
  assert.ok(result.pixelHeight <= 1_500);
  assert.ok(result.pixelWidth * result.pixelHeight <= 1_048_576);
  assert.equal(result.limited, true);
});

test("malformed or numerically unbounded PDF geometry fails before canvas allocation", () => {
  for (const input of [
    { baseWidth: 0, baseHeight: 100, requestedScale: 1, maxPixels: 100, maxSide: 100 },
    { baseWidth: 100, baseHeight: Number.NaN, requestedScale: 1, maxPixels: 100, maxSide: 100 },
    { baseWidth: 100, baseHeight: 100, requestedScale: 1, maxPixels: 0, maxSide: 100 },
    {
      baseWidth: Number.MAX_VALUE,
      baseHeight: Number.MAX_VALUE,
      requestedScale: 1,
      maxPixels: 16_777_216,
      maxSide: 8_192,
    },
  ]) {
    assert.throws(
      () => boundPdfViewportScale(input),
      (error) => error instanceof PdfCanvasBudgetError
        && error.code === "PDF_CANVAS_RESOURCE_LIMIT",
    );
  }
});
