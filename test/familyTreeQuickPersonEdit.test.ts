import test from "node:test";
import assert from "node:assert/strict";
import type { Person } from "../src/types/index.ts";
import {
  buildQuickPersonEdit,
  quickPersonEditDraft,
} from "../src/utils/quickPersonEdit.ts";

const now = "2026-08-13T10:00:00.000Z";

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    researchId: "research-1",
    status: "доведена",
    gender: "жінка",
    surname: "Стара",
    maidenSurname: "Дівоча",
    givenName: "Олена",
    patronymic: "Іванівна",
    fullName: "Стара Олена Іванівна",
    nameVariants: "Гелена",
    surnameVariants: "Старова",
    birthDate: "1901",
    birthYearFrom: "1900",
    birthYearTo: "1902",
    birthPlace: "Київ",
    marriageDate: "1921-05-10",
    marriagePlace: "Біла Церква",
    deathDate: "1980",
    deathYearFrom: "1979",
    deathYearTo: "1981",
    deathPlace: "Київ",
    residencePlaces: "Київ; Львів",
    socialStatus: "міщанка",
    religion: "православна",
    occupation: "учителька",
    isLiving: false,
    privacyStatus: "private",
    notes: "Важлива нотатка",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    photos: [{
      id: "photo-1",
      name: "portrait.jpg",
      mimeType: "image/jpeg",
      size: 120,
      createdAt: now,
      storage: "google-drive",
      storagePath: "drive-file-1",
    }],
    primaryPhotoId: "photo-1",
    events: [
      {
        id: "birth",
        personId: "person-1",
        type: "birth",
        title: "Народження",
        date: "1901",
        placeName: "Київ",
        address: "будинок 7",
        geo: null,
        notes: "з метричної книги",
      },
      {
        id: "military-1",
        personId: "person-1",
        type: "military",
        title: "Військова служба",
        date: "1919",
        placeName: "Одеса",
        geo: null,
        notes: "додатковий факт",
      },
      {
        id: "death",
        personId: "person-1",
        type: "death",
        title: "Смерть",
        date: "1980",
        placeName: "Київ",
        cause: "хвороба",
        geo: null,
        notes: "свідоцтво",
      },
    ],
    customFields: { education: "Університет" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("quick person edit updates core facts and preserves extended profile data", () => {
  const original = person();
  const draft = {
    ...quickPersonEditDraft(original),
    surname: "Нова",
    givenName: "Ганна",
    patronymic: "Петрівна",
    birthDate: "02.03.1902",
    birthPlace: "Черкаси",
    marriageDate: "1925",
    marriagePlace: "Львів",
    deathDate: "1982",
    deathPlace: "Львів",
  };

  const result = buildQuickPersonEdit(
    original,
    draft,
    "2026-08-13T11:00:00.000Z",
  );

  assert.ok(result.person);
  assert.equal(result.person.fullName, "Нова Ганна Петрівна");
  assert.equal(result.person.birthDate, "1902-03-02");
  assert.equal(result.person.birthPlace, "Черкаси");
  assert.equal(result.person.marriageDate, "1925");
  assert.equal(result.person.deathDate, "1982");
  assert.equal(result.person.updatedAt, "2026-08-13T11:00:00.000Z");
  assert.deepEqual(result.person.photos, original.photos);
  assert.deepEqual(result.person.customFields, original.customFields);
  assert.equal(result.person.notes, original.notes);
  assert.equal(result.person.events.some((event) => event.id === "military-1"), true);
  assert.equal(
    result.person.events.find((event) => event.id === "birth")?.address,
    "будинок 7",
  );
});

test("marking a person living clears death fields and the death event only", () => {
  const original = person();
  const result = buildQuickPersonEdit(original, {
    ...quickPersonEditDraft(original),
    isLiving: true,
  });

  assert.ok(result.person);
  assert.equal(result.person.isLiving, true);
  assert.equal(result.person.deathDate, "");
  assert.equal(result.person.deathYearFrom, "");
  assert.equal(result.person.deathYearTo, "");
  assert.equal(result.person.deathPlace, "");
  const deathEvent = result.person.events.find((event) => event.type === "death");
  assert.equal(deathEvent?.date ?? "", "");
  assert.equal(deathEvent?.placeName ?? "", "");
  assert.equal(deathEvent?.cause, undefined);
  assert.equal(result.person.events.some((event) => event.id === "military-1"), true);
});

test("quick person edit reports invalid dates without producing a person", () => {
  const original = person();
  const result = buildQuickPersonEdit(original, {
    ...quickPersonEditDraft(original),
    birthDate: "31.02.1901",
  });

  assert.equal(result.person, null);
  assert.ok(result.errors.birthDate);
});
