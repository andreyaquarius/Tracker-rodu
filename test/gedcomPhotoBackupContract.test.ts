import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("GEDCOM completion offers an optional Drive backup only after the core import is complete", () => {
  const button = source("../src/components/GedcomImportButton.tsx");
  const completeAt = button.indexOf("await completeGedcomImportOperation(importOperationId)");
  const planAt = button.indexOf("buildGedcomPhotoBackupPlan(");
  assert.ok(completeAt >= 0);
  assert.ok(planAt > completeAt);
  assert.match(button, /personIdRemap/);
  assert.match(button, /<GedcomPhotoBackupModal/);
});

test("photo backup UI requires explicit consent and explains the unknown lifetime", () => {
  const modal = source("../src/components/GedcomPhotoBackupModal.tsx");
  assert.match(modal, /Підключити Google Drive і зберегти/);
  assert.match(modal, /Не зараз/);
  assert.match(modal, /можуть перестати працювати будь-коли/);
  assert.match(modal, /Зрозуміло, завершити/);
  assert.match(modal, /повторний імпорт цього самого файла їх не відновить/);
  assert.match(modal, /Створіть у MyHeritage новий експорт із фото/);
  assert.match(modal, /copyableGedcomPhotoBackupPlan/);
  assert.match(modal, /beforeunload/);
  assert.match(modal, /progress\.processed \/ progress\.total/);
  assert.doesNotMatch(modal, /disabled=\{busy \|\| \(!driveReady/);
});

test("all GEDCOM entry points receive the shared batch backup callback", () => {
  const app = source("../src/App.tsx");
  const personsV2 = source("../src/features/persons-v2/PersonsModuleV2.tsx");
  const personsLegacy = source("../src/pages/PersonsPage.tsx");
  const familyTree = source("../src/pages/ProductionFamilyTreePage.tsx");
  assert.match(app, /backupImportedGedcomPhotos/);
  assert.match(personsV2, /onBackupGedcomPhotos=\{onBackupGedcomPhotos\}/);
  assert.match(personsLegacy, /onBackupGedcomPhotos=\{onBackupGedcomPhotos\}/);
  assert.match(familyTree, /onBackupGedcomPhotos=\{onBackupGedcomPhotos\}/);
});

test("production tree keeps the GEDCOM photo offer mounted while tree data reloads", () => {
  const familyTree = source("../src/pages/ProductionFamilyTreePage.tsx");
  const controlAt = familyTree.indexOf("const gedcomImportControl =");
  const loadingAt = familyTree.indexOf("if (loading)", controlAt);
  const normalRenderAt = familyTree.indexOf("const needsRoot", loadingAt);

  assert.ok(controlAt >= 0 && loadingAt > controlAt && normalRenderAt > loadingAt);
  assert.match(
    familyTree.slice(loadingAt, normalRenderAt),
    /if \(loading\)[\s\S]*?\{gedcomImportControl\}[\s\S]*?<FamilyTreeLoadingState \/>/,
  );
  assert.match(
    familyTree.slice(normalRenderAt),
    /return \([\s\S]*?\{gedcomImportControl\}/,
  );
  assert.match(familyTree, /key=\{`family-tree-gedcom-import:\$\{projectId\}`\}/);
});

test("GEDCOM entry points stay mounted when the create quota changes", () => {
  const button = source("../src/components/GedcomImportButton.tsx");
  const personsV2 = source("../src/features/persons-v2/PersonsModuleV2.tsx");
  const personsLegacy = source("../src/pages/PersonsPage.tsx");
  const familyTree = source("../src/pages/ProductionFamilyTreePage.tsx");

  assert.match(button, /disabled\?: boolean/);
  assert.match(button, /disabled=\{busy \|\| disabled\}/);
  assert.match(
    personsV2,
    /\{!readOnly && canUseGedcom \? \([\s\S]*?<GedcomImportButton[\s\S]*?disabled=\{!canCreate \|\| !canCreateTree \|\| gedcomImportGroups\.length > 0\}/,
  );
  assert.doesNotMatch(personsV2, /!readOnly && canCreate && canUseGedcom/);
  assert.match(personsLegacy, /\{canUseGedcom \? \([\s\S]*?<GedcomImportButton[\s\S]*?disabled=\{!canCreateRecords \|\| !canCreateTree\}/);
  assert.doesNotMatch(personsLegacy, /canCreateRecords && canUseGedcom/);
  assert.match(familyTree, /const gedcomImportControl = !readOnly && onImportRecords && onSaveRelation \? \(/);
  assert.match(familyTree, /disabled=\{!canImportGedcom\}/);
});

test("a completed tree import can reopen batch photo backup from persisted people", () => {
  const familyTree = source("../src/pages/ProductionFamilyTreePage.tsx");
  const tools = source("../src/components/familyTree/FamilyTreeToolsWindow.tsx");

  assert.match(
    familyTree,
    /buildGedcomPhotoBackupPlan\(persons, \{\}, persons\)/,
  );
  assert.match(familyTree, /function openGedcomPhotoRecovery\(\)/);
  assert.match(familyTree, /onOpenGedcomPhotoBackup=\{openGedcomPhotoRecovery\}/);
  assert.match(familyTree, /<GedcomPhotoBackupModal[\s\S]*?plan=\{gedcomPhotoRecovery\.plan\}/);
  assert.match(tools, /Зберегти фото з GEDCOM/);
  assert.match(tools, /gedcomPhotoBackupCount/);
});

test("Drive uploads use a deterministic deduplication property", () => {
  const drive = source("../src/services/googleDriveStorage.ts");
  const backup = source("../src/services/gedcomPhotoBackup.ts");
  assert.match(drive, /trackerRoduDeduplicationKey/);
  assert.match(drive, /findFileByDeduplicationKey/);
  assert.match(backup, /deduplicationKey: candidate\.deduplicationKey/);
});

test("Drive OAuth requests only the per-file scope and ignores old broad grants", () => {
  const drive = source("../src/services/googleDriveStorage.ts");
  assert.match(
    drive,
    /const GOOGLE_DRIVE_SCOPE = "https:\/\/www\.googleapis\.com\/auth\/drive\.file";/,
  );
  assert.doesNotMatch(drive, /drive\.readonly/);
  assert.match(drive, /include_granted_scopes:\s*false/);
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
