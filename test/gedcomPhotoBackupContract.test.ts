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
  assert.match(modal, /beforeunload/);
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

test("Drive uploads use a deterministic deduplication property", () => {
  const drive = source("../src/services/googleDriveStorage.ts");
  const backup = source("../src/services/gedcomPhotoBackup.ts");
  assert.match(drive, /trackerRoduDeduplicationKey/);
  assert.match(drive, /findFileByDeduplicationKey/);
  assert.match(backup, /deduplicationKey: candidate\.deduplicationKey/);
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
