import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { pdfGatewayLimitsFromEnvironment } from "../supabase/functions/pdf-gateway/config.ts";
import { PdfGatewayUpstreamError } from "../supabase/functions/pdf-gateway/gatewayCore.ts";
import { GoogleDrivePublicError } from "../supabase/functions/pdf-gateway/googleDrivePublic.ts";
import { PdfGatewaySecurityError } from "../supabase/functions/pdf-gateway/security.ts";

const executable = ts.transpileModule(
  readFileSync(new URL("../supabase/functions/pdf-gateway/index.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const primaryOrigin = "https://trekerrodu.com.ua";
const vercelOrigin = "https://tracker-rodu.vercel.app";
const requestHeaders = "authorization, apikey, x-client-info, content-type, range, if-range";

function gateway(environment: Record<string, string | undefined>) {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  // Execute the actual entry point, but make any database, provider or network
  // access fail: preflight/rejected-origin/unauthenticated requests need none.
  const pureDependencies = {
    pdfGatewayLimitsFromEnvironment, PdfGatewayUpstreamError, GoogleDrivePublicError, PdfGatewaySecurityError,
  };
  const dependency = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name === "string" && Object.hasOwn(pureDependencies, name)) {
        return pureDependencies[name as keyof typeof pureDependencies];
      }
      throw new Error(`Unexpected gateway dependency: ${String(name)}`);
    },
  });
  runInNewContext(executable, {
    exports: {}, URL, Request, Response, Headers, crypto: globalThis.crypto,
    require: () => dependency,
    fetch: () => { throw new Error("CORS checks must not access the network"); },
    Deno: {
      env: { get: (name: string) => environment[name] },
      serve: (callback: typeof handler) => { handler = callback; },
    },
  });
  assert.ok(handler, "the real PDF gateway handler must be registered");
  return handler;
}

function request(origin: string, method = "OPTIONS") {
  return new Request("https://gateway.example.test/functions/v1/pdf-gateway/open-session", {
    method,
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders,
    },
  });
}

async function assertPreflightAllowed(response: Response, origin: string) {
  assert.equal(response.status, 204, origin);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, POST, OPTIONS");
  const allowedHeaders = response.headers.get("access-control-allow-headers")!.split(", ");
  for (const header of requestHeaders.split(", ")) assert.ok(allowedHeaders.includes(header), header);
  assert.match(response.headers.get("access-control-expose-headers")!, /Content-Range/u);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "");
}

test("PDF preflight allows the primary and Vercel origins from ALLOWED_ORIGINS", async () => {
  const handle = gateway({
    APP_URL: primaryOrigin,
    ALLOWED_ORIGIN: primaryOrigin,
    ALLOWED_ORIGINS: `${primaryOrigin},${vercelOrigin}`,
  });
  for (const origin of [primaryOrigin, vercelOrigin]) {
    await assertPreflightAllowed(await handle(request(origin)), origin);
  }
});

test("the plural list adds origins without masking APP_URL or legacy ALLOWED_ORIGIN", async () => {
  const legacyOrigin = "https://legacy.example.test";
  const additionalOrigin = "https://additional.example.test";
  const handle = gateway({
    APP_URL: primaryOrigin,
    ALLOWED_ORIGIN: legacyOrigin,
    ALLOWED_ORIGINS: ` , ${vercelOrigin}/, ${additionalOrigin}, ${vercelOrigin}, `,
  });
  for (const origin of [primaryOrigin, legacyOrigin, vercelOrigin, additionalOrigin]) {
    await assertPreflightAllowed(await handle(request(origin)), origin);
  }
});

test("legacy origin configuration still works when ALLOWED_ORIGINS is missing or empty", async () => {
  for (const environment of [
    { APP_URL: primaryOrigin },
    { ALLOWED_ORIGIN: primaryOrigin },
    { APP_URL: primaryOrigin, ALLOWED_ORIGINS: " , " },
  ]) {
    await assertPreflightAllowed(await gateway(environment)(request(primaryOrigin)), primaryOrigin);
  }
});

test("ALLOWED_ORIGINS alone can configure the PDF gateway allowlist", async () => {
  await assertPreflightAllowed(
    await gateway({ ALLOWED_ORIGINS: vercelOrigin })(request(vercelOrigin)),
    vercelOrigin,
  );
});

test("unlisted origins are rejected before preflight, authentication or document access", async () => {
  const handle = gateway({ APP_URL: primaryOrigin, ALLOWED_ORIGINS: vercelOrigin });
  for (const origin of [
    "https://untrusted.example.test",
    "https://other-preview.vercel.app",
    "https://tracker-rodu.vercel.app.evil.test",
    "http://tracker-rodu.vercel.app",
    "https://tracker-rodu.vercel.app:444",
  ]) {
    for (const method of ["OPTIONS", "POST", "GET", "HEAD"]) {
      const response = await handle(request(origin, method));
      assert.equal(response.status, 403, `${method} ${origin}`);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal((await response.json()).error, "ORIGIN_NOT_ALLOWED");
    }
  }
});

test("empty, invalid and wildcard configuration never allows arbitrary remote origins", async () => {
  for (const environment of [
    {},
    { ALLOWED_ORIGINS: " , " },
    { ALLOWED_ORIGINS: "*, https://*.vercel.app, not-a-url" },
  ]) {
    const response = await gateway(environment)(request(vercelOrigin));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal((await response.json()).error, "ORIGIN_NOT_ALLOWED");
  }
});

test("existing loopback development origins remain allowed", async () => {
  const handle = gateway({ ALLOWED_ORIGINS: vercelOrigin });
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
    await assertPreflightAllowed(await handle(request(origin)), origin);
  }
  assert.equal((await handle(request("http://localhost.evil.test:5173"))).status, 403);
});

test("allowing the Vercel origin does not bypass authentication for opening a PDF session", async () => {
  const response = await gateway({ ALLOWED_ORIGINS: vercelOrigin })(request(vercelOrigin, "POST"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), vercelOrigin);
  assert.equal((await response.json()).error, "AUTH_REQUIRED");
});
