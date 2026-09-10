import assert from "node:assert/strict";
import test from "node:test";
import { selectRowsByUpdatedCursor } from "../src/utils/pagedRows.ts";

test("compound cursor preserves timestamp ties, bounded pages, and no OFFSET", async () => {
  const rows = [{ id: "a", updated_at: "2026-09-10T10:00:00Z" }, { id: "b", updated_at: "2026-09-10T10:00:00Z" },
    { id: "c", updated_at: "2026-09-09T10:00:00Z" }, { id: "d", updated_at: "2026-09-09T10:00:00Z" }];
  const filters: string[] = [];
  let page = 0;
  const result = await selectRowsByUpdatedCursor(() => ({
    or(filter: string) { filters.push(filter); return this; },
    async limit(count: number) { assert.equal(count, 2); return { data: rows.slice(page++ * 2, page * 2), error: null }; },
  }), 2);
  assert.deepEqual(result, rows);
  assert.deepEqual(filters, [
    'updated_at.lt."2026-09-10T10:00:00Z",and(updated_at.eq."2026-09-10T10:00:00Z",id.gt."b")',
    'updated_at.lt."2026-09-09T10:00:00Z",and(updated_at.eq."2026-09-09T10:00:00Z",id.gt."d")',
  ]);
});

test("compound cursor propagates errors and stops a non-advancing server", async () => {
  const repeating = () => ({ or() { return this; }, async limit() { return { data: [{ id: "a", updated_at: "today" }], error: null }; } });
  await assert.rejects(selectRowsByUpdatedCursor(repeating, 1), /did not advance/);
  await assert.rejects(selectRowsByUpdatedCursor(() => ({ or() { return this; }, async limit() { return { data: null, error: new Error("denied") }; } })), /denied/);
});
