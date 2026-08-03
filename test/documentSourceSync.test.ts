import assert from "node:assert/strict";
import test from "node:test";
import {
  documentSourceFromAttachment,
  findDocumentSourceForAttachment,
  isExternalPdfViewerV2Enabled,
  syncDocumentSourcesForDocument,
} from "../src/services/documentSourceSync.ts";
import type { DocumentRecord, ScanAttachment } from "../src/types/index.ts";
import type { StoredDocumentSource } from "../src/services/document-sources/contracts.ts";

function attachment(overrides: Partial<ScanAttachment> = {}): ScanAttachment {
  return {
    id: "scan-1",
    name: "book.pdf",
    mimeType: "application/pdf",
    size: 1234,
    createdAt: "2026-07-30T10:00:00.000Z",
    storage: "external-url",
    storagePath: "https://example.org/book.pdf",
    webViewLink: "https://example.org/book.pdf",
    ...overrides,
  };
}

test("external PDF viewer v2 is enabled only by the exact feature flag", () => {
  assert.equal(isExternalPdfViewerV2Enabled({ external_pdf_viewer_v2: true }), true);
  assert.equal(isExternalPdfViewerV2Enabled({ external_pdf_viewer_v2: false }), false);
  assert.equal(isExternalPdfViewerV2Enabled({}), false);
});

test("legacy Wikimedia attachment becomes stable registry metadata", () => {
  const source = documentSourceFromAttachment("document-1", attachment({
    storagePath: "https://uk.wikisource.org/wiki/Page:Book.pdf/25",
    webViewLink: "https://uk.wikisource.org/wiki/Page:Book.pdf/25",
    sourceProvider: "wikimedia",
    sourcePageUrl: "https://uk.wikisource.org/wiki/Page:Book.pdf/25",
    canonicalSourceUrl: "https://upload.wikimedia.org/book.pdf",
    providerFileTitle: "File:Book.pdf",
    initialPage: 25,
    sourceFingerprint: { sha1: "abc", contentLength: 1234 },
  }));

  assert.ok(source);
  assert.equal(source.provider, "wikimedia");
  assert.equal(source.documentId, "document-1");
  assert.equal(source.initialPage, 25);
  assert.equal(source.accessMode, "direct_cors");
  assert.deepEqual(source.fingerprint, { sha1: "abc", contentLength: 1234 });
});

test("Drive PDF keeps only a stable file page and non-secret fingerprint", () => {
  const source = documentSourceFromAttachment("document-1", attachment({
    storage: "google-drive",
    storagePath: "drive-file-id",
    webViewLink: "https://drive.google.com/file/d/drive-file-id/view?resourcekey=secret",
    driveMd5Checksum: "md5",
    driveRevisionId: "revision",
    driveModifiedTime: "2026-07-30T09:00:00.000Z",
  }));

  assert.ok(source);
  assert.equal(source.provider, "google_drive");
  assert.equal(source.originalUrl, "https://drive.google.com/file/d/drive-file-id/view");
  assert.equal(source.providerFileId, "drive-file-id");
  assert.equal(source.accessMode, "google_drive_api");
  assert.deepEqual(source.fingerprint, {
    md5: "md5",
    revisionId: "revision",
    modifiedTime: "2026-07-30T09:00:00.000Z",
    contentLength: 1234,
  });
});

test("secret-bearing legacy URL is never projected into document_sources", () => {
  assert.equal(documentSourceFromAttachment("document-1", attachment({
    storagePath: "https://example.org/book.pdf?token=private",
    webViewLink: "https://example.org/book.pdf?token=private",
  })), null);
});

test("attachment resolves a stored source by explicit id or stable identity", () => {
  const source: StoredDocumentSource = {
    id: "source-1",
    documentId: "document-1",
    provider: "direct_pdf",
    originalUrl: "https://example.org/book.pdf",
    mimeType: "application/pdf",
    accessMode: "secure_proxy",
    fingerprint: {},
    warnings: [],
    status: "active",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  };

  assert.equal(findDocumentSourceForAttachment([source], attachment())?.id, "source-1");
  assert.equal(findDocumentSourceForAttachment([source], attachment({
    documentSourceId: "source-1",
    storagePath: "https://elsewhere.example/book.pdf",
  }))?.id, "source-1");
});

test("sync keeps an existing validated source authoritative over stale attachment metadata", async () => {
  const existing: StoredDocumentSource = {
    id: "source-confirmed",
    documentId: "document-1",
    provider: "direct_pdf",
    originalUrl: "https://example.org/book.pdf",
    canonicalUrl: "https://example.org/book.pdf",
    displayName: "confirmed.pdf",
    mimeType: "application/pdf",
    pageCount: 99,
    accessMode: "secure_proxy",
    fingerprint: { etag: '"confirmed"', contentLength: 9999 },
    warnings: ["confirmed metadata"],
    status: "changed",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T11:00:00.000Z",
  };
  let saveCalls = 0;
  const result = await syncDocumentSourcesForDocument(
    "project-1",
    {
      id: "document-1",
      scans: [attachment({
        documentSourceId: existing.id,
        name: "stale.pdf",
        size: 1234,
        sourcePageCount: 2,
        sourceFingerprint: { etag: '"stale"' },
      })],
    } as DocumentRecord,
    {
      listDocumentSources: async () => [existing],
      saveDocumentSource: async () => {
        saveCalls += 1;
        throw new Error("existing source must not be overwritten");
      },
    },
  );

  assert.equal(saveCalls, 0);
  assert.deepEqual(result.sources, [existing]);
  assert.deepEqual(result.failures, []);
});

test("sync resolves missing legacy metadata before it can enter document_sources", async () => {
  const stale = attachment({
    name: "stale-name.pdf",
    size: 1234,
    sourceFingerprint: { etag: '"unverified"' },
  });
  let savedInput: unknown;
  let resolvedContext: unknown;
  const result = await syncDocumentSourcesForDocument(
    "project-1",
    { id: "document-1", scans: [stale] } as DocumentRecord,
    {
      listDocumentSources: async () => [],
      saveDocumentSource: async (_projectId, input) => {
        savedInput = input;
        return {
          id: "source-validated",
          ...input,
          status: "active",
          createdAt: "2026-08-03T09:00:00.000Z",
          updatedAt: "2026-08-03T09:00:00.000Z",
        };
      },
    },
    {
      userId: "user-1",
      now: () => new Date("2026-08-03T09:00:00.000Z"),
      resolveSource: async (_url, context) => {
        resolvedContext = context;
        return {
          provider: "direct_pdf",
          requestId: "request-1",
          candidates: [{
            id: "validated",
            source: {
              provider: "direct_pdf",
              originalUrl: stale.storagePath,
              canonicalUrl: "https://cdn.example.org/validated.pdf",
              providerHost: "cdn.example.org",
              displayName: "validated.pdf",
              mimeType: "application/pdf",
              fileSizeBytes: 5678,
              accessMode: "secure_proxy",
              fingerprint: { etag: '"validated"', contentLength: 5678 },
              warnings: [],
            },
          }],
        };
      },
    },
  );

  assert.equal(result.failures.length, 0);
  assert.equal(result.sources[0]?.id, "source-validated");
  assert.deepEqual(resolvedContext, {
    userId: "user-1",
    projectId: "project-1",
    documentId: "document-1",
  });
  assert.deepEqual(savedInput, {
    provider: "direct_pdf",
    originalUrl: stale.storagePath,
    canonicalUrl: "https://cdn.example.org/validated.pdf",
    providerHost: "cdn.example.org",
    displayName: "validated.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 5678,
    accessMode: "secure_proxy",
    fingerprint: { etag: '"validated"', contentLength: 5678 },
    warnings: [],
    documentId: "document-1",
    lastValidatedAt: "2026-08-03T09:00:00.000Z",
  });
});

test("sync fails open to the legacy viewer when resolver validation fails", async () => {
  let saveCalls = 0;
  const result = await syncDocumentSourcesForDocument(
    "project-1",
    { id: "document-1", scans: [attachment()] } as DocumentRecord,
    {
      listDocumentSources: async () => [],
      saveDocumentSource: async () => {
        saveCalls += 1;
        throw new Error("unverified metadata must not be saved");
      },
    },
    {
      userId: "user-1",
      resolveSource: async () => {
        throw new Error("temporary upstream failure");
      },
    },
  );

  assert.equal(saveCalls, 0);
  assert.deepEqual(result.sources, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.attachmentId, "scan-1");
});
