import { browserLocalStorage } from "./sidebarPreference.ts";

export interface FamilyTreeViewPreferences {
  ancestorDepth: number;
  descendantDepth: number;
  collateralDepth: number;
  showAllParentSets: boolean;
  activeParentSetByChild: Readonly<Record<string, string>>;
}

export interface FamilyTreeViewPreferenceCacheSnapshot {
  preferences: FamilyTreeViewPreferences;
  /** True until the latest local edit has been acknowledged by Supabase. */
  dirty: boolean;
  /** Distinguishes a real cached default from the absence of a cache entry. */
  found: boolean;
}

export const DEFAULT_FAMILY_TREE_VIEW_PREFERENCES: FamilyTreeViewPreferences = {
  ancestorDepth: 7,
  descendantDepth: 0,
  collateralDepth: 0,
  showAllParentSets: false,
  activeParentSetByChild: {},
};

export const FAMILY_TREE_VIEW_PREFERENCES_STORAGE_PREFIX =
  "tracker-rodu.family-tree-view-preferences.v1:";

export const MAX_STORED_ACTIVE_PARENT_SETS = 500;
export const MAX_FAMILY_TREE_VIEW_GENERATIONS = 100;

const CACHE_VERSION = 1;
const MAX_IDENTIFIER_LENGTH = 128;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

interface FamilyTreeViewPreferenceCacheEnvelope {
  version: typeof CACHE_VERSION;
  preferences: FamilyTreeViewPreferences;
  dirty: boolean;
}

function boundedGenerationCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(
    0,
    Math.min(MAX_FAMILY_TREE_VIEW_GENERATIONS, Math.trunc(value)),
  );
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER_LENGTH
    ? normalized
    : "";
}

function normalizeActiveParentSets(
  value: unknown,
): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  // Prefer the most recently appended choices when the bounded cache is full.
  // The tree adds a newly selected child at the end, so retaining the last
  // valid entries evicts an old/stale child instead of discarding the edit the
  // user has just made.
  const accepted: Array<readonly [string, string]> = [];
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (accepted.length >= MAX_STORED_ACTIVE_PARENT_SETS) break;
    const [rawChildId, rawParentSetId] = entries[index]!;
    const childId = safeIdentifier(rawChildId);
    const parentSetId = safeIdentifier(rawParentSetId);
    if (
      !childId ||
      !parentSetId ||
      childId === "__proto__" ||
      childId === "constructor" ||
      childId === "prototype"
    ) {
      continue;
    }
    accepted.push([childId, parentSetId]);
  }

  const normalized: Record<string, string> = {};
  for (const [childId, parentSetId] of accepted.reverse()) {
    normalized[childId] = parentSetId;
  }
  return normalized;
}

export function normalizeFamilyTreeViewPreferences(
  value: unknown,
): FamilyTreeViewPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
      activeParentSetByChild: {},
    };
  }
  const candidate = value as Partial<FamilyTreeViewPreferences>;
  return {
    ancestorDepth: boundedGenerationCount(
      candidate.ancestorDepth,
      DEFAULT_FAMILY_TREE_VIEW_PREFERENCES.ancestorDepth,
    ),
    descendantDepth: boundedGenerationCount(
      candidate.descendantDepth,
      DEFAULT_FAMILY_TREE_VIEW_PREFERENCES.descendantDepth,
    ),
    // The current control is a checkbox, not a numeric depth selector.
    collateralDepth:
      typeof candidate.collateralDepth === "number" &&
        Number.isFinite(candidate.collateralDepth) &&
        candidate.collateralDepth > 0
        ? 1
        : 0,
    showAllParentSets: candidate.showAllParentSets === true,
    activeParentSetByChild: normalizeActiveParentSets(
      candidate.activeParentSetByChild,
    ),
  };
}

export function sameFamilyTreeViewPreferences(
  left: FamilyTreeViewPreferences,
  right: FamilyTreeViewPreferences,
): boolean {
  const normalizedLeft = normalizeFamilyTreeViewPreferences(left);
  const normalizedRight = normalizeFamilyTreeViewPreferences(right);
  if (
    normalizedLeft.ancestorDepth !== normalizedRight.ancestorDepth ||
    normalizedLeft.descendantDepth !== normalizedRight.descendantDepth ||
    normalizedLeft.collateralDepth !== normalizedRight.collateralDepth ||
    normalizedLeft.showAllParentSets !== normalizedRight.showAllParentSets
  ) {
    return false;
  }
  const leftEntries = Object.entries(normalizedLeft.activeParentSetByChild);
  const rightEntries = Object.entries(normalizedRight.activeParentSetByChild);
  return leftEntries.length === rightEntries.length && leftEntries.every(
    ([childId, parentSetId]) =>
      normalizedRight.activeParentSetByChild[childId] === parentSetId,
  );
}

/**
 * The authenticated user id is part of the key so accounts sharing a browser
 * can never hydrate one another's private view cache.
 */
export function familyTreeViewPreferencesStorageKey(
  userId: string,
  projectId: string,
  treeId: string,
): string {
  return `${FAMILY_TREE_VIEW_PREFERENCES_STORAGE_PREFIX}${userId}:${projectId}:${treeId}`;
}

export function readFamilyTreeViewPreferenceCache(
  userId: string,
  projectId: string,
  treeId: string,
  storage: ReadableStorage | null = browserLocalStorage(),
): FamilyTreeViewPreferenceCacheSnapshot {
  const fallback: FamilyTreeViewPreferenceCacheSnapshot = {
    preferences: normalizeFamilyTreeViewPreferences(undefined),
    dirty: false,
    found: false,
  };
  if (!storage || !userId || !projectId || !treeId) return fallback;

  try {
    const serialized = storage.getItem(
      familyTreeViewPreferencesStorageKey(userId, projectId, treeId),
    );
    if (!serialized) return fallback;
    const parsed = JSON.parse(serialized) as Partial<FamilyTreeViewPreferenceCacheEnvelope>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== CACHE_VERSION ||
      !("preferences" in parsed)
    ) {
      return fallback;
    }
    return {
      preferences: normalizeFamilyTreeViewPreferences(parsed.preferences),
      dirty: parsed.dirty === true,
      found: true,
    };
  } catch {
    return fallback;
  }
}

export function writeFamilyTreeViewPreferenceCache(
  userId: string,
  projectId: string,
  treeId: string,
  preferences: FamilyTreeViewPreferences,
  dirty: boolean,
  storage: WritableStorage | null = browserLocalStorage(),
): void {
  if (!storage || !userId || !projectId || !treeId) return;
  const envelope: FamilyTreeViewPreferenceCacheEnvelope = {
    version: CACHE_VERSION,
    preferences: normalizeFamilyTreeViewPreferences(preferences),
    dirty,
  };
  try {
    storage.setItem(
      familyTreeViewPreferencesStorageKey(userId, projectId, treeId),
      JSON.stringify(envelope),
    );
  } catch {
    // A blocked/full storage must not prevent the live tree from working.
  }
}
