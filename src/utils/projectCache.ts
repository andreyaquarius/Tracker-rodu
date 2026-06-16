// Per-project read caches (persons, documents, researches, work records,
// custom structure, analysis records) are persisted in localStorage under keys
// that all share this prefix. They contain personal genealogical data, so they
// MUST be wiped on sign-out — otherwise the next user of a shared browser can
// read the previous account's project data.

export const PROJECT_CACHE_PREFIX = "tracker-rodu-project-";

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | undefined {
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
  storage: StorageLike | undefined = defaultStorage(),
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
