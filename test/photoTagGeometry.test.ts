import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPhotoTagRect, photoTagPoint, photoTagRect, photoTagStyle, validPhotoTagRect } from "../src/services/photoTagGeometry.ts";

test("photo regions survive desktop, zoom, scroll and mobile scaling", () => {
  const expected = { x: 0.2, y: 0.25, width: 0.3, height: 0.5 };
  for (const box of [
    { left: 80, top: 90, width: 1200, height: 800 },
    { left: -420, top: -20, width: 2400, height: 1600 },
    { left: 12, top: 96, width: 320, height: 213.3333333333333 },
  ]) {
    const start = photoTagPoint(box.left + box.width * 0.2, box.top + box.height * 0.25, box);
    const end = photoTagPoint(box.left + box.width * 0.5, box.top + box.height * 0.75, box);
    assert.deepEqual(photoTagRect(start, end), expected);
    assert.deepEqual(photoTagRect(end, start), expected);
  }
  assert.deepEqual(photoTagStyle(expected), { left: "20%", top: "25%", width: "30%", height: "50%" });
});
test("pointer coordinates clamp to original image edges", () => {
  const box = { left: 20, top: 50, width: 300, height: 200 };
  assert.deepEqual(photoTagRect(photoTagPoint(-50, -60, box), photoTagPoint(500, 800, box)), { x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => photoTagPoint(10, 10, { ...box, width: 0 }));
  assert.throws(() => photoTagPoint(NaN, 10, box));
});
test("invalid and empty regions cannot be saved", () => {
  for (const rect of [
    { x: 0, y: 0, width: 0, height: 0.2 },
    { x: -0.1, y: 0, width: 0.2, height: 0.2 },
    { x: 0.9, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0.9, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: NaN, height: 1 },
    { x: 0, y: Infinity, width: 1, height: 1 },
  ]) assert.equal(validPhotoTagRect(rect), false);
  assert.equal(validPhotoTagRect({ x: 0, y: 0, width: 1, height: 1 }), true);
  assert.deepEqual(canonicalPhotoTagRect({ x: 0.10000000000002, y: 0.3, width: 0.499999999999, height: 0.7 }),
    { x: 0.1, y: 0.3, width: 0.5, height: 0.7 });
});
