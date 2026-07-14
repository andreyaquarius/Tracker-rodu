import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);

test("production tree does not duplicate the card add-relative action with a canvas placeholder", () => {
  assert.match(productionPage, /showUnknownParentPlaceholders:\s*false/);
  assert.doesNotMatch(
    productionPage,
    /showUnknownParentPlaceholders:\s*!readOnly\s*&&\s*canCreate/,
  );
});
