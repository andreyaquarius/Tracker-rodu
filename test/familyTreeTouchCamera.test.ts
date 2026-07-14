import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyPinchToCamera,
  pinchSnapshot,
  wheelZoomFactor,
  zoomCameraAtClientPoint,
} from "../src/features/family-tree-view/react/treeCameraMath.ts";

const viewport = { left: 100, top: 50, width: 800, height: 600 };

test("wheel and touchpad zoom keep the point below the cursor stationary", () => {
  const camera = { x: 40, y: -20, zoom: 1 };
  const pointer = { x: 620, y: 410 };
  const beforeWorld = {
    x: camera.x + (pointer.x - viewport.left - viewport.width / 2) / camera.zoom,
    y: camera.y + (pointer.y - viewport.top - viewport.height / 2) / camera.zoom,
  };
  const next = zoomCameraAtClientPoint(camera, viewport, pointer, 1.8);
  const afterWorld = {
    x: next.x + (pointer.x - viewport.left - viewport.width / 2) / next.zoom,
    y: next.y + (pointer.y - viewport.top - viewport.height / 2) / next.zoom,
  };

  assert.ok(Math.abs(beforeWorld.x - afterWorld.x) < 1e-9);
  assert.ok(Math.abs(beforeWorld.y - afterWorld.y) < 1e-9);
});

test("pinch zoom follows both the finger distance and their moving midpoint", () => {
  const previous = { centerX: 500, centerY: 350, distance: 100 };
  const current = { centerX: 520, centerY: 370, distance: 200 };
  const next = applyPinchToCamera(
    { x: 0, y: 0, zoom: 1 },
    viewport,
    previous,
    current,
  );

  assert.deepEqual(next, { x: -10, y: -10, zoom: 2 });
  assert.deepEqual(
    pinchSnapshot([{ x: 450, y: 350 }, { x: 550, y: 350 }]),
    previous,
  );
});

test("touchpad pinch is responsive but every wheel frame is bounded", () => {
  const ordinary = wheelZoomFactor({
    deltaY: -4,
    deltaMode: 0,
    viewportHeight: 700,
    ctrlKey: false,
  });
  const pinch = wheelZoomFactor({
    deltaY: -4,
    deltaMode: 0,
    viewportHeight: 700,
    ctrlKey: true,
  });
  const extreme = wheelZoomFactor({
    deltaY: -1000,
    deltaMode: 0,
    viewportHeight: 700,
    ctrlKey: true,
  });

  assert.ok(pinch > ordinary);
  assert.equal(extreme, 1.35);
});

test("the tree owns touchscreen and touchpad gestures only inside its viewport", () => {
  const hook = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/useTreeCamera.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const component = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/FamilyTreeViewport.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const css = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/familyTree.css",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(hook, /addEventListener\("wheel", handleWheel, \{ passive: false \}\)/);
  assert.match(hook, /addEventListener\("touchmove", preventTouchZoom, \{ passive: false \}\)/);
  assert.match(hook, /addEventListener\("gesturechange", preventBrowserGesture, \{ passive: false \}\)/);
  assert.match(hook, /applyPinchToCamera/);
  assert.match(component, /onPointerDownCapture=\{camera\.onPointerDown\}/);
  assert.match(component, /onLostPointerCapture=\{camera\.onPointerUp\}/);
  assert.doesNotMatch(component, /onWheel=\{camera\.onWheel\}/);
  assert.match(css, /\.ft-viewport \{[\s\S]*?overscroll-behavior:\s*contain;[\s\S]*?touch-action:\s*none;/);
  assert.match(css, /\.ft-card-position \{[\s\S]*?touch-action:\s*none/);
});
