import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("modal layout follows the expanded or collapsed Tracker workspace", () => {
  const modal = source("../src/components/Modal.tsx");
  const styles = source("../src/styles.css");

  assert.match(modal, /SIDEBAR_LAYOUT_CHANGE_EVENT/);
  assert.match(modal, /getPropertyValue\("--app-sidebar-width"\)/);
  assert.match(styles, /padding:\s*30px 30px 30px calc\(var\(--app-sidebar-width, 340px\) \+ 30px\)/);
  assert.match(styles, /\.modal \{[^}]*overflow-x:\s*hidden/s);
});

test("draggable modal stays inside the viewport when its content becomes taller", () => {
  const modal = source("../src/components/Modal.tsx");
  const styles = source("../src/styles.css");

  assert.match(modal, /new ResizeObserver\(clampToViewport\)/);
  assert.match(modal, /resizeObserver\?\.observe\(modal\)/);
  assert.match(modal, /resizeObserver\?\.disconnect\(\)/);
  assert.match(styles, /\.modal \{[^}]*max-height:\s*calc\(100dvh - 60px\)[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.modal-header \{[^}]*position:\s*sticky[^}]*top:\s*0/s);
});

test("GEDCOM and relative dialogs own padded, non-overflowing content areas", () => {
  const gedcom = source("../src/components/GedcomImportButton.tsx");
  const familyTree = source("../src/pages/ProductionFamilyTreePage.tsx");
  const styles = source("../src/styles.css");

  assert.match(gedcom, /className="gedcom-import-modal"/);
  assert.match(gedcom, /className="gedcom-import-dialog-body"/);
  assert.match(familyTree, /className="family-tree-relative-modal"/);
  assert.match(styles, /\.gedcom-import-preview \{[^}]*padding:\s*22px 24px/s);
  assert.match(styles, /\.gedcom-import-dialog-body > \.details-actions \{[^}]*margin:\s*0/s);
  assert.match(styles, /\.family-tree-v2-relative-menu \{[^}]*padding:\s*22px 24px 24px/s);
});

test("GEDCOM central-person picker shows search before the current selection", () => {
  const gedcom = source("../src/components/GedcomImportButton.tsx");
  const searchPosition = gedcom.indexOf('className="gedcom-root-person-picker__search"');
  const selectedPosition = gedcom.indexOf('className="gedcom-root-person-picker__selected"');

  assert.notEqual(searchPosition, -1);
  assert.notEqual(selectedPosition, -1);
  assert.ok(searchPosition < selectedPosition);
  assert.match(gedcom, /className="gedcom-root-person-picker__selected" aria-live="polite"/);
});

test("topbar popovers stay above tree chrome while dialogs stay above the topbar", () => {
  const modal = source("../src/components/Modal.tsx");
  const styles = source("../src/styles.css");

  assert.match(styles, /\.topbar \{[^}]*z-index:\s*90/s);
  assert.match(styles, /\.family-tree-v2-shell \{[^}]*isolation:\s*isolate/s);
  assert.match(modal, /const MODAL_BASE_Z_INDEX = 100/);
});
