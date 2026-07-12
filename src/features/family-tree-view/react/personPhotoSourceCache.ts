import type { ScanAttachment } from "../../../types/index.ts";

export interface ResolvedTreePersonPhotoSource {
  url: string;
  revokeOnClose: boolean;
}

export type TreePersonPhotoSourceResolver = (
  photo: ScanAttachment,
) => Promise<ResolvedTreePersonPhotoSource | null>;

export interface TreePersonPhotoSourceLease {
  source: Promise<ResolvedTreePersonPhotoSource | null>;
  release: () => void;
}

interface CacheEntry {
  key: string;
  photo: ScanAttachment;
  resolver: TreePersonPhotoSourceResolver;
  references: number;
  state: "queued" | "loading" | "ready" | "failed";
  promise: Promise<ResolvedTreePersonPhotoSource | null>;
  resolve: (source: ResolvedTreePersonPhotoSource | null) => void;
  source: ResolvedTreePersonPhotoSource | null;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const MAX_CONCURRENT_PHOTO_LOADS = 4;
const UNUSED_SOURCE_TTL_MS = 20_000;
const cache = new Map<string, CacheEntry>();
const queue: CacheEntry[] = [];
let activeLoads = 0;

/**
 * Shares portrait object URLs between duplicate occurrences and limits Drive
 * reads. A released off-screen card keeps its URL briefly so panning back does
 * not immediately download/decode the same image again.
 */
export function leaseTreePersonPhotoSource(
  photo: ScanAttachment,
  resolver: TreePersonPhotoSourceResolver,
): TreePersonPhotoSourceLease {
  const key = photoCacheKey(photo);
  let entry = cache.get(key);
  let created = false;
  if (!entry || entry.resolver !== resolver || entry.state === "failed") {
    if (entry && entry.references === 0) disposeEntry(entry);
    entry = createEntry(key, photo, resolver);
    entry.references = 1;
    created = true;
    cache.set(key, entry);
    queue.push(entry);
    drainQueue();
  }

  if (!created) entry.references += 1;
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
  }
  let released = false;
  return {
    source: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry!.references = Math.max(0, entry!.references - 1);
      if (entry!.references === 0) scheduleCleanup(entry!);
    },
  };
}

export function photoCacheKey(photo: ScanAttachment): string {
  const version = photo.driveRevisionId
    || photo.driveMd5Checksum
    || photo.driveModifiedTime
    || String(photo.size || photo.createdAt || "unknown");
  return [photo.storage, photo.storagePath, version].join(":");
}

function createEntry(
  key: string,
  photo: ScanAttachment,
  resolver: TreePersonPhotoSourceResolver,
): CacheEntry {
  let resolve!: (source: ResolvedTreePersonPhotoSource | null) => void;
  const promise = new Promise<ResolvedTreePersonPhotoSource | null>((done) => {
    resolve = done;
  });
  return {
    key,
    photo,
    resolver,
    references: 0,
    state: "queued",
    promise,
    resolve,
    source: null,
  };
}

function drainQueue(): void {
  while (activeLoads < MAX_CONCURRENT_PHOTO_LOADS && queue.length) {
    const entry = queue.shift()!;
    if (cache.get(entry.key) !== entry) {
      entry.resolve(null);
      continue;
    }
    if (entry.references === 0) {
      cache.delete(entry.key);
      entry.state = "failed";
      entry.resolve(null);
      continue;
    }
    activeLoads += 1;
    entry.state = "loading";
    void entry.resolver(entry.photo)
      .then((source) => {
        entry.source = source;
        entry.state = "ready";
        entry.resolve(source);
        if (entry.references === 0) scheduleCleanup(entry);
      })
      .catch(() => {
        entry.state = "failed";
        entry.resolve(null);
        if (cache.get(entry.key) === entry) cache.delete(entry.key);
      })
      .finally(() => {
        activeLoads -= 1;
        drainQueue();
      });
  }
}

function scheduleCleanup(entry: CacheEntry): void {
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = setTimeout(() => {
    if (entry.references === 0) disposeEntry(entry);
  }, UNUSED_SOURCE_TTL_MS);
}

function disposeEntry(entry: CacheEntry): void {
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  if (cache.get(entry.key) === entry) cache.delete(entry.key);
  if (entry.source?.revokeOnClose && entry.source.url) {
    URL.revokeObjectURL(entry.source.url);
  }
  entry.source = null;
}

/** Test-only reset; deliberately not used by production rendering. */
export function clearTreePersonPhotoSourceCache(): void {
  for (const entry of cache.values()) disposeEntry(entry);
  cache.clear();
  queue.splice(0, queue.length);
}
