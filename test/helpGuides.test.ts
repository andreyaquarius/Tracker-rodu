import test from "node:test";
import assert from "node:assert/strict";

import { helpGuideForPage } from "../src/help/helpGuides.ts";

test("returns a help guide for the family tree page", () => {
  const guide = helpGuideForPage("familyTree");

  assert.equal(guide.key, "familyTree");
  assert.equal(guide.title, "Родове дерево");
  assert.ok(guide.steps.length > 0);
});

test("falls back to the intro guide for unknown page keys", () => {
  const guide = helpGuideForPage("unknown-page" as never);

  assert.equal(guide.key, "workspace-intro");
});
