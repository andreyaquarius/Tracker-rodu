import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

test("all parameters in the tree popover come from one persistent per-tree preference", () => {
  assert.match(page, /useFamilyTreeViewPreferences\(projectId, entryPoint\.id\)/);
  assert.match(
    page,
    /preferences: viewPreferences,[\s\S]*?ready: viewPreferencesReady,[\s\S]*?updatePreferences: updateViewPreferences/,
  );
  for (const field of [
    "ancestorDepth",
    "descendantDepth",
    "collateralDepth",
    "showAllParentSets",
    "activeParentSetByChild",
  ]) {
    assert.match(page, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(page, /const \[(?:ancestorDepth|descendantDepth|collateralDepth|showAllParentSets|activeParentSetByChild),\s*set/);
  assert.match(page, /Збережено для вашого облікового запису й цього дерева/);
  assert.match(
    page,
    /enabled:\s*viewPreferencesUsable/,
  );
  assert.match(styles, /\.family-tree-v2-view-settings-sync\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
});

test("each parameter writes through the persistent updater and waits for scoped hydration", () => {
  assert.match(page, /ancestorDepth:\s*nonNegativeInteger\(event\.target\.value, 7\)/);
  assert.match(page, /descendantDepth:\s*nonNegativeInteger\(event\.target\.value, 0\)/);
  assert.match(page, /collateralDepth:\s*event\.target\.checked \? 1 : 0/);
  assert.match(page, /showAllParentSets:\s*event\.target\.checked/);
  assert.match(
    page,
    /activeParentSetByChild:\s*\{[\s\S]*?\.\.\.current\.activeParentSetByChild,[\s\S]*?\[focusPersonId\]: event\.target\.value/,
  );
  assert.ok(
    page.match(/disabled=\{specialPerspectiveActive \|\| !viewPreferencesReady\}/g)?.length === 5,
    "all five controls must wait until the authenticated cache scope is ready",
  );
});

test("temporary perspectives retain live preferences and stale parent-set ids fall back safely", () => {
  const restoreStart = page.indexOf("function restorePedigreeSnapshot");
  const restoreEnd = page.indexOf("function enterAllDescendants", restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const restore = page.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(
    restore,
    /updateViewPreferences|setAncestorDepth|setDescendantDepth|setCollateralDepth|setShowAllParentSets|setActiveParentSetByChild/,
  );
  assert.match(
    page,
    /const effectiveActiveParentSetId = parentSetOptions\.some\([\s\S]*?\? requestedActiveParentSetId[\s\S]*?: parentSetOptions\[0\]\?\.id \?\? ""/,
  );
  assert.match(page, /value=\{effectiveActiveParentSetId\}/);
});
