import test from "node:test";
import assert from "node:assert/strict";
import type { GedcomPreservedRecord } from "../src/types/familyTree.ts";
import {
  buildGedcomArchiveBatchPayload,
  buildGedcomArchiveStoragePayload,
  buildGedcomArchiveXrefRows,
  chunkGedcomArchiveRows,
  GEDCOM_ARCHIVE_BATCH_INTERNAL_TABLE,
  GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE,
  partitionGedcomPreservedRecords,
  personIdMapFromGedcomArchiveRows,
  restoreGedcomArchiveRecords,
} from "../src/utils/gedcomArchive.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const treeId = "10000000-0000-4000-8000-000000000002";
const batchId = "10000000-0000-4000-8000-000000000003";
const personId = "10000000-0000-4000-8000-000000000004";

const head = record(0, null, "HEAD", "", [
  line(0, null, "HEAD", ""),
  line(1, null, "CHAR", "UTF-8"),
]);
const person = record(1, "@I1@", "INDI", "", [
  line(0, "@I1@", "INDI", ""),
  line(1, null, "NAME", "Іван /Каленський/"),
]);
const family = record(2, "@F1@", "FAM", "", [
  line(0, "@F1@", "FAM", ""),
  line(1, null, "HUSB", "@I1@"),
]);
const trailer = record(3, null, "TRLR", "", [line(0, null, "TRLR", "")]);

test("partitions pointer records and preserves invalid duplicate XREF records", () => {
  const duplicate = { ...person, order: 4 };
  const result = partitionGedcomPreservedRecords([head, person, family, trailer, duplicate]);

  assert.deepEqual(result.pointedRecords, [person, family]);
  assert.deepEqual(result.unpointedRecords, [head, trailer]);
  assert.deepEqual(result.duplicatePointedRecords, [duplicate]);
});

test("builds a batch payload with counts, warnings and all non-map records", () => {
  const duplicate = { ...person, order: 4 };
  const payload = buildGedcomArchiveBatchPayload({
    projectId,
    treeId,
    fileName: "tree.ged",
    gedcomVersion: "5.5.1",
    records: [head, person, family, trailer, duplicate],
    personIdByXref: { "@I1@": personId },
    warnings: [{ severity: "info", code: "source", message: "source warning" }],
  });

  assert.equal(payload.status, "importing");
  assert.equal(payload.imported_people, 2);
  assert.equal(payload.imported_families, 1);
  assert.equal(payload.raw_metadata.record_count, 5);
  assert.equal(payload.raw_metadata.pointed_record_count, 2);
  assert.deepEqual(payload.raw_metadata.unpointed_records, [head, trailer]);
  assert.deepEqual(payload.raw_metadata.duplicate_pointed_records, [duplicate]);
  assert.deepEqual(payload.warnings.map((warning) => warning.code), [
    "source",
    "duplicateGedcomXrefArchived",
  ]);
});

test("maps INDI records to people and anchors every other XREF to the import batch", () => {
  const rows = buildGedcomArchiveXrefRows({
    projectId,
    treeId,
    batchId,
    records: [head, person, family, trailer],
    // Also accept the common unwrapped key produced by import adapters.
    personIdByXref: { I1: personId },
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    project_id: projectId,
    tree_id: treeId,
    import_batch_id: batchId,
    gedcom_xref: "@I1@",
    gedcom_record_type: "INDI",
    internal_table: GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE,
    internal_id: personId,
    raw_record: person,
  });
  assert.equal(rows[1].internal_table, GEDCOM_ARCHIVE_BATCH_INTERNAL_TABLE);
  assert.equal(rows[1].internal_id, batchId);
  assert.equal(rows[1].gedcom_record_type, "FAM");
});

test("builds a complete storage payload and restores original record order", () => {
  const payload = buildGedcomArchiveStoragePayload({
    projectId,
    treeId,
    batchId,
    fileName: "tree.ged",
    gedcomVersion: "5.5.1",
    records: [head, person, family, trailer],
    personIdByXref: { "@I1@": personId },
  });
  const storedRows = payload.xrefRows.map((row) => ({
    gedcom_xref: row.gedcom_xref,
    gedcom_record_type: row.gedcom_record_type,
    internal_table: row.internal_table,
    internal_id: row.internal_id,
    raw_record: row.raw_record,
  }));

  const restored = restoreGedcomArchiveRecords(payload.batch.raw_metadata, storedRows);
  assert.deepEqual(restored.map((item) => [item.order, item.tag]), [
    [0, "HEAD"],
    [1, "INDI"],
    [2, "FAM"],
    [3, "TRLR"],
  ]);
  assert.equal(restored[1].internalId, personId);
  assert.equal(restored[2].internalId, batchId);
  assert.deepEqual(personIdMapFromGedcomArchiveRows(storedRows), { "@I1@": personId });
});

test("chunks large xref inserts at no more than 400 rows", () => {
  const rows = Array.from({ length: 801 }, (_, index) => index);
  assert.deepEqual(chunkGedcomArchiveRows(rows).map((chunk) => chunk.length), [400, 400, 1]);
  assert.deepEqual(chunkGedcomArchiveRows(rows, 200).map((chunk) => chunk.length), [200, 200, 200, 200, 1]);
  assert.throws(() => chunkGedcomArchiveRows(rows, 401), RangeError);
  assert.throws(() => chunkGedcomArchiveRows(rows, 0), RangeError);
});

function record(
  order: number,
  pointer: string | null,
  tag: string,
  value: string,
  lines: GedcomPreservedRecord["lines"],
): GedcomPreservedRecord {
  return { order, pointer, tag, value, lines };
}

function line(level: number, pointer: string | null, tag: string, value: string) {
  return { level, pointer, tag, value };
}
