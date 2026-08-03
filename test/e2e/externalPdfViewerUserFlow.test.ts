import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultDocumentSourceRegistry } from "../../src/services/document-sources/defaultRegistry.ts";
import { HttpDocumentSourceGatewayClient } from "../../src/services/document-sources/gatewayClient.ts";
import type {
  AccessContext,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../../src/services/document-sources/contracts.ts";

const context: AccessContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003",
  requestId: "external-pdf-e2e",
};

test("public Drive share resolves, opens by opaque Range session and exports without leaking upstream data", async () => {
  const calls: Array<{ route: string; method: string; body: Record<string, unknown> | null }> = [];
  const sessionToken = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const gatewayBase = "https://project.supabase.co/functions/v1/pdf-gateway/";
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const route = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    calls.push({ route, method, body });

    if (route === "probe-google-drive-public") {
      return jsonResponse({
        canonicalUrl: "https://drive.google.com/file/d/abcdefghijk123456/view",
        displayName: "Метрична книга.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1_200_000_000,
        acceptsRanges: true,
        fingerprint: { revisionId: "revision-1", contentLength: 1_200_000_000 },
      });
    }
    if (route === "open-session") {
      return jsonResponse({
        accessMode: "secure_proxy",
        streamUrl: `${gatewayBase}stream/${sessionToken}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        fingerprint: { revisionId: "revision-1", contentLength: 1_200_000_000 },
      });
    }
    if (url.pathname.endsWith(`/stream/${sessionToken}`)) {
      assert.equal(new Headers(init?.headers).get("range"), "bytes=0-4");
      return new Response("%PDF-", {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Range": "bytes 0-4/1200000000",
          "Accept-Ranges": "bytes",
        },
      });
    }
    if (route === "export-pages") {
      return new Response("%PDF-exported-pages", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    throw new Error(`Unexpected PDF E2E request: ${method} ${url.href}`);
  };
  const gateway = new HttpDocumentSourceGatewayClient({
    baseUrl: gatewayBase,
    fetch: fetchMock,
    headers: () => ({ Authorization: "Bearer user-jwt", apikey: "publishable-key" }),
  });
  const registry = createDefaultDocumentSourceRegistry({ gateway, fetch: fetchMock });

  const resolved = await registry.resolve(
    "https://drive.google.com/file/d/abcdefghijk123456/view",
    context,
  );
  const source = storedSource(resolved);
  const access = await registry.createAccessDescriptor(source, context);
  const firstRange = await fetchMock(access.url, {
    method: "GET",
    headers: { ...access.httpHeaders, Range: "bytes=0-4" },
  });
  const exported = await gateway.exportPdfPages(source, context, {
    pages: [8, 1, 5, 1],
    fileName: "Метрична книга — сторінки.pdf",
    accessUrl: access.url,
  });

  assert.equal(resolved.provider, "google_drive");
  assert.equal(resolved.accessMode, "secure_proxy");
  assert.equal(access.url, `${gatewayBase}stream/${sessionToken}`);
  assert.equal(firstRange.status, 206);
  assert.equal(await firstRange.text(), "%PDF-");
  assert.ok(exported);
  assert.equal(new TextDecoder().decode(await exported!.slice(0, 5).arrayBuffer()), "%PDF-");

  const openBody = calls.find((call) => call.route === "open-session")?.body ?? {};
  const exportBody = calls.find((call) => call.route === "export-pages")?.body ?? {};
  assert.equal("url" in openBody, false);
  assert.equal("sourceUrl" in openBody, false);
  assert.equal("googleDriveAccessToken" in openBody, false);
  assert.equal("url" in exportBody, false);
  assert.equal("sourceUrl" in exportBody, false);
  assert.deepEqual(exportBody.pages, [1, 5, 8]);
  assert.equal(exportBody.sessionToken, sessionToken);
});

function storedSource(source: ResolvedPdfSource): StoredDocumentSource {
  return {
    ...source,
    id: "00000000-0000-4000-8000-000000000004",
    documentId: context.documentId,
    status: "active",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
