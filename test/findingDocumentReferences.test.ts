import assert from "node:assert/strict";
import test from "node:test";
import {
  FindingDocumentReferenceValidationError,
  createFindingDocumentReferenceService,
  normalizeFindingPageSelection,
  type FindingDocumentReferenceStore,
} from "../src/services/findingDocumentReferences.ts";

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "reference-1",
    project_id: "project-1",
    finding_id: "finding-1",
    document_id: "document-1",
    document_source_id: "source-1",
    page_index: 7,
    page_label: "VII",
    selection: null,
    source_fingerprint: { sha1: "source-version", contentLength: 4096 },
    snapshot_provider: null,
    snapshot_file_id: null,
    snapshot_url: null,
    snapshot_mime_type: null,
    created_at: "2026-07-30T10:00:00.000Z",
    updated_at: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

test("normalizes a one-based, zoom-independent crop and preserves PDF page dimensions", () => {
  assert.deepEqual(normalizeFindingPageSelection({
    pageIndex: 12,
    x: 0.123456789,
    y: 0.2,
    width: 0.5,
    height: 0.4,
    rotation: 270,
    sourcePageWidthPt: 595.28,
    sourcePageHeightPt: 841.89,
  }), {
    pageIndex: 12,
    x: 0.12345679,
    y: 0.2,
    width: 0.5,
    height: 0.4,
    rotation: 270,
    sourcePageWidthPt: 595.28,
    sourcePageHeightPt: 841.89,
  });
});

test("rejects zero-based pages, cross-page crops, unsupported rotations and out-of-page rectangles", () => {
  assert.throws(
    () => normalizeFindingPageSelection({
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
    }),
    (error) => error instanceof FindingDocumentReferenceValidationError
      && error.code === "INVALID_PAGE_INDEX",
  );

  assert.throws(
    () => normalizeFindingPageSelection({
      pageIndex: 2,
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.5,
      rotation: 0,
    }, 3),
    (error) => error instanceof FindingDocumentReferenceValidationError
      && error.code === "INVALID_SELECTION",
  );

  assert.throws(
    () => normalizeFindingPageSelection({
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.5,
      rotation: 45,
    }),
    /0, 90, 180 або 270/u,
  );

  assert.throws(
    () => normalizeFindingPageSelection({
      pageIndex: 1,
      x: 0.8,
      y: 0.2,
      width: 0.3,
      height: 0.5,
      rotation: 0,
    }),
    /межі сторінки/u,
  );
});

test("create captures immutable provenance metadata and project scope without storing access URLs", async () => {
  let inserted: Record<string, unknown> | null = null;
  const store = {
    async list() { return []; },
    async get() { return null; },
    async insert(row: Record<string, unknown>) {
      inserted = structuredClone(row);
      return storedRow({
        ...row,
        id: "reference-created",
        created_at: "2026-07-30T10:00:00.000Z",
        updated_at: "2026-07-30T10:00:00.000Z",
      });
    },
    async update() { throw new Error("unexpected update"); },
    async remove() { throw new Error("unexpected remove"); },
  } as unknown as FindingDocumentReferenceStore;
  const service = createFindingDocumentReferenceService(store);
  const fingerprint = { sha1: "version-7", contentLength: 123_456 };

  const created = await service.create(" project-1 ", {
    findingId: "finding-1",
    documentId: "document-1",
    documentSourceId: "source-1",
    pageIndex: 7,
    pageLabel: " VII ",
    selection: {
      pageIndex: 7,
      x: 0.1,
      y: 0.15,
      width: 0.4,
      height: 0.5,
      rotation: 90,
    },
    sourceFingerprint: fingerprint,
    snapshot: {
      provider: "google_drive",
      fileId: "drive-snapshot-1",
      url: "https://drive.google.com/file/d/drive-snapshot-1/view#preview",
      mimeType: "image/png",
    },
  });
  fingerprint.sha1 = "mutated-after-save";

  assert.equal(inserted?.project_id, "project-1");
  assert.deepEqual(inserted?.source_fingerprint, {
    sha1: "version-7",
    contentLength: 123_456,
  });
  assert.deepEqual(inserted?.selection, {
    pageIndex: 7,
    x: 0.1,
    y: 0.15,
    width: 0.4,
    height: 0.5,
    rotation: 90,
  });
  assert.equal(inserted?.page_label, "VII");
  assert.equal(inserted?.snapshot_provider, "google_drive");
  assert.equal(inserted?.snapshot_file_id, "drive-snapshot-1");
  assert.equal(inserted?.snapshot_url, "https://drive.google.com/file/d/drive-snapshot-1/view");
  assert.equal(created.sourceFingerprint.sha1, "version-7");
  assert.equal(created.snapshot?.provider, "google_drive");
});

test("snapshot provenance rejects signed or tokenized URLs instead of persisting a scrubbed URL", async () => {
  const store = {
    async list() { return []; },
    async get() { return null; },
    async insert() { throw new Error("must not insert invalid provenance"); },
    async update() { throw new Error("unexpected update"); },
    async remove() { throw new Error("unexpected remove"); },
  } as unknown as FindingDocumentReferenceStore;
  const service = createFindingDocumentReferenceService(store);

  await assert.rejects(
    service.create("project-1", {
      findingId: "finding-1",
      documentId: "document-1",
      documentSourceId: "source-1",
      pageIndex: 1,
      sourceFingerprint: {},
      snapshot: {
        provider: "external",
        url: "https://files.example.org/crop.png?access_token=secret",
        mimeType: "image/png",
      },
    }),
    (error) => error instanceof FindingDocumentReferenceValidationError
      && error.code === "INVALID_SNAPSHOT",
  );
});

test("list, get, update, save and delete always forward the explicit project scope", async () => {
  const calls: Array<{ operation: string; projectId: string; id?: string; value?: unknown }> = [];
  const store = {
    async list(projectId: string, filters: unknown) {
      calls.push({ operation: "list", projectId, value: filters });
      return [storedRow()];
    },
    async get(projectId: string, id: string) {
      calls.push({ operation: "get", projectId, id });
      return storedRow({ id });
    },
    async insert(row: Record<string, unknown>) {
      calls.push({ operation: "insert", projectId: String(row.project_id), value: row });
      return storedRow({ ...row, id: "new-reference" });
    },
    async update(projectId: string, id: string, patch: unknown) {
      calls.push({ operation: "update", projectId, id, value: patch });
      return storedRow({ id, project_id: projectId, ...(patch as object) });
    },
    async remove(projectId: string, id: string) {
      calls.push({ operation: "remove", projectId, id });
    },
  } as unknown as FindingDocumentReferenceStore;
  const service = createFindingDocumentReferenceService(store);

  await service.list("project-1", { findingId: "finding-1" });
  await service.get("project-1", "reference-1");
  await service.update("project-1", {
    id: "reference-1",
    pageIndex: 8,
    selection: null,
    snapshot: null,
  });
  const save = service.save;
  await save("project-1", {
    findingId: "finding-2",
    documentId: "document-1",
    documentSourceId: "source-1",
    pageIndex: 9,
    sourceFingerprint: { etag: "v9" },
  });
  await service.remove("project-1", "reference-1");

  assert.deepEqual(calls.map(({ operation, projectId }) => ({ operation, projectId })), [
    { operation: "list", projectId: "project-1" },
    { operation: "get", projectId: "project-1" },
    { operation: "update", projectId: "project-1" },
    { operation: "insert", projectId: "project-1" },
    { operation: "remove", projectId: "project-1" },
  ]);
  assert.deepEqual(calls[0]?.value, { findingId: "finding-1" });
  assert.deepEqual(calls[2]?.value, {
    page_index: 8,
    selection: null,
    snapshot_provider: null,
    snapshot_file_id: null,
    snapshot_url: null,
    snapshot_mime_type: null,
  });
  assert.equal("source_fingerprint" in (calls[2]?.value as object), false);
});

test("a crop cannot be updated without an explicit page index", async () => {
  const store = {
    async list() { return []; },
    async get() { return null; },
    async insert() { throw new Error("unexpected insert"); },
    async update() { throw new Error("must validate before update"); },
    async remove() { throw new Error("unexpected remove"); },
  } as unknown as FindingDocumentReferenceStore;
  const service = createFindingDocumentReferenceService(store);

  await assert.rejects(
    service.update("project-1", {
      id: "reference-1",
      selection: null,
    }),
    (error) => error instanceof FindingDocumentReferenceValidationError
      && error.code === "INVALID_SELECTION",
  );
});
