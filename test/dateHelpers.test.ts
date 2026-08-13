import test from "node:test";
import assert from "node:assert/strict";
import {
  autoFormatFlexibleDateInput,
  formatDateForDisplay,
  formatDateTimeForDisplay,
  formatFlexibleDateForDisplay,
  normalizeFlexibleDateInput,
} from "../src/utils/dateHelpers.ts";

test("adds date separators after eight digits on numeric keyboards", () => {
  assert.equal(autoFormatFlexibleDateInput("01011865"), "01.01.1865");
  assert.equal(autoFormatFlexibleDateInput("1865"), "1865");
  assert.equal(autoFormatFlexibleDateInput("0101186"), "0101186");
  assert.equal(autoFormatFlexibleDateInput("01.01.1865"), "01.01.1865");
});

test("normalizes compact Ukrainian dates as DDMMYYYY", () => {
  assert.deepEqual(normalizeFlexibleDateInput("01011865"), { value: "1865-01-01" });
});

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

test("formats display dates without inventing missing precision", () => {
  assert.equal(formatDateForDisplay("2026-07-13"), "13.07.2026");
  assert.equal(formatDateForDisplay("2026-7"), "07.2026");
  assert.equal(formatDateForDisplay("2026"), "2026");
  assert.equal(formatDateForDisplay("близько 1850 року"), "близько 1850 року");
  assert.equal(formatDateForDisplay("2026-13"), "2026-13");
});

test("normalizes already-local full dates for display", () => {
  assert.equal(formatDateForDisplay("3.7.2026"), "03.07.2026");
  assert.equal(formatDateForDisplay("03/07/2026"), "03.07.2026");
});

test("formats timestamps with a full four-digit date and time", () => {
  const result = formatDateTimeForDisplay("2026-07-13T10:15:00");
  assert.match(result, /^13\.07\.2026[,\s]+10:15$/);
  assert.equal(formatDateTimeForDisplay("1852"), "1852");
  assert.equal(formatDateTimeForDisplay("not-a-date"), "not-a-date");
});
