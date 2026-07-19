import assert from "node:assert/strict";
import test from "node:test";
import type { Person } from "../src/types/index.ts";
import {
  archiveRequestDraftForPerson,
  findingDraftForPerson,
  hypothesisDraftForPerson,
  relatedRecordDraftForPerson,
  taskDraftForPerson,
} from "../src/utils/personRelatedRecordDrafts.ts";

const person: Person = {
  id: "person-1",
  researchId: "research-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  surname: "Каленський",
  maidenSurname: "",
  givenName: "Андрій",
  patronymic: "Іванович",
  fullName: "",
  gender: "чоловік",
  nameVariants: "",
  surnameVariants: "",
  birthDate: "",
  birthYearFrom: "",
  birthYearTo: "",
  birthPlace: "с. Каленці",
  marriageDate: "",
  marriagePlace: "",
  deathDate: "",
  deathYearFrom: "",
  deathYearTo: "",
  deathPlace: "",
  residencePlaces: "м. Біла Церква",
  socialStatus: "",
  religion: "",
  occupation: "",
  status: "доведена",
  isLiving: false,
  privacyStatus: "project",
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

test("related-record drafts preserve the person and research context", () => {
  assert.deepEqual(taskDraftForPerson(person), {
    researchId: "research-1",
    personIds: ["person-1"],
    personName: "Каленський Андрій Іванович",
    place: "с. Каленці",
  });
  assert.deepEqual(hypothesisDraftForPerson(person), {
    researchId: "research-1",
    personIds: ["person-1"],
    relatedPeople: "Каленський Андрій Іванович",
  });
  assert.deepEqual(archiveRequestDraftForPerson(person), {
    researchId: "research-1",
    personIds: ["person-1"],
    subject: "Запит щодо Каленський Андрій Іванович",
  });
});

test("finding draft includes an explicit participant and the generic dispatcher matches it", () => {
  const direct = findingDraftForPerson(person);
  assert.equal(direct.researchId, "research-1");
  assert.deepEqual(direct.personIds, ["person-1"]);
  assert.equal(direct.personsText, "Каленський Андрій Іванович");
  assert.equal(direct.place, "с. Каленці");
  assert.match(String((direct.participants as Array<{ id: string }>)[0].id), /\S/u);
  assert.deepEqual(
    (direct.participants as Array<Record<string, unknown>>)[0],
    {
      id: (direct.participants as Array<{ id: string }>)[0].id,
      role: "Згадана особа",
      name: "Каленський Андрій Іванович",
      notes: "Додано з картки особи",
    },
  );

  const dispatched = relatedRecordDraftForPerson("archiveRequests", person);
  assert.deepEqual(dispatched, archiveRequestDraftForPerson(person));
});
