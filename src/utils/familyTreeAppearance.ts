import { browserLocalStorage } from "./sidebarPreference.ts";

export type DirectLineageGrouping =
  | "single"
  | "parents"
  | "grandparents"
  | "great-grandparents";

export interface FamilyTreeAppearancePreferences {
  directLineageColor: string;
  directLineageGrouping: DirectLineageGrouping;
  /** Eight stable sector slots; an empty list means an automatic palette. */
  directLineageBranchColors: readonly string[];
  showCousinDescendantsByDefault: boolean;
}

export const DEFAULT_FAMILY_TREE_APPEARANCE: FamilyTreeAppearancePreferences = {
  directLineageColor: "#2f7465",
  directLineageGrouping: "single",
  directLineageBranchColors: [],
  showCousinDescendantsByDefault: false,
};

export const DIRECT_LINEAGE_COLOR_PRESETS = [
  "#2f7465",
  "#477fa5",
  "#b37a2d",
  "#9a5f82",
  "#725f9a",
] as const;

export interface DirectLineagePalettePreset {
  id: string;
  label: string;
  colors: readonly [string, string, string, string, string, string, string, string];
}

/** Accessible, deliberately distinct palettes for the eight ancestral sectors. */
export const STANDARD_DIRECT_LINEAGE_PALETTES: readonly DirectLineagePalettePreset[] = [
  {
    id: "heritage",
    label: "Родова",
    colors: [
      "#2f7465",
      "#b37a2d",
      "#477fa5",
      "#9a5f82",
      "#5f8445",
      "#b45f55",
      "#596fa3",
      "#7b62a0",
    ],
  },
  {
    id: "forest",
    label: "Природна",
    colors: [
      "#2b6f63",
      "#8c6a35",
      "#397b85",
      "#856047",
      "#53733c",
      "#a25d43",
      "#536f91",
      "#76607e",
    ],
  },
  {
    id: "contrast",
    label: "Контрастна",
    colors: [
      "#176b87",
      "#a56612",
      "#385ba8",
      "#9b4c78",
      "#3d7d39",
      "#a8493f",
      "#6651a5",
      "#846b18",
    ],
  },
] as const;

const GROUPING_DEPTH: Readonly<Record<DirectLineageGrouping, 0 | 1 | 2 | 3>> = {
  single: 0,
  parents: 1,
  grandparents: 2,
  "great-grandparents": 3,
};

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function validHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validGrouping(value: unknown): value is DirectLineageGrouping {
  return (
    value === "single" ||
    value === "parents" ||
    value === "grandparents" ||
    value === "great-grandparents"
  );
}

export function normalizeFamilyTreeAppearance(
  value: unknown,
): FamilyTreeAppearancePreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_FAMILY_TREE_APPEARANCE };
  }
  const candidate = value as Partial<FamilyTreeAppearancePreferences>;
  const branchColors = Array.isArray(candidate.directLineageBranchColors) &&
    candidate.directLineageBranchColors.length === 8 &&
    candidate.directLineageBranchColors.every(validHexColor)
    ? candidate.directLineageBranchColors.map(color => color.toLowerCase())
    : [];
  return {
    directLineageColor: validHexColor(candidate.directLineageColor)
      ? candidate.directLineageColor.toLowerCase()
      : DEFAULT_FAMILY_TREE_APPEARANCE.directLineageColor,
    directLineageGrouping: validGrouping(candidate.directLineageGrouping)
      ? candidate.directLineageGrouping
      : DEFAULT_FAMILY_TREE_APPEARANCE.directLineageGrouping,
    directLineageBranchColors: branchColors,
    showCousinDescendantsByDefault:
      candidate.showCousinDescendantsByDefault === true,
  };
}

export function familyTreeAppearanceStorageKey(
  projectId: string,
  treeId: string,
): string {
  return `tracker-rodu.family-tree-appearance.v1:${projectId}:${treeId}`;
}

export function readFamilyTreeAppearance(
  projectId: string,
  treeId: string,
  storage: ReadableStorage | null = browserLocalStorage(),
): FamilyTreeAppearancePreferences {
  if (!storage || !projectId || !treeId) {
    return { ...DEFAULT_FAMILY_TREE_APPEARANCE };
  }
  try {
    const serialized = storage.getItem(
      familyTreeAppearanceStorageKey(projectId, treeId),
    );
    return serialized
      ? normalizeFamilyTreeAppearance(JSON.parse(serialized))
      : { ...DEFAULT_FAMILY_TREE_APPEARANCE };
  } catch {
    return { ...DEFAULT_FAMILY_TREE_APPEARANCE };
  }
}

export function writeFamilyTreeAppearance(
  projectId: string,
  treeId: string,
  value: FamilyTreeAppearancePreferences,
  storage: WritableStorage | null = browserLocalStorage(),
): void {
  if (!storage || !projectId || !treeId) return;
  try {
    storage.setItem(
      familyTreeAppearanceStorageKey(projectId, treeId),
      JSON.stringify(normalizeFamilyTreeAppearance(value)),
    );
  } catch {
    // Private browsing or a full quota must not block the live preference.
  }
}

export function directLineageGroupingDepth(
  grouping: DirectLineageGrouping,
): 0 | 1 | 2 | 3 {
  return GROUPING_DEPTH[grouping];
}

function hexToHsl(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === red
      ? (green - blue) / delta + (green < blue ? 6 : 0)
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return [(hue * 60) % 360, saturation, lightness];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const part = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((part % 2) - 1));
  const [red1, green1, blue1] =
    part < 1 ? [chroma, x, 0]
      : part < 2 ? [x, chroma, 0]
        : part < 3 ? [0, chroma, x]
          : part < 4 ? [0, x, chroma]
            : part < 5 ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = lightness - chroma / 2;
  const toHex = (channel: number) =>
    Math.round((channel + match) * 255).toString(16).padStart(2, "0");
  return `#${toHex(red1)}${toHex(green1)}${toHex(blue1)}`;
}

export function directLineagePalette(
  preferences: FamilyTreeAppearancePreferences,
): readonly string[] {
  if (
    preferences.directLineageBranchColors.length === 8 &&
    preferences.directLineageBranchColors.every(validHexColor)
  ) {
    return preferences.directLineageBranchColors.map(color =>
      color.toLowerCase()
    );
  }
  const depth = directLineageGroupingDepth(
    preferences.directLineageGrouping,
  );
  const count = depth === 0 ? 1 : 2 ** depth;
  const [hue, saturation, lightness] = hexToHsl(
    preferences.directLineageColor,
  );
  return Array.from({ length: 8 }, (_, index) =>
    index < count
      ? hslToHex(hue + index * (360 / count), saturation, lightness)
      : preferences.directLineageColor,
  );
}
