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
const projectDashboard = readFileSync(
  new URL("../src/services/projectDashboard.ts", import.meta.url),
  "utf8",
);

test("dashboard uses bounded server search for projects and keeps local search as fallback", () => {
  assert.match(
    dashboard,
    /!projectId\s*&&\s*hasSearchQuery\s*\?\s*createGlobalSearchIndex\(db\)\s*:\s*null/,
  );
  assert.match(dashboard, /useDeferredValue\(globalQuery\)/);
  assert.match(dashboard, /searchProjectRecords\(projectId, searchedQuery\)/);
  assert.match(dashboard, /window\.setTimeout\(\(\) =>/);
  assert.match(dashboard, /searchedQuery\.length < 3/);
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

test("dashboard requests are coalesced and briefly cached per project", () => {
  assert.match(projectDashboard, /DASHBOARD_CACHE_TTL_MS\s*=\s*20_000/);
  assert.match(projectDashboard, /dashboardRequests\.get\(projectId\)/);
  assert.match(projectDashboard, /dashboardRequests\.set\(projectId, request\)/);
  assert.match(projectDashboard, /dashboardCache\.set\(projectId/);
  assert.match(projectDashboard, /options\.force/);
  assert.match(projectDashboard, /invalidateProjectDashboard/);
});
