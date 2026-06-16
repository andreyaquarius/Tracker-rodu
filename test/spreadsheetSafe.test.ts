import test from "node:test";
import assert from "node:assert/strict";
import { neutralizeSpreadsheetValue } from "../src/utils/spreadsheetSafe.ts";

// F-08: values starting with a formula trigger must be quoted as text.
test("neutralizes formula triggers", () => {
  assert.equal(neutralizeSpreadsheetValue("=1+1"), "'=1+1");
  assert.equal(neutralizeSpreadsheetValue("=cmd|'/C calc'!A1"), "'=cmd|'/C calc'!A1");
  assert.equal(neutralizeSpreadsheetValue("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  assert.equal(neutralizeSpreadsheetValue("+1+1"), "'+1+1");
  assert.equal(neutralizeSpreadsheetValue("-2+3"), "'-2+3");
  assert.equal(neutralizeSpreadsheetValue("\t=1"), "'\t=1");
});

test("leaves ordinary genealogical data untouched", () => {
  assert.equal(neutralizeSpreadsheetValue("Іван Петренко"), "Іван Петренко");
  assert.equal(neutralizeSpreadsheetValue("1920"), "1920");
  assert.equal(neutralizeSpreadsheetValue("https://archive.gov.ua"), "https://archive.gov.ua");
  assert.equal(neutralizeSpreadsheetValue(""), "");
});
