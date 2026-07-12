import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_IMPORT_BATCH_BYTES,
  DEFAULT_IMPORT_BATCH_ITEMS,
  FINDING_IMPORT_BATCH_BYTES,
  FINDING_IMPORT_BATCH_ITEMS,
  chunkFindingImportRows,
  chunkImportRows,
} from "../src/utils/importBatches.ts";

const encoder = new TextEncoder();

test("chunks ordinary import rows by both count and UTF-8 payload size", () => {
  const rows = Array.from({ length: 450 }, (_, index) => ({
    id: `row-${index}`,
    text: index < 10 ? "і".repeat(60_000) : `value-${index}`,
  }));

  const batches = chunkImportRows(rows);

  assert.deepEqual(batches.flat(), rows);
  assert.equal(batches.every((batch) => batch.length <= DEFAULT_IMPORT_BATCH_ITEMS), true);
  for (const batch of batches) {
    const payloadBytes = encoder.encode(JSON.stringify(batch)).byteLength;
    assert.ok(
      payloadBytes <= DEFAULT_IMPORT_BATCH_BYTES || batch.length === 1,
      `Unexpected import payload of ${payloadBytes} bytes.`,
    );
  }
});

test("splits 2693 GEDCOM findings into small requests instead of one timeout-prone upsert", () => {
  const findings = Array.from({ length: 2_693 }, (_, index) => ({
    id: `finding-${index}`,
    description: `GEDCOM source text ${index} ${"джерело ".repeat(40)}`,
  }));

  const batches = chunkFindingImportRows(findings);

  assert.equal(batches.length, Math.ceil(findings.length / FINDING_IMPORT_BATCH_ITEMS));
  assert.equal(batches.length, 54);
  assert.deepEqual(batches.flat(), findings);
  assert.equal(batches.every((batch) => batch.length <= FINDING_IMPORT_BATCH_ITEMS), true);
  for (const batch of batches) {
    const payloadBytes = encoder.encode(JSON.stringify(batch)).byteLength;
    assert.ok(
      payloadBytes <= FINDING_IMPORT_BATCH_BYTES || batch.length === 1,
      `Unexpected findings payload of ${payloadBytes} bytes.`,
    );
  }
});

test("all project bulk import services use bounded mutation batches", () => {
  const peopleSource = readFileSync(
    new URL("../src/services/projectPeople.ts", import.meta.url),
    "utf8",
  );
  const documentsSource = readFileSync(
    new URL("../src/services/projectDocuments.ts", import.meta.url),
    "utf8",
  );
  const workRecordsSource = readFileSync(
    new URL("../src/services/projectWorkRecords.ts", import.meta.url),
    "utf8",
  );

  assert.match(peopleSource, /for \(const batch of chunkImportRows\(personRows\)\)/);
  assert.match(peopleSource, /for \(const batch of chunkImportRows\(relationRows\)\)/);
  assert.match(documentsSource, /for \(const batch of chunkImportRows\(documentRows\)\)/);
  assert.match(documentsSource, /for \(const batch of chunkImportRows\(yearMatrixRows\)\)/);
  assert.match(workRecordsSource, /for \(const batch of chunkFindingImportRows\(findingRows\)\)/);
  assert.match(workRecordsSource, /replaceImportedFindingParticipants/);
  assert.doesNotMatch(
    workRecordsSource,
    /for \(const finding of findings\)\s*\{\s*await replaceFindingParticipants/,
  );
});

test("rejects invalid batch limits", () => {
  assert.throws(() => chunkImportRows([1], { maxItems: 0 }), RangeError);
  assert.throws(() => chunkImportRows([1], { maxBytes: 1 }), RangeError);
});
