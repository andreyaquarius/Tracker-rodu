import test from "node:test";
import assert from "node:assert/strict";
import { createPersonNameSearchGuard, PersonNameSearchPausedError } from "../src/utils/personNameSearchGuard.ts";

test("historical-name requests deduplicate, expire and do not cross session boundaries", async () => {
  let clock = 1; let calls = 0;
  const search = createPersonNameSearchGuard<number>(() => clock);
  const request = async () => ++calls;
  assert.deepEqual(await Promise.all([search("owner", "name", request), search("owner", "name", request)]), [1, 1]);
  assert.equal(await search("owner", "name", request), 1);
  clock += 30_001;
  assert.equal(await search("owner", "name", request), 2);
  assert.equal(await search("viewer", "name", request), 3);
});

test("57014 pauses further queries for one minute, then allows a retry", async () => {
  let clock = 1; let calls = 0;
  const search = createPersonNameSearchGuard<number>(() => clock);
  await assert.rejects(search("owner", "first", async () => { calls++; throw { code: "57014" }; }));
  await assert.rejects(search("owner", "next", async () => ++calls), PersonNameSearchPausedError);
  assert.equal(calls, 1);
  clock += 60_001;
  assert.equal(await search("owner", "next", async () => ++calls), 2);
});

test("one canceled subscriber does not cancel another picker; all canceled means abort", async () => {
  const search = createPersonNameSearchGuard<number>();
  let resolve!: (value: number) => void; let requestSignal!: AbortSignal;
  const first = new AbortController(); const second = new AbortController();
  const request = (signal: AbortSignal) => { requestSignal = signal; return new Promise<number>((done) => { resolve = done; }); };
  const p1 = search("owner", "same", request, first.signal);
  const p2 = search("owner", "same", request, second.signal);
  first.abort(); await assert.rejects(p1, { name: "AbortError" });
  assert.equal(requestSignal.aborted, false);
  resolve(5); assert.equal(await p2, 5);
  const abandoned = new AbortController();
  const p3 = search("owner", "abandoned", request, abandoned.signal);
  abandoned.abort(); await assert.rejects(p3, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
  resolve(6); // Settles the shared worker without keeping a pending timeout.
  assert.equal(await search("owner", "new", async () => 7), 7);
});
