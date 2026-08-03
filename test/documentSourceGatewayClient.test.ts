import assert from "node:assert/strict";
import test from "node:test";
import type { StoredDocumentSource } from "../src/services/document-sources/contracts.ts";
import {
  DocumentSourceError,
  HttpDocumentSourceGatewayClient,
} from "../src/services/document-sources/index.ts";

test("gateway probes a direct PDF through the project-authorized metadata route", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  let requestedHeaders: Headers | null = null;
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    headers: () => ({ Authorization: "Bearer user-jwt", apikey: "public-anon-key" }),
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        canonicalUrl: "https://archive.example.org/final/scan.pdf",
        displayName: "scan.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 12_345,
        acceptsRanges: true,
        fingerprint: {
          etag: '\"version-1\"',
          lastModified: "Wed, 30 Jul 2026 12:00:00 GMT",
          contentLength: 12_345,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const probe = await client.probeDirectPdf(
    "https://archive.example.org/original/scan.pdf",
    context(),
  );

  assert.equal(
    requestedUrl,
    "https://project.supabase.co/functions/v1/pdf-gateway/probe-source",
  );
  assert.deepEqual(JSON.parse(requestedBody), {
    projectId: "project-1",
    documentId: "document-1",
    url: "https://archive.example.org/original/scan.pdf",
  });
  assert.equal(requestedHeaders?.get("authorization"), "Bearer user-jwt");
  assert.equal(probe.canonicalUrl, "https://archive.example.org/final/scan.pdf");
  assert.equal(probe.fileSizeBytes, 12_345);
  assert.equal(probe.acceptsRanges, true);
  assert.equal(probe.fingerprint.etag, '\"version-1\"');
});

test("gateway metadata probe supports a new unsaved document without weakening project scope", async () => {
  let requestedBody = "";
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    fetch: async (_input, init) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        canonicalUrl: "https://archive.example.org/scan.pdf",
        mimeType: "application/pdf",
        acceptsRanges: true,
        fingerprint: {},
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await client.probeDirectPdf("https://archive.example.org/scan.pdf", {
    userId: "user-1",
    projectId: "project-1",
  });
  assert.deepEqual(JSON.parse(requestedBody), {
    projectId: "project-1",
    url: "https://archive.example.org/scan.pdf",
  });
});

test("gateway probes a public Drive share through its dedicated server route", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const shareUrl = "https://drive.google.com/file/d/1AbCdef_ghijklmnopQRstuV/view";
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    headers: () => ({ Authorization: "Bearer user-jwt" }),
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        canonicalUrl: shareUrl,
        displayName: "Public register.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 55_000,
        acceptsRanges: true,
        fingerprint: { md5: "public-md5", contentLength: 55_000 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const probe = await client.probePublicGoogleDrivePdf(shareUrl, context());

  assert.equal(
    requestedUrl,
    "https://project.supabase.co/functions/v1/pdf-gateway/probe-google-drive-public",
  );
  assert.deepEqual(JSON.parse(requestedBody), {
    projectId: "project-1",
    documentId: "document-1",
    url: shareUrl,
  });
  assert.equal(probe.displayName, "Public register.pdf");
  assert.equal(probe.fingerprint.md5, "public-md5");
});

test("gateway opens an opaque Supabase session without sending the upstream URL", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  let requestedHeaders: Headers | null = null;
  const fetchMock: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = String(init?.body ?? "");
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      accessMode: "secure_proxy",
      streamUrl: "/functions/v1/pdf-gateway/stream/opaque-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      fingerprint: { etag: '"current"', contentLength: 5000 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    fetch: fetchMock,
    headers: () => ({ Authorization: "Bearer user-jwt", apikey: "public-anon-key" }),
  });

  const descriptor = await client.createAccessSession(source(), context());

  assert.equal(
    requestedUrl,
    "https://project.supabase.co/functions/v1/pdf-gateway/open-session",
  );
  assert.deepEqual(JSON.parse(requestedBody), {
    documentId: "document-1",
    documentSourceId: "source-1",
    projectId: "project-1",
    requestId: "request-1",
  });
  assert.equal(requestedBody.includes("archive.example.org"), false);
  assert.equal(requestedHeaders?.get("authorization"), "Bearer user-jwt");
  assert.equal(descriptor.url, "https://project.supabase.co/functions/v1/pdf-gateway/stream/opaque-token");
  assert.equal(descriptor.initialPage, 25);
  assert.equal(descriptor.fingerprint.etag, '"current"');
  assert.deepEqual(descriptor.accessMode === "secure_proxy" ? descriptor.httpHeaders : undefined, {
    authorization: "Bearer user-jwt",
    apikey: "public-anon-key",
  });
});

test("gateway sends a Drive token only in the session POST and never returns it to PDF.js", async () => {
  let requestedBody = "";
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    headers: () => ({ Authorization: "Bearer app-user-jwt", apikey: "public-anon-key" }),
    fetch: async (_input, init) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        accessMode: "google_drive_api",
        streamUrl: "/functions/v1/pdf-gateway/stream/opaque-drive-session",
        expiresAt: "2099-01-01T00:00:00.000Z",
        fingerprint: { revisionId: "drive-revision" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const descriptor = await client.createAccessSession(
    driveSource(),
    context(),
    { googleDriveAccessToken: "ephemeral-google-access-token" },
  );

  const body = JSON.parse(requestedBody) as Record<string, unknown>;
  assert.equal(body.googleDriveAccessToken, "ephemeral-google-access-token");
  assert.equal(body.documentSourceId, "drive-source-1");
  assert.equal(descriptor.accessMode, "google_drive_api");
  assert.equal(
    descriptor.url,
    "https://project.supabase.co/functions/v1/pdf-gateway/stream/opaque-drive-session",
  );
  assert.equal(JSON.stringify(descriptor).includes("ephemeral-google-access-token"), false);
  assert.deepEqual(descriptor.accessMode === "google_drive_api" ? descriptor.httpHeaders : undefined, {
    authorization: "Bearer app-user-jwt",
    apikey: "public-anon-key",
  });
});

test("gateway maps Drive authorization failures without changing generic project access errors", async () => {
  for (const [status, code] of [
    [401, "OAUTH_REQUIRED"],
    [403, "GOOGLE_DRIVE_PERMISSION_DENIED"],
  ] as const) {
    const client = new HttpDocumentSourceGatewayClient({
      baseUrl: "https://project.supabase.co",
      fetch: async () => new Response(JSON.stringify({ error: code }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await assert.rejects(
      client.createAccessSession(
        driveSource(),
        context(),
        { googleDriveAccessToken: "ephemeral-google-access-token" },
      ),
      (error) => error instanceof DocumentSourceError && error.code === code,
    );
  }
});

test("gateway accepts a full function base and local loopback development URL", async () => {
  let requestedUrl = "";
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "http://127.0.0.1:54321/functions/v1/pdf-gateway/",
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        accessMode: "secure_proxy",
        streamUrl: "/functions/v1/pdf-gateway/stream/local-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const descriptor = await client.createAccessSession(source(), context());
  assert.equal(requestedUrl, "http://127.0.0.1:54321/functions/v1/pdf-gateway/open-session");
  assert.equal(descriptor.url, "http://127.0.0.1:54321/functions/v1/pdf-gateway/stream/local-token");
});

test("gateway accepts its direct-CORS response only for the source canonical URL", async () => {
  const directSource = { ...source(), accessMode: "direct_cors" as const };
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    fetch: async () => new Response(JSON.stringify({
      accessMode: "direct_cors",
      url: directSource.canonicalUrl,
      expiresAt: null,
      fingerprint: directSource.fingerprint,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  const descriptor = await client.createAccessSession(directSource, context());
  assert.equal(descriptor.accessMode, "direct_cors");
  assert.equal(descriptor.url, directSource.canonicalUrl);
  assert.equal(descriptor.initialPage, 25);
});

test("gateway blocks document substitution and never sends a request", async () => {
  let requests = 0;
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    fetch: async () => {
      requests += 1;
      return new Response();
    },
  });

  await assert.rejects(
    client.createAccessSession(source(), { ...context(), documentId: "other-document" }),
    (error) => error instanceof DocumentSourceError && error.code === "ACCESS_DENIED",
  );
  assert.equal(requests, 0);
});

test("gateway rejects cross-origin or non-gateway stream URLs", async () => {
  for (const streamUrl of [
    "https://evil.example.org/functions/v1/pdf-gateway/stream/token",
    "https://project.supabase.co/storage/v1/object/public/file.pdf",
  ]) {
    const client = new HttpDocumentSourceGatewayClient({
      baseUrl: "https://project.supabase.co",
      fetch: async () => new Response(JSON.stringify({
        accessMode: "secure_proxy",
        streamUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    await assert.rejects(
      client.createAccessSession(source(), context()),
      (error) => error instanceof DocumentSourceError && error.code === "NETWORK_ERROR",
    );
  }
});

test("gateway streams a server PDF subset using only the opaque viewer session token", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const token = "a".repeat(43);
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    headers: () => ({ Authorization: "Bearer user-jwt" }),
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return new Response("%PDF-export", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    },
  });

  const result = await client.exportPdfPages(source(), context(), {
    pages: [8, 1, 8],
    fileName: "Metric book.pdf",
    accessUrl: `https://project.supabase.co/functions/v1/pdf-gateway/stream/${token}`,
  });

  assert.equal(requestedUrl, "https://project.supabase.co/functions/v1/pdf-gateway/export-pages");
  assert.deepEqual(JSON.parse(requestedBody), {
    projectId: "project-1",
    documentId: "document-1",
    documentSourceId: "source-1",
    pages: [1, 8],
    fileName: "Metric book.pdf",
    sessionToken: token,
  });
  assert.equal(requestedBody.includes("archive.example.org"), false);
  assert.equal(result?.type, "application/pdf");
  assert.equal(await result?.text(), "%PDF-export");
});

test("viewer keeps its bounded fallback when the optional server export worker is absent", async () => {
  const client = new HttpDocumentSourceGatewayClient({
    baseUrl: "https://project.supabase.co",
    fetch: async () => new Response(JSON.stringify({ error: "SERVER_EXPORT_NOT_CONFIGURED" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  });
  assert.equal(await client.exportPdfPages(source(), context(), {
    pages: [1],
    fileName: "page.pdf",
  }), null);
});

function source(): StoredDocumentSource {
  return {
    id: "source-1",
    documentId: "document-1",
    provider: "direct_pdf",
    originalUrl: "https://archive.example.org/scan.pdf",
    canonicalUrl: "https://archive.example.org/scan.pdf",
    displayName: "scan.pdf",
    mimeType: "application/pdf",
    initialPage: 25,
    accessMode: "secure_proxy",
    fingerprint: { etag: '"old"' },
    warnings: [],
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function driveSource(): StoredDocumentSource {
  return {
    id: "drive-source-1",
    documentId: "document-1",
    provider: "google_drive",
    originalUrl: "https://drive.google.com/file/d/1AbCdef_ghijklmnopQRstuV/view",
    canonicalUrl: "https://drive.google.com/file/d/1AbCdef_ghijklmnopQRstuV/view",
    providerHost: "drive.google.com",
    providerFileId: "1AbCdef_ghijklmnopQRstuV",
    displayName: "private.pdf",
    mimeType: "application/pdf",
    accessMode: "google_drive_api",
    fingerprint: { revisionId: "drive-revision" },
    warnings: [],
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function context() {
  return {
    userId: "user-1",
    projectId: "project-1",
    documentId: "document-1",
    requestId: "request-1",
  };
}
