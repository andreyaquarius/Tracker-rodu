import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
  MAX_FAMILY_TREE_VIEW_GENERATIONS,
  MAX_STORED_ACTIVE_PARENT_SETS,
  familyTreeViewPreferencesStorageKey,
  normalizeFamilyTreeViewPreferences,
  readFamilyTreeViewPreferenceCache,
  writeFamilyTreeViewPreferenceCache,
} from "../src/utils/familyTreeViewPreferences.ts";

test("view preference normalization keeps safe defaults and bounded identifiers", () => {
  assert.deepEqual(
    normalizeFamilyTreeViewPreferences(undefined),
    DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
  );
  assert.deepEqual(normalizeFamilyTreeViewPreferences({
    ancestorDepth: 8.9,
    descendantDepth: -4,
    collateralDepth: 2,
    showAllParentSets: true,
    activeParentSetByChild: {
      " child-a ": " parent-set-a ",
      "": "ignored",
      prototype: "ignored",
      "child-with-invalid-parent": "x".repeat(129),
    },
  }), {
    ancestorDepth: 8,
    descendantDepth: 0,
    collateralDepth: 1,
    showAllParentSets: true,
    activeParentSetByChild: {
      "child-a": "parent-set-a",
    },
  });

  assert.equal(
    normalizeFamilyTreeViewPreferences({ ancestorDepth: 10_000 }).ancestorDepth,
    MAX_FAMILY_TREE_VIEW_GENERATIONS,
  );

  const oversized = Object.fromEntries(
    Array.from({ length: MAX_STORED_ACTIVE_PARENT_SETS + 20 }, (_, index) => [
      `child-${index}`,
      `parent-set-${index}`,
    ]),
  );
  assert.equal(
    Object.keys(normalizeFamilyTreeViewPreferences({
      activeParentSetByChild: oversized,
    }).activeParentSetByChild).length,
    MAX_STORED_ACTIVE_PARENT_SETS,
  );
  const bounded = normalizeFamilyTreeViewPreferences({
    activeParentSetByChild: oversized,
  }).activeParentSetByChild;
  assert.equal(bounded["child-0"], undefined);
  assert.equal(
    bounded[`child-${MAX_STORED_ACTIVE_PARENT_SETS + 19}`],
    `parent-set-${MAX_STORED_ACTIVE_PARENT_SETS + 19}`,
  );
});

test("view cache is isolated by authenticated user, project and tree", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const custom = normalizeFamilyTreeViewPreferences({
    ancestorDepth: 10,
    descendantDepth: 5,
    collateralDepth: 1,
    showAllParentSets: true,
    activeParentSetByChild: { "child-a": "parent-set-a" },
  });

  writeFamilyTreeViewPreferenceCache(
    "user-a",
    "project-a",
    "tree-a",
    custom,
    true,
    storage,
  );
  assert.deepEqual(
    readFamilyTreeViewPreferenceCache(
      "user-a",
      "project-a",
      "tree-a",
      storage,
    ),
    { preferences: custom, dirty: true, found: true },
  );
  for (const scope of [
    ["user-b", "project-a", "tree-a"],
    ["user-a", "project-b", "tree-a"],
    ["user-a", "project-a", "tree-b"],
  ] as const) {
    assert.deepEqual(
      readFamilyTreeViewPreferenceCache(...scope, storage),
      {
        preferences: DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
        dirty: false,
        found: false,
      },
    );
  }
  assert.notEqual(
    familyTreeViewPreferencesStorageKey("user-a", "project-a", "tree-a"),
    familyTreeViewPreferencesStorageKey("user-b", "project-a", "tree-a"),
  );
});

test("dirty marker survives failed storage reads and clears only when explicitly acknowledged", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const preferences = normalizeFamilyTreeViewPreferences({ ancestorDepth: 12 });
  writeFamilyTreeViewPreferenceCache(
    "user-a",
    "project-a",
    "tree-a",
    preferences,
    true,
    storage,
  );
  assert.equal(
    readFamilyTreeViewPreferenceCache("user-a", "project-a", "tree-a", storage)
      .dirty,
    true,
  );
  writeFamilyTreeViewPreferenceCache(
    "user-a",
    "project-a",
    "tree-a",
    preferences,
    false,
    storage,
  );
  assert.equal(
    readFamilyTreeViewPreferenceCache("user-a", "project-a", "tree-a", storage)
      .dirty,
    false,
  );

  const blockedStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.equal(
    readFamilyTreeViewPreferenceCache(
      "user-a",
      "project-a",
      "tree-a",
      blockedStorage,
    ).found,
    false,
  );
  assert.doesNotThrow(() =>
    writeFamilyTreeViewPreferenceCache(
      "user-a",
      "project-a",
      "tree-a",
      preferences,
      true,
      blockedStorage,
    )
  );
});

test("all five choices survive a page close and a later cache hydration", () => {
  const values = new Map<string, string>();
  const firstPageStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const selected = normalizeFamilyTreeViewPreferences({
    ancestorDepth: 12,
    descendantDepth: 6,
    collateralDepth: 1,
    showAllParentSets: true,
    activeParentSetByChild: { child: "parent-set:legal" },
  });
  writeFamilyTreeViewPreferenceCache(
    "user-a",
    "project-a",
    "tree-a",
    selected,
    true,
    firstPageStorage,
  );

  // A new storage wrapper models a new component/page instance after the old
  // page has unmounted; only the browser's durable values are shared.
  const reopenedPageStorage = {
    getItem: (key: string) => values.get(key) ?? null,
  };
  assert.deepEqual(
    readFamilyTreeViewPreferenceCache(
      "user-a",
      "project-a",
      "tree-a",
      reopenedPageStorage,
    ),
    { preferences: selected, dirty: true, found: true },
  );
});
