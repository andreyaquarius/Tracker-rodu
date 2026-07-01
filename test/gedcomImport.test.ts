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
