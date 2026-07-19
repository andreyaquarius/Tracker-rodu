import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isMissingFindingsSourceUrlError } from "../supabase/functions/_shared/gedcomExportProcessor.ts";

const processor = readFileSync(
  new URL("../supabase/functions/_shared/gedcomExportProcessor.ts", import.meta.url),
  "utf8",
);

test("recognizes only missing findings.source_url schema errors", () => {
  assert.equal(isMissingFindingsSourceUrlError({
    code: "42703",
    message: "column findings.source_url does not exist",
  }), true);
  assert.equal(isMissingFindingsSourceUrlError({
    code: "42703",
    message: 'column "source_url" does not exist',
  }), true);
  assert.equal(isMissingFindingsSourceUrlError({
    code: "PGRST204",
    message: "Could not find the 'source_url' column of 'findings' in the schema cache",
  }), true);

  assert.equal(isMissingFindingsSourceUrlError({
    code: "42703",
    message: "column findings.summary does not exist",
  }), false);
  assert.equal(isMissingFindingsSourceUrlError({
    code: "42703",
    message: "column documents.source_url does not exist",
  }), false);
  assert.equal(isMissingFindingsSourceUrlError({
    code: "42P01",
    message: "relation findings does not exist",
  }), false);
  assert.equal(isMissingFindingsSourceUrlError(new Error("network unavailable")), false);
});

test("GEDCOM findings retry the legacy projection only for the guarded schema error", () => {
  assert.match(processor, /catch \(error\) \{[\s\S]*?if \(!isMissingFindingsSourceUrlError\(error\)\) throw error;[\s\S]*?FINDING_SELECT_LEGACY/u);
  assert.match(processor, /legacyRows\.map\(\(row\) => \(\{ \.\.\.row, source_url: "" \}\)\)/u);
});
