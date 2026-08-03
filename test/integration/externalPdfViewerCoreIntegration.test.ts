import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessContext,
  PdfAccessDescriptor,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../../src/services/document-sources/contracts.ts";
import { createDefaultDocumentSourceRegistry } from "../../src/services/document-sources/defaultRegistry.ts";
import type {
  DirectPdfGatewayProbe,
  DocumentSourceGatewayClient,
} from "../../src/services/document-sources/gatewayClient.ts";

const requestContext: AccessContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003",
  requestId: "external-pdf-integration",
};

test("default registry resolves a Wikisource Page through the Commons metadata fallback", async () => {
  const requests: URL[] = [];
  const gateway = new FakeGateway();
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.origin === "https://uk.wikisource.org") {
      return jsonResponse({
        query: { pages: [{ title: "File:Metric book.pdf", missing: true }] },
      });
    }
    if (url.origin === "https://commons.wikimedia.org") {
      return jsonResponse({
        query: {
          pages: [{
            title: "File:Metric book.pdf",
            imageinfo: [{
              url: "https://upload.wikimedia.org/wikipedia/commons/a/a3/Metric_book.pdf",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Metric_book.pdf",
              mime: "application/pdf",
              size: 987_654,
              pagecount: 400,
              sha1: "commons-sha1",
              timestamp: "2026-07-30T09:30:00Z",
            }],
          }],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url.href}`);
  };
  const registry = createDefaultDocumentSourceRegistry({ fetch: fetchMock, gateway });

  const source = await registry.resolve(
    "https://uk.wikisource.org/wiki/Page:Metric_book.pdf/25",
    requestContext,
  );

  assert.deepEqual(registry.providers(), ["wikimedia", "google_drive", "direct_pdf"]);
  assert.deepEqual(requests.map((url) => url.origin), [
    "https://uk.wikisource.org",
    "https://commons.wikimedia.org",
  ]);
  assert.equal(requests[1]?.searchParams.get("titles"), "File:Metric book.pdf");
  assert.equal(source.provider, "wikimedia");
  assert.equal(source.originalUrl, "https://uk.wikisource.org/wiki/Page:Metric_book.pdf/25");
  assert.equal(source.canonicalUrl, "https://upload.wikimedia.org/wikipedia/commons/a/a3/Metric_book.pdf");
  assert.equal(source.sourcePageUrl, "https://commons.wikimedia.org/wiki/File:Metric_book.pdf");
  assert.equal(source.initialPage, 25);
  assert.equal(source.accessMode, "direct_cors");
  assert.deepEqual(source.fingerprint, {
    sha1: "commons-sha1",
    lastModified: "2026-07-30T09:30:00Z",
    contentLength: 987_654,
  });
  assert.equal(gateway.probeCalls.length, 0);
});

test("default registry falls back from a direct Wikimedia upload to an opaque gateway session", async () => {
  const gateway = new FakeGateway();
  const requests: Array<{ method: string; range: string | null }> = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      range: new Headers(init?.headers).get("range"),
    });
    throw new TypeError("simulated browser CORS rejection");
  };
  const registry = createDefaultDocumentSourceRegistry({ fetch: fetchMock, gateway });
  const input = "https://upload.wikimedia.org/wikipedia/commons/a/a3/Metric_book.pdf";

  const source = await registry.resolve(input, requestContext);
  const descriptor = await registry.createAccessDescriptor(storedSource(source), requestContext);

  assert.deepEqual(requests, [
    { method: "HEAD", range: null },
    { method: "HEAD", range: null },
    { method: "HEAD", range: null },
    { method: "GET", range: "bytes=0-4" },
    { method: "GET", range: "bytes=0-4" },
    { method: "GET", range: "bytes=0-4" },
  ]);
  assert.deepEqual(gateway.probeCalls, [input]);
  assert.equal(source.provider, "wikimedia");
  assert.equal(source.accessMode, "secure_proxy");
  assert.equal(source.canonicalUrl, input);
  assert.deepEqual(source.fingerprint, {
    etag: '"gateway-v1"',
    contentLength: 32_768,
  });
  assert.equal(gateway.accessCalls, 1);
  assert.equal(descriptor.accessMode, "secure_proxy");
  assert.equal(descriptor.url, "https://project.supabase.co/functions/v1/pdf-gateway/stream/session-1");
  assert.equal(descriptor.expiresAt, "2099-01-01T00:00:00.000Z");
});

test("default registry accepts both a ranged 206 PDF and a whole-file 200 PDF", async () => {
  const gateway = new FakeGateway();
  const requests: Array<{ path: string; method: string; range: string | null }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ path: url.pathname, method, range: new Headers(init?.headers).get("range") });

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": url.pathname.includes("ranged") ? "8192" : "9",
          ETag: url.pathname.includes("ranged") ? '"ranged-v1"' : '"whole-v1"',
          ...(url.pathname.includes("ranged") ? { "Accept-Ranges": "bytes" } : {}),
        },
      });
    }

    if (url.pathname.includes("ranged")) {
      return new Response("%PDF-", {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Range": "bytes 0-4/8192",
          "Accept-Ranges": "bytes",
          ETag: '"ranged-v1"',
        },
      });
    }
    return new Response("%PDF-body", {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": "9",
        ETag: '"whole-v1"',
      },
    });
  };
  const registry = createDefaultDocumentSourceRegistry({ fetch: fetchMock, gateway });

  const ranged = await registry.resolve("https://archive.example.test/ranged.pdf?page=9", requestContext);
  const whole = await registry.resolve("https://archive.example.test/whole-file.pdf", requestContext);

  assert.equal(ranged.provider, "direct_pdf");
  assert.equal(ranged.accessMode, "direct_cors");
  assert.equal(ranged.initialPage, 9);
  assert.equal(ranged.fileSizeBytes, 8192);
  assert.deepEqual(ranged.fingerprint, { etag: '"ranged-v1"', contentLength: 8192 });
  assert.deepEqual(ranged.warnings, []);
  assert.equal(whole.provider, "direct_pdf");
  assert.equal(whole.accessMode, "direct_cors");
  assert.equal(whole.fileSizeBytes, 9);
  assert.deepEqual(whole.fingerprint, { etag: '"whole-v1"', contentLength: 9 });
  assert.equal(whole.warnings.length, 1);
  assert.deepEqual(requests.map((request) => request.method), ["HEAD", "GET", "HEAD", "GET"]);
  assert.equal(requests[1]?.range, "bytes=0-4");
  assert.equal(requests[3]?.range, "bytes=0-4");
  assert.equal(gateway.probeCalls.length, 0);
});

test("registry revalidation detects a fingerprint change and then accepts the reviewed fingerprint", async () => {
  let etag = '"revision-1"';
  const fetchMock: typeof fetch = async (_input, init) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": "4096",
          "Content-Type": "application/pdf",
          ETag: etag,
          "Last-Modified": "Thu, 30 Jul 2026 12:00:00 GMT",
        },
      });
    }
    return new Response("%PDF-", {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-4/4096",
        "Content-Type": "application/pdf",
        ETag: etag,
      },
    });
  };
  const registry = createDefaultDocumentSourceRegistry({
    fetch: fetchMock,
    now: () => new Date("2026-07-30T15:00:00.000Z"),
  });
  const initial = await registry.resolve("https://archive.example.test/revisioned.pdf", requestContext);
  const stored = storedSource(initial);

  etag = '"revision-2"';
  const changed = await registry.revalidate(stored, requestContext);

  assert.equal(changed.status, "changed");
  assert.equal(stored.fingerprint.etag, '"revision-1"');
  if (changed.status !== "changed") assert.fail("expected changed fingerprint result");
  assert.equal(changed.requiresUserReview, true);
  assert.equal(changed.oldFingerprint.etag, '"revision-1"');
  assert.equal(changed.newFingerprint.etag, '"revision-2"');
  assert.equal(changed.validatedAt, "2026-07-30T15:00:00.000Z");

  const accepted = storedSource({ ...initial, fingerprint: changed.newFingerprint });
  const unchanged = await registry.revalidate(accepted, requestContext);
  assert.equal(unchanged.status, "unchanged");
  if (unchanged.status === "unchanged") {
    assert.equal(unchanged.newFingerprint.etag, '"revision-2"');
    assert.equal(unchanged.validatedAt, "2026-07-30T15:00:00.000Z");
  }
});

class FakeGateway implements DocumentSourceGatewayClient {
  readonly probeCalls: string[] = [];
  accessCalls = 0;

  async probeDirectPdf(inputUrl: string): Promise<DirectPdfGatewayProbe> {
    this.probeCalls.push(inputUrl);
    return {
      canonicalUrl: inputUrl,
      displayName: "Metric_book.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 32_768,
      acceptsRanges: true,
      fingerprint: { etag: '"gateway-v1"', contentLength: 32_768 },
    };
  }

  async createAccessSession(source: StoredDocumentSource): Promise<PdfAccessDescriptor> {
    this.accessCalls += 1;
    return {
      accessMode: "secure_proxy",
      url: "https://project.supabase.co/functions/v1/pdf-gateway/stream/session-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fingerprint: source.fingerprint,
      ...(source.initialPage === undefined ? {} : { initialPage: source.initialPage }),
    };
  }
}

function storedSource(source: ResolvedPdfSource): StoredDocumentSource {
  return {
    ...source,
    id: "00000000-0000-4000-8000-000000000004",
    documentId: requestContext.documentId,
    status: "active",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
