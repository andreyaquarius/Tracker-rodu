import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFindingSourceUrl,
  resolvedFindingSourceUrl,
  stripFindingSourceUrls,
} from "../src/utils/findingSourceUrl.ts";

test("extractFindingSourceUrl accepts safe HTTP(S) links and trims sentence punctuation", () => {
  assert.equal(
    extractFindingSourceUrl("See https://example.test/catalog/42)."),
    "https://example.test/catalog/42",
  );
  assert.equal(extractFindingSourceUrl("javascript:alert(1)"), "");
});

test("stripFindingSourceUrls removes repeated links without damaging surrounding source text", () => {
  assert.equal(
    stripFindingSourceUrls([
      "Parish register · https://example.test/record/42",
      "page 12 — https://example.test/record/42",
    ].join("\n")),
    "Parish register\npage 12",
  );
});

test("resolvedFindingSourceUrl prefers the dedicated field and supports legacy malformed imports", () => {
  const common = {
    file: "",
    page: "",
    summary: "",
    description: "",
    transcription: "",
    notes: "",
    archive: "",
    fund: "",
  };
  assert.equal(
    resolvedFindingSourceUrl({
      ...common,
      sourceUrl: "https://example.test/preferred",
      notes: "https://example.test/legacy",
    }),
    "https://example.test/preferred",
  );
  assert.equal(
    resolvedFindingSourceUrl({
      ...common,
      sourceUrl: "",
      summary: "Imported source https://example.test/legacy",
    }),
    "https://example.test/legacy",
  );
});
