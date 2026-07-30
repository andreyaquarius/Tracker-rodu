import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import { migrateLegacyDocumentSource } from "../src/services/documentSourceLegacyMigration.ts";
import type { ScanAttachment } from "../src/types/index.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const context = {
  projectId,
  documentId,
  userId: "33333333-3333-4333-8333-333333333333",
};

const attachment: ScanAttachment = {
  id: "legacy-scan",
  name: "archive.pdf",
  mimeType: "application/pdf",
  size: 1_024,
  createdAt: "2026-07-30T08:00:00.000Z",
  storage: "external-url",
  storagePath: "https://archive.example/archive.pdf",
  webViewLink: "https://archive.example/archive.pdf",
  deleteOnRemove: false,
};

const resolved: ResolvedPdfSource = {
  provider: "direct_pdf",
  originalUrl: attachment.storagePath,
  canonicalUrl: attachment.storagePath,
  providerHost: "archive.example",
  displayName: attachment.name,
  mimeType: "application/pdf",
  fileSizeBytes: attachment.size,
  accessMode: "secure_proxy",
  fingerprint: { etag: "validated", contentLength: attachment.size },
  warnings: [],
};

function stored(id = "44444444-4444-4444-8444-444444444444"): StoredDocumentSource {
  return {
    id,
    documentId,
    ...resolved,
    status: "active",
    lastValidatedAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T09:00:00.000Z",
    updatedAt: "2026-07-30T09:00:00.000Z",
  };
}

test("legacy migration persists only metadata returned by the validated resolver", async () => {
  let savedInput: unknown;
  const result = await migrateLegacyDocumentSource(
    { projectId, documentId, attachment },
    { resolve: async () => resolved },
    context,
    {
      listDocumentSources: async () => [],
      saveDocumentSource: async (_projectId, input) => {
        savedInput = input;
        return stored();
      },
    },
  );

  assert.equal(result?.fingerprint.etag, "validated");
  assert.equal((savedInput as { documentId: string }).documentId, documentId);
  assert.equal("accessUrl" in (savedInput as object), false);
  assert.equal("httpHeaders" in (savedInput as object), false);
});

test("legacy migration reuses the row created by a concurrent tab", async () => {
  const existing = stored("55555555-5555-4555-8555-555555555555");
  const result = await migrateLegacyDocumentSource(
    { projectId, documentId, attachment },
    { resolve: async () => resolved },
    context,
    {
      saveDocumentSource: async () => { throw new Error("duplicate"); },
      listDocumentSources: async () => [existing],
    },
  );
  assert.equal(result?.id, existing.id);
});

test("legacy migration fails open without persisting an unverified projection", async () => {
  let writes = 0;
  const result = await migrateLegacyDocumentSource(
    { projectId, documentId, attachment },
    { resolve: async () => { throw new Error("provider unavailable"); } },
    context,
    {
      saveDocumentSource: async () => {
        writes += 1;
        return stored();
      },
      listDocumentSources: async () => [],
    },
  );
  assert.equal(result, null);
  assert.equal(writes, 0);
});

test("aborting lazy migration propagates cancellation instead of silently falling back", async () => {
  const controller = new AbortController();
  controller.abort("viewer closed");
  await assert.rejects(() => migrateLegacyDocumentSource(
    { projectId, documentId, attachment, signal: controller.signal },
    { resolve: async () => { throw new Error("cancelled"); } },
    { ...context, signal: controller.signal },
    {
      saveDocumentSource: async () => stored(),
      listDocumentSources: async () => [],
    },
  ), /cancelled/u);
});

test("non-PDF legacy attachments are not migrated", async () => {
  let resolverCalls = 0;
  const result = await migrateLegacyDocumentSource(
    {
      projectId,
      documentId,
      attachment: { ...attachment, mimeType: "image/jpeg", name: "scan.jpg" },
    },
    {
      resolve: async () => {
        resolverCalls += 1;
        return resolved;
      },
    },
    context,
    {
      saveDocumentSource: async () => stored(),
      listDocumentSources: async () => [],
    },
  );
  assert.equal(result, null);
  assert.equal(resolverCalls, 0);
});
