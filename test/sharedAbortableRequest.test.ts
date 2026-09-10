import assert from "node:assert/strict";
import test from "node:test";
import { createSharedAbortableRequest } from "../src/utils/sharedAbortableRequest.ts";

test("shares simultaneous reads but cancellation belongs to each consumer", async () => {
  const pool = createSharedAbortableRequest<number>();
  let finish!: (value: number) => void;
  let transport!: AbortSignal;
  let calls = 0;
  const load = (signal: AbortSignal) => { calls++; transport = signal; return new Promise<number>((resolve) => { finish = resolve; }); };
  const controller = new AbortController();
  const first = pool.run("account/project/query", load, controller.signal);
  const second = pool.run("account/project/query", load);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(transport.aborted, false);
  finish(42);
  assert.equal(await second, 42);
  assert.equal(calls, 1);
  assert.equal(await pool.run("account/project/query", async () => 43), 43, "resolved values are not retained");
});

test("last cancellation aborts the transport, discards late results and permits a new read", async () => {
  const pool = createSharedAbortableRequest<number>();
  const controller = new AbortController();
  let finish!: (value: number) => void;
  let transport!: AbortSignal;
  const first = pool.run("key", (signal) => { transport = signal; return new Promise<number>((resolve) => { finish = resolve; }); }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(transport.aborted, true);
  const next = pool.run("key", async () => 2);
  finish(1);
  assert.equal(await next, 2);
});

test("errors are not cached, keys are isolated, and pre-aborted reads never start", async () => {
  const pool = createSharedAbortableRequest<number>();
  await assert.rejects(pool.run("a", async () => { throw new Error("offline"); }), /offline/);
  assert.deepEqual(await Promise.all([pool.run("a", async () => 1), pool.run("b", async () => 2)]), [1, 2]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pool.run("a", async () => { assert.fail("must not start"); }, controller.signal), { name: "AbortError" });
});
