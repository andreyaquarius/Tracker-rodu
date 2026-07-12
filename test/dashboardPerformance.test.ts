import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboard = readFileSync(
  new URL("../src/pages/DashboardPage.tsx", import.meta.url),
  "utf8",
);
const globalSearch = readFileSync(
  new URL("../src/utils/globalSearch.ts", import.meta.url),
  "utf8",
);

test("dashboard does not build the large global-search index before search is used", () => {
  assert.match(
    dashboard,
    /hasSearchQuery\s*\?\s*createGlobalSearchIndex\(db\)\s*:\s*null/,
  );
  assert.match(dashboard, /useDeferredValue\(globalQuery\)/);
  assert.match(dashboard, /setTimeout\(onRequestSearchData,\s*300\)/);
});

test("global-search indexing resolves related records through ID maps", () => {
  assert.match(globalSearch, /documentById:\s*new Map/);
  assert.match(globalSearch, /findingById:\s*new Map/);
  assert.match(globalSearch, /personById:\s*new Map/);
  assert.match(globalSearch, /context\.documentById\.get\(id\)/);
  assert.match(globalSearch, /context\.findingById\.get\(id\)/);
  assert.match(globalSearch, /context\.personById\.get\(id\)/);

  assert.doesNotMatch(
    globalSearch,
    /db\.findings\.filter\(\(item\)\s*=>\s*findingIds\.includes/,
  );
  assert.doesNotMatch(
    globalSearch,
    /db\.persons\.filter\(\(item\)\s*=>\s*personIds\.includes/,
  );
});
