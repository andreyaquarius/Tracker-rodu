import test from "node:test";
import assert from "node:assert/strict";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import { buildGedcomImportReport } from "../src/utils/gedcomImportReport.ts";
import {
  reconcileGedcomImportForRetry,
  type GedcomImportReconciliationPayload,
} from "../src/utils/gedcomImportReconciliation.ts";

const SOURCE_URL = "https://archive.example/record/42";

function sourceFixture() {
  return buildGedcomImportDraft([
    "0 HEAD",
    "1 _PROJECT_GUID SOURCE-FINDINGS-COMPAT",
    "0 @I1@ INDI",
    "1 NAME Anna /Source/",
    "1 BIRT",
    "2 DATE 1900",
    "2 SOUR @S1@",
    "3 PAGE Аркуш 42",
    `3 _URL ${SOURCE_URL}`,
    "1 FAMS @F1@",
    "0 @I2@ INDI",
    "1 NAME Petro /Source/",
    "1 FAMS @F1@",
    "0 @F1@ FAM",
    "1 WIFE @I1@",
    "1 HUSB @I2@",
    "1 SOUR @S1@",
    "2 PAGE Родинна справа",
    "1 MARR",
    "2 DATE 1920",
    "2 SOUR @S1@",
    "3 PAGE Акт 7",
    "0 @S1@ SOUR",
    "1 TITL Архівне джерело",
    "0 TRLR",
  ].join("\n"));
}

function payload(prefix: string): GedcomImportReconciliationPayload {
  let id = 0;
  const built = buildGedcomAppImport(sourceFixture(), {
    idFactory: () => `${prefix}-${++id}`,
    nowFactory: () => "2026-07-19T00:00:00.000Z",
  });
  return {
    people: built.people,
    personRecords: built.personRecords,
    documents: built.documents,
    relations: built.relations,
    findings: built.findings,
    rootPersonId: built.rootPersonId ?? "",
    personIdByXref: built.personIdByXref,
    importSourceKey: built.importSourceKey,
  };
}

test("parses a dedicated URL from a GEDCOM citation", () => {
  const draft = sourceFixture();
  assert.equal(draft.people[0]?.events[0]?.citations?.[0]?.url, SOURCE_URL);
});

test("counts person, family and family-event citations in the import report", () => {
  const draft = sourceFixture();
  let id = 0;
  const built = buildGedcomAppImport(draft, {
    idFactory: () => `report-${++id}`,
    nowFactory: () => "2026-07-19T00:00:00.000Z",
  });

  const report = buildGedcomImportReport(draft, built);
  assert.equal(report.sources, 1);
  assert.equal(report.citations, 3);
});

test("retry reuses a legacy citation finding despite its document link and URL-polluted fields", () => {
  const committed = payload("old");
  const retry = payload("new");
  const committedCitation = committed.findings.find((finding) => finding.customFields.__gedcomCitation);
  assert.ok(committedCitation);
  const legacyCitation = {
    ...committedCitation,
    documentId: "legacy-generated-document",
    sourceUrl: "",
    file: SOURCE_URL,
    page: `Аркуш 42 · ${SOURCE_URL}`,
    description: `Архівне джерело ${SOURCE_URL}`,
    summary: `Архівне джерело · ${SOURCE_URL}`,
  };

  const result = reconcileGedcomImportForRetry(retry, {
    people: committed.people,
    documents: [],
    relations: committed.relations,
    findings: [legacyCitation],
  });
  const reconciledCitation = result.findings.find((finding) => finding.customFields.__gedcomCitation);

  assert.equal(reconciledCitation, legacyCitation);
  assert.equal(reconciledCitation?.id, committedCitation.id);
  assert.equal(reconciledCitation?.documentId, "legacy-generated-document");
});

test("retry preserves a user-edited dedicated URL on an existing GEDCOM finding", () => {
  const committed = payload("edited-old");
  const retry = payload("edited-new");
  const citation = committed.findings.find((finding) => finding.sourceUrl === SOURCE_URL);
  assert.ok(citation);
  const editedCitation = {
    ...citation,
    sourceUrl: "https://archive.example/record/42?verified=1",
    notes: "Перевірено користувачем",
  };

  const result = reconcileGedcomImportForRetry(retry, {
    people: committed.people,
    documents: [],
    relations: committed.relations,
    findings: [editedCitation],
  });

  assert.equal(result.findings.find((finding) => finding.id === editedCitation.id), editedCitation);
});
