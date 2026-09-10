import assert from "node:assert/strict";
import test from "node:test";
import { createPersonSummaryCache } from "../src/utils/personSummaryCache.ts";
import type { ProjectPersonSummary } from "../src/services/projectPersonSummaries.ts";

const value = (id: string): ProjectPersonSummary => ({ personId: id, relationCount: 1, taskCount: 0,
  findingCount: 0, documentCount: 0, hypothesisCount: 0, archiveRequestCount: 0, lastEventType: null, lastEventDate: null });

test("summary cache only loads missing/changed persons and expires or changes account scope", async () => {
  let clock = 0;
  const cache = createPersonSummaryCache(() => clock);
  const calls: string[][] = [];
  const load = async (ids: string[]) => { calls.push(ids); return new Map(ids.map((id) => [id, value(id)])); };
  const signal = new AbortController().signal;
  await cache.load("account/project", new Map([["a", "1"], ["b", "1"]]), load, signal);
  await cache.load("account/project", new Map([["a", "1"], ["b", "2"]]), load, signal);
  await cache.load("account/project", new Map([["a", "1"]]), load, signal);
  assert.deepEqual(calls, [["a", "b"], ["b"]]);
  clock = 30_001;
  await cache.load("account/project", new Map([["a", "1"]]), load, signal);
  await cache.load("different-account/project", new Map([["a", "1"]]), load, signal);
  assert.deepEqual(calls.slice(2), [["a"], ["a"]]);
});

test("summary cache batches at 200, caches RLS omissions, and never caches errors", async () => {
  const cache = createPersonSummaryCache();
  const signal = new AbortController().signal;
  const revisions = new Map(Array.from({ length: 450 }, (_, n) => [String(n), "1"]));
  const sizes: number[] = [];
  await cache.load("scope", revisions, async (ids) => { sizes.push(ids.length); return new Map(); }, signal);
  await cache.load("scope", revisions, async () => { assert.fail("already fetched, including omissions"); }, signal);
  assert.deepEqual(sizes, [200, 200, 50]);
  cache.clear();
  await assert.rejects(cache.load("scope", revisions, async () => { throw new Error("offline"); }, signal));
  await cache.load("scope", new Map([["1", "1"]]), async (ids) => new Map([[ids[0], value(ids[0])]]), signal);
});

test("summary cache rejects a late result after logout/invalidation or cancellation", async () => {
  const cache = createPersonSummaryCache();
  let finish!: (value: Map<string, ProjectPersonSummary>) => void;
  const result = cache.load("scope", new Map([["a", "1"]]), () => new Promise((resolve) => { finish = resolve; }), new AbortController().signal);
  cache.clear();
  finish(new Map([["a", value("a")]]));
  await assert.rejects(result, { name: "AbortError" });
});
