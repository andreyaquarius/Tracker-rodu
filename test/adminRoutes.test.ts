import assert from "node:assert/strict";
import test from "node:test";
import { adminPath, parseAppRoute, type AdminPage } from "../src/utils/appRoutes.ts";

const ADMIN_PAGES: AdminPage[] = [
  "overview",
  "analytics",
  "subscriptions",
  "features",
  "announcements",
  "feedback",
  "operations",
  "security",
];

test("builds and parses every private admin route", () => {
  for (const page of ADMIN_PAGES) {
    const path = adminPath(page);
    assert.deepEqual(parseAppRoute(path), { kind: "admin", page });
  }
});

test("does not treat unknown admin sections as the overview", () => {
  assert.deepEqual(parseAppRoute("/admin/private-user-data"), { kind: "unknown" });
  assert.deepEqual(parseAppRoute("/admin/access"), { kind: "unknown" });
});
