import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessContext,
  DocumentSourceAdapter,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import {
  DocumentSourceAdapterRegistry,
  DocumentSourceError,
} from "../src/services/document-sources/index.ts";

test("registry routes resolve/access/revalidate and only gives adapters persistence-safe URLs", async () => {
  let resolvedInput = "";
  const adapter: DocumentSourceAdapter = {
    provider: "wikimedia",
    canHandle: (url) => new URL(url).hostname.endsWith("wikisource.org"),
    resolve: async (url): Promise<ResolvedPdfSource> => {
      resolvedInput = url;
      return {
        provider: "wikimedia",
        originalUrl: "https://should-not-be-used.invalid/?token=secret",
        canonicalUrl: "https://upload.wikimedia.org/archive.pdf?token=ephemeral&id=public",
        sourcePageUrl: "https://uk.wikisource.org/wiki/File:Archive.pdf#details",
        displayName: "Archive.pdf",
        mimeType: "application/pdf",
        accessMode: "direct_cors",
        fingerprint: { sha1: "abc" },
        warnings: [],
      };
    },
    createAccessDescriptor: async (source) => ({
      accessMode: "direct_cors",
      url: source.canonicalUrl ?? source.originalUrl,
      expiresAt: null,
      fingerprint: source.fingerprint,
    }),
    revalidate: async (source) => ({
      status: "unchanged",
      oldFingerprint: source.fingerprint,
      newFingerprint: source.fingerprint,
      resolvedMetadata: {
        canonicalUrl: source.canonicalUrl ?? source.originalUrl,
        providerHost: source.providerHost ?? "uk.wikisource.org",
        ...(source.fileSizeBytes !== undefined ? { fileSizeBytes: source.fileSizeBytes } : {}),
        ...(source.pageCount !== undefined ? { pageCount: source.pageCount } : {}),
        accessMode: source.accessMode,
      },
      validatedAt: "2026-07-30T00:00:00.000Z",
    }),
  };
  const registry = new DocumentSourceAdapterRegistry([adapter]);
  const context = requestContext();
  const resolved = await registry.resolve(
    "https://uk.wikisource.org/wiki/File:Archive.pdf?title=public#fragment",
    context,
  );

  assert.equal(resolvedInput, "https://uk.wikisource.org/wiki/File:Archive.pdf?title=public");
  assert.equal(resolved.originalUrl, resolvedInput);
  assert.equal(resolved.canonicalUrl, "https://upload.wikimedia.org/archive.pdf?id=public");
  assert.equal(resolved.sourcePageUrl, "https://uk.wikisource.org/wiki/File:Archive.pdf");
  assert.deepEqual(registry.providers(), ["wikimedia"]);

  const stored = storedSource(resolved);
  assert.equal((await registry.createAccessDescriptor(stored, context)).accessMode, "direct_cors");
  assert.equal((await registry.revalidate(stored, context)).status, "unchanged");
});

test("registry rejects signed or tokenized URLs instead of persisting a stripped broken link", () => {
  const registry = new DocumentSourceAdapterRegistry([{
    ...inertAdapter(),
    canHandle: () => true,
  }]);
  assert.throws(
    () => registry.inspect("https://archive.example.org/file.pdf?X-Amz-Signature=secret&X-Amz-Expires=60"),
    (error) => error instanceof DocumentSourceError && error.code === "SENSITIVE_URL_NOT_PERSISTABLE",
  );
});

test("registry rejects duplicate and unsupported adapters with stable errors", () => {
  const adapter = inertAdapter();
  const registry = new DocumentSourceAdapterRegistry([adapter]);
  assert.throws(() => registry.register(adapter), /already registered/u);
  assert.throws(
    () => registry.inspect("https://example.org/archive.pdf"),
    (error) => error instanceof DocumentSourceError && error.code === "UNSUPPORTED_PROVIDER",
  );
});

test("registry rejects a non-PDF adapter result", async () => {
  const adapter: DocumentSourceAdapter = {
    ...inertAdapter(),
    canHandle: () => true,
    resolve: async (url) => ({
      provider: "wikimedia",
      originalUrl: url,
      mimeType: "image/jpeg" as "application/pdf",
      accessMode: "direct_cors",
      fingerprint: {},
      warnings: [],
    }),
  };

  await assert.rejects(
    new DocumentSourceAdapterRegistry([adapter]).resolve("https://example.org/not-a-pdf", requestContext()),
    (error) => error instanceof DocumentSourceError && error.code === "SOURCE_NOT_PDF",
  );
});

function inertAdapter(): DocumentSourceAdapter {
  return {
    provider: "wikimedia",
    canHandle: () => false,
    resolve: async () => {
      throw new Error("not used");
    },
    createAccessDescriptor: async () => {
      throw new Error("not used");
    },
    revalidate: async () => {
      throw new Error("not used");
    },
  };
}

function requestContext(): AccessContext {
  return {
    userId: "user-1",
    projectId: "project-1",
    documentId: "document-1",
    requestId: "request-1",
  };
}

function storedSource(source: ResolvedPdfSource): StoredDocumentSource {
  return {
    ...source,
    id: "source-1",
    documentId: "document-1",
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}
