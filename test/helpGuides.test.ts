import test from "node:test";
import assert from "node:assert/strict";

import {
  fullHelpTourKeys,
  helpGuideForPage,
  helpGuides,
} from "../src/help/helpGuides.ts";

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

test("every module tour has content and custom pages use the custom guide", () => {
  for (const guideKey of fullHelpTourKeys) {
    assert.equal(helpGuides[guideKey].key, guideKey);
    assert.ok(helpGuides[guideKey].steps.length > 0, guideKey);
  }
  assert.equal(helpGuideForPage("custom:family-notes").key, "custom");
  assert.equal(helpGuideForPage(null).key, "workspace-intro");
});
