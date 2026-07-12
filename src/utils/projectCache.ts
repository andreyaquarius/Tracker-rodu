// Per-project read caches (persons, documents, researches, work records,
// custom structure, analysis records) are persisted in localStorage under keys
// that all share this prefix. They contain personal genealogical data, so they
// MUST be wiped on sign-out — otherwise the next user of a shared browser can
// read the previous account's project data.

export const PROJECT_CACHE_PREFIX = "tracker-rodu-project-";
const COMPUTED_TREE_LAYOUT_CACHE_PREFIX = "family-tree-layout:";

export interface ProjectCacheStorage {
  readonly length: number;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): ProjectCacheStorage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    // Accessing localStorage can throw in privacy modes / sandboxed contexts.
    return undefined;
  }
}

/**
 * Removes every localStorage entry that holds cached project data. Safe to call
 * when storage is unavailable. Returns the number of keys removed.
 */
export function clearAllProjectCaches(
  storage: ProjectCacheStorage | undefined = defaultStorage(),
): number {
  if (!storage) return 0;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(PROJECT_CACHE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

/**
 * Writes a disposable project cache without allowing storage limits, privacy
 * mode, or a serialization error to break the actual save/load workflow.
 * Oversized entries are removed instead of repeatedly triggering quota errors.
 */
export function saveOptionalProjectCache(
  key: string,
  value: unknown,
  maxChars: number,
  storage: ProjectCacheStorage | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;

  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (typeof candidate !== "string") {
      removeOptionalProjectCache(key, storage);
      return false;
    }
    serialized = candidate;
  } catch {
    removeOptionalProjectCache(key, storage);
    return false;
  }
  if (serialized.length > maxChars) {
    removeOptionalProjectCache(key, storage);
    return false;
  }

  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    removeOptionalProjectCache(key, storage);
  }

  // Old computed tree layouts are fully reproducible and used to accumulate
  // under a new signature key after every expand/refocus operation. Reclaim
  // only those disposable entries, then make one final cache attempt.
  removeStorageEntriesWithPrefix(COMPUTED_TREE_LAYOUT_CACHE_PREFIX, storage);
  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    removeOptionalProjectCache(key, storage);
    return false;
  }
}

/**
 * Explicitly discards a reproducible cache without serializing its source data.
 * Large GEDCOM imports use this before JSON.stringify could block the UI or
 * exceed the browser storage quota.
 */
export function discardOptionalProjectCache(
  key: string,
  storage: ProjectCacheStorage | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  removeOptionalProjectCache(key, storage);
  return true;
}

function removeOptionalProjectCache(
  key: string,
  storage: ProjectCacheStorage,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // A cache is an optimization only; storage cleanup must never block the app.
  }
}

function removeStorageEntriesWithPrefix(
  prefix: string,
  storage: ProjectCacheStorage,
): number {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const candidate = storage.key(index);
      if (candidate?.startsWith(prefix)) keys.push(candidate);
    }
  } catch {
    return 0;
  }
  for (const candidate of keys) removeOptionalProjectCache(candidate, storage);
  return keys.length;
}
