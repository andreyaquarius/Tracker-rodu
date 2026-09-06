import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Person } from "../src/types/index.ts";
import {
  buildFindingPersonSearchIndex,
  findPeopleForFinding,
  mergeFindingPersonMatches,
  normalizeFindingPersonSearch,
  suggestPeopleForFinding,
} from "../src/utils/findingPersonSearch.ts";

function person(id: string, patch: Partial<Person> = {}): Person {
  return {
    id, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z",
    researchId: "research-a", surname: "", maidenSurname: "", givenName: "", patronymic: "",
    fullName: "", nameVariants: "", surnameVariants: "", gender: "невідомо",
    birthDate: "", birthYearFrom: "", birthYearTo: "", birthPlace: "", marriageDate: "",
    marriagePlace: "", deathDate: "", deathYearFrom: "", deathYearTo: "", deathPlace: "",
    residencePlaces: "", socialStatus: "", religion: "", occupation: "", status: "потребує дослідження",
    isLiving: false, privacyStatus: "project", notes: "", birthScans: [], marriageScans: [],
    deathScans: [], mentionScans: [], events: [], customFields: {}, ...patch,
  };
}

const people = [
  person("different-patronymic", { surname: "Корзун", givenName: "Захарій", patronymic: "Іванович", birthDate: "1850" }),
  person("exact", { fullName: "Захарій Фомов Корзун", surname: "Корзун", givenName: "Захарій", patronymic: "Фомов", birthDate: "1825", birthPlace: "Вербівка", deathDate: "1891" }),
  person("reordered", { surname: "Корзун", givenName: "Захарій", patronymic: "Фомов" }),
  person("different-first-name", { surname: "Корзун", givenName: "Іван", patronymic: "Петрович" }),
  person("variant", { surname: "Каленський", givenName: "Іван", nameVariants: "Іоаннъ Каленскій; Jan Kalenski" }),
  person("maiden", { surname: "Мельник", maidenSurname: "Коваль", givenName: "Марія", patronymic: "Іванівна" }),
  person("apostrophe", { fullName: "Лук’ян Мельник", birthYearFrom: "1870", birthYearTo: "1872", residencePlaces: "Київ" }),
];

test("automatic suggestions rank full names before partial matches and do not mutate source names", () => {
  const sourceNames = ["  Захарій\nФомов Корзун  "];
  const originalPeople = JSON.stringify(people);
  const matches = suggestPeopleForFinding(buildFindingPersonSearchIndex(people), sourceNames);
  assert.deepEqual(matches.map((match) => match.entry.person.id), ["exact", "reordered", "different-patronymic"]);
  assert.equal(matches[0]?.reason, "Збіг повного імені");
  assert.match(matches[2]?.reason ?? "", /частини імені/);
  assert.equal(matches.some((match) => match.entry.person.id === "different-first-name"), false);
  assert.deepEqual(sourceNames, ["  Захарій\nФомов Корзун  "]);
  assert.equal(JSON.stringify(people), originalPeople);
});

test("manual search supports unordered tokens, partial names, years and locations", () => {
  const index = buildFindingPersonSearchIndex(people);
  assert.deepEqual(findPeopleForFinding(index, "вербів 1825 корз").map((match) => match.entry.person.id), ["exact"]);
  assert.deepEqual(findPeopleForFinding(index, "корз ФОМОВ").map((match) => match.entry.person.id).sort(), ["exact", "reordered"]);
  assert.equal(findPeopleForFinding(index, "Кален")[0]?.entry.person.id, "variant");
  assert.equal(findPeopleForFinding(index, "Київ 1872")[0]?.entry.person.id, "apostrophe");
  assert.match(index.find((entry) => entry.person.id === "exact")?.details ?? "", /нар\. 1825.*пом\. 1891.*Вербівка/);
});

test("legacy name variants and maiden names are searchable and suggested", () => {
  const index = buildFindingPersonSearchIndex(people);
  assert.equal(findPeopleForFinding(index, "Jan Kalenski")[0]?.entry.person.id, "variant");
  const variant = suggestPeopleForFinding(index, ["Іоаннъ Каленскій"])[0];
  assert.equal(variant?.entry.person.id, "variant");
  assert.equal(variant?.reason, "Збіг варіанта написання");
  assert.equal(variant?.matchedName, "Іоаннъ Каленскій");
  assert.equal(suggestPeopleForFinding(index, ["Коваль Марія Іванівна"])[0]?.entry.person.id, "maiden");
});

test("search folds case, apostrophes, repeated whitespace and stress marks only in search keys", () => {
  assert.equal(normalizeFindingPersonSearch("  ЛУК’ЯН\n МЕ́ЛЬНИК "), "лукян мельник");
  assert.equal(normalizeFindingPersonSearch("Йосип Ївга Ірина"), "йосип ївга ірина");
  assert.equal(findPeopleForFinding(buildFindingPersonSearchIndex(people), "лукян мельник")[0]?.entry.person.id, "apostrophe");
});

test("one long-name typo or transposition is a hint, never a fuzzy match for a year", () => {
  const index = buildFindingPersonSearchIndex(people);
  assert.deepEqual(findPeopleForFinding(index, "Захарій Фомов Корзну").map((match) => match.entry.person.id).sort(), ["exact", "reordered"]);
  assert.equal(findPeopleForFinding(index, "Захарій Фомов Карзун")[0]?.reason, "Схоже написання імені");
  assert.deepEqual(findPeopleForFinding(index, "1826"), []);
  assert.deepEqual(findPeopleForFinding(index, "Іваа"), []);
});

test("empty source text produces no random suggestions, but all people remain browsable", () => {
  const index = buildFindingPersonSearchIndex(people);
  assert.deepEqual(suggestPeopleForFinding(index, [" ", ""]), []);
  assert.equal(findPeopleForFinding(index, "").length, people.length);
  assert.deepEqual(findPeopleForFinding(index, "Зовсім Незнайоме Прізвище"), []);
});

test("both original and user-normalized names contribute without creating duplicate candidates", () => {
  const index = buildFindingPersonSearchIndex(people);
  const results = suggestPeopleForFinding(index, ["Іоаннъ Каленскій", "Іван Каленський", "Іван Каленський"]);
  assert.equal(results.filter((match) => match.entry.person.id === "variant").length, 1);
});

test("historical hints cannot introduce unavailable people or override a stronger local result", () => {
  const index = buildFindingPersonSearchIndex(people);
  const local = suggestPeopleForFinding(index, ["Захарій Фомов Корзун"]);
  const hint = { personId: "variant", personNameId: "historical-1", displayName: "Untrusted remote title",
    matchedName: "Іоаннъ Каленскій", matchType: "exact" as const, score: 1 };
  const results = mergeFindingPersonMatches(local, [
    hint,
    { ...hint, personId: "outside-allowed-project" },
    { ...hint, personId: "exact", matchType: "fuzzy" },
    { ...hint, personNameId: "historical-2", matchType: "fuzzy" },
  ], index);
  assert.equal(results.some((match) => match.entry.person.id === "outside-allowed-project"), false);
  assert.equal(results.filter((match) => match.entry.person.id === "variant").length, 1);
  assert.equal(results.find((match) => match.entry.person.id === "variant")?.entry.label, "Каленський Іван");
  assert.equal(results.find((match) => match.entry.person.id === "exact")?.reason, "Збіг повного імені");
  const restricted = index.filter((entry) => entry.person.id === "exact");
  assert.deepEqual(mergeFindingPersonMatches(local, [hint], restricted).map((match) => match.entry.person.id), ["exact"]);
});

test("large catalog searches do not truncate eligible candidates before matching", () => {
  const large = Array.from({ length: 10_000 }, (_, index) => person(`person-${index}`, { fullName: `Тестова Особа ${index}` }));
  large.push(person("last-person", { fullName: "Захарій Фомов Корзун" }));
  const index = buildFindingPersonSearchIndex(large);
  assert.equal(findPeopleForFinding(index, "Захарій Корзун")[0]?.entry.person.id, "last-person");
  assert.equal(findPeopleForFinding(index, "Тестова").length, 10_000);
});

test("picker keeps explicit selection and confirmation, scopes hints, and handles stale lookups", () => {
  const picker = readFileSync(new URL("../src/components/FindingPersonPicker.tsx", import.meta.url), "utf8");
  const crud = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
  assert.match(picker, /new AbortController\(\)/);
  assert.match(picker, /controller\.signal\.aborted/);
  assert.match(picker, /remote\.key === requestKey/);
  assert.match(picker, /controller\.abort\(\)/);
  assert.match(picker, /320/);
  assert.match(picker, /Пошук серед завантажених осіб працює/);
  assert.match(picker, /aria-pressed=\{selectedId === entry\.person\.id\}/);
  assert.match(picker, /onClick=\{\(\) => onSelect\(entry\.person\.id\)\}/);
  assert.match(picker, /if \(event\.key === "Enter"\) event\.preventDefault\(\)/);
  const lookupEffect = picker.slice(picker.indexOf("useEffect(() =>"), picker.indexOf("  return ("));
  assert.doesNotMatch(lookupEffect, /onSelect\(|\.insert\(|\.update\(|\.delete\(/);
  assert.match(crud, /persons=\{findingNamePersons\}/);
  assert.match(crud, /!findingNamePersonAvailable/);
  assert.match(crud, /!findingNameCapture\.confirmed/);
  assert.match(crud, /existingPersonId: ""/);
  assert.match(crud, /originalName=\{findingNameCapture\.originalText\}/);
  assert.match(crud, /normalizedName=\{findingNameCapture\.normalizedFullName\}/);
});
