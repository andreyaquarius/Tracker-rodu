import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import {
  deriveGedcomImportSourceKey,
  reconcileGedcomImportForRetry,
  type GedcomImportReconciliationPayload,
} from "../src/utils/gedcomImportReconciliation.ts";
import { GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD } from "../src/utils/gedcomMetadata.ts";

function fixture(projectGuid: string, personUid: string, personName = "Anna /Retry/") {
  return buildGedcomImportDraft([
    "0 HEAD",
    `1 _PROJECT_GUID ${projectGuid}`,
    "1 _ROOT @I1@",
    "0 @I1@ INDI",
    `1 NAME ${personName}`,
    "1 SEX F",
    "1 BIRT",
    "2 DATE 1900",
    "2 NOTE Event evidence",
    "2 SOUR @S1@",
    "3 PAGE archive-page-1",
    "1 RIN MH:I1",
    `1 _UID ${personUid}`,
    "1 FAMS @F1@",
    "0 @I2@ INDI",
    "1 NAME Petro /Retry/",
    "1 SEX M",
    "1 RIN MH:I2",
    `1 _UID ${personUid}-partner`,
    "1 FAMS @F1@",
    "0 @F1@ FAM",
    "1 HUSB @I2@",
    "1 WIFE @I1@",
    "1 MARR",
    "2 DATE 1920",
    "0 @S1@ SOUR",
    "1 TITL Retry source",
    "1 RIN MH:S1",
    "1 TEXT Source body",
    "0 TRLR",
  ].join("\n"));
}

function ids(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function payload(prefix: string, draft = fixture("TREE-ONE", "uid-one")): GedcomImportReconciliationPayload {
  const built = buildGedcomAppImport(draft, {
    idFactory: ids(prefix),
    nowFactory: () => prefix === "old" ? "2026-07-01" : "2026-07-12",
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

test("derives a stable source namespace and stamps every imported entity", () => {
  const draft = fixture("TREE-ONE", "uid-one");
  const first = payload("old", draft);
  const second = payload("new", draft);

  assert.equal(deriveGedcomImportSourceKey(draft), "myheritage-project:tree-one");
  assert.equal(first.importSourceKey, second.importSourceKey);
  assert.equal(first.people.every((person) =>
    person.customFields[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD] === first.importSourceKey
  ), true);
  assert.equal(first.documents.every((document) =>
    document.customFields[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD] === first.importSourceKey
  ), true);
  assert.equal(first.findings.every((finding) =>
    finding.customFields[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD] === first.importSourceKey
  ), true);
});

test("reuses committed IDs and remaps root, archive map and dependent records on retry", () => {
  const committed = payload("old");
  const retry = payload("new");
  assert.ok(committed.findings.length >= 2);

  const result = reconcileGedcomImportForRetry(retry, {
    people: committed.people,
    documents: committed.documents,
    relations: committed.relations,
    findings: committed.findings.slice(0, 1),
  });

  assert.deepEqual(result.people.map((person) => person.id), committed.people.map((person) => person.id));
  assert.deepEqual(result.documents.map((document) => document.id), committed.documents.map((document) => document.id));
  assert.deepEqual(result.relations.map((relation) => relation.id), committed.relations.map((relation) => relation.id));
  assert.equal(result.findings[0]?.id, committed.findings[0]?.id);
  assert.equal(result.findings[0]?.participants[0]?.id, committed.findings[0]?.participants[0]?.id);
  assert.equal(result.rootPersonId, committed.rootPersonId);
  assert.deepEqual(result.personIdByXref, committed.personIdByXref);
  assert.equal(result.findings.every((finding) =>
    finding.personIds.every((id) => result.people.some((person) => person.id === id))
  ), true);
  assert.equal(result.findings.every((finding) =>
    !finding.documentId || result.documents.some((document) => document.id === finding.documentId)
  ), true);
});

test("recovers records committed before source namespaces existed using UID and exact source metadata", () => {
  const committed = payload("old");
  const legacyPeople = committed.people.map((person) => {
    const customFields = { ...person.customFields };
    delete customFields[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD];
    return { ...person, customFields };
  });
  const legacyDocuments = committed.documents.map((document) => {
    const customFields = { ...document.customFields };
    delete customFields[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD];
    return { ...document, customFields };
  });
  const retry = payload("new");

  const result = reconcileGedcomImportForRetry(retry, {
    people: legacyPeople,
    documents: legacyDocuments,
    relations: committed.relations,
    findings: committed.findings,
  });

  assert.deepEqual(result.people.map((person) => person.id), committed.people.map((person) => person.id));
  assert.deepEqual(result.documents.map((document) => document.id), committed.documents.map((document) => document.id));
  assert.deepEqual(result.findings.map((finding) => finding.id), committed.findings.map((finding) => finding.id));
});

test("does not merge equal XREF values from different GEDCOM source namespaces", () => {
  const first = payload("old", fixture("TREE-ONE", "uid-one", "Anna /First/"));
  const unrelated = payload("new", fixture("TREE-TWO", "uid-two", "Anna /Second/"));

  const result = reconcileGedcomImportForRetry(unrelated, {
    people: first.people,
    documents: first.documents,
    relations: first.relations,
    findings: first.findings,
  });

  assert.notEqual(result.importSourceKey, first.importSourceKey);
  assert.deepEqual(result.people.map((person) => person.id), unrelated.people.map((person) => person.id));
  assert.deepEqual(result.documents.map((document) => document.id), unrelated.documents.map((document) => document.id));
});

test("passes reconciled IDs to tree creation and archive persistence", () => {
  const buttonSource = readFileSync(
    new URL("../src/components/GedcomImportButton.tsx", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(buttonSource, /const reconciled = await onImportGedcom\(committed, \{/);
  assert.match(buttonSource, /onProgress: \(nextProgress\) => setProgress\(nextProgress\)/);
  assert.match(buttonSource, /people: committed\.people/);
  assert.match(buttonSource, /relations: committed\.relations/);
  assert.match(buttonSource, /rootPersonId: committed\.rootPersonId/);
  assert.match(buttonSource, /personIdByXref: committed\.personIdByXref/);
  assert.match(appSource, /listProjectDocuments\(projectId\)/);
  assert.match(appSource, /listProjectWorkRecords\(projectId\)/);
  assert.match(appSource, /reconcileGedcomImportForRetry\(input/);
});
