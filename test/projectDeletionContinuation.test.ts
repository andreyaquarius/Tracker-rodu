import assert from "node:assert/strict";
import test from "node:test";

import {
  isTrustedDeletionWorkerToken,
  requestDeletionContinuation,
} from "../supabase/functions/process-project-deletions/continuation.ts";

const jobId = "250529f5-9539-49fc-aa87-56eb584fdf88";

test("project deletion continuation starts exactly one targeted worker", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  };

  await requestDeletionContinuation({
    supabaseUrl: "https://example.supabase.co/",
    serverToken: "test-server-token",
    jobId,
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.input,
    "https://example.supabase.co/functions/v1/process-project-deletions",
  );
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).Authorization,
    "Bearer test-server-token",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { jobId });
});

test("project deletion continuation performs no immediate retry after rejection", async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async () => {
    requestCount += 1;
    return new Response("temporary failure", { status: 503 });
  };

  await assert.rejects(
    requestDeletionContinuation({
      supabaseUrl: "https://example.supabase.co",
      serverToken: "test-server-token",
      jobId,
      fetchImpl,
    }),
    /rejected \(503\)/,
  );
  assert.equal(requestCount, 1);
});

test("queue continuation omits a job id and requires a server token", async () => {
  let requestBody = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(null, { status: 202 });
  };

  await requestDeletionContinuation({
    supabaseUrl: "https://example.supabase.co",
    serverToken: "test-server-token",
    fetchImpl,
  });
  assert.deepEqual(JSON.parse(requestBody), {});

  await assert.rejects(
    requestDeletionContinuation({
      supabaseUrl: "https://example.supabase.co",
      serverToken: "",
      fetchImpl,
    }),
    /server-to-server token/,
  );
});

test("only configured server credentials bypass browser authentication", () => {
  const serviceRoleKey = "service-role-secret";
  const cronSecret = "cron-secret";

  assert.equal(
    isTrustedDeletionWorkerToken(serviceRoleKey, serviceRoleKey, cronSecret),
    true,
  );
  assert.equal(
    isTrustedDeletionWorkerToken(serviceRoleKey, serviceRoleKey, ""),
    true,
    "service-role continuation must work when the optional cron secret is absent",
  );
  assert.equal(
    isTrustedDeletionWorkerToken(cronSecret, serviceRoleKey, cronSecret),
    true,
  );
  assert.equal(
    isTrustedDeletionWorkerToken("ordinary-browser-jwt", serviceRoleKey, cronSecret),
    false,
  );
  assert.equal(
    isTrustedDeletionWorkerToken("ordinary-browser-jwt", serviceRoleKey, ""),
    false,
  );
  assert.equal(
    isTrustedDeletionWorkerToken("", serviceRoleKey, cronSecret),
    false,
  );
});
