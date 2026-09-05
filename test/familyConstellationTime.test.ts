import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import type { FamilyGraphData, TreePerson, TreeUnion } from "../src/features/family-tree-view/types.ts";
import type { PersonEvent } from "../src/types/index.ts";
import { buildConstellationScene } from "../src/features/family-tree-view/constellation/constellationModel.ts";
import { constellationDateAtYear, constellationProfileDate, parseConstellationDate } from "../src/features/family-tree-view/constellation/constellationDates.ts";
import { buildConstellationTimeModel, projectConstellationTime, constellationTimeEdgeLabel, type ConstellationTimeProfile } from "../src/features/family-tree-view/constellation/constellationTime.ts";

function setup(people: Partial<TreePerson>[] = [{}], profiles: ConstellationTimeProfile[] = [], unions: TreeUnion[] = []) {
  const graph: FamilyGraphData = { persons: people.map((person, i) => ({ id: String(i), displayName: `Особа ${i}`, ...person })),
    parentChildRelations: people.slice(1).map((_, i) => ({ id: `p${i}`, parentId: "0", childId: String(i + 1), kind: "biological" })), unions };
  const scene = buildConstellationScene(graph, "0");
  const model = buildConstellationTimeModel(scene, graph, profiles, 2026);
  return { model, graph, scene, at: (year: number, id = "0") => projectConstellationTime(model, year).persons.get(id)! };
}
const event = (id: string, type: PersonEvent["type"], date?: string, placeName?: string): PersonEvent => ({ id, personId: "0", type, date, placeName });

test("year parser validates calendar dates and recognizes supported Ukrainian and GEDCOM forms", () => {
  for (const input of ["1900", "1900-02-28", "28.02.1900", "28/02/1900", "28-02-1900", "FEB 1900", "28 FEB 1900", "02.1900", "1900-02", "1900 року"]) {
    const date = parseConstellationDate(input);
    assert.equal(date.min, 1900, input); assert.equal(date.max, 1900, input); assert.equal(date.precision, "exact", input);
  }
  assert.equal(parseConstellationDate("29.02.2000").reference, 2000);
  for (const input of ["29.02.1900", "1900-13-01", "1900-04-31", "00.01.1900", "0000", "Справа 1900, стор. 12", "1900?", "1800–1700", "1900-01-01T99:00:00Z"]) {
    assert.equal(parseConstellationDate(input).precision, "unknown", input);
  }
});

test("approximate dates retain a marker without inventing a lifespan or tolerance", () => {
  for (const text of ["ABT 1900", "близько 1900", "приблизно 1900", "~1900", "EST 1900"]) {
    const date = parseConstellationDate(text);
    assert.equal(date.reference, 1900); assert.equal(date.min, undefined); assert.equal(date.max, undefined);
    assert.equal(constellationDateAtYear(date, 1900), "approximate"); assert.equal(constellationDateAtYear(date, 1899), undefined);
  }
  const { at } = setup([{ birth: { display: "близько 1900", sort: "1900-01-01" }, death: { display: "1980" } }]);
  assert.equal(at(1890).state, "unknown"); assert.equal(at(1900).state, "unknown"); assert.equal(at(1981).state, "deceased");
});

test("bounded and open-ended dates preserve uncertainty and year-granularity boundaries", () => {
  for (const text of ["1880–1885", "1880-1885", "BET 1880 AND 1885", "FROM 1880 TO 1885", "між 1880 та 1885"]) {
    const date = parseConstellationDate(text);
    assert.equal(date.min, 1880, text); assert.equal(date.max, 1885, text);
    assert.equal(constellationDateAtYear(date, 1883), "possible");
    assert.equal(constellationDateAtYear(date, 1886), undefined);
  }
  assert.equal(parseConstellationDate("до 1900").max, 1899);
  assert.equal(parseConstellationDate("BEF 10 JAN 1900").max, 1900);
  assert.equal(parseConstellationDate("після 1900").min, 1901);
  assert.equal(parseConstellationDate("AFT 10 JAN 1900").min, 1900);
  assert.equal(constellationDateAtYear(parseConstellationDate("до 1900"), 1890), undefined, "Open bounds must not manufacture events every year");
  assert.equal(constellationProfileDate("", "1880", "").max, undefined);
  assert.equal(constellationProfileDate("", "", "1885").max, 1885);
  assert.equal(constellationProfileDate("", "1885", "1880").precision, "unknown");
  assert.equal(constellationDateAtYear(parseConstellationDate("BET 1 JAN 1900 AND 3 FEB 1900"), 1900), "dated", "A within-year interval locates the year, not the day");
  assert.equal(setup([{}], [{ id: "0", birthYearFrom: "1900", birthYearTo: "1900" }]).at(1900).state, "alive");
});

test("lifespan includes years of birth/death without asserting day-level precision", () => {
  const { at } = setup([{ birth: { display: "1900-12-31" }, death: { display: "1980-01-01" } }]);
  assert.equal(at(1899).state, "future"); assert.equal(at(1900).state, "alive");
  assert.equal(at(1979).state, "alive"); assert.equal(at(1980).state, "alive"); assert.equal(at(1981).state, "deceased");
});

test("missing death does not mean immortal; an explicit living flag only applies through today", () => {
  const { at } = setup([{ birth: { display: "1900" } }, { birth: { display: "2000" }, isLiving: true }]);
  assert.equal(at(1900).state, "alive", "Birth itself establishes life in that year");
  assert.equal(at(2026).state, "unknown"); assert.equal(at(2026, "1").state, "alive"); assert.equal(at(2030, "1").state, "unknown");
  assert.equal(at(1999, "1").state, "future");
});

test("date ranges and one-sided profile bounds override a misleading exact sorting year", () => {
  const { at, model } = setup([{ birth: { sort: "1880" }, death: { display: "1950" } }], [{ id: "0", birthYearFrom: "1880", birthYearTo: "1885" }]);
  assert.equal(model.persons.get("0")?.birth.precision, "range");
  assert.equal(at(1879).state, "future"); assert.equal(at(1883).state, "unknown"); assert.equal(at(1885).state, "alive");
  assert.equal(setup([{}], [{ id: "0", birthYearFrom: "1880" }]).at(1900).state, "unknown");
});

test("contradictory life data is explicitly unknown rather than confidently misclassified", () => {
  assert.equal(setup([{ birth: { display: "1950" }, death: { display: "1900" } }]).at(1920).conflict, true);
  const { at } = setup([{ birth: { display: "1950" }, death: { display: "2000" }, isLiving: true }]);
  assert.equal(at(2026).state, "unknown"); assert.equal(at(2026).conflict, true);
  const alternative = setup([{ birth: { display: "1900" }, death: { display: "1980" } }], [{ id: "0", events: [event("alternative", "birth", "1920")] }]);
  assert.equal(alternative.at(1910).conflict, true, "Contradicting core and additional life events must not be silently resolved");
});

test("private and unloaded people cannot leak profile dates, places, events or union dates", () => {
  const { model, at } = setup([{ isPrivate: true, badges: { privacy: "masked" }, birth: { display: "1900" } }, {}], [{ id: "0", birthDate: "1888", birthPlace: "Секретне місце", events: [event("hidden", "immigration", "1950", "Секрет")] }, { id: "outside", birthDate: "1111" }],
    [{ id: "u", kind: "partnership", memberIds: ["0", "1"], startDate: { display: "1910" } }]);
  assert.equal(model.events.length, 0); assert.equal(model.years.length, 0); assert.equal(model.unions.size, 0);
  assert.equal(model.persons.has("outside"), false); assert.equal(at(2000).state, "unknown");
  assert.equal(at(2000).lastPlaces.length, 0);
});

test("private records remain usable for an authorized viewer; actual RPC masking always wins", () => {
  const { model, at } = setup([{ isPrivate: true, birth: { display: "1900" }, death: { display: "1980" } }], [{ id: "0", birthPlace: "Київ" }]);
  assert.equal(at(1950).state, "alive"); assert.equal(model.events[0]?.place, "Київ");
  assert.equal(at(1950).lastPlaces[0]?.place, "Київ");
  const masked = setup([{ badges: { privacy: "masked" }, birth: { display: "1900" } }], [{ id: "0", birthDate: "1900" }]);
  assert.equal(masked.model.events.length, 0, "The masking marker is authoritative even without isPrivate");
});

test("core copies of one union marriage collapse while repeat marriages remain distinct", () => {
  const { model } = setup([{}, {}], [{ id: "0", marriageDate: "20.05.1900", marriagePlace: "Київ" }, { id: "1", marriageDate: "1900-05-20" }],
    [{ id: "first", kind: "partnership", memberIds: ["0", "1"], status: "divorced", startDate: { display: "1900-05-20" }, endDate: { display: "1920" } },
      { id: "second", kind: "partnership", memberIds: ["0", "1"], status: "married", startDate: { display: "1925" } }]);
  const marriage = model.events.filter(event => event.type === "marriage");
  assert.equal(marriage.length, 2); assert.equal(marriage[0]?.place, "Київ"); assert.deepEqual(marriage[0]?.personIds, ["0", "1"]);
  assert.equal(model.persons.get("0")!.events.filter(event => event.type === "marriage").length, 2);
  assert.equal(projectConstellationTime(model, 1900).events.filter(({ event }) => event.type === "marriage").length, 1);
});

test("union time uses recorded start/end, not today's divorce status applied to the past", () => {
  const { model, scene } = setup([{}, {}], [], [{ id: "u", kind: "partnership", memberIds: ["0", "1"], status: "divorced", startDate: { display: "1900" }, endDate: { display: "1920" } }]);
  assert.equal(projectConstellationTime(model, 1899).unions.get("u"), "future");
  assert.equal(projectConstellationTime(model, 1910).unions.get("u"), "started");
  assert.equal(projectConstellationTime(model, 1921).unions.get("u"), "ended");
  const edge = scene.edges.find(edge => edge.kind === "partner");
  assert.equal(constellationTimeEdgeLabel(edge), "Розлучення");
  assert.doesNotMatch(constellationTimeEdgeLabel(edge, projectConstellationTime(model, 1910)), /Розлучення/u);
  assert.match(constellationTimeEdgeLabel(edge, projectConstellationTime(model, 1910)), /Після дати початку/u);
  const undated = setup([{}, {}], [], [{ id: "u", kind: "partnership", memberIds: ["0", "1"], status: "divorced" }]);
  assert.equal(projectConstellationTime(undated.model, 1910).unions.get("u"), "unknown");
});

test("parent sets are not promoted to marriage events, and core marriage does not invent a spouse", () => {
  const { model, scene } = setup([{}, {}], [{ id: "0", marriageDate: "1910" }], [{ id: "p", kind: "parent-set", memberIds: ["0", "1"], startDate: { display: "1900" } }]);
  assert.equal(model.unions.size, 0); assert.equal(model.events.length, 1);
  assert.deepEqual(model.events[0]?.personIds, ["0"]); assert.equal(scene.edges.some(edge => edge.kind === "partner"), false);
});

test("movement and residence records stay tied to actual person dates and original source places", () => {
  const { model, at } = setup([{}], [{ id: "0", events: [event("a", "birth", "1880", "Село"), event("b", "emigration", "1900", "Порт"),
    { ...event("c", "immigration", "1905", "Нове місце"), placeOriginalText: "Запис із джерела" },
    event("d", "residence", "1905", "Друге місце"), event("e", "residence", undefined, "Без дати"), event("f", "residence", "ABT 1906", "Приблизне місце") ] }]);
  assert.equal(at(1890).lastPlaces[0]?.place, "Село"); assert.equal(at(1900).lastPlaces[0]?.place, "Порт");
  assert.deepEqual(at(1910).lastPlaces.map(event => event.place), ["Запис із джерела", "Друге місце"]);
  assert.equal(model.persons.get("0")!.events.some(event => event.place === "Без дати"), true);
  const possible = projectConstellationTime(model, 1906).events.find(({ event }) => event.place === "Приблизне місце");
  assert.equal(possible?.certainty, "approximate");
  assert.equal(projectConstellationTime(model, 1905).events.length, 2);
});

test("core event copies and duplicated IDs are collapsed without discarding separately entered facts", () => {
  const birth = event("b", "birth", "1900", "Місце");
  const { model } = setup([{ birth: { display: "1900" } }], [{ id: "0", events: [birth, birth, event("r1", "residence", "1920", "A"), event("r2", "residence", "1920", "B"), { ...event("foreign", "birth", "1111"), personId: "outside" }] }]);
  assert.equal(model.events.length, 3); assert.equal(model.events[0]?.place, "Місце"); assert.equal(model.years.includes(1111), false);
});

test("year range is bounded, includes present, and disables when no dates are understood", () => {
  assert.equal(setup().model.range, undefined);
  assert.equal(setup([{ birth: { display: "десь у XIX столітті" } }]).model.range, undefined);
  assert.deepEqual(setup([{ birth: { display: "1900" } }]).model.range, { min: 1899, max: 2026 });
  assert.deepEqual(setup([{ birth: { display: "0001" } }, { birth: { display: "9999" } }]).model.range, { min: 1, max: 9999 });
});

test("changing year is a bounded pure projection that leaves geometry and source data untouched", () => {
  const { model, graph, scene } = setup(Array.from({ length: 1000 }, (_, i) => ({ birth: { display: String(1500 + i % 500) }, death: { display: String(1550 + i % 500) } })));
  const before = structuredClone({ model, graph, scene });
  const start = performance.now();
  for (let year = 1850; year <= 1950; year++) {
    const slice = projectConstellationTime(model, year);
    assert.equal(Object.values(slice.counts).reduce((a, b) => a + b), 1000);
  }
  assert.ok(performance.now() - start < 2500, "100 slider steps should not require simulation or re-layout");
  assert.deepEqual(structuredClone({ model, graph, scene }), before);
});

test("integration uses existing authorized person data and keeps time out of layout dependencies", () => {
  const page = readFileSync(new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("../src/components/familyTree/FamilyConstellationWindow.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/features/family-tree-view/constellation/constellation.css", import.meta.url), "utf8");
  assert.match(page, /timeProfiles=\{persons\}/u);
  assert.match(component, /useConstellationScene\(graph, focusPersonId\)/u);
  assert.match(component, /aria-label="Режим сузір’я"/u);
  assert.match(css, /\.constellation-body\s*\{\s*grid-row:\s*3/u);
  assert.match(css, /\.constellation-time-controls\s*\{\s*grid-row:\s*2/u);
});
