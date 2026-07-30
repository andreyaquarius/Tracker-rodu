import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessContext,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import {
  createDefaultDocumentSourceRegistry,
  DirectPdfSourceAdapter,
  DocumentSourceError,
  WikimediaPdfSourceAdapter,
} from "../src/services/document-sources/index.ts";
import type {
  DirectPdfGatewayProbe,
  DocumentSourceGatewayClient,
} from "../src/services/document-sources/gatewayClient.ts";

test("default registry keeps specific providers ahead of the generic direct-PDF adapter", () => {
  const registry = createDefaultDocumentSourceRegistry({ fetch: unusedFetch });
  assert.deepEqual(registry.providers(), ["wikimedia", "google_drive", "direct_pdf"]);
  assert.equal(
    registry.inspect("https://upload.wikimedia.org/wikipedia/commons/a/a3/book.pdf").provider,
    "wikimedia",
  );
  assert.equal(registry.inspect("https://archive.example.org/book.pdf").provider, "direct_pdf");
  assert.equal(
    registry.inspect("https://drive.google.com/file/d/1AbCdef_ghijklmnopQRstuV/view").provider,
    "google_drive",
  );
});

test("Wikimedia Page URL resolves the Commons PDF and preserves initialPage", async () => {
  const requests: URL[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.origin === "https://uk.wikisource.org") {
      return jsonResponse({ query: { pages: [{ title: "File:Book.pdf", missing: true }] } });
    }
    return jsonResponse({
      query: {
        pages: [{
          title: "File:Book.pdf",
          imageinfo: [{
            url: "https://upload.wikimedia.org/wikipedia/commons/a/a3/Book.pdf",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
            mime: "application/pdf",
            size: 987_654,
            pagecount: 400,
            sha1: "sha-one",
            timestamp: "2026-07-30T09:30:00Z",
          }],
        }],
      },
    });
  };
  const adapter = new WikimediaPdfSourceAdapter({ fetch: fetchMock });
  const input = "https://uk.wikisource.org/wiki/Page:Book.pdf/25";

  const source = await adapter.resolve(input, context());

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.origin, "https://uk.wikisource.org");
  assert.equal(requests[1]?.origin, "https://commons.wikimedia.org");
  assert.equal(requests[1]?.searchParams.get("titles"), "File:Book.pdf");
  assert.equal(source.provider, "wikimedia");
  assert.equal(source.canonicalUrl, "https://upload.wikimedia.org/wikipedia/commons/a/a3/Book.pdf");
  assert.equal(source.sourcePageUrl, "https://commons.wikimedia.org/wiki/File:Book.pdf");
  assert.equal(source.providerFileTitle, "File:Book.pdf");
  assert.equal(source.initialPage, 25);
  assert.equal(source.pageCount, 400);
  assert.deepEqual(source.fingerprint, {
    sha1: "sha-one",
    lastModified: "2026-07-30T09:30:00Z",
    contentLength: 987_654,
  });

  const descriptor = await adapter.createAccessDescriptor(storedSource(source), context());
  assert.equal(descriptor.accessMode, "direct_cors");
  assert.equal(descriptor.initialPage, 25);
});

test("ordinary Wikisource article returns all PDF candidates and ignores cover images", async () => {
  const adapter = new WikimediaPdfSourceAdapter({
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("generator"), "images");
      assert.equal(url.searchParams.get("titles"), "Archive register");
      return jsonResponse({
        query: {
          pages: [
            {
              title: "File:Register A.pdf",
              imageinfo: [{
                url: "https://upload.wikimedia.org/a/Register_A.pdf",
                descriptionurl: "https://commons.wikimedia.org/wiki/File:Register_A.pdf",
                mime: "application/pdf",
                size: 100,
                pagecount: 10,
              }],
            },
            {
              title: "File:Register B.pdf",
              imageinfo: [{
                url: "https://upload.wikimedia.org/b/Register_B.pdf",
                descriptionurl: "https://commons.wikimedia.org/wiki/File:Register_B.pdf",
                mime: "application/pdf",
                size: 200,
                pagecount: 20,
              }],
            },
            {
              title: "File:Cover.jpg",
              imageinfo: [{
                url: "https://upload.wikimedia.org/c/Cover.jpg",
                mime: "image/jpeg",
                size: 300,
              }],
            },
          ],
        },
      });
    },
  });

  const candidates = await adapter.resolveCandidates(
    "https://en.wikisource.org/wiki/Archive_register",
    context(),
  );

  assert.deepEqual(candidates.map((candidate) => candidate.providerFileTitle), [
    "File:Register A.pdf",
    "File:Register B.pdf",
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.pageCount), [10, 20]);
  await assert.rejects(
    adapter.resolve("https://en.wikisource.org/wiki/Archive_register", context()),
    (error) => error instanceof DocumentSourceError && error.code === "MULTIPLE_SOURCE_CANDIDATES",
  );
});

test("direct Wikimedia upload validates PDF bytes instead of relying on an extension", async () => {
  const adapter = new WikimediaPdfSourceAdapter({ fetch: pdfProbeFetch() });
  const source = await adapter.resolve(
    "https://upload.wikimedia.org/wikipedia/commons/a/a3/Book.pdf",
    context(),
  );

  assert.equal(source.provider, "wikimedia");
  assert.equal(source.accessMode, "direct_cors");
  assert.equal(source.displayName, "Book.pdf");
  assert.equal(source.fileSizeBytes, 9000);
});

test("Wikimedia API metadata with a fake PDF extension still requires valid magic bytes", async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).includes("/w/api.php")) {
      return jsonResponse({
        query: {
          pages: [{
            title: "File:Fake.pdf",
            imageinfo: [{
              url: "https://upload.wikimedia.org/wikipedia/commons/f/f0/Fake.pdf",
              mime: "text/html",
            }],
          }],
        },
      });
    }
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("<!doc", { status: 206, headers: { "Content-Type": "text/html" } });
  };
  const adapter = new WikimediaPdfSourceAdapter({ fetch: fetchMock });

  await assert.rejects(
    adapter.resolve("https://commons.wikimedia.org/wiki/File:Fake.pdf", context()),
    (error) => error instanceof DocumentSourceError && error.code === "SOURCE_NOT_PDF",
  );
});

test("direct PDF adapter verifies range signature and carries ?page into viewer access", async () => {
  const adapter = new DirectPdfSourceAdapter({ fetch: pdfProbeFetch() });
  const source = await adapter.resolve("https://archive.example.org/scan.pdf?page=12", context());

  assert.equal(source.accessMode, "direct_cors");
  assert.equal(source.initialPage, 12);
  assert.equal(source.fileSizeBytes, 9000);
  assert.equal(source.fingerprint.etag, '"revision-7"');
  assert.deepEqual(source.warnings, []);

  const descriptor = await adapter.createAccessDescriptor(storedSource(source), context());
  assert.equal(descriptor.initialPage, 12);
  assert.equal(descriptor.expiresAt, null);
});

test("direct PDF adapter falls back to the gateway when browser CORS fails", async () => {
  const gateway = new FakeGateway();
  const fetchMock: typeof fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const adapter = new DirectPdfSourceAdapter({ fetch: fetchMock, gateway });
  const source = await adapter.resolve("https://archive.example.org/scan.pdf?page=8", context());

  assert.equal(gateway.probedUrl, "https://archive.example.org/scan.pdf?page=8");
  assert.equal(source.accessMode, "secure_proxy");
  assert.equal(source.initialPage, 8);

  const descriptor = await adapter.createAccessDescriptor(storedSource(source), context());
  assert.equal(gateway.accessRequests, 1);
  assert.equal(descriptor.accessMode, "secure_proxy");
  assert.equal(descriptor.initialPage, 8);
});

test("direct PDF adapter rejects HTML or a fake .pdf without the PDF signature", async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("<!doc", { status: 206, headers: { "Content-Type": "text/html" } });
  };
  const adapter = new DirectPdfSourceAdapter({ fetch: fetchMock });

  await assert.rejects(
    adapter.resolve("https://archive.example.org/fake.pdf", context()),
    (error) => error instanceof DocumentSourceError && error.code === "SOURCE_NOT_PDF",
  );
});

test("adapter revalidation reports a changed external fingerprint without overwriting it", async () => {
  const adapter = new DirectPdfSourceAdapter({
    fetch: pdfProbeFetch(),
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });
  const current = storedSource({
    provider: "direct_pdf",
    originalUrl: "https://archive.example.org/scan.pdf",
    canonicalUrl: "https://archive.example.org/scan.pdf",
    displayName: "scan.pdf",
    mimeType: "application/pdf",
    accessMode: "direct_cors",
    fingerprint: { etag: '"old"', contentLength: 9000 },
    warnings: [],
  });

  const result = await adapter.revalidate(current, context());
  assert.equal(result.status, "changed");
  if (result.status === "changed") {
    assert.equal(result.requiresUserReview, true);
    assert.equal(result.oldFingerprint.etag, '"old"');
    assert.equal(result.newFingerprint.etag, '"revision-7"');
  }
});

test("Wikimedia revalidation keeps a revision-specific canonical URL pending with its fingerprint", async () => {
  const adapter = new WikimediaPdfSourceAdapter({
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "commons.wikimedia.org");
      return jsonResponse({
        query: {
          pages: [{
            title: "File:Book.pdf",
            imageinfo: [{
              url: "https://upload.wikimedia.org/wikipedia/commons/b/b4/Book.pdf",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
              mime: "application/pdf",
              size: 12_345,
              pagecount: 42,
              sha1: "revision-two",
              timestamp: "2026-07-30T11:55:00Z",
            }],
          }],
        },
      });
    },
  });
  const current = storedSource({
    provider: "wikimedia",
    originalUrl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
    canonicalUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a3/Book.pdf",
    sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
    providerHost: "upload.wikimedia.org",
    providerFileTitle: "File:Book.pdf",
    displayName: "Book.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 10_000,
    pageCount: 40,
    accessMode: "direct_cors",
    fingerprint: { sha1: "revision-one", contentLength: 10_000 },
    warnings: [],
  });

  const result = await adapter.revalidate(current, context());

  assert.equal(result.status, "changed");
  if (result.status === "changed") {
    assert.equal(result.newFingerprint.sha1, "revision-two");
    assert.deepEqual(result.resolvedMetadata, {
      canonicalUrl: "https://upload.wikimedia.org/wikipedia/commons/b/b4/Book.pdf",
      providerHost: "upload.wikimedia.org",
      fileSizeBytes: 12_345,
      pageCount: 42,
      accessMode: "direct_cors",
    });
  }
});

test("Wikimedia relocation requires review even when the content fingerprint is unchanged", async () => {
  const adapter = new WikimediaPdfSourceAdapter({
    fetch: async () => jsonResponse({
      query: {
        pages: [{
          title: "File:Book.pdf",
          imageinfo: [{
            url: "https://upload.wikimedia.org/wikipedia/commons/c/c5/Book.pdf",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
            mime: "application/pdf",
            size: 10_000,
            pagecount: 40,
            sha1: "revision-one",
          }],
        }],
      },
    }),
  });
  const current = storedSource({
    provider: "wikimedia",
    originalUrl: "https://commons.wikimedia.org/wiki/File:Book.pdf",
    canonicalUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a3/Book.pdf",
    providerHost: "upload.wikimedia.org",
    providerFileTitle: "File:Book.pdf",
    displayName: "Book.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 10_000,
    pageCount: 40,
    accessMode: "direct_cors",
    fingerprint: { sha1: "revision-one", contentLength: 10_000 },
    warnings: [],
  });

  const result = await adapter.revalidate(current, context());

  assert.equal(result.status, "changed");
  if (result.status === "changed") {
    assert.equal(result.newFingerprint.sha1, "revision-one");
    assert.equal(
      result.resolvedMetadata.canonicalUrl,
      "https://upload.wikimedia.org/wikipedia/commons/c/c5/Book.pdf",
    );
  }
});

class FakeGateway implements DocumentSourceGatewayClient {
  probedUrl = "";
  accessRequests = 0;

  async probeDirectPdf(inputUrl: string): Promise<DirectPdfGatewayProbe> {
    this.probedUrl = inputUrl;
    return {
      canonicalUrl: inputUrl,
      displayName: "scan.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 9000,
      acceptsRanges: true,
      fingerprint: { etag: '"gateway-revision"', contentLength: 9000 },
    };
  }

  async createAccessSession(source: StoredDocumentSource): Promise<PdfAccessDescriptor> {
    this.accessRequests += 1;
    return {
      accessMode: "secure_proxy",
      url: "https://project.supabase.co/functions/v1/pdf-gateway/stream/session-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fingerprint: source.fingerprint,
      ...(source.initialPage !== undefined ? { initialPage: source.initialPage } : {}),
    };
  }
}

function pdfProbeFetch(): typeof fetch {
  return async (_input, init) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": "9000",
          "Content-Type": "application/pdf",
          ETag: '"revision-7"',
          "Last-Modified": "Wed, 30 Jul 2026 09:30:00 GMT",
        },
      });
    }
    return new Response("%PDF-", {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-4/9000",
        "Content-Type": "application/pdf",
        ETag: '"revision-7"',
      },
    });
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function context(): AccessContext {
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

const unusedFetch: typeof fetch = async () => {
  throw new Error("not used");
};
