export type DocumentBlobCacheScope = {
  userId: string;
  projectId: string;
  allowLegacyMigration: boolean;
};

type CachedDocumentBlob = {
  /** Physical IndexedDB key. Legacy v1 records used the logical key directly. */
  cacheKey: string;
  logicalCacheKey?: string;
  userId?: string;
  projectId?: string;
  sourceIdentity?: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt?: number;
  schemaVersion?: 2;
};

const DB_NAME = "tracker-rodu-document-cache";
const DB_VERSION = 2;
const STORE_NAME = "documentBlobs";
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024;
const CLEANUP_TARGET_BYTES = Math.floor(MAX_CACHE_SIZE_BYTES * 0.75);
export const DOCUMENT_BLOB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;
let activeScope: DocumentBlobCacheScope | null = null;

/**
 * Sets the authenticated owner/project namespace used by every subsequent
 * cache operation. No private document is read or written without a scope.
 */
export function setDocumentBlobCacheScope(
  userId: string | null | undefined,
  projectId: string | null | undefined,
  options: { allowLegacyMigration?: boolean } = {},
): void {
  const normalizedUserId = userId?.trim() ?? "";
  const normalizedProjectId = projectId?.trim() ?? "";
  activeScope = normalizedUserId && normalizedProjectId
    ? {
        userId: normalizedUserId,
        projectId: normalizedProjectId,
        allowLegacyMigration: options.allowLegacyMigration !== false,
      }
    : null;
  if (activeScope) void clearExpiredDocumentBlobCache().catch(() => undefined);
}

export function resetDocumentBlobCacheScope(): void {
  activeScope = null;
}

export function documentBlobCacheScopedKey(
  cacheKey: string,
  scope: Pick<DocumentBlobCacheScope, "userId" | "projectId">,
): string {
  return `v2:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.projectId)}:${cacheKey}`;
}

export async function getCachedDocumentBlob(
  cacheKey: string,
  expectedSourceIdentity = "",
): Promise<Blob | null> {
  const scope = activeScope;
  if (!cacheKey || !scope || !canUseIndexedDb()) return null;

  const database = await openCacheDatabase();
  const scopedKey = documentBlobCacheScopedKey(cacheKey, scope);
  const scopedRecord = await readCachedDocument(database, scopedKey);
  if (scopedRecord) {
    if (!recordMatchesSource(scopedRecord, expectedSourceIdentity)) return null;
    if (isExpired(scopedRecord)) {
      await deleteCachedDocument(database, scopedKey);
      return null;
    }
    void touchCachedDocument(scopedKey).catch(() => undefined);
    return scopedRecord.blob;
  }

  // v1 stored the logical cache key without user/project ownership. Existing
  // signed-in users must not lose that downloaded copy during the upgrade.
  // We only adopt a legacy record when the current accessible attachment has
  // the same source identity, then verify the scoped copy. The legacy record is
  // deliberately retained until a privacy boundary (sign-out/account switch),
  // so a failed migration can never destroy the user's only local copy.
  if (!scope.allowLegacyMigration) return null;
  const legacyRecord = await readCachedDocument(database, cacheKey);
  if (!legacyRecord || isScopedRecord(legacyRecord)) return null;
  if (!recordMatchesSource(legacyRecord, expectedSourceIdentity)) return null;

  const migrated = scopedRecordFromLegacy(cacheKey, legacyRecord, scope);
  try {
    await writeCachedDocument(database, migrated);
    const verified = await readCachedDocument(database, scopedKey);
    if (!verified || !sameCachedPayload(migrated, verified)) {
      await deleteCachedDocument(database, scopedKey).catch(() => undefined);
      return legacyRecord.blob;
    }
  } catch {
    return legacyRecord.blob;
  }

  void trimDocumentCache(MAX_CACHE_SIZE_BYTES).catch(() => undefined);
  return migrated.blob;
}

export async function putCachedDocumentBlob(
  cacheKey: string,
  blob: Blob,
  mimeType = "",
  sourceIdentity = cacheKey,
): Promise<void> {
  const scope = activeScope;
  if (!cacheKey || !blob.size || !scope || !canUseIndexedDb()) return;
  const database = await openCacheDatabase();
  const now = Date.now();
  const record: CachedDocumentBlob = {
    cacheKey: documentBlobCacheScopedKey(cacheKey, scope),
    logicalCacheKey: cacheKey,
    userId: scope.userId,
    projectId: scope.projectId,
    sourceIdentity,
    blob,
    mimeType: mimeType || blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: now,
    lastAccessedAt: now,
    expiresAt: now + DOCUMENT_BLOB_CACHE_TTL_MS,
    schemaVersion: 2,
  };

  try {
    await writeCachedDocument(database, record);
    await trimDocumentCache(MAX_CACHE_SIZE_BYTES);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await trimDocumentCache(CLEANUP_TARGET_BYTES);
    await writeCachedDocument(database, record);
  }
}

/** Clears the complete disposable document cache. It never touches remote files. */
export async function clearDocumentBlobCache(): Promise<void> {
  if (!canUseIndexedDb()) return;
  const database = await openCacheDatabase();
  await idbRequest(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear());
}

/**
 * Clears only one authenticated user's cache, optionally one project. Legacy
 * unowned records are removed only at an explicit privacy boundary.
 */
export async function clearDocumentBlobCacheForUser(
  userId: string,
  options: { projectId?: string; includeLegacy?: boolean } = {},
): Promise<number> {
  if (!userId || !canUseIndexedDb()) return 0;
  const database = await openCacheDatabase();
  const records = await allCachedDocuments(database);
  let removed = 0;
  for (const record of records) {
    const legacy = !isScopedRecord(record);
    const matchesUser = record.userId === userId;
    const matchesProject = !options.projectId || record.projectId === options.projectId;
    if ((matchesUser && matchesProject) || (options.includeLegacy && legacy)) {
      await deleteCachedDocument(database, record.cacheKey);
      removed += 1;
    }
  }
  return removed;
}

export async function clearExpiredDocumentBlobCache(now = Date.now()): Promise<number> {
  if (!canUseIndexedDb()) return 0;
  const database = await openCacheDatabase();
  const records = await allCachedDocuments(database);
  let removed = 0;
  for (const record of records) {
    if (record.expiresAt !== undefined && record.expiresAt <= now) {
      await deleteCachedDocument(database, record.cacheKey);
      removed += 1;
    }
  }
  return removed;
}

export async function estimateDocumentBlobCacheSize(): Promise<number> {
  if (!canUseIndexedDb()) return 0;
  const database = await openCacheDatabase();
  const records = await allCachedDocuments(database);
  return records.reduce((total, record) => total + record.size, 0);
}

function scopedRecordFromLegacy(
  logicalCacheKey: string,
  legacy: CachedDocumentBlob,
  scope: DocumentBlobCacheScope,
): CachedDocumentBlob {
  const now = Date.now();
  return {
    ...legacy,
    cacheKey: documentBlobCacheScopedKey(logicalCacheKey, scope),
    logicalCacheKey,
    userId: scope.userId,
    projectId: scope.projectId,
    lastAccessedAt: now,
    expiresAt: now + DOCUMENT_BLOB_CACHE_TTL_MS,
    schemaVersion: 2,
  };
}

function sameCachedPayload(first: CachedDocumentBlob, second: CachedDocumentBlob): boolean {
  return first.cacheKey === second.cacheKey
    && first.userId === second.userId
    && first.projectId === second.projectId
    && first.sourceIdentity === second.sourceIdentity
    && first.size === second.size
    && first.mimeType === second.mimeType
    && second.blob.size === first.blob.size;
}

function recordMatchesSource(record: CachedDocumentBlob, expectedSourceIdentity: string): boolean {
  return !expectedSourceIdentity || record.sourceIdentity === expectedSourceIdentity;
}

function isScopedRecord(record: CachedDocumentBlob): boolean {
  return record.schemaVersion === 2 && Boolean(record.userId && record.projectId);
}

function isExpired(record: CachedDocumentBlob, now = Date.now()): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

async function touchCachedDocument(physicalCacheKey: string): Promise<void> {
  const database = await openCacheDatabase();
  const record = await readCachedDocument(database, physicalCacheKey);
  if (!record) return;
  const now = Date.now();
  record.lastAccessedAt = now;
  if (isScopedRecord(record)) record.expiresAt = now + DOCUMENT_BLOB_CACHE_TTL_MS;
  await writeCachedDocument(database, record);
}

async function trimDocumentCache(maxBytes: number): Promise<void> {
  const database = await openCacheDatabase();
  const records = await allCachedDocuments(database);
  let totalSize = records.reduce((total, record) => total + record.size, 0);
  if (totalSize <= maxBytes) return;

  const now = Date.now();
  const candidates = records
    .filter((record) => isScopedRecord(record))
    .sort((first, second) => {
      const firstExpired = isExpired(first, now) ? 0 : 1;
      const secondExpired = isExpired(second, now) ? 0 : 1;
      return firstExpired - secondExpired || first.lastAccessedAt - second.lastAccessedAt;
    });

  // Never evict an unowned v1 record during the background migration. It is
  // removed only after sign-out/account switch, not because a new write needs
  // space. This is the rollback guarantee for existing users.
  for (const record of candidates) {
    if (totalSize <= maxBytes) break;
    await deleteCachedDocument(database, record.cacheKey);
    totalSize -= record.size;
  }
}

async function readCachedDocument(
  database: IDBDatabase,
  cacheKey: string,
): Promise<CachedDocumentBlob | undefined> {
  return idbRequest<CachedDocumentBlob | undefined>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(cacheKey),
  );
}

async function writeCachedDocument(
  database: IDBDatabase,
  record: CachedDocumentBlob,
): Promise<void> {
  await idbRequest(
    database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record),
  );
}

async function deleteCachedDocument(database: IDBDatabase, cacheKey: string): Promise<void> {
  await idbRequest(
    database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(cacheKey),
  );
}

async function allCachedDocuments(database: IDBDatabase): Promise<CachedDocumentBlob[]> {
  return idbRequest<CachedDocumentBlob[]>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll(),
  );
}

function openCacheDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      ensureIndex(store, "lastAccessedAt", "lastAccessedAt");
      ensureIndex(store, "expiresAt", "expiresAt");
      ensureIndex(store, "userId", "userId");
      ensureIndex(store, "projectId", "projectId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("Не вдалося відкрити локальний кеш документів."));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("Локальний кеш документів заблокований іншою вкладкою."));
    };
  });
  return dbPromise;
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Операція локального кешу не виконана."));
  });
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function isQuotaError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED"
  );
}
