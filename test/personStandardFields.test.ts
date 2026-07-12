import test from "node:test";
import assert from "node:assert/strict";
import type { PersonEvent } from "../src/types/index.ts";
import { normalizePersonEvents } from "../src/utils/geo.ts";
import {
  personEducation,
  personNationality,
  withPersonStandardFields,
} from "../src/utils/personStandardFields.ts";

test("stores nationality and multiple education records as standard person fields", () => {
  const customFields = withPersonStandardFields({}, {
    nationality: "українець",
    education: "Київська гімназія\nУніверситет св. Володимира",
  });

  assert.equal(personNationality({ customFields } as never), "українець");
  assert.deepEqual(personEducation({ customFields } as never), [
    "Київська гімназія",
    "Університет св. Володимира",
  ]);
});

test("normalizes editable GEDCOM event details without flattening them into notes", () => {
  const saved: PersonEvent[] = [{
    id: "military-1",
    personId: "person-1",
    type: "military",
    title: "Military Service",
    date: "FROM ABT 1881 TO 13 DEC 1886",
    placeName: "127 піхотний Путівльський полк",
    value: "інформація з запису про шлюб",
    age: "18-25",
    cause: null,
    address: "м. Житомир, казарми полку",
    geo: null,
    notes: "Додаткова примітка",
  }];

  const normalized = normalizePersonEvents(saved, {
    id: "person-1",
    birthDate: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathPlace: "",
    residencePlaces: "",
  });
  const event = normalized.find((item) => item.id === "military-1");

  assert.equal(event?.type, "military");
  assert.equal(event?.value, "інформація з запису про шлюб");
  assert.equal(event?.age, "18-25");
  assert.equal(event?.address, "м. Житомир, казарми полку");
  assert.equal(event?.notes, "Додаткова примітка");
});
