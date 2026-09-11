import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Person, PersonEvent, PersonRelation, ScanAttachment } from "../src/types/index.ts";
import type { ProjectPersonMarriage } from "../src/services/projectPersonMarriages.ts";
import { buildPersonFamilyTimeline } from "../src/features/persons-v2/relativeTimeline.ts";
import { buildPersonTimeline, personTimelineAttachments } from "../src/features/persons-v2/model.ts";
import { buildPersonLifeMapStops } from "../src/features/persons-v2/personLifeMapModel.ts";
import { personTimelineEventDisplayTitle, personTimelineEventDisplaySubtitle } from "../src/features/persons-v2/presentation.ts";

function person(id: string, patch: Partial<Person> = {}): Person {
  return {
    id, fullName: id, surname: "", givenName: "", patronymic: "", maidenSurname: "",
    researchId: "", createdAt: "", updatedAt: "", gender: "невідомо", status: "доведена",
    nameVariants: "", surnameVariants: "", birthDate: "", birthPlace: "", birthYearFrom: "", birthYearTo: "",
    deathDate: "", deathPlace: "", deathYearFrom: "", deathYearTo: "", marriageDate: "", marriagePlace: "",
    residencePlaces: "", socialStatus: "", religion: "", occupation: "", notes: "", isLiving: false,
    privacyStatus: "project", customFields: {}, events: [], birthScans: [], marriageScans: [],
    deathScans: [], mentionScans: [], photos: [], ...patch,
  };
}
function relation(childId: string, parentId: string, patch: Partial<PersonRelation> = {}): PersonRelation {
  return {
    id: `${childId}:${parentId}`, personId: childId, relatedPersonId: parentId, relationType: "батько або мати",
    status: "доведено", evidenceText: "", notes: "", createdAt: "", updatedAt: "", ...patch,
  };
}
function event(id: string, type: PersonEvent["type"], date: string, patch: Partial<PersonEvent> = {}): PersonEvent {
  return { id, personId: "child", type, date, ...patch };
}
function marriage(id: string, child: string, partner: string, date: string): ProjectPersonMarriage {
  return {
    id, projectId: "project", treeId: "tree", personAId: child, personBId: partner,
    date, place: "Київ", address: "буд. 2", evidenceStatus: "proven", createdAt: "", updatedAt: "",
  };
}
const familyOnly = (result: ReturnType<typeof buildPersonFamilyTimeline>) => result.filter((item) => item.relative);

test("both parents see a child's birth, marriage and death among their own events", () => {
  const father = person("father", { birthDate: "1840", gender: "чоловік" });
  const mother = person("mother", { birthDate: "1845", gender: "жінка" });
  const child = person("child", { fullName: "Олена Корзун", gender: "жінка", birthDate: "1870", marriageDate: "1890", deathDate: "1910" });
  const options = { persons: [father, mother, child], relations: [relation("child", "father"), relation("mother", "child", { relationType: "донька" })] };
  for (const parent of [father, mother]) {
    const timeline = buildPersonFamilyTimeline(parent, options);
    assert.deepEqual(timeline.map((item) => item.date), [parent.birthDate, "1870", "1890", "1910"]);
    assert.deepEqual(familyOnly(timeline).map((item) => item.title), [
      "Народження доньки · Олена Корзун", "Шлюб доньки · Олена Корзун", "Смерть доньки · Олена Корзун",
    ]);
    assert.ok(familyOnly(timeline).every((item) => item.personId === parent.id && item.relative?.personId === child.id));
    assert.equal(parent.events.length, 0);
  }
});

test("children see parental deaths, not parents' birth or marriage facts", () => {
  const child = person("child", { birthDate: "1870" });
  const father = person("father", { gender: "чоловік", birthDate: "1840", marriageDate: "1868", deathDate: "1900" });
  const mother = person("mother", { gender: "жінка", deathDate: "1905" });
  const timeline = buildPersonFamilyTimeline(child, { persons: [child, father, mother], relations: [relation("child", "father"), relation("child", "mother")] });
  assert.deepEqual(familyOnly(timeline).map((item) => item.title), ["Смерть батька · father", "Смерть матері · mother"]);
  assert.equal(buildPersonTimeline(child).length, 1, "projection never turns parental death into the child's own death");
});

test("explicit and shared-parent siblings include deaths once; no recursive distant-relative propagation", () => {
  const root = person("root");
  const brother = person("brother", { gender: "чоловік", deathDate: "1920" });
  const sister = person("sister", { gender: "жінка", deathDate: "1921" });
  const people = [root, brother, sister, person("father"), person("mother"), person("grandparent", { deathDate: "1800" }), person("nephew", { deathDate: "1950" })];
  const relations = [
    relation("root", "father"), relation("root", "mother"), relation("brother", "father"), relation("brother", "mother"),
    relation("root", "brother", { relationType: "брат" }), relation("sister", "root", { relationType: "брат або сестра" }),
    relation("father", "grandparent"), relation("nephew", "brother"),
  ];
  assert.deepEqual(familyOnly(buildPersonFamilyTimeline(root, { persons: people, relations })).map((item) => item.title), ["Смерть брата · brother", "Смерть сестри · sister"]);
});

test("duplicate/inverse parent links and alternative parent sets do not duplicate facts", () => {
  const child = person("child", { birthDate: "1870" });
  const parent = person("parent");
  const options = { persons: [parent, child], relations: [relation("child", "parent"), relation("parent", "child", { relationType: "син" }), relation("child", "parent", { id: "alternative-set" })] };
  assert.equal(familyOnly(buildPersonFamilyTimeline(parent, options)).length, 1);
});

test("source edits, source deletion, unlinking and relinking recompute without orphaned copies", () => {
  const parent = person("parent");
  const child = person("child", { birthDate: "1870" });
  const relations = [relation(child.id, parent.id)];
  const original = structuredClone([parent, child]);
  const first = familyOnly(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations }))[0];
  const edited = { ...child, birthDate: "1871", birthPlace: "Вербівка" };
  const second = familyOnly(buildPersonFamilyTimeline(parent, { persons: [parent, edited], relations }))[0];
  assert.equal(first.id, second.id);
  assert.equal(second.date, "1871");
  assert.equal(second.placeName, "Вербівка");
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [] }).length, 0);
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent], relations }).length, 0);
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, person("child")], relations }).length, 0);
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations }).length, 1);
  assert.deepEqual([parent, child], original);
});

test("refuted/self/social-only relations and unavailable people never produce relatives' facts", () => {
  const parent = person("parent");
  const child = person("child", { birthDate: "1870", deathDate: "1900" });
  for (const relationType of ["хрещений", "свідок", "опікун", "родич"] as const) {
    assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent", { relationType })] }).length, 0);
  }
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent", { status: "спростовано" }), relation("parent", "parent")] }).length, 0);
  // Even a visible sibling cannot be inferred through a hidden/missing parent.
  assert.equal(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("parent", "hidden"), relation("child", "hidden")] }).length, 0);
});

test("hypothetical kinship is marked, the stronger direct evidence wins, adopted parentage is labeled", () => {
  const parent = person("parent");
  const child = person("child", { birthDate: "1900" });
  const options = { persons: [parent, child], relations: [relation("child", "parent", { status: "гіпотеза", relationType: "усиновлювач" })] };
  const projected = familyOnly(buildPersonFamilyTimeline(parent, options))[0];
  assert.equal(projected.relative?.relationStatus, "гіпотеза");
  assert.match(projected.title!, /усиновленої дитини/u);
  options.relations.push(relation("child", "parent", { status: "доведено" }));
  assert.equal(familyOnly(buildPersonFamilyTimeline(parent, options))[0].relative?.relationStatus, "доведено");
});

test("all child marriages use the shared relationship and retain partner, date and address", () => {
  const parent = person("parent");
  const child = person("child", { marriageDate: "1800", events: [event("marriage", "marriage", "1800")] });
  const first = marriage("m1", "child", "partner1", "1890");
  const second = marriage("m2", "partner2", "child", "1900");
  const options = { persons: [parent, child, person("partner1"), person("partner2")], relations: [relation("child", "parent")], marriages: [first, second, first] };
  const timeline = familyOnly(buildPersonFamilyTimeline(parent, options));
  assert.deepEqual(timeline.map((item) => item.date), ["1890", "1900"]);
  assert.deepEqual(timeline.map((item) => item.value), ["Шлюб з partner1", "Шлюб з partner2"]);
  assert.ok(timeline.every((item) => item.address === "буд. 2"));
  const remaining = familyOnly(buildPersonFamilyTimeline(parent, { ...options, marriages: [second] }));
  assert.deepEqual(remaining.map((item) => item.date), ["1900"]);
});

test("refuted shared marriages do not propagate or resurrect legacy dates; own-card behavior is preserved", () => {
  const parent = person("parent");
  const child = person("child", { marriageDate: "1890" });
  const rejected = { ...marriage("m1", child.id, "partner", "1890"), evidenceStatus: "disproven" as const };
  const options = { persons: [parent, child, person("partner")], relations: [relation(child.id, parent.id)], marriages: [rejected] };
  assert.equal(familyOnly(buildPersonFamilyTimeline(parent, options)).length, 0);
  const own = buildPersonFamilyTimeline(child, options).filter((item) => !item.relative);
  assert.deepEqual(own, buildPersonTimeline(child, { marriages: [{
    id: "m1", partnerId: "partner", partnerName: "partner", date: "1890", place: "Київ", address: "буд. 2",
  }] }));
});

test("finding and core duplicates merge, while independent conflicting sources retain provenance", () => {
  const parent = person("parent");
  const child = person("child", { birthDate: "1870", events: [event("finding:f1", "birth", "1870", { sourceFindingId: "f1" }), event("finding:f2", "birth", "1871", { sourceFindingId: "f2" })] });
  const result = familyOnly(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent")] }));
  assert.deepEqual(result.map((item) => item.sourceFindingId), ["f1", "f2"]);
  assert.ok(result.every((item) => personTimelineEventDisplayTitle(item) === item.title && personTimelineEventDisplaySubtitle(item) === ""));
});

test("relative facts preserve meaningful source titles and do not change the person's own chronology", () => {
  const parent = person("parent", { birthDate: "1840", events: [event("census", "census", "1880")] });
  const child = person("child", { events: [event("birth-record", "birth", "1870", {
    title: "Народження за сімейною Біблією", value: "Запис на форзаці", notes: "Оригінальне формулювання",
  })] });
  const timeline = buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent")] });
  assert.deepEqual(timeline.filter((item) => !item.relative), buildPersonTimeline(parent));
  assert.equal(familyOnly(timeline)[0].value, "Народження за сімейною Біблією · Запис на форзаці");
  assert.equal(familyOnly(timeline)[0].notes, "Оригінальне формулювання");
});

test("existing explicit participation is not duplicated and witness/godparent titles stay unchanged", () => {
  const child = person("child", { events: [event("finding:f1", "birth", "1870", { sourceFindingId: "f1" })] });
  for (const role of ["Мати", "Свідок", "Хрещений батько"]) {
    const participant = event("finding:f1", "mention", "1870", { sourceFindingId: "f1", relatedPersonIds: ["child"], title: `${role} · Народження · child` });
    const parent = person("parent", { events: [participant] });
    const result = buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent")] });
    assert.equal(result.length, 1);
    assert.equal(personTimelineEventDisplayTitle(result[0]), participant.title);
    assert.equal(result[0].source, "event");
  }
});

test("relative attachments belong to source only and never contaminate the person's life map", () => {
  const scan = { id: "child-birth", storage: "google-drive", storagePath: "drive-child" } as ScanAttachment;
  const parentScan = { ...scan, id: "parent-birth", storagePath: "drive-parent" };
  const parent = person("parent", { birthScans: [parentScan] });
  const child = person("child", { birthDate: "1870", birthScans: [scan], events: [event("birth", "birth", "1870", {
    age: "0", geo: { latitude: 50, longitude: 30, displayName: "Київ", source: "map_click" },
  })] });
  const result = familyOnly(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent")] }));
  assert.deepEqual(personTimelineAttachments(parent, result[0]).map((item) => item.id), ["child-birth"]);
  assert.equal(result[0].scans?.[0].deleteOnRemove, false);
  assert.deepEqual(buildPersonLifeMapStops(result), []);
  assert.equal(scan.deleteOnRemove, undefined, "source file unchanged");
});

test("known posthumous events are omitted, partial/uncertain dates are not falsely excluded", () => {
  const parent = person("parent", { deathDate: "1900" });
  const child = person("child", { birthDate: "1870", marriageDate: "1900-12-31", deathDate: "1901" });
  const options = { persons: [parent, child], relations: [relation("child", "parent")] };
  assert.deepEqual(familyOnly(buildPersonFamilyTimeline(parent, options)).map((item) => item.type), ["birth", "marriage"]);
  const uncertain = { ...child, deathDate: "ABT 1901" };
  assert.equal(familyOnly(buildPersonFamilyTimeline(parent, { ...options, persons: [parent, uncertain] })).length, 3);
  const exactParent = { ...parent, deathDate: "03.05.1900" };
  assert.deepEqual(familyOnly(buildPersonFamilyTimeline(exactParent, options)).map((item) => item.type), ["birth"]);
  const rangeParent = { ...parent, deathDate: "", deathYearFrom: "1899", deathYearTo: "1901" };
  assert.equal(familyOnly(buildPersonFamilyTimeline(rangeParent, options)).length, 3);
});

test("unknown dates with meaningful places stay at the end and blank editor events stay absent", () => {
  const parent = person("parent");
  const child = person("child", { birthYearFrom: "1869", birthYearTo: "1871", deathPlace: "Вербівка", events: [event("marriage", "marriage", "")] });
  const result = familyOnly(buildPersonFamilyTimeline(parent, { persons: [parent, child], relations: [relation("child", "parent")] }));
  assert.deepEqual(result.map((item) => item.datePrecision), ["range", "unknown"]);
});

test("profile actions open/edit the relative and finding by id; family projection stays out of persistence", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const view = read("../src/features/persons-v2/PersonTimelineV2.tsx");
  assert.match(view, /onEditRelative\(event\.relative!\.personId\)/u);
  assert.match(view, /onSelectEvent && !event\.relative/u);
  assert.match(view, /Вік родича/u);
  assert.match(view, /Спорідненість:/u);
  const profile = read("../src/features/persons-v2/PersonProfileV2.tsx");
  assert.match(profile, /buildPersonFamilyTimeline\(person, \{ persons, relations, marriages \}\)/u);
  assert.match(profile, /onEditRelative=\{onEdit \?/u);
  assert.match(profile, /if \(relative\) onEdit\(relative\)/u);
  const module = read("../src/features/persons-v2/PersonsModuleV2.tsx");
  assert.match(module, /onOpenFindingById=\{\(findingId\) => onOpenRelated\("findings", findingId\)\}/u);
  assert.doesNotMatch(read("../src/features/persons-v2/relativeTimeline.ts"), /\.rpc\(|\.from\(|localStorage|fetch\(/u);
});
