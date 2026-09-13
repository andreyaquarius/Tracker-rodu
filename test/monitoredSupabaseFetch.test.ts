import assert from "node:assert/strict";
import test from "node:test";
import { createMonitoredSupabaseFetch, type SupabaseFailure } from "../src/utils/monitoredSupabaseFetch.ts";
import { createSupabaseRequestDiagnostics } from "../src/utils/supabaseRequestDiagnostics.ts";
import { sanitizeBrowserEvent } from "../src/utils/browserMonitoringPrivacy.ts";

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
  assert.equal(reports.length, 1);
  const { diagnostics, ...failure } = reports[0];
  assert.deepEqual(failure, { operation: "table:projects", method: "POST", status: 403, code: "42501" });
  assert.equal(diagnostics?.tags.failure_kind, "http");
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

test("transport diagnostics survive the Sentry privacy boundary without changing the rejection", async () => {
  const target = new EventTarget();
  let now = 0;
  let offline = false;
  const collector = createSupabaseRequestDiagnostics({
    target, now: () => now,
    readState: () => ({ network: offline ? "offline" : "online", visibility: offline ? "hidden" : "visible" }),
  });
  collector.initialize();
  const reports: SupabaseFailure[] = [];
  const original = new TypeError("Failed to fetch https://private.test?token=secret");
  const wrapped = createMonitoredSupabaseFetch(async () => {
    now = 3_250;
    offline = true;
    target.dispatchEvent(new Event("pagehide"));
    throw original;
  }, base, failure => reports.push(failure), () => true, collector.begin);
  await assert.rejects(wrapped(`${base}/rest/v1/rpc/get_dashboard_stats`, { method: "POST" }), error => error === original);
  assert.equal(reports.length, 1);
  const failure = reports[0];
  const event = sanitizeBrowserEvent({
    type: undefined,
    tags: { area: "supabase", operation: failure.operation, http_status: String(failure.status), ...failure.diagnostics?.tags },
    contexts: { supabase_request: { duration_ms: failure.diagnostics?.durationMs } },
  }, "/projects/private-project");
  assert.equal(event?.tags?.original_error_type, "TypeError");
  assert.equal(event?.tags?.network_start, "online");
  assert.equal(event?.tags?.network_end, "offline");
  assert.equal(event?.tags?.visibility_end, "hidden");
  assert.equal(event?.tags?.pagehide_observed, "yes");
  assert.equal(event?.tags?.request_duration, "1s_5s");
  assert.equal(event?.contexts?.supabase_request?.duration_ms, 3_250);
  assert.deepEqual(event?.fingerprint, ["supabase", "rpc:get_dashboard_stats", "0", "unknown"]);
  assert.doesNotMatch(JSON.stringify(event), /private|secret|Failed to fetch/);
});

test("HTTP diagnostics stop at response arrival rather than after reading its error body", async () => {
  let now = 0;
  let hidden = false;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const collector = createSupabaseRequestDiagnostics({
    now: () => now,
    readState: () => ({ network: "online", visibility: hidden ? "hidden" : "visible" }),
  });
  const reports: SupabaseFailure[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status: 500 });
  const wrapped = createMonitoredSupabaseFetch(async () => { now = 80; return response; }, base,
    failure => reports.push(failure), () => true, collector.begin);
  assert.equal(await wrapped(`${base}/rest/v1/tasks`), response);
  assert.equal(reports.length, 0);
  now = 1_200;
  hidden = true;
  body.enqueue(new TextEncoder().encode('{"code":"57014"}'));
  body.close();
  await settle(() => reports.length === 1);
  assert.equal(reports[0].diagnostics?.durationMs, 80);
  assert.equal(reports[0].diagnostics?.tags.visibility_end, "visible");
  assert.equal(reports[0].code, "57014");
  assert.equal((await response.json()).code, "57014");
});

test("diagnostic failures never change requests, and disabled/excluded requests do not collect", async () => {
  let begins = 0;
  const broken = () => { begins += 1; throw new Error("diagnostics failed"); };
  const original = new TypeError("network");
  const reports: SupabaseFailure[] = [];
  const fetcher: typeof fetch = async () => { throw original; };
  const wrapped = createMonitoredSupabaseFetch(fetcher, base, failure => reports.push(failure), () => true, broken);
  await assert.rejects(wrapped(`${base}/rest/v1/tasks`), error => error === original);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].diagnostics, undefined);
  const failingFinish = createMonitoredSupabaseFetch(fetcher, base, failure => reports.push(failure), () => true,
    () => () => { throw new Error("finish failed"); });
  await assert.rejects(failingFinish(`${base}/rest/v1/tasks`), error => error === original);
  assert.equal(reports.length, 2);
  const disabled = createMonitoredSupabaseFetch(fetcher, base, failure => reports.push(failure), () => false, broken);
  await assert.rejects(disabled(`${base}/rest/v1/tasks`), error => error === original);
  await assert.rejects(wrapped(`${base}/auth/v1/token`), error => error === original);
  assert.equal(begins, 1);
  assert.equal(reports.length, 2);
});
