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
  runImportBatches,
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

  assert.match(peopleSource, /runImportBatches\(chunkImportRows\(personRows\)/);
  assert.match(peopleSource, /runImportBatches\(chunkImportRows\(relationRows\)/);
  assert.match(documentsSource, /runImportBatches\(chunkImportRows\(documentRows\)/);
  assert.match(documentsSource, /runImportBatches\(chunkImportRows\(yearMatrixRows\)/);
  assert.match(workRecordsSource, /runImportBatches\(chunkFindingImportRows\(findingRows\)/);
  assert.match(workRecordsSource, /replaceImportedFindingParticipants/);
  assert.doesNotMatch(
    workRecordsSource,
    /for \(const finding of findings\)\s*\{\s*await replaceFindingParticipants/,
  );
});

test("runs import batches with bounded concurrency and monotonic progress", async () => {
  const batches = Array.from({ length: 9 }, (_, batchIndex) =>
    Array.from({ length: batchIndex === 8 ? 1 : 3 }, (_, itemIndex) =>
      batchIndex * 3 + itemIndex,
    ),
  );
  let activeWorkers = 0;
  let maximumActiveWorkers = 0;
  const processedBatchIndexes: number[] = [];
  const progress: Array<{
    completedBatches: number;
    totalBatches: number;
    processedItems: number;
    totalItems: number;
  }> = [];

  await runImportBatches(batches, async (_batch, batchIndex) => {
    activeWorkers += 1;
    maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
    await new Promise((resolve) => setTimeout(resolve, 2));
    processedBatchIndexes.push(batchIndex);
    activeWorkers -= 1;
  }, {
    concurrency: 3,
    onProgress: (update) => progress.push(update),
  });

  assert.equal(maximumActiveWorkers, 3);
  assert.deepEqual(processedBatchIndexes.toSorted((left, right) => left - right),
    batches.map((_batch, index) => index));
  assert.equal(progress.length, batches.length);
  assert.equal(progress.every((update, index) =>
    update.completedBatches === index + 1 &&
    update.totalBatches === batches.length &&
    update.totalItems === 25 &&
    (index === 0 || update.processedItems > progress[index - 1].processedItems)), true);
  assert.deepEqual(progress.at(-1), {
    completedBatches: 9,
    totalBatches: 9,
    processedItems: 25,
    totalItems: 25,
  });
});

test("does not invoke a batch worker or report progress for empty input", async () => {
  let calls = 0;
  await runImportBatches([], async () => {
    calls += 1;
  }, {
    concurrency: 2,
    onProgress: () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
});

test("rejects invalid batch limits", () => {
  assert.throws(() => chunkImportRows([1], { maxItems: 0 }), RangeError);
  assert.throws(() => chunkImportRows([1], { maxBytes: 1 }), RangeError);
});

test("rejects invalid batch concurrency", async () => {
  await assert.rejects(
    runImportBatches([[1]], async () => undefined, { concurrency: 0 }),
    RangeError,
  );
});
