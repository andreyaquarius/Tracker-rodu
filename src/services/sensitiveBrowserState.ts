import {
  clearDocumentBlobCache,
  clearDocumentBlobCacheForUser,
  resetDocumentBlobCacheScope,
} from "./documentBlobCache.ts";
import { clearGoogleDriveSession } from "./googleDriveStorage.ts";
import {
  PROJECT_CACHE_PREFIX,
  type ProjectCacheStorage,
} from "../utils/projectCache.ts";
import {
  FAMILY_TREE_VIEW_PREFERENCES_STORAGE_PREFIX,
} from "../utils/familyTreeViewPreferences.ts";
import { FEEDBACK_DRAFT_STORAGE_PREFIX } from "../utils/feedbackDrafts.ts";

export const SENSITIVE_LOCAL_STORAGE_PREFIXES = Object.freeze([
  PROJECT_CACHE_PREFIX,
  "family-tree-layout:",
  "family-tree-viewport:",
  "family-tree-manual-positions-v3:",
  "tracker-rodu.family-tree-appearance.v1:",
  FAMILY_TREE_VIEW_PREFERENCES_STORAGE_PREFIX,
  FEEDBACK_DRAFT_STORAGE_PREFIX,
]);

export const SENSITIVE_LOCAL_STORAGE_KEYS = Object.freeze([
  "tracker-rodu-account-onboarded",
  "tracker-rodu-active-workspace",
  "tracker-rodu-ai-finding-indexing-consent",
  "tracker-rodu-google-drive-connected",
]);

export interface SensitiveBrowserCleanupResult {
  localStorageEntriesRemoved: number;
  documentCacheEntriesRemoved: number;
  errors: string[];
}

function browserStorage(): ProjectCacheStorage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Removes private account/project mirrors while preserving unrelated settings. */
export function clearSensitiveLocalStorage(
  storage: ProjectCacheStorage | undefined = browserStorage(),
): number {
  if (!storage) return 0;
  const exact = new Set<string>(SENSITIVE_LOCAL_STORAGE_KEYS);
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key &&
        (exact.has(key) || SENSITIVE_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)))
      ) {
        keys.push(key);
      }
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // A privacy-mode storage failure must not prevent the remaining cleanup.
    }
  }
  return removed;
}

/** Removes cache entries for one project after membership/access is lost. */
export function clearSensitiveProjectLocalStorage(
  projectId: string,
  storage: ProjectCacheStorage | undefined = browserStorage(),
): number {
  if (!projectId || !storage) return 0;
  const projectSuffix = `:${projectId}`;
  const appearancePrefix = `tracker-rodu.family-tree-appearance.v1:${projectId}:`;
  const viewPreferencesPrefix = FAMILY_TREE_VIEW_PREFERENCES_STORAGE_PREFIX;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      if (
        (key.startsWith(PROJECT_CACHE_PREFIX) && key.endsWith(projectSuffix)) ||
        key.startsWith(appearancePrefix) ||
        (
          key.startsWith(viewPreferencesPrefix) &&
          key.slice(viewPreferencesPrefix.length).split(":")[1] === projectId
        ) ||
        key.startsWith("family-tree-layout:") ||
        key.startsWith("family-tree-viewport:") ||
        key.startsWith("family-tree-manual-positions-v3:")
      ) {
        keys.push(key);
      }
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Keep clearing the rest; these are reproducible mirrors only.
    }
  }
  return removed;
}

let cleanupChain: Promise<void> = Promise.resolve();

/**
 * Enforces an account privacy boundary. Remote Supabase/Drive records are never
 * deleted here; only browser-local mirrors and downloaded document blobs are.
 */
export function clearSensitiveBrowserState(options: {
  userId?: string | null;
  includeLegacyDocumentCache?: boolean;
  clearAllDocumentCaches?: boolean;
} = {}): Promise<SensitiveBrowserCleanupResult> {
  const operation = cleanupChain
    .catch(() => undefined)
    .then(async () => {
      const result: SensitiveBrowserCleanupResult = {
        localStorageEntriesRemoved: 0,
        documentCacheEntriesRemoved: 0,
        errors: [],
      };

      try {
        if (typeof window !== "undefined") clearGoogleDriveSession();
      } catch (error) {
        result.errors.push(errorText(error));
      }

      result.localStorageEntriesRemoved = clearSensitiveLocalStorage();
      resetDocumentBlobCacheScope();

      try {
        if (options.clearAllDocumentCaches || !options.userId) {
          await clearDocumentBlobCache();
        } else {
          result.documentCacheEntriesRemoved = await clearDocumentBlobCacheForUser(
            options.userId,
            { includeLegacy: options.includeLegacyDocumentCache !== false },
          );
        }
      } catch (error) {
        result.errors.push(errorText(error));
      }

      return result;
    });

  // A failed cleanup must never permanently block the next privacy boundary.
  cleanupChain = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function clearSensitiveProjectBrowserState(
  userId: string,
  projectId: string,
): Promise<SensitiveBrowserCleanupResult> {
  const result: SensitiveBrowserCleanupResult = {
    localStorageEntriesRemoved: clearSensitiveProjectLocalStorage(projectId),
    documentCacheEntriesRemoved: 0,
    errors: [],
  };
  try {
    result.documentCacheEntriesRemoved = await clearDocumentBlobCacheForUser(userId, {
      projectId,
      includeLegacy: false,
    });
  } catch (error) {
    result.errors.push(errorText(error));
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
