import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608140001_family_tree_root_replacement.sql",
    import.meta.url,
  ),
  "utf8",
);
const mutationService = readFileSync(
  new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
  "utf8",
);
const peopleService = readFileSync(
  new URL("../src/services/projectPeople.ts", import.meta.url),
  "utf8",
);
const toolsWindow = readFileSync(
  new URL("../src/components/familyTree/FamilyTreeToolsWindow.tsx", import.meta.url),
  "utf8",
);
const productionTree = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const personsModule = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);

test("tree-root RPCs enforce membership, edit access and project serialization", () => {
  assert.match(migration, /auth\.uid\(\) is null/i);
  assert.match(migration, /security_private\.is_project_member\(target_project_id\)/i);
  assert.match(migration, /security_private\.can_edit_project\(target_project_id\)/i);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(migration, /ROOT_PERSON_NOT_IN_PROJECT/i);
  assert.match(migration, /ROOT_REPLACEMENT_NOT_IN_PROJECT/i);
  assert.match(migration, /from public, anon, authenticated, service_role/i);
  assert.match(migration, /to authenticated, service_role/i);
});

test("root replacement and person deletion are one database transaction", () => {
  assert.match(
    migration,
    /create or replace function security_private\.replace_tree_roots_and_delete_project_persons/i,
  );
  assert.match(migration, /ROOT_REPLACEMENT_REQUIRED/i);
  assert.match(migration, /delete from public\.family_trees/i);
  assert.match(migration, /private\.delete_project_person_ids\([\s\S]*normalized_person_ids/i);
  assert.match(peopleService, /replace_tree_roots_and_delete_project_persons/i);
});

test("regular root changes use the atomic server contract", () => {
  const setRoot = mutationService.match(
    /export async function setFamilyTreeRoot[\s\S]*?\n}\n/,
  )?.[0] ?? "";
  assert.match(setRoot, /rpc\("set_family_tree_root"/i);
  assert.doesNotMatch(setRoot, /\.from\("family_trees"\)/i);
  assert.doesNotMatch(setRoot, /\.from\("family_tree_persons"\)/i);
});

test("production settings expose a persistent root selector without changing visual focus", () => {
  assert.match(toolsWindow, /<legend>Коренева особа<\/legend>/);
  assert.match(toolsWindow, /Поточна коренева особа/);
  assert.match(toolsWindow, /onSetTreeRoot/);
  assert.match(productionTree, /mutations\.setFamilyTreeRoot/);
  assert.match(productionTree, /rootCandidates=\{treeRootCandidates\}/);
  assert.match(productionTree, /onSetTreeRoot=\{setActiveTreeRoot\}/);
});

test("person deletion opens root replacement flow instead of the obsolete blocking alert", () => {
  assert.match(personsModule, /onListRootRequirements/);
  assert.match(personsModule, /RootPersonDeletionDialogV2/);
  assert.match(personsModule, /onDeletePersonsWithRootReplacements/);
  assert.doesNotMatch(
    personsModule,
    /Спочатку відкрийте налаштування дерева та виберіть іншу кореневу особу/,
  );
});
