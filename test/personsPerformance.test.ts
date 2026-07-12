import test from "node:test";
import assert from "node:assert/strict";
import { dataGroupsForPage } from "../src/utils/projectDataGroups.ts";
import { selectRowsInParallel } from "../src/utils/pagedRows.ts";

test("persons page hydrates card data without loading the document collection", () => {
  const groups = dataGroupsForPage("persons");

  assert.deepEqual([...groups], ["researches", "people"]);
  assert.equal(groups.has("documents"), false);
});

test("large people collections request three pages concurrently and preserve row order", async () => {
  const requestedRanges: Array<[number, number]> = [];
  let activeRequests = 0;
  let peakConcurrency = 0;

  const rows = await selectRowsInParallel(() => ({
    range: async (from: number, to: number) => {
      requestedRanges.push([from, to]);
      activeRequests += 1;
      peakConcurrency = Math.max(peakConcurrency, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const count = from === 0 ? 1_000 : from === 1_000 ? 1_000 : from === 2_000 ? 480 : 0;
      return {
        data: Array.from({ length: count }, (_, index) => from + index),
        error: null,
      };
    },
  }));

  assert.equal(peakConcurrency, 3);
  assert.deepEqual(requestedRanges, [[0, 999], [1_000, 1_999], [2_000, 2_999]]);
  assert.equal(rows.length, 2_480);
  assert.equal(rows[0], 0);
  assert.equal(rows[2_479], 2_479);
});

test("a heavy table can serialize its 2,480-row pages to avoid statement bursts", async () => {
  const requestedRanges: Array<[number, number]> = [];
  let activeRequests = 0;
  let peakConcurrency = 0;

  const rows = await selectRowsInParallel(() => ({
    range: async (from: number, to: number) => {
      requestedRanges.push([from, to]);
      activeRequests += 1;
      peakConcurrency = Math.max(peakConcurrency, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const count = Math.max(0, Math.min(1_000, 2_480 - from));
      return {
        data: Array.from({ length: count }, (_, index) => from + index),
        error: null,
      };
    },
  }), 1_000, 1);

  assert.equal(peakConcurrency, 1);
  assert.deepEqual(requestedRanges, [[0, 999], [1_000, 1_999], [2_000, 2_999]]);
  assert.equal(new Set(rows).size, 2_480);
  assert.equal(rows[2_479], 2_479);
});
