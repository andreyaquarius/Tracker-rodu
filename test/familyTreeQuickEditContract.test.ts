import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const dialog = readFileSync(
  new URL(
    "../src/components/familyTree/FamilyTreeQuickEditPersonDialog.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("production tree exposes quick edit only when the user can save", () => {
  assert.match(page, /onEditPerson=\{!readOnly && onSavePerson \?/);
  assert.match(page, /<FamilyTreeQuickEditPersonDialog/);
  assert.match(page, /const saved = await onSavePerson\(person\)/);
  assert.match(page, /reloadPedigreeAfterMutation\(\)/);
});

test("quick edit form covers names, life status and core facts", () => {
  assert.match(dialog, /update\("surname", event\.target\.value\)/);
  assert.match(dialog, /update\("givenName", event\.target\.value\)/);
  assert.match(dialog, /selectLifeStatus\(true\)/);
  assert.match(dialog, /title="Народження"/);
  assert.match(dialog, /title="Шлюб"/);
  assert.match(dialog, /title="Смерть"/);
  assert.match(dialog, /Відкрити повну картку/);
});
