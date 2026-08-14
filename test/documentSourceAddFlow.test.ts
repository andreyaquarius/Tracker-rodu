import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessContext,
  DocumentSourceAdapter,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  SourceValidationResult,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import { DocumentSourceAdapterRegistry } from "../src/services/document-sources/registry.ts";
import {
  attachmentFromResolvedDocumentSource,
  resolveDocumentSourceForAdd,
} from "../src/services/documentSourceAddFlow.ts";

test("add flow returns every validated candidate and keeps the document optional", async () => {
  let receivedDocumentId: string | undefined;
  let receivedSignal: AbortSignal | undefined;
  const registry = new DocumentSourceAdapterRegistry([fakeAdapter(async (_url, context) => {
    receivedDocumentId = context.documentId;
    receivedSignal = context.signal;
    return [source("first.pdf", 1), source("second.pdf", 2)];
  })]);
  const controller = new AbortController();

  const resolution = await resolveDocumentSourceForAdd(
    "https://archive.example.org/article",
    {
      userId: "user-1",
      projectId: "project-1",
      signal: controller.signal,
    },
    { registry, requestId: () => "request-fixed" },
  );

  assert.equal(receivedDocumentId, undefined);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(resolution.requestId, "request-fixed");
  assert.equal(resolution.provider, "direct_pdf");
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.source.displayName),
    ["first.pdf", "second.pdf"],
  );
  assert.notEqual(resolution.candidates[0]?.id, resolution.candidates[1]?.id);
});

test("validated source bridge preserves page, access, warning, and fingerprint metadata", () => {
  const resolved: ResolvedPdfSource = {
    ...source("register.pdf", 25),
    sourcePageUrl: "https://archive.example.org/register",
    canonicalUrl: "https://archive.example.org/register.pdf",
    providerFileTitle: "File:Register.pdf",
    fileSizeBytes: 55_000,
    pageCount: 800,
    accessMode: "secure_proxy",
    fingerprint: {
      etag: '"revision-9"',
      lastModified: "Wed, 30 Jul 2026 12:00:00 GMT",
      contentLength: 55_000,
    },
    warnings: ["Metadata warning"],
  };

  const attachment = attachmentFromResolvedDocumentSource(resolved);
  assert.equal(attachment.storage, "external-url");
  assert.equal(attachment.storagePath, resolved.sourcePageUrl);
  assert.equal(attachment.canonicalSourceUrl, resolved.canonicalUrl);
  assert.equal(attachment.initialPage, 25);
  assert.equal(attachment.sourcePageCount, 800);
  assert.equal(attachment.sourceAccessMode, "secure_proxy");
  assert.ok(Number.isFinite(Date.parse(attachment.sourceValidatedAt ?? "")));
  assert.deepEqual(attachment.sourceWarnings, ["Metadata warning"]);
  assert.deepEqual(attachment.sourceFingerprint, resolved.fingerprint);
});

function source(name: string, initialPage: number): ResolvedPdfSource {
  return {
    provider: "direct_pdf",
    originalUrl: `https://archive.example.org/${name}`,
    canonicalUrl: `https://archive.example.org/${name}`,
    displayName: name,
    mimeType: "application/pdf",
    initialPage,
    accessMode: "direct_cors",
    fingerprint: {},
    warnings: [],
  };
}

function fakeAdapter(
  resolveCandidates: NonNullable<DocumentSourceAdapter["resolveCandidates"]>,
): DocumentSourceAdapter {
  return {
    provider: "direct_pdf",
    canHandle: () => true,
    resolve: async (url, context) => (await resolveCandidates(url, context))[0]!,
    resolveCandidates,
    createAccessDescriptor: async (stored: StoredDocumentSource): Promise<PdfAccessDescriptor> => ({
      accessMode: "direct_cors",
      url: stored.canonicalUrl ?? stored.originalUrl,
      expiresAt: null,
      fingerprint: stored.fingerprint,
    }),
    revalidate: async (
      stored: StoredDocumentSource,
      _context: AccessContext,
    ): Promise<SourceValidationResult> => ({
      status: "unchanged",
      oldFingerprint: stored.fingerprint,
      newFingerprint: stored.fingerprint,
      resolvedMetadata: {
        canonicalUrl: stored.canonicalUrl ?? stored.originalUrl,
        providerHost: stored.providerHost ?? "archive.example",
        ...(stored.fileSizeBytes !== undefined ? { fileSizeBytes: stored.fileSizeBytes } : {}),
        ...(stored.pageCount !== undefined ? { pageCount: stored.pageCount } : {}),
        accessMode: stored.accessMode,
      },
      validatedAt: "2026-07-30T12:00:00.000Z",
    }),
  };
}
