import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as providerErrors from "../supabase/functions/genehelp/providerError.ts";

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const edgeExecutable = compile("../supabase/functions/genehelp/index.ts");
const clientExecutable = compile("../src/services/geneHelp.ts");

test("real GeneHelp handler forwards field validation and safe codes for onboarding, creation and status", async () => {
  for (const [action, connected, expectedPath, code] of [
    ["create-simple-request", false, "/api/partners/onboarding/users", "GHONB"],
    ["create-simple-request", true, "/api/partners/v2/genealogy-requests/simple", "GHCRT"],
    ["get-status", true, "/api/partners/genealogy-requests/ABCD1234", "GHSTS"],
  ] as const) {
    let handler!: (request: Request) => Promise<Response>; let writes = 0;
    const calls: string[] = [];
    const query = {
      select: () => query, eq: () => query,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: connected ? { encrypted_integration_token: "encrypted" } : null, error: null }),
      upsert: async () => { writes += 1; return { error: null }; },
    };
    runInNewContext(edgeExecutable, {
      exports: {}, URL, Response, AbortController, setTimeout, clearTimeout,
      Deno: { serve: (callback: typeof handler) => { handler = callback; }, env: { get: () => "test-partner-token" } },
      fetch: async (url: URL) => {
        calls.push(url.pathname);
        return Response.json({ message: "The given data was invalid.", errors: { field: ["A specific field constraint."] } }, { status: 422 });
      },
      require: (name: string) => {
        if (name.includes("providerError")) return providerErrors;
        if (name.includes("_shared/ai")) return {
          authenticatedContext: async () => ({ admin: { from: () => query }, user: { id: "user", email: "test@example.test", user_metadata: {} } }),
          json: (body: unknown, status = 200) => Response.json(body, { status }),
          decryptApiKey: async () => "test-integration-token",
          errorMessage: (error: { message?: string }, fallback: string) => error.message ?? fallback,
        };
        throw new Error(`Unexpected module ${name}`);
      },
    });
    const response = await handler(new Request("https://local.test/genehelp", {
      method: "POST", body: JSON.stringify({ action, id: "ABCD1234", description: "A detailed research request.", registrationConsent: true }),
    }));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "A specific field constraint.", code });
    assert.deepEqual(calls, [expectedPath]); assert.equal(writes, 0);
  }
});

test("GeneHelp browser service validates short input and preserves useful provider errors", async () => {
  let calls = 0;
  let reply: { data: unknown; error: unknown } = { data: null, error: null };
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  runInNewContext(clientExecutable, {
    exports, Response, Error,
    require: (name: string) => {
      if (name.includes("supabaseAuth")) return { getSupabaseClient: () => ({}) };
      if (name.includes("authenticatedEdgeFunction")) return { invokeAuthenticatedEdgeFunction: async () => { calls += 1; return reply; } };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  await assert.rejects(exports.createGeneHelpSimpleRequest({ description: " short " }), /12/);
  assert.equal(calls, 0);
  reply = { data: null, error: { context: Response.json({ error: "Description is too long." }, { status: 422 }) } };
  await assert.rejects(exports.createGeneHelpSimpleRequest({ description: "Long enough description" }), /Description is too long/);
  assert.equal(calls, 1);
  const gatewayError = { context: new Response("<html>Bad Gateway</html>", { status: 502 }) };
  reply = { data: null, error: gatewayError };
  await assert.rejects(exports.getGeneHelpAccountStatus(), error => error === gatewayError);
});
