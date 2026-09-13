import assert from "node:assert/strict";
import test from "node:test";
import { createRetryingSupabaseReadFetch } from "../src/utils/retryingSupabaseReadFetch.ts";
import { createMonitoredSupabaseFetch, type SupabaseFailure } from "../src/utils/monitoredSupabaseFetch.ts";

const base = "https://project.supabase.co";
const rpc = `${base}/rest/v1/rpc/get_dashboard_stats`;
const init = { method: "POST", body: '{"target_project_id":"private"}' };

test("audited POST reads recover from transient transport failure with unchanged request", async () => {
  for (const name of ["get_dashboard_stats", "get_my_subscription_context", "get_feedback_unread_count", "list_my_genehelp_notifications"]) {
    let calls = 0; const delays: number[] = []; const response = new Response("ok");
    const url = `${base}/rest/v1/rpc/${name}`;
    const retry = createRetryingSupabaseReadFetch(async (input, actualInit) => {
      assert.equal(input, url); assert.equal(actualInit, init);
      if (++calls < 3) throw new TypeError("network");
      return response;
    }, base, async ms => { delays.push(ms); });
    const reports: SupabaseFailure[] = [];
    const monitored = createMonitoredSupabaseFetch(retry, base, value => reports.push(value), () => true);
    assert.equal(await monitored(url, init), response);
    assert.equal(calls, 3); assert.deepEqual(delays, [300, 900]); assert.equal(reports.length, 0);
  }
});

test("persistent RPC failure is reported once after a bounded number of attempts", async () => {
  let calls = 0; const error = new TypeError("network"); const reports: SupabaseFailure[] = [];
  const retry = createRetryingSupabaseReadFetch(async () => { calls += 1; throw error; }, base, async () => {});
  const monitored = createMonitoredSupabaseFetch(retry, base, value => reports.push(value), () => true);
  await assert.rejects(monitored(rpc, init), value => value === error);
  assert.equal(calls, 3); assert.equal(reports.length, 1); assert.equal(reports[0].status, 0);
  assert.doesNotMatch(JSON.stringify(reports), /private/);
});

test("table writes, arbitrary RPCs, Edge calls, other hosts and SDK GETs are never replayed", async () => {
  for (const [url, options] of [
    [`${base}/rest/v1/projects`, init],
    [`${base}/rest/v1/rpc/mark_genehelp_notification_read`, init],
    [`${base}/functions/v1/genehelp`, init],
    [rpc, { method: "GET" }],
    [rpc, { method: "DELETE" }],
    [rpc.replace(base, "https://other.test"), init],
  ] as const) {
    let calls = 0;
    const retry = createRetryingSupabaseReadFetch(async () => { calls += 1; throw new TypeError("network"); }, base, async () => {});
    await assert.rejects(retry(url, options)); assert.equal(calls, 1);
  }
});

test("HTTP failures, cancellation, and programming errors are never retried", async () => {
  for (const status of [401, 422, 429, 500, 503]) {
    let calls = 0; const response = new Response("failed", { status });
    const retry = createRetryingSupabaseReadFetch(async () => { calls += 1; return response; }, base, async () => {});
    assert.equal(await retry(rpc, init), response); assert.equal(calls, 1);
  }
  for (const error of [new DOMException("cancelled", "AbortError"), new SyntaxError("bug")]) {
    let calls = 0;
    const retry = createRetryingSupabaseReadFetch(async () => { calls += 1; throw error; }, base, async () => {});
    await assert.rejects(retry(rpc, init), value => value === error); assert.equal(calls, 1);
  }
});

test("abort during the real backoff cancels the pending retry", async () => {
  let calls = 0; const controller = new AbortController();
  const retry = createRetryingSupabaseReadFetch(async () => { calls += 1; throw new TypeError("network"); }, base);
  const result = retry(rpc, { ...init, signal: controller.signal });
  await Promise.resolve(); controller.abort();
  await assert.rejects(result, { name: "AbortError" }); assert.equal(calls, 1);
});
