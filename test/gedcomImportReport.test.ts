import test from "node:test";
import assert from "node:assert/strict";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import { buildGedcomImportReport, formatGedcomImportReport } from "../src/utils/gedcomImportReport.ts";

test("builds a user-facing GEDCOM import report", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Living /Private/",
    "1 RESN privacy",
    "0 @I2@ INDI",
    "1 NAME Living /Private/",
    "1 RESN privacy",
    "0 @I3@ INDI",
    "1 NAME Deceased /Parent/",
    "1 SEX F",
    "1 DEAT Y",
    "0 @I4@ INDI",
    "1 NAME Unknown /Child/",
    "1 FAMC @F1@",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I3@",
    "1 CHIL @I4@",
    "0 TRLR",
  ].join("\n"));

  const built = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  const report = buildGedcomImportReport(draft, built);

  assert.equal(report.persons, 4);
  assert.equal(report.families, 1);
  assert.equal(report.relations, 3);
  assert.equal(report.livingPersons, 2);
  assert.equal(report.deceasedPersons, 1);
  assert.equal(report.unknownVitalStatusPersons, 1);
  assert.equal(report.potentialDuplicates, 1);

  const formatted = formatGedcomImportReport(report);
  assert.match(formatted, /^Живих: 2$/m);
  assert.match(formatted, /^Померлих: 1$/m);
  assert.match(formatted, /^Невідомий статус: 1$/m);
});

test("uses the normalized GEDCOM vital status as the report source of truth", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Recent /Person/",
    "1 BIRT",
    `2 DATE ${new Date().getUTCFullYear() - 35}`,
    "0 @I2@ INDI",
    "1 NAME Explicit /Deceased/",
    "1 _LIVING N",
    "0 TRLR",
  ].join("\n"));
  const built = buildGedcomAppImport(draft, {
    idFactory: () => `status-id-${++id}`,
    nowFactory: () => "2026-07-20T00:00:00.000Z",
  });

  const report = buildGedcomImportReport(draft, built);
  assert.equal(report.livingPersons, 1);
  assert.equal(report.deceasedPersons, 1);
  assert.equal(report.unknownVitalStatusPersons, 0);
});
