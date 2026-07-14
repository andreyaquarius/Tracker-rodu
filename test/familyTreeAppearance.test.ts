import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  STANDARD_DIRECT_LINEAGE_PALETTES,
  directLineageGroupingDepth,
  directLineagePalette,
  familyTreeAppearanceStorageKey,
  normalizeFamilyTreeAppearance,
  readFamilyTreeAppearance,
  writeFamilyTreeAppearance,
  type DirectLineageGrouping,
  type FamilyTreeAppearancePreferences,
} from "../src/utils/familyTreeAppearance.ts";

const groupings: readonly [DirectLineageGrouping, 0 | 1 | 2 | 3][] = [
  ["single", 0],
  ["parents", 1],
  ["grandparents", 2],
  ["great-grandparents", 3],
];

test("direct-lineage grouping exposes one, two, four and eight automatic colors", () => {
  for (const [grouping, depth] of groupings) {
    assert.equal(directLineageGroupingDepth(grouping), depth);
    const preferences: FamilyTreeAppearancePreferences = {
      directLineageColor: "#2f7465",
      directLineageGrouping: grouping,
      directLineageBranchColors: [],
      showCousinDescendantsByDefault: false,
    };
    const palette = directLineagePalette(preferences);
    const count = depth === 0 ? 1 : 2 ** depth;
    assert.equal(palette.length, 8);
    assert.equal(palette[0], "#2f7465");
    assert.equal(new Set(palette.slice(0, count)).size, count);
  }
});

test("eight valid custom branch colors override the automatic palette", () => {
  const colors = STANDARD_DIRECT_LINEAGE_PALETTES[1]!.colors;
  const normalized = normalizeFamilyTreeAppearance({
    directLineageColor: "#ABCDEF",
    directLineageGrouping: "great-grandparents",
    directLineageBranchColors: colors.map(color => color.toUpperCase()),
  });
  assert.equal(normalized.directLineageColor, "#abcdef");
  assert.equal(normalized.showCousinDescendantsByDefault, false);
  assert.deepEqual(normalized.directLineageBranchColors, colors);
  assert.deepEqual(directLineagePalette(normalized), colors);

  assert.deepEqual(
    normalizeFamilyTreeAppearance({
      directLineageColor: "#2f7465",
      directLineageGrouping: "parents",
      directLineageBranchColors: colors.slice(0, 2),
    }).directLineageBranchColors,
    [],
  );
  assert.deepEqual(
    normalizeFamilyTreeAppearance({
      directLineageColor: "#2f7465",
      directLineageGrouping: "parents",
      directLineageBranchColors: [...colors.slice(0, 7), "not-a-color"],
    }).directLineageBranchColors,
    [],
  );
});

test("every standard branch palette contains eight distinct hex colors", () => {
  assert.ok(STANDARD_DIRECT_LINEAGE_PALETTES.length >= 3);
  for (const preset of STANDARD_DIRECT_LINEAGE_PALETTES) {
    assert.equal(preset.colors.length, 8, preset.label);
    assert.equal(new Set(preset.colors).size, 8, preset.label);
    for (const color of preset.colors) {
      assert.match(color, /^#[0-9a-f]{6}$/i, preset.label);
    }
  }
});

test("appearance storage stays isolated per project and tree and tolerates failures", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const custom: FamilyTreeAppearancePreferences = {
    directLineageColor: "#477fa5",
    directLineageGrouping: "grandparents",
    directLineageBranchColors: [...STANDARD_DIRECT_LINEAGE_PALETTES[0]!.colors],
    showCousinDescendantsByDefault: true,
  };
  writeFamilyTreeAppearance("project-a", "tree-a", custom, storage);
  assert.deepEqual(
    readFamilyTreeAppearance("project-a", "tree-a", storage),
    custom,
  );
  assert.deepEqual(
    readFamilyTreeAppearance("project-a", "tree-b", storage),
    DEFAULT_FAMILY_TREE_APPEARANCE,
  );
  assert.notEqual(
    familyTreeAppearanceStorageKey("project-a", "tree-a"),
    familyTreeAppearanceStorageKey("project-b", "tree-a"),
  );

  const failingStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.deepEqual(
    readFamilyTreeAppearance("project-a", "tree-a", failingStorage),
    DEFAULT_FAMILY_TREE_APPEARANCE,
  );
  assert.doesNotThrow(() =>
    writeFamilyTreeAppearance("project-a", "tree-a", custom, failingStorage)
  );
});
