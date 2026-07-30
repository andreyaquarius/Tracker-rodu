import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRecord } from "../src/types/index.ts";
import type { StoredDocumentSource } from "../src/services/document-sources/contracts.ts";
import type { FindingDocumentReference } from "../src/services/findingDocumentReferences.ts";
import {
  buildFindingDocumentReopenTarget,
  findingDocumentReopenLaunchMode,
  findingDocumentReopenTargetLabel,
  findingDocumentSelectionViewportRect,
  findingDocumentSourceVersionStatus,
  resolveFindingDocumentReopenTargets,
  selectFindingDocumentReopenTarget,
} from "../src/services/findingDocumentReopen.ts";

const document = documentRecord();
const source = storedSource();
const reference = findingReference();

test("reopen target points at the original PDF physical page and keeps normalized provenance", () => {
  const target = buildFindingDocumentReopenTarget(document, source, reference);

  assert.equal(target.viewer.scan.documentSourceId, "source-1");
  assert.equal(target.viewer.scan.initialPage, 25);
  assert.equal(target.viewer.pageIndex, 0, "viewer pageIndex is an attachment index, not a PDF page");
  assert.equal(target.restore.pageIndex, 25);
  assert.equal(target.restore.pageLabel, "XXV");
  assert.deepEqual(target.restore.selection, reference.selection);
  assert.notEqual(target.restore.selection, reference.selection, "reopen state must not mutate persisted provenance");
  assert.equal(target.source.versionStatus, "unchanged");
  assert.deepEqual(target.source.capturedFingerprint, { sha1: "version-1", contentLength: 4_096 });
  assert.deepEqual(target.source.currentFingerprint, { sha1: "version-1", contentLength: 4_096 });
  assert.equal(target.viewer.scan.storagePath, "https://upload.wikimedia.org/book.pdf");
  assert.equal(target.viewer.scan.webViewLink, "https://uk.wikisource.org/wiki/Page:Book.pdf/25");
  assert.equal("accessToken" in target.viewer.scan, false);
  assert.equal("accessUrl" in target.viewer.scan, false);
});

test("changed source keeps the old fingerprint and crop instead of rewriting either", () => {
  const changedSource = storedSource({
    fingerprint: { sha1: "version-2", contentLength: 4_120 },
    status: "changed",
  });
  const target = buildFindingDocumentReopenTarget(document, changedSource, reference);

  assert.equal(target.source.versionStatus, "changed");
  assert.deepEqual(target.source.capturedFingerprint, { sha1: "version-1", contentLength: 4_096 });
  assert.deepEqual(target.restore.selection, reference.selection);

  target.source.currentFingerprint.sha1 = "mutated-current";
  if (target.restore.selection) target.restore.selection.x = 0.8;
  assert.equal(reference.sourceFingerprint.sha1, "version-1");
  assert.equal(reference.selection?.x, 0.1);
});

test("restored selection materializes in the rotated viewport and remains zoom independent", () => {
  const target = buildFindingDocumentReopenTarget(document, source, reference);
  assertRectAlmostEqual(findingDocumentSelectionViewportRect(target, { width: 800, height: 600 }), {
    x: 440,
    y: 60,
    width: 200,
    height: 180,
  });
  assertRectAlmostEqual(findingDocumentSelectionViewportRect(target, { width: 1_600, height: 1_200 }), {
    x: 880,
    y: 120,
    width: 400,
    height: 360,
  });
});

test("resolver keeps valid references available while reporting broken references separately", async () => {
  const missingDocumentReference = findingReference({
    id: "reference-missing-document",
    documentId: "document-missing",
    documentSourceId: "source-missing-document",
  });
  const missingSourceReference = findingReference({
    id: "reference-missing-source",
    documentSourceId: "source-missing",
  });
  const result = await resolveFindingDocumentReopenTargets(
    "project-1",
    "finding-1",
    [document],
    {
      async listReferences(projectId, filters) {
        assert.equal(projectId, "project-1");
        assert.deepEqual(filters, { findingId: "finding-1" });
        return [reference, missingDocumentReference, missingSourceReference];
      },
      async getSource(_projectId, sourceId) {
        return sourceId === source.id ? source : null;
      },
    },
  );

  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]?.referenceId, "reference-1");
  assert.deepEqual(result.issues.map((value) => value.code), [
    "document_not_loaded",
    "source_not_found",
  ]);
});

test("resolver reports a legacy finding without PDF provenance instead of guessing from display text", async () => {
  const result = await resolveFindingDocumentReopenTargets(
    "project-1",
    "legacy-finding",
    [document],
    {
      async listReferences() { return []; },
      async getSource() { throw new Error("must not resolve a source without provenance"); },
    },
  );

  assert.deepEqual(result.targets, []);
  assert.equal(result.issues[0]?.code, "reference_not_found");
});

test("Drive reopen creates a stable file-id attachment and keeps the snapshot separate", () => {
  const driveSource = storedSource({
    provider: "google_drive",
    providerFileId: "drive-file-1",
    originalUrl: "https://drive.google.com/file/d/drive-file-1/view",
    canonicalUrl: undefined,
    sourcePageUrl: undefined,
    accessMode: "google_drive_api",
    fingerprint: {
      md5: "md5-1",
      revisionId: "revision-1",
      modifiedTime: "2026-07-30T09:00:00.000Z",
    },
  });
  const target = buildFindingDocumentReopenTarget(document, driveSource, findingReference({
    snapshot: {
      provider: "google_drive",
      fileId: "snapshot-1",
      url: "https://drive.google.com/file/d/snapshot-1/view",
      mimeType: "image/png",
    },
    sourceFingerprint: {
      md5: "md5-1",
      revisionId: "revision-1",
      modifiedTime: "2026-07-30T09:00:00.000Z",
    },
  }));

  assert.equal(target.viewer.scan.storage, "google-drive");
  assert.equal(target.viewer.scan.storagePath, "drive-file-1");
  assert.equal(target.viewer.scan.initialPage, 25);
  assert.equal(target.snapshot?.scan.storagePath, "snapshot-1");
  assert.notEqual(target.snapshot?.scan.id, target.viewer.scan.id);
});

test("an unavailable original uses a saved snapshot and otherwise fails explicitly", () => {
  const unavailable = storedSource({ status: "unavailable" });
  const withoutSnapshot = buildFindingDocumentReopenTarget(document, unavailable, reference);
  const withSnapshot = buildFindingDocumentReopenTarget(document, unavailable, findingReference({
    snapshot: {
      provider: "google_drive",
      fileId: "snapshot-1",
      url: "https://drive.google.com/file/d/snapshot-1/view",
      mimeType: "image/png",
    },
  }));

  assert.equal(findingDocumentReopenLaunchMode(withoutSnapshot), "unavailable");
  assert.equal(findingDocumentReopenLaunchMode(withSnapshot), "snapshot");
  assert.equal(findingDocumentReopenLaunchMode({
    ...withoutSnapshot,
    source: { ...withoutSnapshot.source, status: "needs_auth" },
  }), "source");
});

test("fingerprint comparison distinguishes unknown, unchanged and changed versions", () => {
  assert.equal(findingDocumentSourceVersionStatus({}, {}), "unknown");
  assert.equal(findingDocumentSourceVersionStatus({ etag: "v1" }, {}), "unknown");
  assert.equal(findingDocumentSourceVersionStatus({ etag: "v1" }, { etag: "v1" }), "unchanged");
  assert.equal(findingDocumentSourceVersionStatus({ etag: "v1" }, { etag: "v2" }), "changed");
  assert.equal(findingDocumentSourceVersionStatus({ etag: "v1" }, { etag: "v1" }, "changed"), "changed");
});

test("multi-reference prompt selection is one-based, strict and labels the physical page", () => {
  const first = buildFindingDocumentReopenTarget(document, source, reference);
  const second = buildFindingDocumentReopenTarget(
    document,
    source,
    findingReference({ id: "reference-2", pageIndex: 31, pageLabel: "31", selection: undefined }),
  );
  const targets = [first, second];

  assert.equal(findingDocumentReopenTargetLabel(first, 0), "1. Metric book — сторінка 25 (XXV)");
  assert.equal(findingDocumentReopenTargetLabel(second, 1), "2. Metric book — сторінка 31");
  assert.equal(selectFindingDocumentReopenTarget(targets, " 2 "), second);
  assert.equal(selectFindingDocumentReopenTarget(targets, "0"), null);
  assert.equal(selectFindingDocumentReopenTarget(targets, "2x"), null);
  assert.equal(selectFindingDocumentReopenTarget(targets, "3"), null);
});

function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "document-1",
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    researchId: "research-1",
    title: "Metric book",
    documentType: "metrical-book",
    archive: "Archive",
    fund: "Fund",
    description: "Description",
    file: "File 1",
    yearFrom: "1900",
    yearTo: "1901",
    place: "Kyiv",
    url: "",
    pagesCount: "100",
    lastPage: "",
    reviewStatus: "not-started",
    notes: "",
    scans: [],
    customFields: {},
    ...overrides,
  };
}

function storedSource(overrides: Partial<StoredDocumentSource> = {}): StoredDocumentSource {
  return {
    id: "source-1",
    documentId: "document-1",
    provider: "wikimedia",
    originalUrl: "https://uk.wikisource.org/wiki/Page:Book.pdf/25",
    canonicalUrl: "https://upload.wikimedia.org/book.pdf",
    sourcePageUrl: "https://uk.wikisource.org/wiki/Page:Book.pdf/25",
    providerFileTitle: "File:Book.pdf",
    displayName: "Book.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 4_096,
    pageCount: 100,
    initialPage: 25,
    accessMode: "direct_cors",
    fingerprint: { sha1: "version-1", contentLength: 4_096 },
    warnings: [],
    status: "active",
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    ...overrides,
  };
}

function findingReference(overrides: Partial<FindingDocumentReference> = {}): FindingDocumentReference {
  return {
    id: "reference-1",
    projectId: "project-1",
    findingId: "finding-1",
    documentId: "document-1",
    documentSourceId: "source-1",
    pageIndex: 25,
    pageLabel: "XXV",
    selection: {
      pageIndex: 25,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.25,
      rotation: 90,
      sourcePageWidthPt: 595.28,
      sourcePageHeightPt: 841.89,
    },
    sourceFingerprint: { sha1: "version-1", contentLength: 4_096 },
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

function assertRectAlmostEqual(
  actual: { x: number; y: number; width: number; height: number } | null,
  expected: { x: number; y: number; width: number; height: number },
): void {
  assert.ok(actual);
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
}
