import assert from "node:assert/strict";
import test from "node:test";
import { parseAppRoute } from "../src/utils/appRoutes.ts";
import { productAnalyticsPageCode } from "../src/utils/productAnalyticsRegistry.ts";

test("classifies private routes without retaining dynamic identifiers", () => {
  const projectId = "project-private-6ff089";
  const personId = "person-private-662eda";
  const route = parseAppRoute(`/projects/${projectId}/persons/${personId}`);
  const code = productAnalyticsPageCode(route);

  assert.equal(code, "person_profile");
  assert.equal(JSON.stringify(code).includes(projectId), false);
  assert.equal(JSON.stringify(code).includes(personId), false);
});

test("classifies stable tree and settings routes", () => {
  assert.equal(
    productAnalyticsPageCode(parseAppRoute("/projects/tree/rodove-derevo")),
    "family_tree",
  );
  assert.equal(
    productAnalyticsPageCode(parseAppRoute("/projects/tree/rodove-derevo/statystyka")),
    "tree_statistics",
  );
  assert.equal(productAnalyticsPageCode(parseAppRoute("/settings")), "settings");
});
