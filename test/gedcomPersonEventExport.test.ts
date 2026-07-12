import test from "node:test";
import assert from "node:assert/strict";
import type { Person } from "../src/types/index.ts";
import { buildFamilyTreeProjection } from "../src/utils/familyTreeProjection.ts";
import { exportFamilyTreeProjectionToGedcom } from "../src/utils/gedcom.ts";

test("exports structured person-event details back to GEDCOM", () => {
  const person = basePerson();
  person.events = [{
    id: "event-military",
    personId: person.id,
    type: "military",
    title: "Military Service",
    date: "FROM ABT 1881 TO 13 DEC 1886",
    placeName: "127 піхотний Путівльський полк",
    value: "інформація з запису про шлюб",
    age: "20-25",
    cause: "мобілізація",
    address: "м. Житомир, казарми",
    geo: null,
    notes: "Звільнений у запас",
  }];
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    persons: [person],
    legacyRelations: [],
  });

  const exported = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Трекер Роду",
    createdAt: "2026-07-12",
  }).text;

  assert.match(exported, /1 EVEN інформація з запису про шлюб/);
  assert.match(exported, /2 TYPE Military Service/);
  assert.match(exported, /2 AGE 20-25/);
  assert.match(exported, /2 CAUS мобілізація/);
  assert.match(exported, /2 ADDR м\. Житомир, казарми/);
});

function basePerson(): Person {
  const timestamp = "2026-07-12T00:00:00.000Z";
  return {
    id: "person-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    researchId: "",
    surname: "Каленський",
    maidenSurname: "",
    givenName: "Василь",
    patronymic: "",
    fullName: "Каленський Василь",
    gender: "чоловік",
    nameVariants: "",
    surnameVariants: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "",
    socialStatus: "",
    religion: "",
    occupation: "",
    status: "доведена",
    isLiving: false,
    privacyStatus: "private",
    notes: "",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    photos: [],
    primaryPhotoId: "",
    events: [],
    customFields: {},
  };
}
