import assert from "node:assert/strict";
import test from "node:test";
import { readableProviderError, geneHelpProviderOperationCode } from "../supabase/functions/genehelp/providerError.ts";
import { createMonitoredSupabaseFetch, type SupabaseFailure } from "../src/utils/monitoredSupabaseFetch.ts";

test("GeneHelp field constraints take precedence over a generic validation message", () => {
  assert.equal(readableProviderError({ message: "The given data was invalid.", errors: {
    "content.title": ["Title is too long."], "content.description": ["Description is required.", "Description is required."],
  } }), "Title is too long.\nDescription is required.");
  assert.equal(readableProviderError({ error: { errors: { email: ["Invalid email."] } } }), "Invalid email.");
  assert.equal(readableProviderError({ error: "Rejected" }), "Rejected");
});

test("malformed, cyclic, or excessive provider details remain bounded", () => {
  assert.equal(readableProviderError("<html>upstream failure</html>"), "");
  assert.equal(readableProviderError({ errors: { title: [{ private: "object" }, null] }, message: "Invalid" }), "Invalid");
  const cycle: { error?: unknown } = {}; cycle.error = cycle;
  assert.equal(readableProviderError(cycle), "");
  assert.ok(readableProviderError({ errors: { title: Array.from({ length: 50 }, (_, i) => `${i}${"x".repeat(1000)}`) } }).length <= 4007);
});

test("422 telemetry retains only the fixed provider stage and never the field messages", async () => {
  const reports: SupabaseFailure[] = [];
  const body = { code: geneHelpProviderOperationCode("/api/partners/v2/genealogy-requests/simple"), error: "Private name was rejected" };
  const response = new Response(JSON.stringify(body), { status: 422 });
  const wrapped = createMonitoredSupabaseFetch(async () => response, "https://project.supabase.co", failure => reports.push(failure), () => true);
  await wrapped("https://project.supabase.co/functions/v1/genehelp", { method: "POST" });
  for (let i = 0; i < 100 && !reports.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reports.length, 1); assert.equal(reports[0].code, "GHCRT");
  assert.doesNotMatch(JSON.stringify(reports), /Private|rejected/);
  assert.deepEqual(await response.json(), body);
  assert.equal(geneHelpProviderOperationCode("/api/partners/onboarding/users"), "GHONB");
  assert.equal(geneHelpProviderOperationCode("/api/partners/genealogy-requests/private-id"), "GHSTS");
});
