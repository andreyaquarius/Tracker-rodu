import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildConstellationTour, constellationThemeColors, constellationStars, constellationStarPoint, interpolateConstellationCamera, MAX_CONSTELLATION_TOUR_STEPS } from "../src/features/family-tree-view/constellation/constellationCinema.ts";
import { resolveFamilyTreeChartColorScheme, chartColorContrastRatio } from "../src/features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import { DEFAULT_FAMILY_TREE_APPEARANCE } from "../src/utils/familyTreeAppearance.ts";
import { buildConstellationScene } from "../src/features/family-tree-view/constellation/constellationModel.ts";
import { buildConstellationTimeModel } from "../src/features/family-tree-view/constellation/constellationTime.ts";
import { buildConstellationPlacesModel, buildConstellationPlacesScene } from "../src/features/family-tree-view/constellation/constellationPlaces.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";

const fixture = (size = 5) => {
  const graph: FamilyGraphData = { persons: Array.from({ length: size }, (_, i) => ({ id: String(i), displayName: `Особа ${i}`, birth: { display: String(1800 + i) } })),
    unions: [], parentChildRelations: Array.from({ length: size - 1 }, (_, i) => ({ id: `r${i}`, parentId: "0", childId: String(i + 1), kind: "biological" })) };
  const scene = buildConstellationScene(graph, "0");
  const time = buildConstellationTimeModel(scene, graph, graph.persons.map(person => ({ id: person.id, birthPlace: `Місце ${person.id}` })), 2026);
  const places = buildConstellationPlacesScene(buildConstellationPlacesModel(time));
  return { graph, scene, time, places };
};
test("night palette stays readable and preserves the user's saved scheme without mutations", () => {
  for (const color of ["#183b29", "#aa2288", "#0707bf", "#faff00", "#000000", "#ffffff"]) {
    const scheme = resolveFamilyTreeChartColorScheme({ ...DEFAULT_FAMILY_TREE_APPEARANCE, directLineageColor: color, directLineageGrouping: "grandparents" });
    const before = structuredClone(scheme); const night = constellationThemeColors(scheme, "night");
    assert.equal(night.background, "#050814"); assert.equal(night.grouping, scheme.grouping);
    assert.ok(chartColorContrastRatio(night.text, night.background) >= 7);
    assert.ok(chartColorContrastRatio(night.mutedText, night.background) >= 4.5);
    for (const tone of [...night.lineage, night.focus, night.lineageBase]) {
      assert.ok(chartColorContrastRatio(tone.foreground, tone.fill) >= 4.5);
      assert.ok(chartColorContrastRatio(tone.stroke, night.background) >= 3);
    }
    assert.deepEqual(scheme, before); assert.equal(constellationThemeColors(scheme, "light"), scheme);
  }
});
test("night colors respond to palette edits and keep different branch colors distinguishable", () => {
  const a = constellationThemeColors(resolveFamilyTreeChartColorScheme({ ...DEFAULT_FAMILY_TREE_APPEARANCE, directLineageColor: "#3355aa", directLineageGrouping: "grandparents" }), "night");
  const b = constellationThemeColors(resolveFamilyTreeChartColorScheme({ ...DEFAULT_FAMILY_TREE_APPEARANCE, directLineageColor: "#aa5533" }), "night");
  assert.notEqual(a.focus.stroke, b.focus.stroke);
  assert.ok(new Set(a.lineage.slice(0, 4).map(tone => tone.stroke)).size >= 3);
});
test("family presentation only uses loaded unmasked people and real scene coordinates", () => {
  const { scene, time, places } = fixture(); const snapshot = structuredClone(scene);
  const tour = buildConstellationTour("family", scene, time, places);
  assert.equal(tour.steps.length, 5); assert.equal(tour.steps[0]?.personId, "0");
  assert.ok(tour.steps.every(step => scene.nodes.some(node => node.id === step.personId && node.x === step.x && node.y === step.y)));
  assert.deepEqual(structuredClone(scene), snapshot);
  scene.nodes[1]!.person.badges = { privacy: "masked" };
  assert.equal(buildConstellationTour("family", scene, time, places).steps.some(step => step.personId === scene.nodes[1]!.id), false);
  assert.deepEqual(buildConstellationTour("family", undefined, time, places), { steps: [], total: 0 });
});
test("time presentation preserves uncertain date wording without inventing unknown dates", () => {
  const { graph, scene, places } = fixture();
  const time = buildConstellationTimeModel(scene, graph, [{ id: "0", events: [
    { id: "approx", personId: "0", type: "residence", date: "близько 1900", placeName: "Київ" },
    { id: "unknown", personId: "0", type: "residence", placeName: "Львів" },
  ] }], 2026);
  const tour = buildConstellationTour("time", scene, time, places);
  assert.ok(tour.steps.every((step, i) => !i || tour.steps[i - 1]!.year! <= step.year!));
  assert.ok(tour.steps.some(step => step.title.includes("близько 1900") && step.detail.includes("Київ")));
  assert.equal(tour.steps.some(step => step.detail.includes("Львів")), false);
});
test("large presentations sample across the full sequence, retain endpoints and do not duplicate stops", () => {
  const { scene, time, places } = fixture(1000);
  const tour = buildConstellationTour("time", scene, time, places);
  assert.equal(tour.total, 1000); assert.equal(tour.steps.length, MAX_CONSTELLATION_TOUR_STEPS);
  assert.equal(tour.steps[0]?.year, 1800); assert.equal(tour.steps.at(-1)?.year, 2799);
  assert.equal(new Set(tour.steps.map(step => step.id)).size, MAX_CONSTELLATION_TOUR_STEPS);
});
test("place presentation is scoped to the rendered filter and explicitly identifies its schematic nature", () => {
  const { scene, time } = fixture(); const places = buildConstellationPlacesScene(buildConstellationPlacesModel(time), "2");
  const tour = buildConstellationTour("places", scene, time, places);
  assert.equal(tour.steps.length, 1); assert.equal(tour.steps[0]?.placeId, places.nodes[0]?.id);
  assert.match(tour.steps[0]!.detail, /не географічна мапа/u);
});
test("camera flight eases without overshoot, preserving exact endpoints and positive zoom", () => {
  const from = { x: -9999, y: 500, zoom: 0.0001 }; const to = { x: 400, y: -300, zoom: 1.05 };
  assert.deepEqual(interpolateConstellationCamera(from, to, 0), from);
  const end = interpolateConstellationCamera(from, to, 1);
  assert.ok(Math.abs(end.zoom - to.zoom) < 1e-10); assert.equal(end.x, to.x); assert.equal(end.y, to.y);
  for (let i = 0; i <= 20; i++) {
    const value = interpolateConstellationCamera(from, to, i / 20);
    assert.ok(value.x >= from.x && value.x <= to.x); assert.ok(value.y >= to.y && value.y <= from.y); assert.ok(value.zoom > 0 && value.zoom <= to.zoom + 1e-10);
  }
});
test("starfield is deterministic, bounded even on 8K screens, and moves gently through wrapping boundaries", () => {
  assert.deepEqual(constellationStars(390, 700), constellationStars(390, 700));
  assert.ok(constellationStars(8000, 6000).length <= 220); assert.ok(constellationStars(320, 500).length >= 45);
  for (const star of constellationStars(1440, 1000)) {
    const before = constellationStarPoint(star, 0, 1440, 1000); const after = constellationStarPoint(star, 1, 1440, 1000);
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 7);
    const later = constellationStarPoint(star, 1e6, 1440, 1000);
    assert.ok(later.x >= -20 && later.x <= 1460); assert.ok(later.y >= -20 && later.y <= 1020);
  }
});
test("moving background is separate, visibility-aware, reduced-motion-aware and fully cancelable", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const stars = read("../src/components/appearance/StarrySkyCanvas.tsx");
  const window = read("../src/components/familyTree/FamilyConstellationWindow.tsx");
  const motion = read("../src/features/family-tree-view/appearance/useSkyMotionEnvironment.ts");
  assert.match(motion, /prefers-reduced-motion: reduce/u); assert.match(motion, /visibilitychange/u); assert.match(stars, /cancelAnimationFrame/u);
  assert.match(stars, /SKY_ANIMATION_FPS/u); assert.doesNotMatch(stars, /fetch\(|setInterval\(/u);
  assert.equal((window.match(/ref=\{camera.containerRef\}/gu) ?? []).length, 1);
  assert.match(window, /onWheelCapture=\{pausePresentation\}/u); assert.match(window, /presentationBefore/u);
});
