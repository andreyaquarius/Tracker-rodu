import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_FAMILY_TREE_APPEARANCE, normalizeFamilyTreeAppearance, readFamilyTreeAppearance, writeFamilyTreeAppearance } from "../src/utils/familyTreeAppearance.ts";
import { chartColorContrastRatio, resolveFamilyTreeChartColorScheme } from "../src/features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import { starrySkyViewportBounds, starryTreeColorScheme, starryTreeTone, prepareStarrySkyForExport } from "../src/features/family-tree-view/appearance/starrySkyTheme.ts";
import { skyCometFrame, SKY_COMET_DURATION_SECONDS, SKY_COMET_INTERVAL_SECONDS } from "../src/features/family-tree-view/appearance/skyComets.ts";

test("starry appearance is opt-in, validated, and survives the existing storage roundtrip", () => {
  for (const value of [undefined, null, {}, { starryBackground: "true" }, { starryBackground: 1 }]) {
    assert.equal(normalizeFamilyTreeAppearance(value).starryBackground, false);
  }
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const prefs = { ...DEFAULT_FAMILY_TREE_APPEARANCE, starryBackground: true, starryAnimation: false, directLineageColor: "#8555aa" };
  writeFamilyTreeAppearance("project", "a", prefs, storage);
  assert.deepEqual(readFamilyTreeAppearance("project", "a", storage), prefs);
  assert.equal(readFamilyTreeAppearance("project", "b", storage).starryBackground, false);
});

test("animation preference is independent of the background and keeps explicit pause", () => {
  assert.equal(normalizeFamilyTreeAppearance({}).starryAnimation, true);
  assert.equal(normalizeFamilyTreeAppearance({ starryAnimation: "false" }).starryAnimation, true);
  assert.equal(normalizeFamilyTreeAppearance({ starryAnimation: false, starryBackground: false }).starryAnimation, false);
});

test("comets are sparse, bounded and smoothly fade instead of flashing", () => {
  for (const t of [NaN, Infinity, -1, 0, 2.99, 19.99]) assert.equal(skyCometFrame(t, 1200, 800), undefined);
  assert.equal(skyCometFrame(4, 0, 800), undefined);
  const pass = Array.from({ length: 2000 }, (_, index) => skyCometFrame(index / 100, 1200, 800)).filter(frame => frame !== undefined);
  assert.ok(pass.length >= SKY_COMET_DURATION_SECONDS * 100 - 1 && pass.length <= 500);
  assert.ok(pass[0]!.opacity < 0.01);
  assert.ok(pass.at(-1)!.opacity < 0.01);
  for (const frame of pass) { assert.ok(frame.opacity >= 0 && frame.opacity <= 0.82); assert.ok(frame.tail <= 130); }
  let activeSeconds = 0;
  for (let t = 0; t < 200; t += 0.1) if (skyCometFrame(t, 1200, 800)) activeSeconds += 0.1;
  assert.ok(activeSeconds < 50, "sky stays quiet for at least 75% of the time");
});

test("randomized passes arrive from every edge, vary delays and colors, and keep one stable flight path", () => {
  const directions = new Set<string>(); const colors = new Set<string>(); const delays = new Set<number>();
  for (let pass = 0; pass < 80; pass++) {
    const samples = Array.from({ length: 200 }, (_, i) => ({ time: pass * SKY_COMET_INTERVAL_SECONDS + i / 10, frame: skyCometFrame(pass * SKY_COMET_INTERVAL_SECONDS + i / 10, 1200, 800, 71) })).filter(s => s.frame);
    assert.ok(samples.length > 0);
    const first = samples[0]!; const last = samples.at(-1)!;
    const angle = first.frame!.angle;
    assert.equal(angle, last.frame!.angle);
    assert.deepEqual(first.frame, skyCometFrame(first.time, 1200, 800, 71));
    const dx = last.frame!.x - first.frame!.x; const dy = last.frame!.y - first.frame!.y;
    directions.add(Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up");
    colors.add(first.frame!.color); delays.add(Math.round((first.time % SKY_COMET_INTERVAL_SECONDS) * 10));
  }
  assert.equal(directions.size, 4); assert.equal(colors.size, 4); assert.ok(delays.size > 10);
  assert.notDeepEqual(Array.from({ length: 200 }, (_, i) => skyCometFrame(i / 10, 1200, 800, 71)), Array.from({ length: 200 }, (_, i) => skyCometFrame(i / 10, 1200, 800, 27)));
});

test("night tones preserve the original palette and keep text and borders readable", () => {
  for (const directLineageColor of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#2f7465", "#b37a2d"]) {
    const light = resolveFamilyTreeChartColorScheme({ ...DEFAULT_FAMILY_TREE_APPEARANCE, directLineageColor, directLineageGrouping: "great-grandparents" });
    const before = structuredClone(light);
    const night = starryTreeColorScheme(light);
    assert.deepEqual(light, before);
    assert.equal(night.background, "#050814");
    assert.equal(night.grouping, light.grouping);
    for (const tone of [night.lineageBase, night.focus, night.duplicate, ...night.lineage, starryTreeTone(directLineageColor)]) {
      assert.ok(chartColorContrastRatio(tone.foreground, tone.fill) >= 4.5, JSON.stringify(tone));
      assert.ok(chartColorContrastRatio(tone.stroke, tone.fill) >= 3, JSON.stringify(tone));
    }
  }
});

test("export sky is resized to the full diagram after zooming without touching other SVG content", () => {
  const attributes = new Map<string, string>();
  const layer = { setAttribute: (name: string, value: string) => attributes.set(name, value) };
  const svg = { querySelectorAll: (selector: string) => { assert.equal(selector, "[data-starry-sky]"); return [layer]; } };
  prepareStarrySkyForExport(svg as unknown as SVGSVGElement, { x: -2000, y: -1000, width: 4000, height: 2400 });
  assert.deepEqual(Object.fromEntries(attributes), { x: "-2000", y: "-1000", width: "4000", height: "2400" });
});

test("sky covers wide and tall SVG letterboxes without modifying the camera bounds", () => {
  const bounds = { x: -500, y: -500, width: 1000, height: 1000 };
  assert.deepEqual(starrySkyViewportBounds(bounds, { width: 1200, height: 600 }), { x: -1000, y: -500, width: 2000, height: 1000 });
  assert.deepEqual(starrySkyViewportBounds(bounds, { width: 300, height: 600 }), { x: -500, y: -1000, width: 1000, height: 2000 });
  assert.equal(starrySkyViewportBounds(bounds, { width: 0, height: 0 }), bounds);
  assert.deepEqual(bounds, { x: -500, y: -500, width: 1000, height: 1000 });
});

test("sky is decorative, bounded, and wired to both chart variants plus the classic viewport", () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const sky = source("features/family-tree-view/appearance/StarrySkyBackground.tsx");
  assert.match(sky, /length: 160/);
  assert.match(sky, /aria-hidden="true"/);
  assert.match(sky, /pointerEvents="none"/);
  assert.doesNotMatch(sky, /setInterval|onClick|fetch\(/);
  assert.match(sky, /if \(!active\) return/);
  assert.match(sky, /cancelAnimationFrame/);
  assert.match(sky, /SKY_ANIMATION_FPS/);
  for (const name of ["CircularAncestorChartWindow", "FanGenealogyChartWindow"]) {
    const window = source(`components/familyTree/${name}.tsx`);
    assert.match(window, /StarryBackgroundToggle enabled=\{chartAppearance.starryBackground\}/);
    assert.match(window, /starryTreeColorScheme\(scheme\)/);
    assert.match(window, /<StarrySkyBackground/);
  }
  const viewport = source("features/family-tree-view/react/FamilyTreeViewport.tsx");
  assert.match(viewport, /data-starry=\{starryBackground\}/);
  assert.match(viewport, /<TreeEdgeCanvas\s+starryBackground=\{starryBackground\}/);
  const page = source("pages/ProductionFamilyTreePage.tsx");
  assert.match(page, /starryBackground=\{appearance.starryBackground\}/);
  assert.match(page, /onAppearanceChange=\{updateTreeAppearance\}/);
});
