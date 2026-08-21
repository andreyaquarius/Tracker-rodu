import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const localGuide = readFileSync(
  new URL("../docs/ZAGULYAKY_LOCAL_TESTING.md", import.meta.url),
  "utf8",
);
const stage0Guide = readFileSync(
  new URL("../docs/ZAGULYAKY_STAGE0_POLICY_AND_LOCAL_TESTING.md", import.meta.url),
  "utf8",
);

test("local Zagulyaky handoff uses the pinned npm exec syntax and covers all Edge workflows", () => {
  for (const guide of [localGuide, stage0Guide]) {
    assert.doesNotMatch(guide, /npm\.cmd exec supabase --/);
    assert.match(guide, /npm\.cmd exec -- supabase/);
  }
  assert.match(
    localGuide,
    /npm\.cmd exec -- supabase db reset --local --sql-paths seed\/zagulyaky-local-demo\.sql/,
  );
  assert.match(localGuide, /npm\.cmd exec -- supabase functions serve/);
  assert.match(localGuide, /zagulyaky-stage0-import/);
  assert.match(localGuide, /zagulyaka-attachment/);
  assert.match(localGuide, /zagulyaky-storage-cleanup/);
  assert.match(localGuide, /http:\/\/localhost:5173\//);
  assert.match(localGuide, /destructive|руйнів/i);
});
