import assert from "node:assert/strict";
import test from "node:test";
import {
  CROP_RESIZE_HANDLES,
  clampCropRect,
  createCropRect,
  moveCropRect,
  normalizedCropToViewportRect,
  normalizeQuarterRotation,
  resizeCropRect,
  screenPointToPagePoint,
  viewportRectToNormalizedCrop,
  type CropRect,
  type CropResizeHandle,
  type CropSize,
  type NormalizedCropRect,
  type QuarterRotation,
} from "../src/services/pdfViewerCropGeometry.ts";

const PAGE: CropSize = { width: 100, height: 100 };

test("crop creation supports every drag direction, minimum size and hard page bounds", () => {
  assert.deepEqual(createCropRect({ x: 70, y: 80 }, { x: 20, y: 30 }, PAGE), {
    x: 20,
    y: 30,
    width: 50,
    height: 50,
  });
  assert.deepEqual(createCropRect({ x: 98, y: 98 }, { x: 99, y: 99 }, PAGE), {
    x: 88,
    y: 88,
    width: 12,
    height: 12,
  });
  assert.deepEqual(createCropRect({ x: 2, y: 3 }, { x: -50, y: -30 }, PAGE), {
    x: 0,
    y: 0,
    width: 12,
    height: 12,
  });
});

test("moving preserves size and clamps all edges to the page", () => {
  const original = { x: 20, y: 30, width: 40, height: 25 };
  assert.deepEqual(moveCropRect(original, { x: 500, y: 500 }, PAGE), {
    x: 60,
    y: 75,
    width: 40,
    height: 25,
  });
  assert.deepEqual(moveCropRect(original, { x: -500, y: -500 }, PAGE), {
    x: 0,
    y: 0,
    width: 40,
    height: 25,
  });
});

test("all eight resize markers move only their own edges", () => {
  const original = { x: 20, y: 20, width: 40, height: 30 };
  const expected: Record<CropResizeHandle, CropRect> = {
    nw: { x: 30, y: 25, width: 30, height: 25 },
    n: { x: 20, y: 25, width: 40, height: 25 },
    ne: { x: 20, y: 25, width: 50, height: 25 },
    e: { x: 20, y: 20, width: 50, height: 30 },
    se: { x: 20, y: 20, width: 50, height: 35 },
    s: { x: 20, y: 20, width: 40, height: 35 },
    sw: { x: 30, y: 20, width: 30, height: 35 },
    w: { x: 30, y: 20, width: 30, height: 30 },
  };

  assert.equal(CROP_RESIZE_HANDLES.length, 8);
  for (const handle of CROP_RESIZE_HANDLES) {
    assert.deepEqual(resizeCropRect(original, handle, { x: 10, y: 5 }, PAGE, 10), expected[handle]);
  }
});

test("resize cannot cross the opposite edge, shrink below minimum or leave the page", () => {
  const original = { x: 20, y: 20, width: 40, height: 30 };
  assert.deepEqual(resizeCropRect(original, "nw", { x: 1_000, y: 1_000 }, PAGE, 12), {
    x: 48,
    y: 38,
    width: 12,
    height: 12,
  });
  assert.deepEqual(resizeCropRect(original, "se", { x: 1_000, y: 1_000 }, PAGE, 12), {
    x: 20,
    y: 20,
    width: 80,
    height: 80,
  });
  assert.deepEqual(clampCropRect({ x: 110, y: 80, width: -130, height: 60 }, PAGE), {
    x: 0,
    y: 80,
    width: 100,
    height: 20,
  });
});

test("screen points map to intrinsic page coordinates independently of CSS scale", () => {
  assert.deepEqual(screenPointToPagePoint(
    { x: 250, y: 250 },
    { x: 50, y: 100, width: 400, height: 300 },
    { width: 800, height: 600 },
  ), { x: 400, y: 300 });
  assert.deepEqual(screenPointToPagePoint(
    { x: -100, y: 2_000 },
    { x: 50, y: 100, width: 400, height: 300 },
    { width: 800, height: 600 },
  ), { x: 0, y: 600 });
});

test("canonical normalized crop transforms correctly at 0/90/180/270 degrees", () => {
  const normalized: NormalizedCropRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };
  const cases: Array<{
    rotation: QuarterRotation;
    viewport: CropSize;
    expected: CropRect;
  }> = [
    { rotation: 0, viewport: { width: 600, height: 800 }, expected: { x: 60, y: 160, width: 180, height: 200 } },
    { rotation: 90, viewport: { width: 800, height: 600 }, expected: { x: 440, y: 60, width: 200, height: 180 } },
    { rotation: 180, viewport: { width: 600, height: 800 }, expected: { x: 360, y: 440, width: 180, height: 200 } },
    { rotation: 270, viewport: { width: 800, height: 600 }, expected: { x: 160, y: 360, width: 200, height: 180 } },
  ];

  for (const value of cases) {
    const viewportRect = normalizedCropToViewportRect(normalized, value.viewport, value.rotation);
    assertRectAlmostEqual(viewportRect, value.expected);
    assertRectAlmostEqual(
      viewportRectToNormalizedCrop(viewportRect, value.viewport, value.rotation),
      normalized,
    );
  }
});

test("rotation transforms clamp malformed viewport crops and normalize full turns", () => {
  assert.deepEqual(viewportRectToNormalizedCrop(
    { x: -100, y: 100, width: 900, height: 700 },
    { width: 800, height: 600 },
    90,
  ), { x: 1 / 6, y: 0, width: 5 / 6, height: 1 });
  assert.equal(normalizeQuarterRotation(-90), 270);
  assert.equal(normalizeQuarterRotation(450), 90);
  assert.throws(() => normalizeQuarterRotation(45), /multiple of 90/u);
  assert.throws(() => normalizeQuarterRotation(90.5), /multiple of 90/u);
});

function assertRectAlmostEqual(actual: CropRect, expected: CropRect): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-9,
      `${key}: expected ${expected[key]}, received ${actual[key]}`,
    );
  }
}
