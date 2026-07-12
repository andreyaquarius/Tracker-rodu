import test from "node:test";
import assert from "node:assert/strict";
import {
  centerViewportOnRect,
  familyTreeViewportStorageKey,
  initialFamilyTreeViewport,
  parseFamilyTreeViewport,
  persistFamilyTreeViewport,
  readStoredFamilyTreeViewport,
  serializeFamilyTreeViewport,
  zoomViewportAtPoint,
} from "../src/hooks/useFamilyTreeViewport.ts";

test("family tree viewport storage key scopes tree root and mode", () => {
  assert.equal(
    familyTreeViewportStorageKey({
      treeId: "tree-1",
      rootPersonId: "person-1",
      mode: "ancestors",
    }),
    "family-tree-viewport:tree-1:person-1:ancestors",
  );
});

test("family tree viewport serializes compact stable values", () => {
  const serialized = serializeFamilyTreeViewport({ x: 12.7, y: -18.2, scale: 0.87654 });

  assert.equal(serialized, '{"x":13,"y":-18,"scale":0.877}');
  assert.deepEqual(parseFamilyTreeViewport(serialized), { x: 13, y: -18, scale: 0.877 });
  assert.equal(parseFamilyTreeViewport("{bad"), null);
});

test("family tree viewport storage failures do not break the tree", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = {
    getItem() {
      throw new DOMException("quota", "QuotaExceededError");
    },
    setItem() {
      throw new DOMException("quota", "QuotaExceededError");
    },
    removeItem() {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    assert.equal(readStoredFamilyTreeViewport("family-tree-viewport:test"), null);
    assert.equal(persistFamilyTreeViewport("family-tree-viewport:test", { x: 1, y: 2, scale: 1 }), false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("zooming at a point keeps the same world point under the cursor", () => {
  const viewport = { x: 100, y: 80, scale: 1 };
  const point = { x: 300, y: 220 };
  const beforeWorld = {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };

  const next = zoomViewportAtPoint(viewport, point, 1.5);
  const afterWorld = {
    x: (point.x - next.x) / next.scale,
    y: (point.y - next.y) / next.scale,
  };

  assert.deepEqual(afterWorld, beforeWorld);
});

test("center viewport places target rectangle in the visible center", () => {
  const viewport = centerViewportOnRect({
    viewportWidth: 800,
    viewportHeight: 600,
    targetX: 0,
    targetY: 0,
    targetWidth: 220,
    targetHeight: 120,
    scale: 1,
  });

  assert.equal(viewport.x, 290);
  assert.equal(viewport.y, 240);
  assert.equal(viewport.scale, 1);
});

test("initial family tree viewport fits large layouts instead of opening at 100 percent", () => {
  const viewport = initialFamilyTreeViewport({
    viewportWidth: 1000,
    viewportHeight: 600,
    minX: -3000,
    minY: -500,
    maxX: 3000,
    maxY: 900,
    rootX: 0,
    rootY: 0,
    rootWidth: 220,
    rootHeight: 120,
    padding: 50,
  });

  assert.equal(viewport.scale < 1, true);
  assert.equal(viewport.scale >= 0.08, true);
});

test("initial family tree viewport keeps small layouts centered at normal scale", () => {
  const viewport = initialFamilyTreeViewport({
    viewportWidth: 1000,
    viewportHeight: 600,
    minX: -220,
    minY: -140,
    maxX: 420,
    maxY: 240,
    rootX: 0,
    rootY: 0,
    rootWidth: 220,
    rootHeight: 120,
  });

  assert.equal(viewport.scale, 1);
});
