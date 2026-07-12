import test from "node:test";
import assert from "node:assert/strict";
import type { Person } from "../src/types/index.ts";
import {
  buildGedcomPersonSearchIndex,
  gedcomPersonSearchLabel,
  normalizeGedcomPersonSearchText,
  searchGedcomPeople,
} from "../src/utils/gedcomPersonSearch.ts";

function person(input: Partial<Person> & Pick<Person, "id">): Person {
  return {
    fullName: "",
    surname: "",
    maidenSurname: "",
    givenName: "",
    patronymic: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    ...input,
  } as Person;
}

test("GEDCOM person search is Unicode case-insensitive and searches full names", () => {
  const index = buildGedcomPersonSearchIndex([
    person({ id: "1", fullName: "Сергієнко Василь Михайлович" }),
    person({ id: "2", fullName: "Каленська Олена Андріївна" }),
  ]);

  assert.deepEqual(searchGedcomPeople(index, "СЕРГІЄНКО василь").map((entry) => entry.person.id), ["1"]);
  assert.equal(normalizeGedcomPersonSearchText("  ОЛЕНА   Андріївна "), "олена андріївна");
});

test("GEDCOM person search matches exact dates, years, and year ranges", () => {
  const index = buildGedcomPersonSearchIndex([
    person({ id: "1", fullName: "Перша Особа", birthDate: "1969-04-12", deathDate: "2016-09-03" }),
    person({ id: "2", fullName: "Друга Особа", birthYearFrom: "1870", birthYearTo: "1872" }),
  ]);

  assert.deepEqual(searchGedcomPeople(index, "1969-04-12").map((entry) => entry.person.id), ["1"]);
  assert.deepEqual(searchGedcomPeople(index, "2016").map((entry) => entry.person.id), ["1"]);
  assert.deepEqual(searchGedcomPeople(index, "1872").map((entry) => entry.person.id), ["2"]);
  assert.equal(gedcomPersonSearchLabel(index[0].person), "Перша Особа (нар. 1969-04-12, пом. 2016-09-03)");
});

test("GEDCOM person search returns nothing for blank input and enforces the result limit", () => {
  const people = Array.from({ length: 17_556 }, (_, index) => person({
    id: String(index),
    fullName: `Тестова Особа ${index}`,
    birthDate: "1900",
  }));
  const searchIndex = buildGedcomPersonSearchIndex(people);

  assert.deepEqual(searchGedcomPeople(searchIndex, "   "), []);
  assert.equal(searchGedcomPeople(searchIndex, "тестова", 20).length, 20);
  assert.equal(searchGedcomPeople(searchIndex, "немає збігів").length, 0);
});
