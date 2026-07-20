import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("table import is hidden by capacity and reserves the authoritative monthly quota", () => {
  const app = readSource("../src/App.tsx");
  const personsV2 = readSource("../src/features/persons-v2/PersonsModuleV2.tsx");
  const personsLegacy = readSource("../src/pages/PersonsPage.tsx");

  assert.match(app, /import\s*\{[\s\S]*beginTableImport[\s\S]*\}\s*from\s*"\.\/services\/subscriptionService"/u);
  assert.match(app, /!subscriptionAccess\.canImportTable[\s\S]*PLAN_LIMIT_REACHED:table_imports_per_month/u);
  assert.match(app, /await beginTableImport\(projectId\)/u);
  assert.match(app, /onImportRecords=\{subscriptionAccess\.canImportTable \? importTableRecords : undefined\}/u);
  assert.match(personsV2, /!readOnly && canCreate && canImportTable/u);
  assert.match(personsLegacy, /canCreateRecords && canImportTable/u);
});

test("person and GEDCOM creation no longer inherit the legacy research requirement", () => {
  const app = readSource("../src/App.tsx");
  const scopedCollections = app.slice(
    app.indexOf("const researchScopedCollections"),
    app.indexOf("const standardSectionQuotaKeys"),
  );

  assert.doesNotMatch(scopedCollections, /"persons"/u);
  assert.doesNotMatch(app, /validateResearchScope\("persons", input\.personRecords\)/u);
  assert.doesNotMatch(app, /validateResearchScope\("documents", input\.documents\)/u);
  assert.match(app, /gedcomResearchRequired=\{false\}/u);
  assert.ok(
    (app.match(/researchRequired=\{false\}/gu)?.length ?? 0) >= 2,
    "both person-module variants disable the obsolete requirement",
  );
});

test("tree and person capacity changes refresh subscription state immediately", () => {
  const app = readSource("../src/App.tsx");
  const familyTree = readSource("../src/pages/FamilyTreePage.tsx");
  const productionTree = readSource("../src/pages/ProductionFamilyTreePage.tsx");
  const team = readSource("../src/components/ProjectTeamModal.tsx");

  assert.match(app, /onSubscriptionChanged=\{\(\) => void subscriptionAccess\.refreshSubscription\(\)\}/u);
  assert.ok(
    (familyTree.match(/onSubscriptionChanged\?\.\(\)/gu)?.length ?? 0) >= 6,
    "legacy tree refreshes after tree and person mutations",
  );
  assert.ok(
    (productionTree.match(/onSubscriptionChanged\?\.\(\)/gu)?.length ?? 0) >= 3,
    "production tree refreshes after root, GEDCOM and relative creation",
  );
  assert.ok(
    (team.match(/onSubscriptionChanged\?\.\(\)/gu)?.length ?? 0) >= 5,
    "all editor-seat mutations refresh capacity",
  );
  assert.ok(
    (app.match(/void subscriptionAccess\.refreshSubscription\(\)/gu)?.length ?? 0) >= 5,
    "imports and destructive capacity changes refresh the application context",
  );
});

test("legacy and production tree creation controls respect person and tree capacity", () => {
  const legacy = readSource("../src/pages/FamilyTreePage.tsx");
  const production = readSource("../src/pages/ProductionFamilyTreePage.tsx");
  const personsV2 = readSource("../src/features/persons-v2/PersonsModuleV2.tsx");

  assert.match(legacy, /onAction=\{!readOnly && canCreate \? openBuilderActionFromOccurrence : undefined\}/u);
  assert.match(legacy, /onAction=\{!readOnly && canCreate \? openBuilderAction : undefined\}/u);
  assert.match(production, /const canImportGedcom = Boolean\([\s\S]*canCreateTree[\s\S]*onImportRecords/u);
  assert.match(personsV2, /disabled=\{!canCreate \|\| !canCreateTree \|\| gedcomImportGroups\.length > 0\}/u);
});

test("upgrade guidance uses the project owner's capacity plan", () => {
  const app = readSource("../src/App.tsx");

  assert.match(app, /const projectCapacityPlan = projectCapacity\?\.effectivePlanCode/u);
  assert.match(app, /projectCapacity\.ownerId !== account\.id/u);
  assert.match(app, /Змінити тариф або звільнити місце може лише власник цього проєкту/u);
  assert.match(app, /projectCapacityPlan === "free"[\s\S]*\? "researcher"[\s\S]*: "professional"/u);
  assert.match(app, /currentPlan=\{projectCapacityPlan\}/u);
});

test("legal pages and runtime config publish the current tariff revision", () => {
  const config = readSource("../src/config/legal.ts");
  const terms = readSource("../public/terms/index.html");
  const privacy = readSource("../public/privacy/index.html");

  assert.match(config, /id:\s*"2026-07-20"/u);
  assert.match(config, /label:\s*"20 липня 2026 року"/u);
  assert.match(terms, /Редакція:\s*20 липня 2026 року/u);
  assert.match(privacy, /Редакція:\s*20 липня 2026 року/u);
});
