import assert from "node:assert/strict";
import test from "node:test";
import type { Person, PersonEvent, PersonRelation, ScanAttachment } from "../src/types/index.ts";
import {
  buildPersonFamilyOrder,
  buildPersonTimeline,
  calculatePersonProfileCompleteness,
  filterAndSortPersons,
  personAvatar,
  personDisplayName,
  personInitials,
  personLifeYears,
  personMainPlaces,
  personRelationLabel,
} from "../src/features/persons-v2/model.ts";

function person(overrides: Partial<Person> = {}): Person {
  return {
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
    ...overrides,
  };
}

function photo(id: string, overrides: Partial<ScanAttachment> = {}): ScanAttachment {
  return {
    id,
    name: `${id}.jpg`,
    mimeType: "image/jpeg",
    size: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    storage: "external-url",
    storagePath: `https://example.test/${id}.jpg`,
    availability: "available",
    ...overrides,
  };
}

function event(overrides: Partial<PersonEvent> & Pick<PersonEvent, "id" | "type">): PersonEvent {
  return {
    personId: "person-1",
    title: "Подія",
    date: null,
    placeName: null,
    geo: null,
    notes: null,
    ...overrides,
  };
}

function relation(overrides: Partial<PersonRelation> = {}): PersonRelation {
  return {
    id: "relation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    personId: "child",
    relatedPersonId: "parent",
    relationType: "батько",
    status: "доведено",
    evidenceText: "",
    notes: "",
    ...overrides,
  };
}

test("person summary helpers preserve ranges, deduplicate places, and select an available avatar", () => {
  const unavailable = photo("missing", { availability: "missing-local" });
  const available = photo("available");
  const value = person({
    fullName: "  Каленський   Андрій Іванович  ",
    birthYearFrom: "1870",
    birthYearTo: "1872",
    deathDate: "1943-03-05",
    birthPlace: "с. Каленці",
    marriagePlace: "м. Біла Церква",
    deathPlace: "м. Біла Церква",
    residencePlaces: "м. Біла Церква; Київ\nкиїв",
    events: [event({ id: "military", type: "military", placeName: "Одеса" })],
    photos: [unavailable, available],
    primaryPhotoId: unavailable.id,
  });

  assert.equal(personDisplayName(value), "Каленський Андрій Іванович");
  assert.equal(personLifeYears(value), "1870–1872–1943");
  assert.equal(personInitials(value), "КА");
  assert.deepEqual(personMainPlaces(value), {
    birth: "с. Каленці",
    marriage: "м. Біла Церква",
    death: "м. Біла Церква",
    residences: ["м. Біла Церква", "Київ"],
    eventPlaces: ["Одеса"],
    all: ["с. Каленці", "м. Біла Церква", "Київ", "Одеса"],
    primary: "с. Каленці",
  });
  assert.deepEqual(personAvatar(value), {
    kind: "photo",
    initials: "КА",
    photo: available,
  });
});

test("display and avatar helpers have deterministic fallbacks", () => {
  const unnamed = person({ surname: "", givenName: "", patronymic: "", fullName: "" });
  assert.equal(personDisplayName(unnamed), "Особа без імені");
  assert.equal(personInitials(unnamed), "?");
  assert.deepEqual(personAvatar(unnamed), { kind: "initials", initials: "?" });
  assert.equal(personLifeYears(unnamed), "");
});

test("relation labels are shown from the opened person's direction", () => {
  const parent = person({ id: "parent", gender: "чоловік" });
  const daughter = person({ id: "child", gender: "жінка" });
  const parentEdge = relation();

  assert.equal(personRelationLabel(parentEdge, daughter.id, parent), "Батько");
  assert.equal(personRelationLabel(parentEdge, parent.id, daughter), "донька");

  const spouseEdge = relation({
    personId: "wife",
    relatedPersonId: "husband",
    relationType: "подружжя",
  });
  assert.equal(
    personRelationLabel(spouseEdge, "wife", person({ id: "husband", gender: "чоловік" })),
    "чоловік",
  );
  assert.equal(
    personRelationLabel(spouseEdge, "husband", person({ id: "wife", gender: "жінка" })),
    "дружина",
  );
});

test("profile completeness exposes section-level checks and never penalizes living people for death facts", () => {
  const living = calculatePersonProfileCompleteness(person({
    isLiving: true,
    birthDate: "1980",
    birthPlace: "Київ",
    occupation: "Архівіст",
    residencePlaces: "Київ",
    notes: "Коротка біографія",
    birthScans: [photo("birth-source")],
    photos: [photo("portrait")],
    primaryPhotoId: "portrait",
    events: [event({ id: "education", type: "education", date: "1997" })],
  }));

  assert.equal(living.percent, 100);
  assert.deepEqual(living.missing, []);
  const vital = living.sections.find((section) => section.id === "vital");
  assert.equal(vital?.total, 2);
  assert.equal(vital?.checks.some((item) => item.id.startsWith("death-")), false);

  const sparseDeceased = calculatePersonProfileCompleteness(person({
    surname: "",
    givenName: "",
    patronymic: "",
    gender: "невідомо",
  }));
  assert.ok(sparseDeceased.percent < 25);
  assert.ok(sparseDeceased.missing.includes("Дата або період смерті"));
  assert.equal(sparseDeceased.completed + sparseDeceased.missing.length, sparseDeceased.total);
});

test("timeline folds synthetic core duplicates and orders exact, partial, approximate, and unknown dates stably", () => {
  const value = person({
    birthDate: "1872-11-18",
    birthPlace: "Каленці",
    marriageDate: "1898",
    marriagePlace: "Біла Церква",
    deathYearFrom: "1941",
    deathYearTo: "1943",
    deathPlace: "Біла Церква",
    residencePlaces: "Київ; Одеса",
    events: [
      event({
        id: "birth",
        type: "birth",
        date: "1872-11-18",
        placeName: "Каленці",
        notes: "Запис у метричній книзі",
      }),
      event({ id: "baptism", type: "baptism", date: "1872-11", placeName: "Каленці" }),
      event({ id: "census", type: "census", date: "близько 1900", placeName: "Київ" }),
      event({ id: "unknown-a", type: "mention", title: "Перша без дати" }),
      event({ id: "unknown-b", type: "other", title: "Друга без дати" }),
      event({ id: "residence", type: "residence", placeName: "Київ; Одеса" }),
    ],
  });

  const timeline = buildPersonTimeline(value);
  assert.deepEqual(
    timeline.map((item) => item.id),
    [
      "baptism",
      "person-1:core:birth",
      "person-1:core:marriage",
      "census",
      "person-1:core:death",
      "person-1:core:residence",
      "unknown-a",
      "unknown-b",
    ],
  );
  const birth = timeline.find((item) => item.id === "person-1:core:birth");
  assert.deepEqual(birth?.deduplicatedEventIds, ["birth"]);
  assert.equal(birth?.notes, "Запис у метричній книзі");
  assert.equal(birth?.datePrecision, "exact");
  assert.equal(timeline[0].datePrecision, "month");
  assert.equal(timeline[3].datePrecision, "approximate");
  assert.equal(timeline[4].datePrecision, "range");
  assert.deepEqual(timeline[5].deduplicatedEventIds, ["residence"]);
  assert.equal(timeline[6].sortTimestamp, null);
  assert.equal(timeline[7].sortTimestamp, null);
});

test("timeline keeps genuinely conflicting core facts instead of hiding them as duplicates", () => {
  const timeline = buildPersonTimeline(person({
    birthDate: "1872",
    birthPlace: "Каленці",
    events: [event({
      id: "alternative-birth",
      type: "birth",
      date: "1873",
      placeName: "Війтівка",
    })],
  }));

  assert.deepEqual(timeline.map((item) => item.id), ["person-1:core:birth", "alternative-birth"]);
});

test("catalog model combines query, status, gender, life-state, and saved-segment filters", () => {
  const people = [
    person({ id: "confirmed", fullName: "Андрій Каленський", status: "доведена", birthPlace: "Каленці" }),
    person({ id: "partial", fullName: "Богдан Каленський", status: "частково доведена", gender: "чоловік" }),
    person({ id: "personal", fullName: "Ганна Особиста", status: "відома особисто" }),
    person({ id: "oral", fullName: "Дмитро Переказ", status: "відома з переказів" }),
    person({ id: "documented", fullName: "Євдокія Документальна", status: "відома документально" }),
    person({ id: "hypothesis", fullName: "Олена Петрина", status: "гіпотетична", gender: "жінка", isLiving: true }),
    person({ id: "doubtful", fullName: "Ярина Кухар", status: "сумнівна", gender: "жінка" }),
  ];

  assert.deepEqual(
    filterAndSortPersons(people, { segment: "confirmed" }).map((item) => item.id),
    ["confirmed", "partial", "personal", "oral", "documented"],
  );
  assert.deepEqual(
    filterAndSortPersons(people, { segment: "hypotheses" }).map((item) => item.id),
    ["hypothesis"],
  );
  assert.deepEqual(
    filterAndSortPersons(people, {
      segment: "direct",
      directPersonIds: new Set(["confirmed", "hypothesis"]),
      gender: "жінка",
      lifeStatus: "living",
    }).map((item) => item.id),
    ["hypothesis"],
  );
  assert.deepEqual(
    filterAndSortPersons(people, { query: "каленці андрій", status: "доведена" })
      .map((item) => item.id),
    ["confirmed"],
  );
  assert.deepEqual(
    filterAndSortPersons(people, {
      status: ["відома особисто", "відома з переказів", "відома документально"],
    }).map((item) => item.id),
    ["personal", "oral", "documented"],
  );
});

test("catalog search indexes person notes and complete event details", () => {
  const searchable = person({
    id: "searchable",
    notes: "Працював пасічником біля монастиря",
    events: [event({
      id: "service",
      type: "military",
      title: "Військова служба",
      date: "1914",
      placeName: "Одеса",
      value: "Козацький полк",
      age: "42 роки",
      cause: "поранення",
      address: "вулиця Кутузова",
      notes: "запис у послужному списку",
      geo: {
        displayName: "Одеський повіт",
        latitude: 46.48,
        longitude: 30.73,
        source: "map_click",
        precision: "settlement",
        provider: "local-gazetteer",
        externalId: "odesa-1",
      },
    })],
  });
  const other = person({ id: "other", fullName: "Інша особа" });

  for (const query of [
    "пасічником",
    "військова служба",
    "козацький полк",
    "42 роки",
    "поранення",
    "кутузова",
    "послужному списку",
    "одеський повіт",
    "local-gazetteer",
  ]) {
    assert.deepEqual(
      filterAndSortPersons([other, searchable], { query }).map((item) => item.id),
      ["searchable"],
      query,
    );
  }
});

test("catalog sorting is stable and keeps unknown life dates at the end in both directions", () => {
  const people = [
    person({ id: "unknown-a", fullName: "Невідома А", birthDate: "" }),
    person({ id: "later", fullName: "Пізня", birthDate: "1900" }),
    person({ id: "earlier", fullName: "Рання", birthDate: "1870-04-01" }),
    person({ id: "unknown-b", fullName: "Невідома Б", birthDate: "" }),
  ];

  assert.deepEqual(
    filterAndSortPersons(people, { sortBy: "birth" }).map((item) => item.id),
    ["earlier", "later", "unknown-a", "unknown-b"],
  );
  assert.deepEqual(
    filterAndSortPersons(people, { sortBy: "birth", sortDirection: "desc" })
      .map((item) => item.id),
    ["later", "earlier", "unknown-a", "unknown-b"],
  );
});

test("family order ranks the central person before parent generations deterministically", () => {
  const people = [
    person({ id: "maternal-grandmother", fullName: "Ярина Материнська", gender: "жінка" }),
    person({ id: "root", fullName: "Центральна особа" }),
    person({ id: "paternal-grandfather", fullName: "Андрій Батьківський", gender: "чоловік" }),
    person({ id: "mother", fullName: "Олена Материнська", gender: "жінка" }),
    person({ id: "maternal-grandfather", fullName: "Богдан Материнський", gender: "чоловік" }),
    person({ id: "father", fullName: "Іван Батьківський", gender: "чоловік" }),
    person({ id: "paternal-grandmother", fullName: "Ганна Батьківська", gender: "жінка" }),
  ];
  const links = [
    { parentId: "maternal-grandmother", childId: "mother", parentRoleLabel: "mother" },
    { parentId: "mother", childId: "root", parentRoleLabel: "mother" },
    { parentId: "paternal-grandmother", childId: "father", parentRoleLabel: "mother" },
    { parentId: "maternal-grandfather", childId: "mother", parentRoleLabel: "father" },
    { parentId: "father", childId: "root", parentRoleLabel: "father" },
    { parentId: "paternal-grandfather", childId: "father", parentRoleLabel: "father" },
  ];

  const order = buildPersonFamilyOrder(people, "root", links);
  const rankedIds = [...order]
    .sort(([, firstRank], [, secondRank]) => firstRank - secondRank)
    .map(([personId]) => personId);

  assert.deepEqual(rankedIds, [
    "root",
    "father",
    "mother",
    "paternal-grandfather",
    "maternal-grandfather",
    "paternal-grandmother",
    "maternal-grandmother",
  ]);
});

test("family order deduplicates repeated ancestors and terminates on cycles", () => {
  const people = [
    person({ id: "root", fullName: "Центральна" }),
    person({ id: "father", fullName: "Батько", gender: "чоловік" }),
    person({ id: "mother", fullName: "Мати", gender: "жінка" }),
    person({ id: "shared", fullName: "Спільний предок" }),
  ];
  const order = buildPersonFamilyOrder(people, "root", [
    { parentId: "father", childId: "root", parentRoleLabel: "father" },
    { parentId: "mother", childId: "root", parentRoleLabel: "mother" },
    { parentId: "shared", childId: "father" },
    { parentId: "shared", childId: "mother" },
    { parentId: "root", childId: "shared" },
    { parentId: "root", childId: "root" },
  ]);

  assert.deepEqual([...order.keys()], ["root", "father", "mother", "shared"]);
  assert.equal(order.size, 4);
  assert.deepEqual(buildPersonFamilyOrder(people, "missing", []), new Map());
});

test("family catalog sort keeps ranked people first and uses name plus id as a deterministic fallback", () => {
  const people = [
    person({ id: "z-unranked", fullName: "Ярина" }),
    person({ id: "same-b", fullName: "Однакове ім’я" }),
    person({ id: "parent", fullName: "Батько" }),
    person({ id: "same-a", fullName: "Однакове ім’я" }),
    person({ id: "a-unranked", fullName: "Андрій" }),
    person({ id: "root", fullName: "Центральна" }),
  ];
  const familyOrder = new Map([
    ["root", 0],
    ["parent", 1],
  ]);

  const sorted = filterAndSortPersons(people, { sortBy: "family", familyOrder });
  const reversedInput = filterAndSortPersons([...people].reverse(), { sortBy: "family", familyOrder });
  const expected = ["root", "parent", "a-unranked", "same-a", "same-b", "z-unranked"];

  assert.deepEqual(sorted.map((item) => item.id), expected);
  assert.deepEqual(reversedInput.map((item) => item.id), expected);
  assert.deepEqual(
    filterAndSortPersons(people, { sortBy: "family", familyOrder: new Map() })
      .map((item) => item.id),
    ["a-unranked", "parent", "same-a", "same-b", "root", "z-unranked"],
  );
});

test("family catalog ordering remains active after catalogue filters", () => {
  const people = [
    person({ id: "unranked", fullName: "Андрій", gender: "чоловік" }),
    person({ id: "mother", fullName: "Ярина", gender: "жінка" }),
    person({ id: "root", fullName: "Центральна", gender: "чоловік" }),
  ];

  assert.deepEqual(
    filterAndSortPersons(people, {
      sortBy: "family",
      familyOrder: new Map([["root", 0], ["mother", 1]]),
      gender: "чоловік",
    }).map((item) => item.id),
    ["root", "unranked"],
  );
});
