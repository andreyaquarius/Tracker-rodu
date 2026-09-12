import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Person, PersonName } from "../src/types/index.ts";
import type { ProjectPersonMarriage } from "../src/services/projectPersonMarriages.ts";
import { resolvePersonCardNameDisplay } from "../src/utils/personCardNameDisplay.ts";
import { personTreeNameFields } from "../src/utils/personTreeName.ts";
import { applyFamilyTreeNameDisplay } from "../src/features/family-tree-view/adapters/familyTreeNameDisplay.ts";
import { partnershipNameDisplayOrder } from "../src/features/family-tree-view/adapters/trackerFamilyTreeAdapter.ts";
import { DEFAULT_FAMILY_TREE_APPEARANCE, type MarriedSurnameDisplay } from "../src/utils/familyTreeAppearance.ts";

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "woman", surname: "Коваленко", maidenSurname: "Петренко", givenName: "Олена",
    patronymic: "Іванівна", fullName: "Коваленко Олена Іванівна", gender: "жінка",
    ...overrides,
  } as Person;
}
function name(overrides: Partial<PersonName> = {}): PersonName {
  return {
    id: "name", personId: "woman", nameType: "birth", surname: "Петренко", maidenSurname: "",
    givenName: "Олена", patronymic: "Іванівна", fullName: "Петренко Олена Іванівна", fullNormalized: "",
    originalText: "", isPrimary: false, isPreferred: false, evidenceStatus: "proven", confidence: 100,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", metadata: {},
    ...overrides,
  } as PersonName;
}
function preference(mode: MarriedSurnameDisplay, infer = false) {
  return { marriedSurnameDisplay: mode, inferMarriedSurnameFromHusband: infer };
}
const formats: Array<[MarriedSurnameDisplay, string]> = [
  ["maiden-only", "Петренко Олена Іванівна"],
  ["married-only", "Коваленко Олена Іванівна"],
  ["maiden-with-married", "Петренко (Коваленко) Олена Іванівна"],
  ["married-with-maiden", "Коваленко (Петренко) Олена Іванівна"],
];

for (const [mode, expected] of formats) {
  test(`person card and tree agree for ${mode} without editing canonical data`, () => {
    const source = person();
    const before = structuredClone(source);
    const names = [name()];
    const namesBefore = structuredClone(names);
    const result = resolvePersonCardNameDisplay(source, names, {}, preference(mode));
    const tree = applyFamilyTreeNameDisplay({
      persons: [{ id: source.id, sex: "female", ...personTreeNameFields(source, names) }],
      unions: [], parentChildRelations: [],
    }, preference(mode), [source]);
    assert.equal(result.label, expected);
    assert.equal(result.inlineLabel, expected);
    assert.equal(result.label, tree.persons[0].displayName);
    assert.deepEqual(source, before);
    assert.deepEqual(names, namesBefore);
  });
}

test("birth/maiden and married name records work when legacy maiden field is empty", () => {
  for (const birthType of ["birth", "maiden"]) {
    const source = person({ surname: "", maidenSurname: "", fullName: "Олена Іванівна" });
    const names = [name({ nameType: birthType }), name({ id: "married", nameType: "married", surname: "Коваленко" })];
    assert.equal(resolvePersonCardNameDisplay(source, names, {}, preference("maiden-with-married")).label,
      "Петренко (Коваленко) Олена Іванівна");
  }
});

test("unknown surnames fall back to known ones without empty or repeated parentheses", () => {
  for (const [mode] of formats) {
    assert.equal(resolvePersonCardNameDisplay(person({ maidenSurname: "" }), [], {}, preference(mode)).label, "Коваленко Олена Іванівна");
    assert.equal(resolvePersonCardNameDisplay(person({ maidenSurname: "коваленко" }), [], {}, preference(mode)).label.toLocaleLowerCase("uk"), "коваленко олена іванівна");
  }
});

test("men and people without structured surnames keep their existing label", () => {
  assert.equal(resolvePersonCardNameDisplay(person({ gender: "чоловік" }), [], {}, preference("maiden-only")).label,
    "Коваленко Олена Іванівна");
  assert.equal(resolvePersonCardNameDisplay(person({ surname: "", maidenSurname: "", givenName: "", patronymic: "", fullName: "Невідома жінка" }), [], {}, preference("maiden-only")).label,
    "Невідома жінка");
});

test("full-name-only patronymics are preserved by the shared tree formatter", () => {
  assert.equal(resolvePersonCardNameDisplay(person({ patronymic: "" }), [], {}, preference("maiden-only")).label,
    "Петренко Олена Іванівна");
});

test("an unrelated person's previously loaded names cannot change the next card", () => {
  assert.equal(resolvePersonCardNameDisplay(person({ maidenSurname: "" }), [name({ personId: "other", surname: "Чуже" })], {}, preference("maiden-only")).label,
    "Коваленко Олена Іванівна");
});

test("no tree context preserves existing card settings, including language selection", () => {
  const names = [name({ fullNormalized: "Olena Petrenko", languageCode: "en" })];
  assert.equal(resolvePersonCardNameDisplay(person(), names, { mode: "interface_language", interfaceLanguage: "en" }).label,
    "Olena Petrenko");
});

test("explicit documentary mode keeps original spelling verbatim", () => {
  const originalText = "  Елена  Ивановна Корзунъ  ";
  const names = [name({ nameType: "original", originalText, sourceDocumentId: "document" })];
  assert.equal(resolvePersonCardNameDisplay(person(), names, { mode: "original" }, preference("maiden-only")).label, originalText);
  assert.equal(names[0].originalText, originalText);
});

function marriage(overrides: Partial<ProjectPersonMarriage> = {}): ProjectPersonMarriage {
  return { id: "marriage", personAId: "woman", personBId: "current", status: "active", createdAt: "1900-01-01", ...overrides } as ProjectPersonMarriage;
}

test("optional husband fallback uses the current relationship rather than a former spouse", () => {
  const source = person({ surname: "Петренко", fullName: "Петренко Олена Іванівна" });
  const persons = [source, person({ id: "former", gender: "чоловік", surname: "Сидоренко" }), person({ id: "current", gender: "чоловік", surname: "Коваль" })];
  const marriages = [marriage({ id: "old", personBId: "former", status: "ended" }), marriage()];
  assert.equal(resolvePersonCardNameDisplay(source, [], {}, preference("married-only", false), persons, marriages).label,
    "Петренко Олена Іванівна");
  assert.equal(resolvePersonCardNameDisplay(source, [], {}, preference("married-only", true), persons, marriages).label,
    "Коваль Олена Іванівна");
  assert.equal(resolvePersonCardNameDisplay(source, [], {}, preference("maiden-only", true), persons, marriages).label,
    "Петренко Олена Іванівна");
});

test("an explicit married surname wins over optional inferred husband surname", () => {
  const source = person();
  const persons = [source, person({ id: "current", gender: "чоловік", surname: "Інше" })];
  assert.equal(resolvePersonCardNameDisplay(source, [], {}, preference("married-only", true), persons, [marriage()]).label,
    "Коваленко Олена Іванівна");
});

test("spouse display order is identical to the renderer adapter", () => {
  assert.ok(partnershipNameDisplayOrder({}, true)! < partnershipNameDisplayOrder({ displayOrder: 1 }, false)!);
  assert.equal(partnershipNameDisplayOrder({ display_order: "3" }, false), partnershipNameDisplayOrder({ displayOrder: 3 }, false));
});

test("profile and preview share the same formatter and account/tree preference context", () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const file of ["PersonProfileV2.tsx", "PersonPreviewDrawerV2.tsx"]) {
    assert.match(source(`features/persons-v2/${file}`), /resolvePersonCardNameDisplay\(/);
    assert.match(source(`features/persons-v2/${file}`), /treeNamePreferences/);
  }
  const module = source("features/persons-v2/PersonsModuleV2.tsx");
  assert.match(module, /pedigreeTreeId \|\| currentPedigree\?\.treeId \|\| currentMarriageLoad\.treeId/);
  assert.match(module, /useFamilyTreeAppearancePreferences\(projectId, namePreferenceTreeId, \{\s*readOnly: true/);
  assert.match(module, /cacheScope: pedigreeCacheScope/);
  assert.equal((module.match(/treeNamePreferences=\{treeNamePreferences\}/g) || []).length, 2);
});

test("reading card preferences never creates a remote default and responds to live changes", () => {
  const hook = readFileSync(new URL("../src/hooks/useFamilyTreeAppearancePreferences.ts", import.meta.url), "utf8");
  assert.match(hook, /if \(readOnly\) setSyncState\("idle"\);\s*else queueRemoteSave/);
  assert.match(hook, /if \(readOnly\) return;/);
  assert.match(hook, /FAMILY_TREE_APPEARANCE_CHANGED_EVENT, onChanged/);
  assert.match(hook, /addEventListener\("storage", onStorage\)/);
  assert.match(hook, /appearanceKey === activeKey/);
  assert.equal(DEFAULT_FAMILY_TREE_APPEARANCE.marriedSurnameDisplay, "married-only");
});
