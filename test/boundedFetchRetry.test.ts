import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithBoundedRetry } from "../src/services/document-sources/boundedFetchRetry.ts";

test("bounded fetch retries transient idempotent responses with exponential delays", async () => {
  const delays: number[] = [];
  const statuses = [503, 429, 206];
  let calls = 0;
  const response = await fetchWithBoundedRetry(
    async () => new Response("%PDF-", { status: statuses[calls++] }),
    "https://archive.example.org/register.pdf",
    { method: "GET" },
    {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    },
  );

  assert.equal(response.status, 206);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("bounded fetch never retries a mutating request", async () => {
  let calls = 0;
  const response = await fetchWithBoundedRetry(
    async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
    "https://example.org/session",
    { method: "POST" },
    { sleep: async () => undefined },
  );
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("bounded fetch stops after the configured attempt cap", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithBoundedRetry(
      async () => {
        calls += 1;
        throw new TypeError("temporary network failure");
      },
      "https://archive.example.org/register.pdf",
      { method: "HEAD" },
      { maxAttempts: 3, sleep: async () => undefined },
    ),
    /temporary network failure/u,
  );
  assert.equal(calls, 3);
});

test("bounded fetch propagates abort without another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchWithBoundedRetry(
      async () => {
        calls += 1;
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw controller.signal.reason;
      },
      "https://archive.example.org/register.pdf",
      { method: "GET", signal: controller.signal },
      { sleep: async () => undefined },
    ),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls, 1);
});
