import test from "node:test";
import assert from "node:assert/strict";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";

test("builds an import draft from GEDCOM individuals and family links", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "1 SOUR Test",
    "1 CHAR UTF-8",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Ivan /Hurskyi/",
    "2 GIVN Ivan",
    "2 SURN Hurskyi",
    "1 SEX M",
    "0 @I2@ INDI",
    "1 NAME Yevdokiia /Hurska/",
    "1 SEX F",
    "0 @I3@ INDI",
    "1 NAME Hryhorii /Hurskyi/",
    "1 BIRT",
    "2 DATE 6 JUN 1896",
    "2 PLAC Trubiivka",
    "1 FAMC @F1@",
    "2 PEDI birth",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "1 CHIL @I3@",
    "1 MARR",
    "2 DATE 1895",
    "2 PLAC Trubiivka",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.summary.individuals, 3);
  assert.equal(draft.summary.families, 1);
  assert.equal(draft.people.find((person) => person.xref === "@I1@")?.gender, "male");
  assert.equal(draft.people.find((person) => person.xref === "@I3@")?.events[0]?.eventType, "birth");
  assert.equal(draft.people.find((person) => person.xref === "@I3@")?.events[0]?.placeName, "Trubiivka");
  assert.equal(draft.families[0].partnerXrefs.join(","), "@I1@,@I2@");
  assert.equal(draft.parentChildRelationships.length, 2);
  assert.equal(draft.parentChildRelationships[0].parentXref, "@I1@");
  assert.equal(draft.parentChildRelationships[0].childXref, "@I3@");
  assert.equal(draft.parentChildRelationships[0].relationshipType, "biological");
  assert.equal(draft.parentChildRelationships[1].parentRoleLabel, "mother");
  assert.equal(draft.partnerRelationships[0].relationshipType, "marriage");
  assert.equal(draft.partnerRelationships[0].eventDate, "1895");
});

test("uses GEDCOM PEDI to preserve adoptive parent-child semantics", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Petro /Shevchenko/",
    "0 @I2@ INDI",
    "1 NAME Mariia /Shevchenko/",
    "1 FAMC @F1@",
    "2 PEDI adopted",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 CHIL @I2@",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.parentChildRelationships.length, 1);
  assert.equal(draft.parentChildRelationships[0].relationshipType, "adoptive");
  assert.equal(draft.parentChildRelationships[0].pedigree, "adopted");
});

test("preserves GEDCOM privacy restriction metadata on imported people", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Private /Person/",
    "1 RESN confidential",
    "1 _LIVING Y",
    "0 TRLR",
  ].join("\n"));

  const person = draft.people[0];
  assert.equal(person.privacyStatus, "confidential");
  assert.equal(person.isLiving, true);
});

test("infers living people from MyHeritage privacy restriction when no death is present", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Living /Private/",
    "1 RESN privacy",
    "0 @I2@ INDI",
    "1 NAME Deceased /Private/",
    "1 RESN privacy",
    "1 DEAT Y",
    "0 @I3@ INDI",
    "1 NAME Explicit /Notliving/",
    "1 RESN privacy",
    "1 _LIVING N",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.people.find((person) => person.xref === "@I1@")?.isLiving, true);
  assert.equal(draft.people.find((person) => person.xref === "@I2@")?.isLiving, false);
  assert.equal(draft.people.find((person) => person.xref === "@I3@")?.isLiving, false);
});

test("does not treat GEDCOM DEAT N as a death event", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Living /Marker/",
    "1 RESN privacy",
    "1 DEAT N",
    "0 TRLR",
  ].join("\n"));

  const person = draft.people[0];
  assert.equal(person.isLiving, true);
  assert.equal(person.events.some((event) => event.eventType === "death"), false);
});

test("reads MyHeritage-style married surname extension", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Hanna /Birth/",
    "2 TYPE birth",
    "1 _MARNM Hanna /Married/",
    "2 GIVN Hanna",
    "2 SURN Married",
    "0 TRLR",
  ].join("\n"));

  const person = draft.people[0];
  assert.equal(person.names.some((name) => name.nameType === "birth" && name.surname === "Birth"), true);
  assert.equal(person.names.some((name) => name.nameType === "married" && name.surname === "Married"), true);
});

test("reads MyHeritage married surname nested under NAME", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Hanna /Birth/",
    "2 GIVN Hanna",
    "2 SURN Birth",
    "2 _MARNM Married",
    "0 TRLR",
  ].join("\n"));

  const person = draft.people[0];
  const marriedName = person.names.find((name) => name.nameType === "married");
  assert.equal(marriedName?.surname, "Married");
  assert.equal(marriedName?.givenName, "Hanna");
  assert.equal(marriedName?.fullName, "Hanna Married");
});

test("reads maiden name type as birth surname", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Hanna /Maiden/",
    "2 TYPE maiden",
    "1 _MARNM Hanna /Married/",
    "0 TRLR",
  ].join("\n"));

  const person = draft.people[0];
  assert.equal(person.names.some((name) => name.nameType === "birth" && name.surname === "Maiden"), true);
  assert.equal(person.names.some((name) => name.nameType === "married" && name.surname === "Married"), true);
});

test("reports families that reference missing people", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Child /Missingparent/",
    "0 @F1@ FAM",
    "1 HUSB @I2@",
    "1 CHIL @I1@",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.parentChildRelationships.length, 0);
  assert.equal(draft.warnings.some((warning) => warning.code === "gedcom_family_missing_partner"), true);
});

test("keeps unsupported top-level records as unmapped records", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Ivan /Hurskyi/",
    "0 @R1@ RESN locked",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.people.length, 1);
  assert.equal(draft.unmappedRecords.length, 1);
  assert.equal(draft.unmappedRecords[0].tag, "RESN");
});

test("reads saved central person marker from GEDCOM header", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "1 _TRK_ROOT @I2@",
    "0 @I1@ INDI",
    "1 NAME First /Person/",
    "0 @I2@ INDI",
    "1 NAME Root /Person/",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.rootPersonXref, "@I2@");
});

test("builds a large GEDCOM import draft without quadratic child-line scans", () => {
  const peopleCount = 3_000;
  const lines = ["0 HEAD", "1 CHAR UTF-8"];
  for (let index = 1; index <= peopleCount; index += 1) {
    lines.push(
      `0 @I${index}@ INDI`,
      `1 NAME Given${index} /Birth${index}/`,
      `2 GIVN Given${index}`,
      `2 SURN Birth${index}`,
      `2 _MARNM Married${index}`,
      "1 BIRT",
      `2 DATE ${1800 + (index % 200)}`,
      `2 PLAC Place ${index % 25}`,
      `2 NOTE Source note ${index}`,
      "3 CONC  continued",
    );
  }
  lines.push("0 TRLR");

  const startedAt = performance.now();
  const draft = buildGedcomImportDraft(lines.join("\n"));
  const elapsedMs = performance.now() - startedAt;

  assert.equal(draft.people.length, peopleCount);
  assert.equal(draft.people[peopleCount - 1]?.events[0]?.notes, `Source note ${peopleCount}continued`);
  assert.equal(
    draft.people[peopleCount - 1]?.names.some((name) => name.nameType === "married" && name.surname === `Married${peopleCount}`),
    true,
  );
  assert.ok(elapsedMs < 5_000, `Expected near-linear GEDCOM import, received ${elapsedMs.toFixed(0)} ms.`);
});
