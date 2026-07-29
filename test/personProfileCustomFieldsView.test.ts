import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const profile = source("../src/features/persons-v2/PersonProfileV2.tsx");
const moduleSource = source("../src/features/persons-v2/PersonsModuleV2.tsx");

test("person profile view renders persisted custom fields, not only the editor", () => {
  assert.match(profile, /import\s*\{\s*CustomFieldsView\s*\}\s*from\s*"\.\.\/\.\.\/components\/CustomFields"/u);
  assert.match(profile, /import\s*\{\s*normalizeCustomFieldValues\s*\}\s*from\s*"\.\.\/\.\.\/utils\/customFields"/u);
  assert.match(profile, /customFieldDefinitions\?:\s*(?:readonly\s+)?CustomFieldDefinition\[\]/u);

  const overview = profile.match(
    /function OverviewPanelV2\([\s\S]*?\nfunction TimelinePanelV2\(/u,
  )?.[0] ?? "";

  assert.match(overview, /<CustomFieldsView/u);
  assert.match(overview, /db=\{db\}/u);
  assert.match(overview, /definitions=\{customFieldDefinitions\}/u);
  assert.match(
    overview,
    /values=\{normalizeCustomFieldValues\(person\.customFields\)\}/u,
  );
});

test("persons module passes custom-field context into the read-only profile", () => {
  const profileRoute = moduleSource.match(
    /if \(target\.mode === "profile"\)[\s\S]*?\n\s*if \(familyOrderStatus === "loading"\)/u,
  )?.[0] ?? "";

  assert.match(profileRoute, /<PersonProfileV2/u);
  assert.match(profileRoute, /db=\{db\}/u);
  assert.match(
    profileRoute,
    /customFieldDefinitions=\{customFieldDefinitions\}/u,
  );
});
