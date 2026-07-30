import assert from "node:assert/strict";
import test from "node:test";
import {
  createPdfSubsetBlob,
  DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
  firstKnownPositiveSize,
  parsePageRange,
  pdfClientExportLimits,
  pdfExportDeduplicationKey,
  pdfExportFileName,
  validateClientExportSize,
  validateKnownClientExportSize,
  validateZipExportBudget,
} from "../src/services/pdfPageExport.ts";
import { PDFDocument } from "pdf-lib";

test("parses, deduplicates and sorts complex PDF page ranges", () => {
  assert.deepEqual(parsePageRange("8, 1-3, 2, 12-15", 20), [1, 2, 3, 8, 12, 13, 14, 15]);
});

test("rejects invalid and out-of-bounds PDF page ranges", () => {
  assert.throws(() => parsePageRange("", 10), /Укажіть сторінку/u);
  assert.throws(() => parsePageRange("0", 10), /від 1/u);
  assert.throws(() => parsePageRange("5-3", 10), /початкова/u);
  assert.throws(() => parsePageRange("1-11", 10), /за межі/u);
  assert.throws(() => parsePageRange("1,,2", 10), /між комами/u);
  assert.throws(() => parsePageRange("one", 10), /Некоректний/u);
});

test("enforces the configured page limit after deduplication", () => {
  assert.deepEqual(parsePageRange("1-3,2", 10, 3), [1, 2, 3]);
  assert.throws(() => parsePageRange("1-4", 10, 3), /не більше 3/u);
});

test("builds safe localized file names", () => {
  assert.equal(pdfExportFileName("ДАЖО: справа 1/77?", [8], "png"), "ДАЖО- справа 1-77-_сторінка-008.png");
  assert.equal(pdfExportFileName("Книга", [8, 1, 3], "pdf"), "Книга_сторінки-001-008.pdf");
});

test("reads bounded positive export configuration and falls back on malformed values", () => {
  assert.deepEqual(pdfClientExportLimits({
    VITE_PDF_CLIENT_EXPORT_MAX_BYTES: "1048576",
    VITE_PDF_CLIENT_EXPORT_MAX_PAGES: "12",
    VITE_PDF_EXPORT_MAX_IMAGE_SIDE: "2048",
    VITE_PDF_EXPORT_IMAGE_SCALE: "1.5",
  }), {
    maxSourceBytes: 1_048_576,
    maxPages: 12,
    maxImageSide: 2_048,
    imageScale: 1.5,
    maxZipTotalPixels: 80_000_000,
    maxZipMemoryBytes: 384 * 1024 * 1024,
  });
  assert.deepEqual(pdfClientExportLimits({
    VITE_PDF_CLIENT_EXPORT_MAX_BYTES: "-1",
    VITE_PDF_CLIENT_EXPORT_MAX_PAGES: "oops",
  }), DEFAULT_PDF_CLIENT_EXPORT_LIMITS);
});

test("falls back from a persisted zero to the first positive PDF source size", () => {
  assert.equal(firstKnownPositiveSize(0, 4_096), 4_096);
  assert.equal(firstKnownPositiveSize(undefined, -1, 8_192), 8_192);
  assert.equal(firstKnownPositiveSize(12_345, 8_192), 12_345);
  assert.equal(firstKnownPositiveSize(0, Number.NaN, -1), undefined);
});

test("rejects browser export payloads above configured limits", () => {
  const limits = { ...DEFAULT_PDF_CLIENT_EXPORT_LIMITS, maxSourceBytes: 10, maxPages: 2 };
  assert.throws(() => validateClientExportSize(11, 1, limits), /завеликий/u);
  assert.throws(() => validateClientExportSize(10, 3, limits), /не більше 2/u);
  assert.doesNotThrow(() => validateClientExportSize(10, 2, limits));
});

test("requires a known safe source size before materializing the complete PDF", () => {
  const limits = { ...DEFAULT_PDF_CLIENT_EXPORT_LIMITS, maxSourceBytes: 10, maxPages: 2 };

  assert.throws(() => validateKnownClientExportSize(undefined, 1, limits), /Розмір PDF невідомий/u);
  assert.throws(() => validateKnownClientExportSize(0, 1, limits), /Розмір PDF невідомий/u);
  assert.throws(() => validateKnownClientExportSize(11, 1, limits), /завеликий/u);
  assert.equal(validateKnownClientExportSize(10, 2, limits), 10);
});

test("enforces cumulative ZIP pixel and estimated memory budgets", () => {
  const limits = {
    ...DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
    maxZipTotalPixels: 1_000,
    maxZipMemoryBytes: 100,
  };

  assert.doesNotThrow(() => validateZipExportBudget({
    totalPixels: 1_000,
    largestPagePixels: 10,
    encodedBytes: 20,
  }, limits));
  assert.throws(() => validateZipExportBudget({
    totalPixels: 1_001,
    largestPagePixels: 10,
    encodedBytes: 0,
  }, limits), /Сумарний ліміт/u);
  assert.throws(() => validateZipExportBudget({
    totalPixels: 100,
    largestPagePixels: 10,
    encodedBytes: 21,
  }, limits), /забагато пам’яті/u);
});

test("builds a stable Drive deduplication key for one logical PDF export", () => {
  const base = {
    documentId: "document-1",
    sourceIdentity: "source-1",
    sourceVersion: "sha1:abc123",
    pages: [3, 1, 3],
    format: "pdf" as const,
    destinationPath: ["Експорт документів"],
  };
  const first = pdfExportDeduplicationKey(base);
  const reordered = pdfExportDeduplicationKey({ ...base, pages: [1, 3] });

  assert.equal(first, reordered);
  assert.match(first, /^pdf-export:v1:[0-9a-f]{16}$/u);
  assert.notEqual(first, pdfExportDeduplicationKey({ ...base, sourceVersion: "sha1:changed" }));
  assert.notEqual(first, pdfExportDeduplicationKey({ ...base, format: "zip-png" }));
  assert.notEqual(first, pdfExportDeduplicationKey({ ...base, imageScale: 1.5 }));
  assert.notEqual(
    pdfExportDeduplicationKey({ ...base, format: "jpeg", jpegQuality: 0.7 }),
    pdfExportDeduplicationKey({ ...base, format: "jpeg", jpegQuality: 0.95 }),
  );
});

test("copies selected original PDF pages in the requested order", async () => {
  const source = await PDFDocument.create();
  source.addPage([300, 400]);
  source.addPage([500, 600]);
  source.addPage([700, 800]);
  const sourceBytes = await source.save();

  const subsetBlob = await createPdfSubsetBlob(sourceBytes, [1, 3]);
  assert.equal(subsetBlob.type, "application/pdf");
  const subset = await PDFDocument.load(await subsetBlob.arrayBuffer());
  assert.equal(subset.getPageCount(), 2);
  assert.deepEqual(subset.getPage(0).getSize(), { width: 300, height: 400 });
  assert.deepEqual(subset.getPage(1).getSize(), { width: 700, height: 800 });
});

test("a cancelled PDF subset export stops before materializing a result", async () => {
  const source = await PDFDocument.create();
  source.addPage([300, 400]);
  const sourceBytes = await source.save();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createPdfSubsetBlob(sourceBytes, [1], DEFAULT_PDF_CLIENT_EXPORT_LIMITS, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});
