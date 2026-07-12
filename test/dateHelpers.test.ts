import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFlexibleDateForDisplay,
  normalizeFlexibleDateInput,
} from "../src/utils/dateHelpers.ts";

test("normalizes Ukrainian dotted dates", () => {
  assert.deepEqual(normalizeFlexibleDateInput("08.02.1852"), { value: "1852-02-08" });
  assert.deepEqual(normalizeFlexibleDateInput("8.2.1852"), { value: "1852-02-08" });
});

test("normalizes slash dates", () => {
  assert.deepEqual(normalizeFlexibleDateInput("08/02/1852"), { value: "1852-02-08" });
  assert.deepEqual(normalizeFlexibleDateInput("8/2/1852"), { value: "1852-02-08" });
});

test("keeps ISO dates as storage format", () => {
  assert.deepEqual(normalizeFlexibleDateInput("1852-02-08"), { value: "1852-02-08" });
});

test("accepts year-only dates for incomplete genealogical facts", () => {
  assert.deepEqual(normalizeFlexibleDateInput("1852"), { value: "1852" });
});

test("rejects ambiguous or impossible dates", () => {
  assert.equal(Boolean(normalizeFlexibleDateInput("08.02.52").error), true);
  assert.equal(Boolean(normalizeFlexibleDateInput("31.02.1852").error), true);
});

test("formats stored dates for display", () => {
  assert.equal(formatFlexibleDateForDisplay("1852-02-08"), "08.02.1852");
  assert.equal(formatFlexibleDateForDisplay("1852"), "1852");
  assert.equal(formatFlexibleDateForDisplay(""), "");
});
