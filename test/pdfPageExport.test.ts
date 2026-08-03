import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePdfSubsetExportStrategy,
  createPdfSubsetBlob,
  createRasterizedPdfSubsetBlob,
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

test("routes large and unknown PDFs to bounded page-by-page raster export", () => {
  const limits = { ...DEFAULT_PDF_CLIENT_EXPORT_LIMITS, maxSourceBytes: 10, maxPages: 2 };

  assert.equal(choosePdfSubsetExportStrategy(10, 2, limits), "vector");
  assert.equal(choosePdfSubsetExportStrategy(11, 2, limits), "rasterized");
  assert.equal(choosePdfSubsetExportStrategy(undefined, 1, limits), "rasterized");
  assert.equal(choosePdfSubsetExportStrategy(0, 1, limits), "rasterized");
  assert.throws(() => choosePdfSubsetExportStrategy(10, 3, limits), /не більше 2/u);
  assert.throws(() => choosePdfSubsetExportStrategy(10, 0, limits), /хоча б одну/u);
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
  assert.notEqual(first, pdfExportDeduplicationKey({ ...base, renderMode: "rasterized" }));
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

test("rebuilds selected large-PDF pages sequentially without materializing the source", async () => {
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
    "base64",
  );
  const originalDocument = globalThis.document;
  const requestedPages: number[] = [];
  const cleanedPages: number[] = [];
  const pageSizes = new Map([
    [1, { width: 300, height: 400 }],
    [2, { width: 500, height: 600 }],
    [3, { width: 700, height: 800 }],
  ]);

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob([jpeg], { type: "image/jpeg" })),
      }),
    },
  });

  try {
    const fakeDocument = {
      numPages: 3,
      getPage: async (pageNumber: number) => {
        requestedPages.push(pageNumber);
        const size = pageSizes.get(pageNumber)!;
        return {
          getViewport: ({ scale }: { scale: number }) => ({
            width: size.width * scale,
            height: size.height * scale,
          }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
          cleanup: () => cleanedPages.push(pageNumber),
        };
      },
    };

    const output = await createRasterizedPdfSubsetBlob(fakeDocument as never, [1, 3], {
      ...DEFAULT_PDF_CLIENT_EXPORT_LIMITS,
      imageScale: 1,
    });
    const rebuilt = await PDFDocument.load(await output.arrayBuffer());

    assert.equal(output.type, "application/pdf");
    assert.deepEqual(requestedPages, [1, 3]);
    assert.deepEqual(cleanedPages, [1, 3]);
    assert.equal(rebuilt.getPageCount(), 2);
    assert.deepEqual(rebuilt.getPage(0).getSize(), pageSizes.get(1));
    assert.deepEqual(rebuilt.getPage(1).getSize(), pageSizes.get(3));
  } finally {
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
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
