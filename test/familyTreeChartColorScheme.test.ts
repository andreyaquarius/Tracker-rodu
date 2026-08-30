import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestorChartToneForOccurrence,
  ancestorLineageGroupForSlot,
  chartColorContrastRatio,
  familyTreeChartColorCssVariables,
  mergeFamilyTreeChartColorOverrides,
  mixChartHexColors,
  normalizeChartHexColor,
  normalizeFamilyTreeChartColorOverrides,
  readableChartForeground,
  resetFamilyTreeChartColorOverride,
  resetFamilyTreeChartColorOverrides,
  resolveFamilyTreeChartColorScheme,
  lineageToneForAhnentafelSlot,
} from "../src/features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  STANDARD_DIRECT_LINEAGE_PALETTES,
  type FamilyTreeAppearancePreferences,
} from "../src/utils/familyTreeAppearance.ts";

test("normalizes safe short and long hex values and rejects CSS injection", () => {
  assert.equal(normalizeChartHexColor(" #AbC "), "#aabbcc");
  assert.equal(normalizeChartHexColor("2F7465"), "#2f7465");
  assert.equal(normalizeChartHexColor("#ABCDEF"), "#abcdef");
  assert.equal(normalizeChartHexColor("#abcd"), undefined);
  assert.equal(normalizeChartHexColor("var(--danger)"), undefined);
  assert.equal(normalizeChartHexColor("#fff;stroke:red"), undefined);
  assert.equal(normalizeChartHexColor(null), undefined);
});

test("uses the saved eight-color lineage palette as the parent branch defaults", () => {
  const palette = STANDARD_DIRECT_LINEAGE_PALETTES[0]!.colors;
  const appearance: FamilyTreeAppearancePreferences = {
    ...DEFAULT_FAMILY_TREE_APPEARANCE,
    directLineageColor: "#477fa5",
    directLineageGrouping: "great-grandparents",
    directLineageBranchColors: [...palette],
  };
  const scheme = resolveFamilyTreeChartColorScheme(appearance);

  assert.equal(
    scheme.paternal.fill,
    mixChartHexColors(palette[0], scheme.background, 0.22),
  );
  assert.equal(
    scheme.maternal.fill,
    mixChartHexColors(palette[4], scheme.background, 0.22),
  );
  assert.equal(
    scheme.lineage[1].fill,
    mixChartHexColors(palette[1], scheme.background, 0.22),
  );
  assert.notEqual(scheme.paternal.fill, scheme.maternal.fill);
  assert.equal(scheme.lineage.length, 8);
  assert.equal(scheme.paternal, scheme.lineage[0]);
  assert.equal(scheme.maternal, scheme.lineage[4]);
  assert.ok(chartColorContrastRatio(scheme.paternal.foreground, scheme.paternal.fill) >= 4.5);
  assert.ok(chartColorContrastRatio(scheme.maternal.foreground, scheme.maternal.fill) >= 4.5);
});

test("single grouping deliberately keeps all eight lineage sectors on one saved color", () => {
  const scheme = resolveFamilyTreeChartColorScheme({
    ...DEFAULT_FAMILY_TREE_APPEARANCE,
    directLineageColor: "#2f7465",
    directLineageGrouping: "single",
    // A stale custom palette must not override the explicit one-color mode.
    directLineageBranchColors: [...STANDARD_DIRECT_LINEAGE_PALETTES[0]!.colors],
  });

  assert.equal(scheme.groupingDepth, 0);
  assert.equal(new Set(scheme.lineage.map((tone) => tone.fill)).size, 1);
  assert.equal(scheme.paternal, scheme.lineage[0]);
  assert.equal(scheme.maternal, scheme.lineage[0]);
  assert.match(scheme.focus.fill, /^#[0-9a-f]{6}$/);
  assert.ok(chartColorContrastRatio(scheme.grid, scheme.background) >= 1.5);
  assert.ok(chartColorContrastRatio(scheme.text, scheme.background) >= 4.5);
  assert.ok(chartColorContrastRatio(scheme.duplicate.fill, scheme.background) >= 3);
});

test("maps Ahnentafel high-order parent bits to one, two, four, or eight groups", () => {
  assert.equal(ancestorLineageGroupForSlot(2, 1, "single"), 0);
  assert.equal(ancestorLineageGroupForSlot(15, 3, "single"), 0);

  assert.equal(ancestorLineageGroupForSlot(2, 1, "parents"), 0);
  assert.equal(ancestorLineageGroupForSlot(3, 1, "parents"), 1);
  assert.equal(ancestorLineageGroupForSlot(4, 2, "parents"), 0);
  assert.equal(ancestorLineageGroupForSlot(5, 2, "parents"), 0);
  assert.equal(ancestorLineageGroupForSlot(6, 2, "parents"), 1);
  assert.equal(ancestorLineageGroupForSlot(7, 2, "parents"), 1);

  assert.equal(ancestorLineageGroupForSlot(2, 1, "grandparents"), undefined);
  assert.deepEqual(
    [4, 5, 6, 7].map((slot) =>
      ancestorLineageGroupForSlot(slot, 2, "grandparents")
    ),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    [8, 9, 10, 11, 12, 13, 14, 15].map((slot) =>
      ancestorLineageGroupForSlot(slot, 3, "grandparents")
    ),
    [0, 0, 1, 1, 2, 2, 3, 3],
  );

  assert.equal(
    ancestorLineageGroupForSlot(4, 2, "great-grandparents"),
    undefined,
  );
  assert.deepEqual(
    [8, 9, 10, 11, 12, 13, 14, 15].map((slot) =>
      ancestorLineageGroupForSlot(slot, 3, "great-grandparents")
    ),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(
    ancestorLineageGroupForSlot(16, 4, "great-grandparents"),
    0,
  );
  assert.equal(
    ancestorLineageGroupForSlot(31, 4, "great-grandparents"),
    7,
  );
  assert.equal(ancestorLineageGroupForSlot(7, 3, "parents"), undefined);
});

test("selects focus, base, and grouped occurrence tones without recomputing colors", () => {
  const appearance: FamilyTreeAppearancePreferences = {
    ...DEFAULT_FAMILY_TREE_APPEARANCE,
    directLineageGrouping: "great-grandparents",
    directLineageBranchColors: [...STANDARD_DIRECT_LINEAGE_PALETTES[2]!.colors],
  };
  const scheme = resolveFamilyTreeChartColorScheme(appearance);

  assert.equal(lineageToneForAhnentafelSlot(scheme, 1), scheme.focus);
  assert.equal(lineageToneForAhnentafelSlot(scheme, 2), scheme.lineageBase);
  assert.equal(
    ancestorChartToneForOccurrence(scheme, { slot: 7, generation: 2 }),
    scheme.lineageBase,
  );
  assert.equal(lineageToneForAhnentafelSlot(scheme, 8), scheme.lineage[0]);
  assert.equal(lineageToneForAhnentafelSlot(scheme, 12), scheme.lineage[4]);
  assert.equal(lineageToneForAhnentafelSlot(scheme, 15), scheme.lineage[7]);
  assert.equal(lineageToneForAhnentafelSlot(scheme, -1), scheme.lineageBase);
});

test("local overrides are normalized and unsafe foreground choices are repaired", () => {
  const scheme = resolveFamilyTreeChartColorScheme(
    DEFAULT_FAMILY_TREE_APPEARANCE,
    {
      background: "#111",
      paternal: "fff",
      maternal: "#222222",
      focus: "#000000",
      duplicate: "#111111",
      grid: "#121212",
      text: "#222222",
    },
  );

  assert.equal(scheme.background, "#111111");
  assert.equal(scheme.paternal.fill, "#ffffff");
  assert.equal(scheme.maternal.fill, "#ffffff");
  assert.equal(scheme.paternal.foreground, "#000000");
  assert.ok(chartColorContrastRatio(scheme.maternal.foreground, scheme.maternal.fill) >= 4.5);
  assert.ok(chartColorContrastRatio(scheme.focus.foreground, scheme.focus.fill) >= 4.5);
  assert.ok(chartColorContrastRatio(scheme.duplicate.fill, scheme.background) >= 3);
  assert.ok(chartColorContrastRatio(scheme.grid, scheme.background) >= 1.5);
  assert.ok(chartColorContrastRatio(scheme.text, scheme.background) >= 4.5);
  assert.ok(chartColorContrastRatio(scheme.mutedText, scheme.background) >= 4.5);
  assert.equal(readableChartForeground("#000000", "#111111"), "#ffffff");
});

test("merges and resets chart-only overrides without mutating appearance or inputs", () => {
  const branchColors = [...STANDARD_DIRECT_LINEAGE_PALETTES[1]!.colors];
  const appearance: FamilyTreeAppearancePreferences = {
    ...DEFAULT_FAMILY_TREE_APPEARANCE,
    directLineageGrouping: "great-grandparents",
    directLineageBranchColors: branchColors,
  };
  const appearanceSnapshot = JSON.stringify(appearance);
  const current = Object.freeze({ paternal: "#123456", grid: "#abcdef" });
  const merged = mergeFamilyTreeChartColorOverrides(current, {
    paternal: "#ABC",
    maternal: "#654321",
    grid: "",
  });

  assert.deepEqual(current, { paternal: "#123456", grid: "#abcdef" });
  assert.deepEqual(merged, { paternal: "#aabbcc", maternal: "#654321" });
  assert.deepEqual(
    resetFamilyTreeChartColorOverride(merged, "paternal"),
    { maternal: "#654321" },
  );
  assert.deepEqual(resetFamilyTreeChartColorOverrides(), {});

  const savedScheme = resolveFamilyTreeChartColorScheme(appearance);
  const overriddenScheme = resolveFamilyTreeChartColorScheme(appearance, merged);
  const resetScheme = resolveFamilyTreeChartColorScheme(
    appearance,
    resetFamilyTreeChartColorOverrides(),
  );
  assert.notEqual(overriddenScheme.paternal.fill, savedScheme.paternal.fill);
  assert.equal(resetScheme.paternal.fill, savedScheme.paternal.fill);
  assert.equal(JSON.stringify(appearance), appearanceSnapshot);
  assert.deepEqual(appearance.directLineageBranchColors, branchColors);
});

test("invalid override entries fall back to the saved appearance", () => {
  assert.deepEqual(
    normalizeFamilyTreeChartColorOverrides({
      paternal: "#ABC",
      maternal: "url(javascript:alert(1))",
      grid: 42,
      unknown: "#ffffff",
    }),
    { paternal: "#aabbcc" },
  );

  const saved = resolveFamilyTreeChartColorScheme(DEFAULT_FAMILY_TREE_APPEARANCE);
  const unsafe = resolveFamilyTreeChartColorScheme(
    DEFAULT_FAMILY_TREE_APPEARANCE,
    normalizeFamilyTreeChartColorOverrides({ paternal: "not-a-color" }),
  );
  assert.deepEqual(unsafe, saved);
});

test("provides inline SVG CSS variables that exports can clone with the chart", () => {
  const scheme = resolveFamilyTreeChartColorScheme(
    DEFAULT_FAMILY_TREE_APPEARANCE,
    { paternal: "#224466", maternal: "#884466" },
  );
  const variables = familyTreeChartColorCssVariables(scheme);

  assert.equal(variables["--family-tree-chart-background"], scheme.background);
  assert.equal(variables["--family-tree-chart-paternal-fill"], scheme.paternal.fill);
  assert.equal(
    variables["--family-tree-chart-paternal-foreground"],
    scheme.paternal.foreground,
  );
  assert.equal(variables["--family-tree-chart-maternal-fill"], scheme.maternal.fill);
  assert.equal(variables["--family-tree-chart-focus-stroke"], scheme.focus.stroke);
  assert.equal(variables["--family-tree-chart-duplicate-fill"], scheme.duplicate.fill);
  assert.equal(variables["--family-tree-chart-grid"], scheme.grid);
  assert.equal(variables["--family-tree-chart-text"], scheme.text);
  assert.equal(variables["--family-tree-chart-muted-text"], scheme.mutedText);
  assert.equal(
    variables["--family-tree-chart-lineage-base-fill"],
    scheme.lineageBase.fill,
  );
  assert.equal(
    variables["--family-tree-chart-lineage-0-fill"],
    scheme.lineage[0].fill,
  );
  assert.equal(
    variables["--family-tree-chart-lineage-7-foreground"],
    scheme.lineage[7].foreground,
  );
  assert.equal(Object.keys(variables).length, 43);
});
