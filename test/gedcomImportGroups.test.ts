import assert from "node:assert/strict";
import test from "node:test";
import type { Finding, Person, PersonRelation } from "../src/types/index.ts";
import { buildGedcomImportGroups } from "../src/utils/gedcomImportGroups.ts";
import {
  GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD,
  GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD,
} from "../src/utils/gedcomMetadata.ts";

function importedPerson(id: string, sourceKey: string, fileName: string): Person {
  return {
    id,
    createdAt: "2026-07-19T10:00:00.000Z",
    customFields: {
      [GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]: sourceKey,
      [GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD]: fileName,
    },
  } as Person;
}

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
  sourceKey = "",
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    createdAt: "2026-07-19T10:01:00.000Z",
    gedcomMetadata: sourceKey
      ? { familyXref: "@F1@", importSourceKey: sourceKey }
      : undefined,
  } as PersonRelation;
}

function finding(id: string, sourceKey: string, fileName: string): Finding {
  return {
    id,
    createdAt: "2026-07-19T10:02:00.000Z",
    customFields: {
      [GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]: sourceKey,
      [GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD]: fileName,
    },
  } as Finding;
}

test("groups GEDCOM persons, owned relations and findings by stable source key", () => {
  const groups = buildGedcomImportGroups(
    [
      importedPerson("person-a", "gedcom:a", "a.ged"),
      importedPerson("person-b", "gedcom:a", "a.ged"),
    ],
    [
      relation("relation-owned", "existing-1", "existing-2", "gedcom:a"),
      relation("relation-to-imported", "person-a", "existing-3"),
    ],
    [finding("finding-a", "gedcom:a", "a.ged")],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.sourceKey, "gedcom:a");
  assert.equal(groups[0]?.fileName, "a.ged");
  assert.deepEqual(groups[0]?.personIds.sort(), ["person-a", "person-b"]);
  assert.deepEqual(groups[0]?.relationIds.sort(), ["relation-owned", "relation-to-imported"]);
  assert.deepEqual(groups[0]?.findingIds, ["finding-a"]);
  assert.equal(groups[0]?.personCount, 2);
  assert.equal(groups[0]?.relationCount, 2);
  assert.equal(groups[0]?.findingCount, 1);
});

test("keeps a removable GEDCOM group when every person was reconciled to an existing record", () => {
  const groups = buildGedcomImportGroups(
    [],
    [relation("relation-a", "existing-1", "existing-2", "gedcom:reused")],
    [finding("finding-a", "gedcom:reused", "reused.ged")],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.personCount, 0);
  assert.equal(groups[0]?.relationCount, 1);
  assert.equal(groups[0]?.findingCount, 1);
  assert.equal(groups[0]?.fileName, "reused.ged");
});

test("keeps an empty completed dataset visible through its durable server marker", () => {
  const groups = buildGedcomImportGroups([], [], [], [{
    sourceKey: "gedcom:tree-only",
    importedAt: "2026-07-19T11:00:00.000Z",
  }]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.sourceKey, "gedcom:tree-only");
  assert.equal(groups[0]?.personCount, 0);
  assert.equal(groups[0]?.relationCount, 0);
  assert.equal(groups[0]?.findingCount, 0);
});
