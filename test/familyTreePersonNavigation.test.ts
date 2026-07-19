import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  selectFamilyTreeEntryPointForPerson,
} from "../src/utils/familyTreePersonNavigation.ts";
import type { FamilyTreeEntryPoint } from "../src/services/familyTreeNeighborhoodService.ts";

const entries: FamilyTreeEntryPoint[] = [
  {
    id: "tree-first",
    projectId: "project",
    title: "Перше",
    rootPersonId: "root-first",
    isDefault: false,
    graphVersion: "1",
  },
  {
    id: "tree-default",
    projectId: "project",
    title: "Основне",
    rootPersonId: "root-default",
    isDefault: true,
    graphVersion: "2",
  },
  {
    id: "tree-empty",
    projectId: "project",
    title: "Порожнє",
    rootPersonId: null,
    isDefault: false,
    graphVersion: "3",
  },
];

test("person-to-tree selection prefers the active member tree, then default, then first", () => {
  assert.equal(
    selectFamilyTreeEntryPointForPerson(
      entries,
      ["tree-first", "tree-default"],
      "tree-first",
    )?.id,
    "tree-first",
  );
  assert.equal(
    selectFamilyTreeEntryPointForPerson(
      entries,
      ["tree-first", "tree-default"],
      "tree-missing",
    )?.id,
    "tree-default",
  );
  assert.equal(
    selectFamilyTreeEntryPointForPerson(entries, ["tree-first"])?.id,
    "tree-first",
  );
});

test("person-to-tree selection rejects roots without visible membership and unavailable trees", () => {
  assert.equal(selectFamilyTreeEntryPointForPerson(entries, []), null);
  assert.equal(
    selectFamilyTreeEntryPointForPerson(entries, ["tree-empty"]),
    null,
  );
  assert.equal(selectFamilyTreeEntryPointForPerson(entries, []), null);
});

test("membership reader excludes hidden tree members", () => {
  const source = readFileSync(
    new URL("../src/services/familyTreeNeighborhoodService.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /from\("family_tree_persons"\)[\s\S]*?\.eq\("person_id", normalizedPersonId\)[\s\S]*?\.neq\("member_role", "hidden"\)/,
  );
});

test("person card navigation focuses a tree without replacing its persisted root", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const module = readFileSync(
    new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
    "utf8",
  );
  const profile = readFileSync(
    new URL("../src/features/persons-v2/PersonProfileV2.tsx", import.meta.url),
    "utf8",
  );
  const preview = readFileSync(
    new URL("../src/features/persons-v2/PersonPreviewDrawerV2.tsx", import.meta.url),
    "utf8",
  );
  const production = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const legacy = readFileSync(
    new URL("../src/pages/FamilyTreePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(profile, /onShowInTree\?: \(person: Person\) => void/);
  assert.match(profile, /onClick=\{\(\) => onShowInTree\(person\)\}[\s\S]*?Показати в дереві/);
  assert.match(preview, /onShowInTree\?: \(person: Person\) => void/);
  assert.match(preview, /Показати в дереві/);
  assert.match(module, /onShowInTree=\{onShowInTree\}/);
  assert.match(app, /readFamilyTreeEntryPointForPerson\([\s\S]*?familyTreePath\(workspace\.projectSlug/);
  assert.match(app, /showPersonInTreeRequestRef\.current !== requestId/);
  assert.match(app, /currentContext\.location !== requestedLocation/);
  assert.match(app, /initialTreeId=\{familyTreeRouteFocus\.treeId\}/);
  assert.match(app, /initialFocusPersonId=\{familyTreeRouteFocus\.focusPersonId\}/);
  assert.match(
    production,
    /selectedEntry\?\.id === initialTreeId\.trim\(\)[\s\S]*?initialFocusPersonId=\{routedFocusPersonId\}/,
  );
  assert.match(production, /\[homePersonId, requestedFocusPersonId\]/);
  assert.match(
    production,
    /appliedRouteFocusRef[\s\S]*?changeFocus\(personId\)[\s\S]*?\[initialFocusPersonId\]/,
  );
  assert.match(
    production,
    /onActiveContextChange\?\.\(\{[\s\S]*?rootPersonId: selectedEntry\.rootPersonId/,
  );

  const legacyRouteFocus = legacy.slice(
    legacy.indexOf("const personId = initialFocusPersonId?.trim()"),
    legacy.indexOf("const updateToolbar", legacy.indexOf("const personId = initialFocusPersonId?.trim()")),
  );
  assert.match(legacyRouteFocus, /setSelectedOccurrenceId\(occurrence\.id\)/);
  assert.match(legacyRouteFocus, /setFocusOccurrenceId\(occurrence\.id\)/);
  assert.match(legacyRouteFocus, /filteredGraph\.treeId !== routedTreeId/);
  assert.doesNotMatch(legacyRouteFocus, /updateToolbar|persistFamilyTreeRoot|rootPersonId/);
});
