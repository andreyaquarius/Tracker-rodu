import test from "node:test";
import assert from "node:assert/strict";
import type { Person, PersonRelation } from "../src/types/index.ts";
import { buildFamilyTreeProjection } from "../src/utils/familyTreeProjection.ts";
import {
  exportFamilyTreeProjectionToGedcom,
  formatGedcomDate,
  parseGedcom,
  summarizeGedcom,
} from "../src/utils/gedcom.ts";

const now = "2026-06-30T00:00:00.000Z";

function person(id: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    researchId: "",
    status: "доведена" as Person["status"],
    gender: "невідомо" as Person["gender"],
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: "",
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
    notes: "",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    events: [],
    customFields: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
  relationType: PersonRelation["relationType"],
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType,
    status: "доведено" as PersonRelation["status"],
    evidenceText: "",
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

test("exports projection to GEDCOM individuals and families", () => {
  const child = person("child", {
    surname: "Гурський",
    givenName: "Григорій",
    birthDate: "1896-06-06",
    birthPlace: "Трубіївка",
  });
  const father = person("father", {
    surname: "Гурський",
    givenName: "Іван",
    gender: "чоловік" as Person["gender"],
  });
  const mother = person("mother", {
    surname: "Гурська",
    givenName: "Євдокія",
    gender: "жінка" as Person["gender"],
  });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    persons: [child, father, mother],
    legacyRelations: [
      relation("father-link", "child", "father", "батько" as PersonRelation["relationType"]),
      relation("mother-link", "child", "mother", "мати" as PersonRelation["relationType"]),
      relation("spouse-link", "father", "mother", "дружина" as PersonRelation["relationType"]),
    ],
  });

  const result = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Трекер Роду",
    submitterName: "Тестовий дослідник",
    createdAt: "2026-06-30",
  });

  assert.match(result.text, /0 HEAD/);
  assert.match(result.text, /1 CHAR UTF-8/);
  assert.match(result.text, new RegExp(`0 ${escapeRegExp(result.individualXrefs.child)} INDI`));
  assert.match(result.text, /1 NAME .*\/Гурський\//);
  assert.match(result.text, /1 BIRT\n2 DATE 6 JUN 1896\n2 PLAC Трубіївка/);
  assert.match(result.text, new RegExp(`1 CHIL ${escapeRegExp(result.individualXrefs.child)}`));
  assert.match(result.text, new RegExp(`1 HUSB ${escapeRegExp(result.individualXrefs.father)}`));
  assert.match(result.text, new RegExp(`1 WIFE ${escapeRegExp(result.individualXrefs.mother)}`));
  assert.match(result.text, /0 TRLR/);
});

test("parses GEDCOM and summarizes record counts", () => {
  const gedcom = [
    "0 HEAD",
    "1 SOUR Test",
    "1 CHAR UTF-8",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Ivan /Hurskyi/",
    "0 @F1@ FAM",
    "1 CHIL @I1@",
    "0 @S1@ SOUR",
    "0 TRLR",
  ].join("\n");

  const parsed = parseGedcom(gedcom);
  const summary = summarizeGedcom(parsed);

  assert.equal(parsed.warnings.length, 0);
  assert.equal(summary.individuals, 1);
  assert.equal(summary.families, 1);
  assert.equal(summary.sources, 1);
  assert.equal(summary.characterEncoding, "UTF-8");
  assert.equal(summary.gedcomVersion, "5.5.1");
});

test("reports invalid GEDCOM lines without throwing", () => {
  const parsed = parseGedcom("0 HEAD\nthis is not gedcom\n0 TRLR");

  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.warnings.some((warning) => warning.code === "gedcom_invalid_line"), true);
});

test("formats common GEDCOM date values conservatively", () => {
  assert.equal(formatGedcomDate("1896-06-06"), "6 JUN 1896");
  assert.equal(formatGedcomDate("1896-06"), "JUN 1896");
  assert.equal(formatGedcomDate("1896"), "1896");
  assert.equal(formatGedcomDate("1896-1900"), "BET 1896 AND 1900");
  assert.equal(formatGedcomDate("1896-xx-06"), "1896-xx-06");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
