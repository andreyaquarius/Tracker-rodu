import assert from "node:assert/strict";
import test from "node:test";
import { createMonitoredSupabaseFetch, type SupabaseFailure } from "../src/utils/monitoredSupabaseFetch.ts";

const base = "https://project.supabase.co";
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(until(), "monitoring completed without blocking the caller");
};

test("RLS failure is reported by code only and the original response is still readable", async () => {
  const reports: SupabaseFailure[] = [];
  const response = new Response(JSON.stringify({ code: "42501", message: "Private name", details: "private SQL row" }), { status: 403 });
  const input = `${base}/rest/v1/projects?owner_id=eq.private-user`;
  const init = { method: "POST", headers: { Authorization: "Bearer private-token" }, body: "private-body" };
  const wrapped = createMonitoredSupabaseFetch(async (actualInput, actualInit) => {
    assert.equal(actualInput, input); assert.equal(actualInit, init); return response;
  }, base, error => reports.push(error), () => true);
  assert.equal(await wrapped(input, init), response);
  assert.equal((await response.json()).code, "42501");
  await settle(() => reports.length === 1);
  assert.deepEqual(reports, [{ operation: "table:projects", method: "POST", status: 403, code: "42501" }]);
  assert.doesNotMatch(JSON.stringify(reports), /private/i);
});

test("RPC timeouts and transport errors are visible even when the UI catches them", async () => {
  const reports: SupabaseFailure[] = [];
  const wrapped = createMonitoredSupabaseFetch(async () => new Response('{"code":"57014"}', { status: 500 }), base, error => reports.push(error), () => true);
  await wrapped(`${base}/rest/v1/rpc/get_family_tree_neighborhood_v1`, { method: "POST" });
  await settle(() => reports.length === 1);
  assert.equal(reports[0].operation, "rpc:get_family_tree_neighborhood_v1");
  assert.equal(reports[0].code, "57014");
  const original = new TypeError("Failed to fetch private URL");
  const offline = createMonitoredSupabaseFetch(async () => { throw original; }, base, error => reports.push(error), () => true);
  await assert.rejects(offline(`${base}/rest/v1/projects`), error => error === original);
  assert.equal(reports[1].status, 0);
});

test("successful requests, auth/password errors, Storage names and unrelated hosts are excluded", async () => {
  const reports: SupabaseFailure[] = [];
  const wrapped = createMonitoredSupabaseFetch(async () => new Response("bad", { status: 400 }), base, error => reports.push(error), () => true);
  for (const url of [`${base}/auth/v1/token`, `${base}/storage/v1/object/private/photo.jpg`, "https://other.test/rest/v1/projects"]) await wrapped(url);
  const successful = createMonitoredSupabaseFetch(async () => new Response("ok"), base, error => reports.push(error), () => true);
  await successful(`${base}/rest/v1/projects`);
  assert.equal(reports.length, 0);
});

test("disabled monitoring neither clones responses nor reports errors", async () => {
  const response = new Response("bad", { status: 500 });
  response.clone = () => { throw new Error("must not clone"); };
  const wrapped = createMonitoredSupabaseFetch(async () => response, base, () => { throw new Error("must not report"); }, () => false);
  assert.equal(await wrapped(`${base}/rest/v1/projects`), response);
});

test("aborted requests are not failures; reporter exceptions never change fetch results", async () => {
  const reports: SupabaseFailure[] = [];
  const abort = new DOMException("Cancelled", "AbortError");
  const wrapped = createMonitoredSupabaseFetch(async () => { throw abort; }, base, error => reports.push(error), () => true);
  await assert.rejects(wrapped(`${base}/rest/v1/projects`), error => error === abort);
  assert.equal(reports.length, 0);
  const response = new Response("invalid JSON", { status: 500 });
  const brokenReporter = createMonitoredSupabaseFetch(async () => response, base, () => { throw new Error("report failed"); }, () => true);
  assert.equal(await brokenReporter(`${base}/rest/v1/projects`), response);
  await new Promise(resolve => setTimeout(resolve, 30));
});

test("oversized or malformed error bodies never leak text or consume the caller's body", async () => {
  for (const body of ["x".repeat(9000), "not json", '{"code":"private-user"}']) {
    const reports: SupabaseFailure[] = [];
    const response = new Response(body, { status: 500 });
    const wrapped = createMonitoredSupabaseFetch(async () => response, base, error => reports.push(error), () => true);
    await wrapped(`${base}/rest/v1/projects`);
    assert.equal(await response.text(), body);
    await settle(() => reports.length === 1);
    assert.equal(reports[0].code, undefined);
  }
});
