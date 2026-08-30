import {
  directLineagePalette,
  directLineageGroupingDepth,
  normalizeFamilyTreeAppearance,
  type DirectLineageGrouping,
  type FamilyTreeAppearancePreferences,
} from "../../../utils/familyTreeAppearance.ts";

export const FAMILY_TREE_CHART_COLOR_OVERRIDE_KEYS = [
  "background",
  "paternal",
  "maternal",
  "focus",
  "duplicate",
  "grid",
  "text",
] as const;

export type FamilyTreeChartColorOverrideKey =
  (typeof FAMILY_TREE_CHART_COLOR_OVERRIDE_KEYS)[number];

export type FamilyTreeChartColorOverrides = Partial<
  Record<FamilyTreeChartColorOverrideKey, string>
>;

export type FamilyTreeChartColorOverridePatch = Partial<
  Record<FamilyTreeChartColorOverrideKey, string | null | undefined>
>;

export interface FamilyTreeChartTone {
  /** Sector/card surface. */
  fill: string;
  /** Text that remains readable on the surface. */
  foreground: string;
  /** Boundary or emphasis line that remains visible on the surface. */
  stroke: string;
}

export interface FamilyTreeChartColorScheme {
  background: string;
  grouping: DirectLineageGrouping;
  groupingDepth: 0 | 1 | 2 | 3;
  /** Saved direct-lineage color, used before the selected grouping depth. */
  lineageBase: FamilyTreeChartTone;
  /** Eight stable Ahnentafel sector tones, including inactive fallback slots. */
  lineage: readonly [
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
    FamilyTreeChartTone,
  ];
  /** Convenience aliases for legends and the first ancestor split. */
  paternal: FamilyTreeChartTone;
  maternal: FamilyTreeChartTone;
  focus: FamilyTreeChartTone;
  duplicate: FamilyTreeChartTone;
  grid: string;
  text: string;
  mutedText: string;
}

export type FamilyTreeChartColorCssVariables = Record<
  | "--family-tree-chart-background"
  | "--family-tree-chart-paternal-fill"
  | "--family-tree-chart-paternal-foreground"
  | "--family-tree-chart-paternal-stroke"
  | "--family-tree-chart-maternal-fill"
  | "--family-tree-chart-maternal-foreground"
  | "--family-tree-chart-maternal-stroke"
  | "--family-tree-chart-focus-fill"
  | "--family-tree-chart-focus-foreground"
  | "--family-tree-chart-focus-stroke"
  | "--family-tree-chart-duplicate-fill"
  | "--family-tree-chart-duplicate-foreground"
  | "--family-tree-chart-duplicate-stroke"
  | "--family-tree-chart-grid"
  | "--family-tree-chart-text"
  | "--family-tree-chart-muted-text"
  | `--family-tree-chart-lineage-base-${"fill" | "foreground" | "stroke"}`
  | `--family-tree-chart-lineage-${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}-${
    "fill" | "foreground" | "stroke"
  }`,
  string
>;

export interface AncestorChartColorOccurrence {
  /** One-based Ahnentafel number: focus=1, father=2n, mother=2n+1. */
  slot: number;
  generation: number;
}

const DEFAULT_BACKGROUND = "#f7f5ee";
const DEFAULT_TEXT = "#173f36";
const DEFAULT_DUPLICATE = "#b57d22";
const DARK_FOREGROUND = "#000000";
const LIGHT_FOREGROUND = "#ffffff";

/**
 * Resolves an immutable chart-only scheme. Persisted tree appearance is the
 * source of the automatic palette; temporary overrides never write into or
 * reuse a mutable array from the appearance object.
 */
export function resolveFamilyTreeChartColorScheme(
  appearance: FamilyTreeAppearancePreferences,
  localOverrides: FamilyTreeChartColorOverrides | null | undefined = undefined,
): FamilyTreeChartColorScheme {
  const normalizedAppearance = normalizeFamilyTreeAppearance(appearance);
  const palette = directLineagePalette(normalizedAppearance).map(
    (color) => normalizeChartHexColor(color) ?? normalizedAppearance.directLineageColor,
  );
  const overrides = normalizeFamilyTreeChartColorOverrides(localOverrides);
  const background = overrides.background ?? DEFAULT_BACKGROUND;
  const baseColor = normalizedAppearance.directLineageColor;
  const groupingDepth = directLineageGroupingDepth(
    normalizedAppearance.directLineageGrouping,
  );
  const activeGroupCount = groupingDepth === 0 ? 1 : 2 ** groupingDepth;
  const maternalGroupIndex = groupingDepth === 0 ? 0 : 2 ** (groupingDepth - 1);

  const requestedText = overrides.text ?? DEFAULT_TEXT;
  const text = readableChartForeground(background, requestedText, 4.5);
  const mutedText = readableChartForeground(
    background,
    mixChartHexColors(text, background, 0.72),
    4.5,
  );

  const lineageBaseFill = ensureChartColorContrast(
    mixChartHexColors(baseColor, background, 0.22),
    background,
    1.15,
  );
  const lineageBase = createChartTone(lineageBaseFill, baseColor, text);
  const singleOverride = overrides.paternal ?? overrides.maternal;
  const lineage = eightChartTones(Array.from({ length: 8 }, (_, index) => {
    const activeBase = groupingDepth === 0
      ? baseColor
      : index < activeGroupCount
      ? palette[index] ?? baseColor
      : baseColor;
    const sideOverride = groupingDepth === 0
      ? singleOverride
      : index < maternalGroupIndex
        ? overrides.paternal
        : overrides.maternal;
    const fill = ensureChartColorContrast(
      sideOverride ?? mixChartHexColors(activeBase, background, 0.22),
      background,
      1.15,
    );
    return createChartTone(fill, activeBase, text);
  }));
  const focusFill = ensureChartColorContrast(
    overrides.focus ?? mixChartHexColors(
      normalizedAppearance.directLineageColor,
      background,
      0.13,
    ),
    background,
    1.1,
  );
  const duplicateFill = ensureChartColorContrast(
    overrides.duplicate ?? DEFAULT_DUPLICATE,
    background,
    3,
  );
  const grid = ensureChartColorContrast(
    overrides.grid ?? mixChartHexColors(baseColor, background, 0.32),
    background,
    1.5,
  );

  return {
    background,
    grouping: normalizedAppearance.directLineageGrouping,
    groupingDepth,
    lineageBase,
    lineage,
    paternal: lineage[0],
    maternal: lineage[maternalGroupIndex],
    focus: createChartTone(
      focusFill,
      normalizedAppearance.directLineageColor,
      text,
    ),
    duplicate: createChartTone(duplicateFill, duplicateFill, text),
    grid,
    text,
    mutedText,
  };
}

/**
 * Resolves the stable lineage group from the high-order father/mother bits of
 * an Ahnentafel slot. `undefined` means the occurrence is closer to the focus
 * than the selected grouping depth and therefore uses `lineageBase`.
 */
export function ancestorLineageGroupForSlot(
  slot: number,
  generation: number,
  grouping: DirectLineageGrouping,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | undefined {
  const depth = directLineageGroupingDepth(grouping);
  if (
    !Number.isSafeInteger(slot) ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    generation > 51
  ) {
    return undefined;
  }
  const generationStart = 2 ** generation;
  const generationEnd = 2 ** (generation + 1);
  if (slot < generationStart || slot >= generationEnd) return undefined;
  if (depth === 0) return 0;
  if (generation < depth) return undefined;

  const zeroBasedSlot = slot - generationStart;
  const remainingBits = generation - depth;
  const group = Math.floor(zeroBasedSlot / 2 ** remainingBits);
  return group >= 0 && group <= 7
    ? group as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
    : undefined;
}

export function ancestorChartToneForOccurrence(
  scheme: FamilyTreeChartColorScheme,
  occurrence: AncestorChartColorOccurrence,
  grouping: DirectLineageGrouping = scheme.grouping,
): FamilyTreeChartTone {
  if (occurrence.generation === 0 && occurrence.slot === 1) return scheme.focus;
  const group = ancestorLineageGroupForSlot(
    occurrence.slot,
    occurrence.generation,
    grouping,
  );
  return group === undefined ? scheme.lineageBase : scheme.lineage[group];
}

/** Convenient lookup when a chart occurrence already exposes its Ahnentafel slot. */
export function lineageToneForAhnentafelSlot(
  scheme: FamilyTreeChartColorScheme,
  slot: number,
): FamilyTreeChartTone {
  if (!Number.isSafeInteger(slot) || slot < 1) return scheme.lineageBase;
  const generation = Math.floor(Math.log2(slot));
  return ancestorChartToneForOccurrence(scheme, { slot, generation });
}

/** Accepts #rgb, rgb, #rrggbb or rrggbb and emits lowercase #rrggbb. */
export function normalizeChartHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  const match = candidate.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return undefined;
  const hex = match[1]!;
  if (hex.length === 6) return `#${hex}`;
  return `#${hex.split("").map((character) => character + character).join("")}`;
}

export function normalizeFamilyTreeChartColorOverrides(
  value: unknown,
): FamilyTreeChartColorOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const normalized: FamilyTreeChartColorOverrides = {};
  for (const key of FAMILY_TREE_CHART_COLOR_OVERRIDE_KEYS) {
    const color = normalizeChartHexColor(candidate[key]);
    if (color) normalized[key] = color;
  }
  return normalized;
}

/**
 * Merges a temporary editor patch without mutating either input. `null`, an
 * empty string, or an invalid color removes that one local override so the
 * value falls back to the saved appearance.
 */
export function mergeFamilyTreeChartColorOverrides(
  current: FamilyTreeChartColorOverrides | null | undefined,
  patch: FamilyTreeChartColorOverridePatch | null | undefined,
): FamilyTreeChartColorOverrides {
  const merged: FamilyTreeChartColorOverrides = {
    ...normalizeFamilyTreeChartColorOverrides(current),
  };
  if (!patch) return merged;
  for (const key of FAMILY_TREE_CHART_COLOR_OVERRIDE_KEYS) {
    if (!(key in patch)) continue;
    const normalized = normalizeChartHexColor(patch[key]);
    if (normalized) merged[key] = normalized;
    else delete merged[key];
  }
  return merged;
}

export function resetFamilyTreeChartColorOverride(
  current: FamilyTreeChartColorOverrides | null | undefined,
  key: FamilyTreeChartColorOverrideKey,
): FamilyTreeChartColorOverrides {
  return mergeFamilyTreeChartColorOverrides(current, { [key]: null });
}

export function resetFamilyTreeChartColorOverrides(): FamilyTreeChartColorOverrides {
  return {};
}

/**
 * Inline these variables on the source SVG. Browser exports clone that SVG,
 * therefore the selected scheme is carried into SVG, PNG and PDF without a
 * second mutable color source.
 */
export function familyTreeChartColorCssVariables(
  scheme: FamilyTreeChartColorScheme,
): FamilyTreeChartColorCssVariables {
  const variables: Record<string, string> = {
    "--family-tree-chart-background": scheme.background,
    "--family-tree-chart-lineage-base-fill": scheme.lineageBase.fill,
    "--family-tree-chart-lineage-base-foreground": scheme.lineageBase.foreground,
    "--family-tree-chart-lineage-base-stroke": scheme.lineageBase.stroke,
    "--family-tree-chart-paternal-fill": scheme.paternal.fill,
    "--family-tree-chart-paternal-foreground": scheme.paternal.foreground,
    "--family-tree-chart-paternal-stroke": scheme.paternal.stroke,
    "--family-tree-chart-maternal-fill": scheme.maternal.fill,
    "--family-tree-chart-maternal-foreground": scheme.maternal.foreground,
    "--family-tree-chart-maternal-stroke": scheme.maternal.stroke,
    "--family-tree-chart-focus-fill": scheme.focus.fill,
    "--family-tree-chart-focus-foreground": scheme.focus.foreground,
    "--family-tree-chart-focus-stroke": scheme.focus.stroke,
    "--family-tree-chart-duplicate-fill": scheme.duplicate.fill,
    "--family-tree-chart-duplicate-foreground": scheme.duplicate.foreground,
    "--family-tree-chart-duplicate-stroke": scheme.duplicate.stroke,
    "--family-tree-chart-grid": scheme.grid,
    "--family-tree-chart-text": scheme.text,
    "--family-tree-chart-muted-text": scheme.mutedText,
  };
  scheme.lineage.forEach((tone, index) => {
    variables[`--family-tree-chart-lineage-${index}-fill`] = tone.fill;
    variables[`--family-tree-chart-lineage-${index}-foreground`] = tone.foreground;
    variables[`--family-tree-chart-lineage-${index}-stroke`] = tone.stroke;
  });
  return variables as FamilyTreeChartColorCssVariables;
}

/** WCAG contrast ratio in the inclusive range 1..21. */
export function chartColorContrastRatio(foreground: string, background: string): number {
  const foregroundColor = normalizeChartHexColor(foreground);
  const backgroundColor = normalizeChartHexColor(background);
  if (!foregroundColor || !backgroundColor) return 1;
  const lighter = Math.max(
    chartColorRelativeLuminance(foregroundColor),
    chartColorRelativeLuminance(backgroundColor),
  );
  const darker = Math.min(
    chartColorRelativeLuminance(foregroundColor),
    chartColorRelativeLuminance(backgroundColor),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableChartForeground(
  background: string,
  preferred: string = DEFAULT_TEXT,
  minimumContrast = 4.5,
): string {
  const normalizedBackground = normalizeChartHexColor(background) ?? DEFAULT_BACKGROUND;
  const normalizedPreferred = normalizeChartHexColor(preferred);
  if (
    normalizedPreferred &&
    chartColorContrastRatio(normalizedPreferred, normalizedBackground) >= minimumContrast
  ) {
    return normalizedPreferred;
  }
  const candidates = [DARK_FOREGROUND, LIGHT_FOREGROUND] as const;
  return candidates.reduce((best, candidate) =>
    chartColorContrastRatio(candidate, normalizedBackground) >
      chartColorContrastRatio(best, normalizedBackground)
      ? candidate
      : best
  );
}

/** `firstAmount` is clamped to 0..1. */
export function mixChartHexColors(
  first: string,
  second: string,
  firstAmount: number,
): string {
  const firstColor = hexToRgb(normalizeChartHexColor(first) ?? DEFAULT_TEXT);
  const secondColor = hexToRgb(normalizeChartHexColor(second) ?? DEFAULT_BACKGROUND);
  const amount = Math.min(1, Math.max(0, Number.isFinite(firstAmount) ? firstAmount : 0));
  return rgbToHex({
    red: firstColor.red * amount + secondColor.red * (1 - amount),
    green: firstColor.green * amount + secondColor.green * (1 - amount),
    blue: firstColor.blue * amount + secondColor.blue * (1 - amount),
  });
}

function createChartTone(
  fill: string,
  preferredStroke: string,
  preferredForeground: string,
): FamilyTreeChartTone {
  return {
    fill,
    foreground: readableChartForeground(fill, preferredForeground, 4.5),
    stroke: ensureChartColorContrast(preferredStroke, fill, 3),
  };
}

function eightChartTones(
  tones: readonly FamilyTreeChartTone[],
): FamilyTreeChartColorScheme["lineage"] {
  if (tones.length !== 8) {
    throw new Error("Кольорова схема має містити вісім стабільних родових секторів.");
  }
  return [
    tones[0]!,
    tones[1]!,
    tones[2]!,
    tones[3]!,
    tones[4]!,
    tones[5]!,
    tones[6]!,
    tones[7]!,
  ];
}

function ensureChartColorContrast(
  color: string,
  background: string,
  minimumContrast: number,
): string {
  const normalizedColor = normalizeChartHexColor(color) ?? DEFAULT_TEXT;
  const normalizedBackground = normalizeChartHexColor(background) ?? DEFAULT_BACKGROUND;
  if (chartColorContrastRatio(normalizedColor, normalizedBackground) >= minimumContrast) {
    return normalizedColor;
  }

  const darkContrast = chartColorContrastRatio(DARK_FOREGROUND, normalizedBackground);
  const lightContrast = chartColorContrastRatio(LIGHT_FOREGROUND, normalizedBackground);
  const target = darkContrast >= lightContrast ? DARK_FOREGROUND : LIGHT_FOREGROUND;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixChartHexColors(target, normalizedColor, step / 20);
    if (chartColorContrastRatio(candidate, normalizedBackground) >= minimumContrast) {
      return candidate;
    }
  }
  return target;
}

function chartColorRelativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  const channels = [rgb.red, rgb.green, rgb.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function hexToRgb(color: string): { red: number; green: number; blue: number } {
  const numeric = Number.parseInt(color.slice(1), 16);
  return {
    red: (numeric >> 16) & 255,
    green: (numeric >> 8) & 255,
    blue: numeric & 255,
  };
}

function rgbToHex(rgb: { red: number; green: number; blue: number }): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}
