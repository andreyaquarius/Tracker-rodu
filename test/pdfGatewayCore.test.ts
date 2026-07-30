import assert from "node:assert/strict";
import test from "node:test";
import type { PdfGatewayLimits } from "../supabase/functions/pdf-gateway/config.ts";
import {
  createBoundedPdfStream,
  fetchPublicPdfWithRedirects,
  PdfGatewayUpstreamError,
  safePdfResponseHeaders,
  validatePdfUpstreamResponse,
  type PdfGatewayFetch,
} from "../supabase/functions/pdf-gateway/gatewayCore.ts";
import { parseSingleByteRange } from "../supabase/functions/pdf-gateway/security.ts";

const limits: PdfGatewayLimits = {
  sessionTtlSeconds: 120,
  maxRedirects: 3,
  connectTimeoutMs: 1_000,
  streamIdleTimeoutMs: 1_000,
  fallbackMaxBytesWithoutRange: 32,
  maxRangeResponseBytes: 16,
  maxRequestsPerSession: 64,
  maxActiveSessionsPerUserProject: 4,
  probeRequestsPerWindow: 30,
  probeWindowSeconds: 60,
  telemetryRequestsPerWindow: 120,
  telemetryWindowSeconds: 60,
  telemetrySuccessSamplePercent: 10,
  maxRequestBodyBytes: 4_096,
};

const publicResolver = async () => ["93.184.216.34"];

test("gateway manually follows only revalidated public redirects", async () => {
  const requests: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
  const fetcher: PdfGatewayFetch = async (input, init) => {
    const url = input.toString();
    requests.push({
      url,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.org/book.pdf" },
      });
    }
    return new Response("%PDF-ok", {
      status: 206,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Range": "bytes 0-6/100",
        "Content-Length": "7",
      },
    });
  };

  const result = await fetchPublicPdfWithRedirects({
    url: "https://archive.example.org/book.pdf",
    method: "GET",
    range: parseSingleByteRange("bytes=0-6"),
    ifRange: '"version-1"',
    resolver: publicResolver,
    fetcher,
    limits,
  });
  assert.equal(result.finalUrl.href, "https://cdn.example.org/book.pdf");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((entry) => entry.redirect === "manual"));
  assert.equal(requests[1].headers.get("range"), "bytes=0-6");
  assert.equal(requests[1].headers.get("if-range"), '"version-1"');
  assert.equal(requests[1].headers.get("cookie"), null);
  assert.equal(requests[1].headers.get("authorization"), null);
  await result.response.body?.cancel();
  result.dispose();
});

test("gateway blocks a redirect to metadata or private IP before a second fetch", async () => {
  let calls = 0;
  const fetcher: PdfGatewayFetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: "https://169.254.169.254/latest/meta-data" },
    });
  };
  await assert.rejects(
    fetchPublicPdfWithRedirects({
      url: "https://archive.example.org/book.pdf",
      method: "GET",
      resolver: publicResolver,
      fetcher,
      limits,
    }),
    /HOST_NOT_ALLOWED/u,
  );
  assert.equal(calls, 1);
});

test("gateway sends a Drive bearer only to explicitly authorized upstream hosts", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const result = await fetchPublicPdfWithRedirects({
    url: "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
    method: "GET",
    range: parseSingleByteRange("bytes=0-6"),
    resolver: publicResolver,
    limits,
    authorization: {
      bearerToken: "ephemeral-drive-token",
      allowedHosts: ["www.googleapis.com", "content.googleapis.com"],
    },
    fetcher: async (input, init) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("%PDF-ok", {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Range": "bytes 0-6/100",
          "Content-Length": "7",
        },
      });
    },
  });

  assert.deepEqual(seen, [{
    url: "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
    authorization: "Bearer ephemeral-drive-token",
  }]);
  await result.response.body?.cancel();
  result.dispose();
});

test("gateway never forwards a Drive bearer to an untrusted redirect host", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  await assert.rejects(
    fetchPublicPdfWithRedirects({
      url: "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
      method: "GET",
      resolver: publicResolver,
      limits,
      authorization: {
        bearerToken: "ephemeral-drive-token",
        allowedHosts: ["www.googleapis.com", "content.googleapis.com"],
      },
      fetcher: async (input, init) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example.org/private.pdf" },
        });
      },
    }),
    (error: unknown) => error instanceof PdfGatewayUpstreamError
      && error.code === "UPSTREAM_AUTH_REDIRECT_BLOCKED",
  );
  assert.deepEqual(seen, [{
    url: "https://www.googleapis.com/drive/v3/files/file-id?alt=media",
    authorization: "Bearer ephemeral-drive-token",
  }]);
});

test("206 validation preserves only PDF range metadata and streams without full buffering", async () => {
  const response = new Response("%PDF-ok", {
    status: 206,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Range": "bytes 0-6/100",
      "Content-Length": "7",
      "Accept-Ranges": "bytes",
      "ETag": '"v1"',
      "Set-Cookie": "must-not-pass=1",
      "Location": "https://private.example/secret",
    },
  });
  const validated = validatePdfUpstreamResponse(
    response,
    parseSingleByteRange("bytes=0-6"),
    limits,
  );
  assert.equal(validated.status, 206);
  assert.equal(validated.verifyMagicPrefix, true);
  assert.equal(validated.maximumBodyBytes, 7);
  assert.equal(validated.headers.get("Content-Type"), "application/pdf");
  assert.equal(validated.headers.get("Content-Range"), "bytes 0-6/100");
  assert.equal(validated.headers.get("Set-Cookie"), null);
  assert.equal(validated.headers.get("Location"), null);

  const body = createBoundedPdfStream(response.body, {
    maximumBytes: validated.maximumBodyBytes,
    verifyMagicPrefix: validated.verifyMagicPrefix,
    idleTimeoutMs: 1_000,
    abort: () => undefined,
  });
  assert.equal(await new Response(body).text(), "%PDF-ok");
});

test("gateway rejects ignored Range responses above the fallback ceiling", () => {
  const response = new Response("%PDF-", {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": "1000",
    },
  });
  assert.throws(
    () => validatePdfUpstreamResponse(
      response,
      parseSingleByteRange("bytes=0-4"),
      limits,
    ),
    (error: unknown) => error instanceof PdfGatewayUpstreamError
      && error.code === "SOURCE_TOO_LARGE_WITHOUT_RANGE",
  );
});

test("gateway verifies PDF magic bytes when the response starts at byte zero", async () => {
  const response = new Response("<html>not a pdf</html>", {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const validated = validatePdfUpstreamResponse(response, null, limits);
  const body = createBoundedPdfStream(response.body, {
    maximumBytes: validated.maximumBodyBytes,
    verifyMagicPrefix: true,
    idleTimeoutMs: 1_000,
    abort: () => undefined,
  });
  await assert.rejects(
    new Response(body).text(),
    (error: unknown) => error instanceof PdfGatewayUpstreamError
      && error.code === "SOURCE_NOT_PDF",
  );
});

test("bounded PDF streaming aborts an upstream body that becomes idle", async () => {
  let aborted = false;
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const body = createBoundedPdfStream(stalled, {
    maximumBytes: 1024,
    verifyMagicPrefix: false,
    idleTimeoutMs: 20,
    abort: () => {
      aborted = true;
    },
  });
  await assert.rejects(
    new Response(body).arrayBuffer(),
    (error: unknown) => error instanceof PdfGatewayUpstreamError
      && error.code === "UPSTREAM_TIMEOUT",
  );
  assert.equal(aborted, true);
});

test("bounded PDF stream reports transferred bytes exactly once without affecting output", async () => {
  const finalized: Array<Record<string, unknown>> = [];
  const body = createBoundedPdfStream(
    new Response("%PDF-telemetry").body,
    {
      maximumBytes: 128,
      verifyMagicPrefix: true,
      idleTimeoutMs: 1_000,
      abort: () => undefined,
      onFinalize: (result) => finalized.push(result),
    },
  );
  assert.equal(await new Response(body).text(), "%PDF-telemetry");
  assert.deepEqual(finalized, [{
    transferredBytes: 14,
    outcome: "completed",
  }]);
});

test("safe response header map never forwards upstream cookies or redirects", () => {
  const headers = safePdfResponseHeaders(new Headers({
    "Content-Length": "10",
    "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    "Set-Cookie": "secret=true",
    "Location": "https://example.org/secret",
    "X-Internal": "secret",
  }));
  assert.equal(headers.get("Content-Length"), "10");
  assert.ok(headers.has("Last-Modified"));
  assert.equal(headers.get("Set-Cookie"), null);
  assert.equal(headers.get("Location"), null);
  assert.equal(headers.get("X-Internal"), null);
});
