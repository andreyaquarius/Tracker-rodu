import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { FamilyGraphData, TreePerson, ParentChildRelation } from "../src/features/family-tree-view/types.ts";
import { buildConstellationScene, constellationLife, MAX_CONSTELLATION_PERSONS } from "../src/features/family-tree-view/constellation/constellationModel.ts";
import { constellationHitTest, constellationLabels, constellationScreenPoint, constellationTone } from "../src/features/family-tree-view/constellation/constellationPresentation.ts";
import { resolveFamilyTreeChartColorScheme, lineageToneForAhnentafelSlot } from "../src/features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import { DEFAULT_FAMILY_TREE_APPEARANCE } from "../src/utils/familyTreeAppearance.ts";
import { applyPinchToCamera, clampTreeZoom, zoomCameraAtClientPoint } from "../src/features/family-tree-view/react/treeCameraMath.ts";

const person = (id: string): TreePerson => ({ id, displayName: `Тестова особа ${id}` });
const parent = (parentId: string, childId: string, extra: Partial<ParentChildRelation> = {}): ParentChildRelation => ({ id: `${parentId}:${childId}`, parentId, childId, kind: "biological", ...extra });
const family = (): FamilyGraphData => ({
  persons: ["root", "father", "mother", "grandfather", "partner", "child", "sibling", "unconnected"].map(person),
  unions: [{ id: "couple", kind: "partnership", memberIds: ["root", "partner"], status: "married" }],
  parentChildRelations: [parent("father", "root", { role: "father" }), parent("mother", "root", { role: "mother" }), parent("grandfather", "father", { role: "father" }), parent("root", "child"), parent("partner", "child"), parent("father", "sibling")],
});

test("constellation classifies actual ancestors, descendants, partners and collateral relatives", () => {
  const graph = family();
  const before = structuredClone(graph);
  const scene = buildConstellationScene(graph, "root");
  const nodes = new Map(scene.nodes.map(node => [node.id, node]));
  assert.equal(nodes.size, 7);
  assert.equal(scene.omittedCount, 1);
  assert.equal(nodes.get("root")?.role, "focus");
  assert.equal(nodes.get("root")?.x, 0);
  assert.equal(nodes.get("father")?.role, "ancestor");
  assert.equal(nodes.get("mother")?.ancestorSlot, 3);
  assert.equal(nodes.get("grandfather")?.generation, -2);
  assert.equal(nodes.get("grandfather")?.ancestorSlot, 4);
  assert.equal(nodes.get("child")?.role, "descendant");
  assert.equal(nodes.get("child")?.generation, 1);
  assert.equal(nodes.get("partner")?.role, "partner");
  assert.equal(nodes.get("sibling")?.role, "relative");
  assert.deepEqual(scene.paths.grandfather?.personIds, ["root", "father", "grandfather"]);
  assert.deepEqual(scene.paths.grandfather?.edgeIds, ["parent:father:root", "parent:grandfather:father"]);
  assert.deepEqual(graph, before, "rendering must not mutate genealogy data");
});

test("parent sets and donor/guardian relationships do not manufacture a marriage", () => {
  const scene = buildConstellationScene({ persons: ["child", "donor", "guardian"].map(person),
    unions: [{ id: "parents", kind: "parent-set", memberIds: ["donor", "guardian"] }],
    parentChildRelations: [parent("donor", "child", { kind: "donor", role: "donor" }), parent("guardian", "child", { kind: "guardian", role: "guardian" })],
  }, "child");
  assert.equal(scene.edges.length, 2);
  assert.ok(scene.edges.every(edge => edge.kind === "parent"));
  assert.equal(scene.edges.find(edge => edge.source === "guardian")?.label, "Опіка");
  assert.equal(scene.nodes.find(node => node.id === "donor")?.ancestorSlot, undefined);
});

test("pedigree collapse draws a shared ancestor once and retains both relationships", () => {
  const graph = family();
  graph.parentChildRelations = [...graph.parentChildRelations, parent("grandfather", "mother", { role: "father" })];
  const scene = buildConstellationScene(graph, "root");
  assert.equal(scene.nodes.filter(node => node.id === "grandfather").length, 1);
  assert.equal(scene.edges.filter(edge => edge.source === "grandfather").length, 2);
});

test("malformed cycles, self edges and missing people terminate without phantom people", () => {
  const graph: FamilyGraphData = { persons: ["a", "b", "c"].map(person), unions: [], parentChildRelations: [parent("a", "b"), parent("b", "c"), parent("c", "a"), parent("a", "a"), parent("missing", "a")] };
  const scene = buildConstellationScene(graph, "a");
  assert.equal(scene.nodes.length, 3);
  assert.equal(scene.edges.length, 3);
  assert.ok(scene.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.deepEqual(buildConstellationScene(graph, "missing").nodes, []);
});

test("layout and connection choices remain deterministic when response order changes", () => {
  const graph = family();
  const reordered = { ...graph, persons: [...graph.persons].reverse(), unions: [...graph.unions].reverse(), parentChildRelations: [...graph.parentChildRelations].reverse() };
  assert.deepEqual(buildConstellationScene(graph, "root"), buildConstellationScene(reordered, "root"));
});

test("deep 11-generation line retains a readable selectable ancestor", () => {
  const graph: FamilyGraphData = { persons: Array.from({ length: 12 }, (_, i) => person(String(i))), unions: [], parentChildRelations: Array.from({ length: 11 }, (_, i) => parent(String(i + 1), String(i), { role: "father" })) };
  const scene = buildConstellationScene(graph, "0");
  const ancestor = scene.nodes.find(node => node.id === "11")!;
  assert.equal(ancestor.generation, -11);
  assert.equal(ancestor.ancestorSlot, 2 ** 11);
  const size = { width: 360, height: 500 };
  const camera = { x: ancestor.x, y: ancestor.y, zoom: 0.9 };
  const labels = constellationLabels(scene, camera, size, ancestor.id);
  assert.ok(labels.some(label => label.node.id === ancestor.id));
  assert.equal(constellationHitTest(scene, camera, size, { x: 180, y: 250 }), ancestor.id);
  assert.equal(scene.paths[ancestor.id]?.personIds.length, 12);
});

test("dense graph is bounded, leaves no dangling edges and builds without a force simulation", () => {
  const people = Array.from({ length: 1200 }, (_, index) => person(String(index)));
  const started = performance.now();
  const scene = buildConstellationScene({ persons: people, unions: [], parentChildRelations: people.slice(1).map(node => parent("0", node.id)) }, "0");
  assert.equal(scene.nodes.length, MAX_CONSTELLATION_PERSONS);
  assert.equal(scene.omittedCount, 200);
  const ids = new Set(scene.nodes.map(node => node.id));
  assert.ok(scene.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)));
  assert.ok(scene.nodes.every(node => [node.x, node.y].every(Number.isFinite)));
  assert.ok(performance.now() - started < 2000, "bounded deterministic layout should finish well below interactive timeout");
});

test("colors inherit the saved ancestry palette without inventing branches from sex", () => {
  const colors = resolveFamilyTreeChartColorScheme({ ...DEFAULT_FAMILY_TREE_APPEARANCE, directLineageGrouping: "parents", directLineageColor: "#476ba8" });
  const scene = buildConstellationScene(family(), "root");
  const father = scene.nodes.find(node => node.id === "father")!;
  assert.deepEqual(constellationTone(father, colors), lineageToneForAhnentafelSlot(colors, 2));
  assert.deepEqual(constellationTone(scene.nodes[0]!, colors), colors.focus);
  assert.deepEqual(constellationTone({ ...father, ancestorSlot: undefined, person: { ...father.person, sex: "male" } }, colors), colors.lineageBase);
});

test("screen labels do not shrink with zoom, overlap each other or leave the viewport", () => {
  const scene = buildConstellationScene(family(), "root");
  const size = { width: 800, height: 650 };
  const normalWidth = constellationLabels(scene, { x: 0, y: 0, zoom: 1 }, size, "root").find(label => label.node.id === "root")!.width;
  for (const zoom of [0.05, 0.3, 0.7, 1.5]) {
    const labels = constellationLabels(scene, { x: 0, y: 0, zoom }, size, "root");
    const root = labels.find(label => label.node.id === "root")!;
    assert.ok(root);
    assert.equal(root.width, normalWidth);
    for (const a of labels) {
      assert.ok(a.x - a.width / 2 >= 0 && a.x + a.width / 2 <= size.width);
      for (const b of labels) {
        if (a === b) continue;
        const overlaps = Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < 52;
        assert.equal(overlaps, false);
      }
    }
  }
});

test("wide overview zoom is opt-in and preserves both wheel and pinch anchors", () => {
  const limits = { min: 0.0001, max: 4 };
  assert.equal(clampTreeZoom(0.001), 0.045, "unchanged default for the classic tree");
  assert.equal(clampTreeZoom(0.001, limits), 0.001);
  const size = { width: 360, height: 500 };
  const viewport = { left: 0, top: 0, ...size };
  const camera = { x: 250, y: 300, zoom: 0.01 };
  const anchor = { x: 2250, y: -2700 };
  const point = constellationScreenPoint(anchor, camera, size);
  const next = zoomCameraAtClientPoint(camera, viewport, point, 0.1, limits);
  assert.equal(next.zoom, 0.001);
  assert.deepEqual(constellationScreenPoint(anchor, next, size), point);
  const pinched = applyPinchToCamera(camera, viewport, { centerX: point.x, centerY: point.y, distance: 100 }, { centerX: point.x, centerY: point.y, distance: 10 }, limits);
  assert.deepEqual(pinched, next);
});

test("life labels preserve uncertain dates and never invent living status", () => {
  assert.equal(constellationLife({ ...person("a"), birth: { display: "близько 1880" }, death: { display: "після 1940" } }), "нар. близько 1880 · пом. після 1940");
  assert.equal(constellationLife(person("b")), "");
});

test("stage one is lazy, read-only and renders without an idle animation loop", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const page = read("../src/pages/ProductionFamilyTreePage.tsx");
  const menu = read("../src/components/familyTree/FamilyTreeDisplayWindow.tsx");
  const window = read("../src/components/familyTree/FamilyConstellationWindow.tsx");
  const canvas = read("../src/features/family-tree-view/constellation/ConstellationCanvas.tsx");
  assert.match(page, /const FamilyConstellationWindow = lazy\(/);
  assert.match(menu, /onClick=\{onOpenConstellationChart\}/);
  assert.match(window, /structuralOnly: true/);
  assert.match(window, /MAX_CONSTELLATION_PERSONS/);
  assert.match(window, /TRACKER_RODU_CHART_BRAND_NAME/);
  assert.doesNotMatch(window, /getSupabaseClient|\.rpc\(|\.upsert\(|localStorage/);
  assert.equal((canvas.match(/requestAnimationFrame\(/g) ?? []).length, 1);
  assert.doesNotMatch(canvas, /setInterval|setTimeout/);
  assert.match(canvas, /cancelAnimationFrame\(frame\)/);
});
