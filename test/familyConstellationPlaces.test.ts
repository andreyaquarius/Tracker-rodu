import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import type { PersonEvent } from "../src/types/index.ts";
import type { FamilyGraphData, TreePerson } from "../src/features/family-tree-view/types.ts";
import { buildConstellationScene } from "../src/features/family-tree-view/constellation/constellationModel.ts";
import { buildConstellationTimeModel, type ConstellationTimeProfile } from "../src/features/family-tree-view/constellation/constellationTime.ts";
import { parseConstellationDate } from "../src/features/family-tree-view/constellation/constellationDates.ts";
import { constellationPlaceKey, constellationPlaceReference } from "../src/features/family-tree-view/constellation/constellationPlaceIdentity.ts";
import { buildConstellationPlacesModel, buildConstellationPlacesScene, constellationPlaceHitTest, constellationPlaceLabels, constellationPeopleCount, constellationRecordCount, constellationVisiblePlaceLinks, MAX_CONSTELLATION_PLACES, MAX_CONSTELLATION_PLACE_LINKS, searchConstellationPlaces } from "../src/features/family-tree-view/constellation/constellationPlaces.ts";

const event = (id: string, placeName: string, date?: string, extra: Partial<PersonEvent> = {}): PersonEvent => ({ id, personId: "0", type: "residence", date, placeName, ...extra });
function setup(profiles: ConstellationTimeProfile[], people?: TreePerson[], unions: FamilyGraphData["unions"] = []) {
  const graph: FamilyGraphData = { persons: people ?? profiles.map(person => ({ id: person.id, displayName: `Особа ${person.id}` })), unions,
    parentChildRelations: profiles.slice(1).map(person => ({ id: `p:${person.id}`, parentId: "0", childId: person.id, kind: "biological" })) };
  const scene = buildConstellationScene(graph, "0");
  const time = buildConstellationTimeModel(scene, graph, profiles, 2026);
  return { graph, time, model: buildConstellationPlacesModel(time) };
}

test("confirmed place IDs unite historical aliases while keeping original source wording", () => {
  const { model } = setup([{ id: "0", events: [event("a", "Кіевъ", "1900", { placeId: "kyiv", placeResolutionStatus: "confirmed", placeCanonicalName: "Київ" }),
    event("b", "Київ", "1920", { placeId: "kyiv", placeResolutionStatus: "confirmed" })] },
    { id: "1", events: [event("c", "Киев", "1910", { personId: "1", placeId: "kyiv", placeResolutionStatus: "confirmed", placeCanonicalName: "Київ" })] }]);
  const place = model.places.get("place:kyiv")!;
  assert.equal(model.places.size, 1); assert.equal(place.label, "Київ"); assert.equal(place.aliases.length, 3);
  assert.equal(place.personIds.length, 2); assert.equal(place.events.length, 3); assert.equal(model.links.length, 0);
  assert.equal(searchConstellationPlaces(model, "Кіевъ")[0]?.id, "place:kyiv");
});

test("pending place IDs, same-named villages and bare text are not silently conflated", () => {
  const { model } = setup([{ id: "0", events: [
    event("a", "Вербівка", "1900", { placeId: "v1", placeResolutionStatus: "confirmed" }),
    event("b", "Вербівка", "1901", { placeId: "v2", placeResolutionStatus: "confirmed" }),
    event("c", "Вербівка", "1902", { placeId: "v1", placeResolutionStatus: "needs_review" }),
    event("d", "с. Вербівка", "1903"), event("e", "Вербівка, Житомирщина", "1904"),
  ] }]);
  assert.equal(model.places.size, 5);
  assert.equal(model.places.get("text:вербівка")?.canonicalId, undefined);
  assert.equal(searchConstellationPlaces(model, "Вербівка").length, 5);
  assert.equal(constellationPlaceReference(event("x", "Place", "", { placeId: "unsafe" })).placeId, undefined);
});

test("text grouping only normalizes Unicode, whitespace and case, not spelling or geography", () => {
  const { model } = setup([{ id: "0", events: [event("a", "  Біла   Церква ", "1900"), event("b", "біла церква", "1901"), event("c", "Белая Церковь", "1902")] }]);
  assert.equal(model.places.size, 2); assert.equal(model.places.get("text:біла церква")?.events.length, 2);
  assert.equal(model.places.get("text:біла церква")?.canonicalId, undefined);
  assert.equal(constellationPlaceKey({ place: "Київ", placeId: "x" }), "place:x");
});

test("year, month and day dates retain calendar-order intervals without timezone inference", () => {
  assert.deepEqual([parseConstellationDate("1900").earliest, parseConstellationDate("1900").latest], [19000101, 19001231]);
  assert.deepEqual([parseConstellationDate("02.1900").earliest, parseConstellationDate("02.1900").latest], [19000201, 19000228]);
  assert.equal(parseConstellationDate("FEB 2000").latest, 20000229);
  assert.equal(parseConstellationDate("FEB 1500").latest, 15000228);
  assert.equal(parseConstellationDate("1900-02-12").earliest, parseConstellationDate("12.02.1900").latest);
  assert.notEqual(parseConstellationDate("1900-02").key, parseConstellationDate("1900-02-01").key);
  assert.equal(parseConstellationDate("ABT 1900").earliest, undefined);
});

test("within-year migrations are ordered only when the full date bounds do not overlap", () => {
  const { model } = setup([{ id: "0", events: [event("a", "Київ", "10.01.1900", { type: "emigration" }), event("b", "Львів", "20.03.1900", { type: "immigration" })] }]);
  assert.equal(model.links.length, 1); assert.equal(model.links[0]?.transitions[0]?.hasMigrationEvent, true);
  assert.equal(model.places.get("text:київ")?.migrationEventCount, 1);
  const overlapping = setup([{ id: "0", events: [event("a", "Київ", "1900-02"), event("b", "Львів", "10.02.1900")] }]);
  assert.equal(overlapping.model.links.length, 0); assert.equal(overlapping.model.journeys.get("0")?.ambiguousGroupCount, 1);
});

test("year-only ties, overlapping ranges and transitive overlaps block arrows across ambiguous groups", () => {
  const { model } = setup([{ id: "0", events: [event("first", "A", "1880"), event("a", "B", "1900–1905"), event("b", "C", "1904–1910"), event("c", "D", "1909–1915"), event("last", "E", "1920")] }]);
  assert.equal(model.links.length, 0, "No A→E bypass or arbitrary B→C→D order");
  assert.equal(model.journeys.get("0")?.groups.length, 3);
  assert.equal(model.journeys.get("0")?.ambiguousGroupCount, 1);
  const sameYear = setup([{ id: "0", events: [event("a", "A", "1900"), event("b", "B", "1900")] }]);
  assert.equal(sameYear.model.links.length, 0);
});

test("unknown, approximate and one-sided dates remain visible without invented arrows", () => {
  const { model } = setup([{ id: "0", events: [event("a", "A", "близько 1900"), event("b", "B", "до 1920"), event("c", "C"), event("d", "D", "десь у XIX ст.")] }]);
  assert.equal(model.places.size, 4); assert.equal(model.links.length, 0);
  assert.equal(model.journeys.get("0")?.unsequenced.length, 4);
});

test("repeated same-place records do not create self-arrows; a return visit keeps direction", () => {
  const { model } = setup([{ id: "0", events: [event("a", "A", "1900"), event("a2", "A", "1901"), event("b", "B", "1905"), event("a3", "A", "1910")] }]);
  assert.equal(model.links.length, 2); assert.ok(model.links.every(link => link.source !== link.target));
  assert.equal(model.journeys.get("0")?.transitions[0]?.from.event.id, "event:0:a2");
  assert.equal(model.journeys.get("0")?.transitions[1]?.source, "text:b");
});

test("different people are never stitched together into a journey and membership counts are unique", () => {
  const { model } = setup([{ id: "0", events: [event("a", "A", "1900"), event("b", "B", "1920"), event("b2", "B", "1921")] },
    { id: "1", events: [event("c", "C", "1901", { personId: "1" }), event("a", "A", "1910", { personId: "1" }), event("b", "B", "1930", { personId: "1" })] }]);
  const ab = model.links.find(link => link.source === "text:a" && link.target === "text:b")!;
  assert.deepEqual(ab.personIds, ["0", "1"]); assert.equal(ab.transitions.length, 2);
  assert.equal(model.places.get("text:b")?.personIds.length, 2); assert.equal(model.places.get("text:b")?.events.length, 3);
  assert.equal(model.links.some(link => link.source === "text:a" && link.target === "text:c"), false);
});

test("actual privacy masking and loaded scope win over cached full place profiles", () => {
  const { model } = setup([{ id: "0", birthPlace: "Hidden", events: [event("secret", "SECRET", "1900")] }, { id: "1", birthPlace: "Allowed", birthDate: "1880" }, { id: "outside", birthPlace: "Outside" }],
    [{ id: "0", displayName: "Приховано", badges: { privacy: "masked" } }, { id: "1", displayName: "Власник", isPrivate: true }]);
  assert.equal(model.places.size, 1); assert.equal(model.places.has("text:allowed"), true); assert.equal(model.maskedPeople, 1);
  assert.equal(model.personCount, 1); assert.equal(model.journeys.has("outside"), false);
});

test("core event enrichment preserves confirmed identities and never discards contradictory place facts", () => {
  const { model } = setup([{ id: "0", birthDate: "1900", birthPlace: "Київ", events: [
    event("birth", "Київ", "1900", { type: "birth", placeId: "kyiv", placeResolutionStatus: "confirmed", placeCanonicalName: "Київ" }),
    event("alternative", "Львів", "1900", { type: "birth" }),
  ] }]);
  assert.equal(model.places.size, 2); assert.equal(model.places.get("place:kyiv")?.events.length, 1);
  assert.equal(model.places.get("text:львів")?.events.length, 1); assert.equal(model.links.length, 0);
});

test("conflicting legacy marriage places are retained instead of choosing a partner's place arbitrarily", () => {
  const { model } = setup([{ id: "0", marriageDate: "1900", marriagePlace: "A" }, { id: "1", marriageDate: "1900", marriagePlace: "B" }], undefined,
    [{ id: "u", kind: "partnership", memberIds: ["0", "1"], startDate: { display: "1900" }, status: "married" }]);
  assert.equal(model.places.size, 2); assert.deepEqual(model.places.get("text:a")?.personIds, ["0"]); assert.deepEqual(model.places.get("text:b")?.personIds, ["1"]);
});

test("legacy residence text is kept as one undated wording, without fabricated settlement parsing", () => {
  const { model } = setup([{ id: "0", residencePlaces: "Київ, Львів; Одеса" }]);
  assert.equal(model.places.size, 1); assert.equal(model.journeys.get("0")?.unsequenced.length, 1);
  assert.equal(model.links.length, 0);
});

test("schematic layout is deterministic and filters without dangling links", () => {
  const { time, model } = setup([{ id: "0", events: [event("a", "A", "1900"), event("b", "B", "1920")] }, { id: "1", events: [event("c", "C", "1900", { personId: "1" })] }]);
  const a = buildConstellationPlacesScene(model);
  const reversed = buildConstellationPlacesModel({ ...time, events: [...time.events].reverse() });
  assert.deepEqual(a, buildConstellationPlacesScene(reversed));
  const b = buildConstellationPlacesScene(model, "0");
  assert.equal(b.nodes.length, 2); assert.ok(b.nodes.every(node => node.place.personIds.includes("0")));
  assert.ok(b.links.every(link => b.nodes.some(node => node.id === link.source) && b.nodes.some(node => node.id === link.target)));
  assert.ok(a.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.equal(buildConstellationPlacesScene(model, "missing").nodes.length, 0);
});

test("120-place canvas cap retains an all-place directory and lets an omitted result be pinned", () => {
  const { model } = setup([{ id: "0", events: Array.from({ length: 400 }, (_, i) => event(String(i), `Place ${String(i).padStart(4, "0")}`, String(1500 + i))) }]);
  const scene = buildConstellationPlacesScene(model);
  assert.equal(scene.nodes.length, MAX_CONSTELLATION_PLACES); assert.equal(scene.omittedCount, 280);
  const omitted = searchConstellationPlaces(model, "Place 0399")[0]!;
  const focused = buildConstellationPlacesScene(model, undefined, omitted.id);
  assert.equal(focused.nodes[0]?.id, omitted.id); assert.equal(focused.nodes[0]?.x, 0);
  assert.equal(focused.nodes.length, MAX_CONSTELLATION_PLACES); assert.equal(model.places.size, 400);
});

test("screen labels are readable, bounded and selectable at mobile and desktop sizes", () => {
  const { model } = setup([{ id: "0", events: Array.from({ length: 25 }, (_, i) => event(String(i), `Довга назва населеного пункту ${i}`, String(1900 + i))) }]);
  const scene = buildConstellationPlacesScene(model); const selected = scene.nodes[0]!;
  for (const width of [320, 390, 1440]) {
    const size = { width, height: 540 }; const camera = { x: selected.x, y: selected.y, zoom: 0.7 };
    const labels = constellationPlaceLabels(scene, camera, size, selected.id);
    assert.ok(labels.some(label => label.node.id === selected.id));
    for (const label of labels) { assert.ok(label.x - label.width / 2 >= 0); assert.ok(label.x + label.width / 2 <= width); assert.ok(label.y >= 0 && label.y + 57 <= size.height); }
    assert.equal(constellationPlaceHitTest(scene, camera, size, { x: width / 2, y: 270 }), selected.id);
  }
});

test("dense place links are capped with selected-person priority, without losing the full model", () => {
  const { model } = setup([{ id: "0", events: [event("a", "A", "1900"), event("b", "B", "1910")] }]);
  const scene = buildConstellationPlacesScene(model);
  const selectedLink = { ...scene.links[0]!, id: "zz-selected" };
  scene.links = [...Array.from({ length: 605 }, (_, index) => ({ ...selectedLink, id: `other:${index}`, personIds: ["1"], transitions: [] })), selectedLink];
  const before = structuredClone(scene);
  const all = constellationVisiblePlaceLinks(scene, "0", true);
  assert.equal(all.links.length, MAX_CONSTELLATION_PLACE_LINKS);
  assert.equal(all.omittedCount, 6);
  assert.equal(all.links[0]?.id, selectedLink.id);
  assert.deepEqual(constellationVisiblePlaceLinks(scene, "0", false), { links: [selectedLink], omittedCount: 0 });
  assert.deepEqual(constellationVisiblePlaceLinks(scene, "missing", false), { links: [], omittedCount: 0 });
  assert.deepEqual(scene, before);
});

test("place labels use Ukrainian count forms, including teens and hundreds", () => {
  assert.deepEqual([0, 1, 2, 4, 5, 11, 14, 21, 22, 111, 121].map(constellationPeopleCount),
    ["0 осіб", "1 особа", "2 особи", "4 особи", "5 осіб", "11 осіб", "14 осіб", "21 особа", "22 особи", "111 осіб", "121 особа"]);
  assert.deepEqual([1, 3, 12, 23, 100].map(constellationRecordCount), ["1 запис", "3 записи", "12 записів", "23 записи", "100 записів"]);
});

test("1000-person place projection is bounded in rendering and does not mutate source records", () => {
  const profiles = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), events: Array.from({ length: 5 }, (_, j) => event(`${i}:${j}`, `Місце ${(i + j) % 1600}`, String(1800 + j * 10), { personId: String(i) })) }));
  const before = structuredClone(profiles);
  const start = performance.now(); const { time, model } = setup(profiles); const snapshot = structuredClone(time);
  const scene = buildConstellationPlacesScene(model);
  assert.equal(model.personCount, 1000); assert.equal(scene.nodes.length, 120); assert.ok(model.places.size > 1000);
  assert.ok(performance.now() - start < 2000); assert.deepEqual(profiles, before); assert.deepEqual(time, snapshot);
});

test("places mode is integrated read-only with one camera viewport and no remote geocoder", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const component = read("../src/components/familyTree/FamilyConstellationWindow.tsx");
  const canvas = read("../src/features/family-tree-view/constellation/ConstellationPlacesCanvas.tsx");
  assert.match(component, /changeMode\("places"\)/u); assert.match(component, /savedCameras/u);
  assert.equal((component.match(/ref=\{camera.containerRef\}/gu) ?? []).length, 1);
  assert.doesNotMatch(canvas, /fetch\(|setInterval\(|geocode/iu);
  assert.match(canvas, /cancelAnimationFrame/u);
});
