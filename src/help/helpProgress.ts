import {
  HELP_STORAGE_KEYS,
  fullHelpTourKeys,
  type HelpGuideKey,
} from "./helpGuides.ts";

export type HelpGuideStatus = "completed" | "dismissed";
export type HelpGuideProgress = Partial<Record<HelpGuideKey, HelpGuideStatus>>;

export interface HelpProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createScopedHelpStorage(
  scopeKey: string,
  storage: HelpProgressStorage | null = browserStorage(),
): HelpProgressStorage | null {
  if (!storage) return null;
  const normalizedScope = scopeKey.trim() || "anonymous";
  const prefix = `tracker-rodu-help:${normalizedScope}:`;
  return {
    getItem(key) {
      const scopedKey = `${prefix}${key}`;
      const scopedValue = storage.getItem(scopedKey);
      if (scopedValue !== null) return scopedValue;

      // The old preference was browser-global. Move an explicit opt-out to the
      // first signed-in account that opens the upgraded help center, then remove
      // the global value so it cannot leak to another account on this browser.
      if (key === HELP_STORAGE_KEYS.autoTipsDisabled) {
        const legacyValue = storage.getItem(key);
        if (legacyValue !== null) {
          storage.setItem(scopedKey, legacyValue);
          storage.removeItem(key);
          return legacyValue;
        }
      }
      return null;
    },
    setItem(key, value) {
      storage.setItem(`${prefix}${key}`, value);
    },
    removeItem(key) {
      storage.removeItem(`${prefix}${key}`);
    },
  };
}

const guideKeySet = new Set<HelpGuideKey>(fullHelpTourKeys);

export function loadHelpGuideProgress(
  storage: HelpProgressStorage | null = browserStorage(),
): HelpGuideProgress {
  if (!storage) return {};

  const stored = readStoredProgress(storage);
  if (stored) return stored;

  // The previous help system had one all-sections tour. Preserve the completed
  // workspace introduction, but let every module teach itself on first visit.
  // This avoids opening all sections at once while still helping existing users.
  if (readHelpStorageFlag(HELP_STORAGE_KEYS.introCompleted, storage)) {
    const migrated: HelpGuideProgress = { "workspace-intro": "completed" };
    saveHelpGuideProgress(migrated, storage);
    return migrated;
  }

  return {};
}

export function updateHelpGuideStatus(
  progress: HelpGuideProgress,
  guideKey: HelpGuideKey,
  status: HelpGuideStatus,
  storage: HelpProgressStorage | null = browserStorage(),
): HelpGuideProgress {
  const next = { ...progress, [guideKey]: status };
  saveHelpGuideProgress(next, storage);
  return next;
}

export function completeAllHelpGuides(
  storage: HelpProgressStorage | null = browserStorage(),
): HelpGuideProgress {
  const completed = Object.fromEntries(
    fullHelpTourKeys.map((guideKey) => [guideKey, "completed"]),
  ) as HelpGuideProgress;
  if (storage) saveHelpGuideProgress(completed, storage);
  return completed;
}

export function shouldAutoOpenHelpGuide(input: {
  guideKey: HelpGuideKey;
  progress: HelpGuideProgress;
  autoTipsDisabled: boolean;
}): boolean {
  return !input.autoTipsDisabled && input.progress[input.guideKey] === undefined;
}

export function readHelpStorageFlag(
  key: string,
  storage: HelpProgressStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function saveHelpStorageFlag(
  key: string,
  value: boolean,
  storage: HelpProgressStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    if (value) storage.setItem(key, "1");
    else storage.removeItem(key);
  } catch {
    // Help progress is optional UI state. Storage failures must not block the app.
  }
}

function readStoredProgress(storage: HelpProgressStorage): HelpGuideProgress | null {
  try {
    const raw = storage.getItem(HELP_STORAGE_KEYS.guideProgress);
    if (raw === null) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const progress: HelpGuideProgress = {};
    for (const [candidateKey, candidateStatus] of Object.entries(value)) {
      if (
        guideKeySet.has(candidateKey as HelpGuideKey) &&
        (candidateStatus === "completed" || candidateStatus === "dismissed")
      ) {
        progress[candidateKey as HelpGuideKey] = candidateStatus;
      }
    }
    return progress;
  } catch {
    return null;
  }
}

function saveHelpGuideProgress(
  progress: HelpGuideProgress,
  storage: HelpProgressStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(HELP_STORAGE_KEYS.guideProgress, JSON.stringify(progress));
  } catch {
    // Keep the in-memory tour usable when localStorage is unavailable or full.
  }
}

function browserStorage(): HelpProgressStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}
