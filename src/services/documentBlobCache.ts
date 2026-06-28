type CachedDocumentBlob = {
  cacheKey: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: number;
  lastAccessedAt: number;
};

const DB_NAME = "tracker-rodu-document-cache";
const DB_VERSION = 1;
const STORE_NAME = "documentBlobs";
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024;
const CLEANUP_TARGET_BYTES = Math.floor(MAX_CACHE_SIZE_BYTES * 0.75);

let dbPromise: Promise<IDBDatabase> | null = null;

export async function getCachedDocumentBlob(cacheKey: string): Promise<Blob | null> {
  if (!cacheKey || !canUseIndexedDb()) return null;
  const database = await openCacheDatabase();
  const record = await idbRequest<CachedDocumentBlob | undefined>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(cacheKey),
  );
  if (!record) return null;

  void touchCachedDocument(cacheKey).catch(() => undefined);
  return record.blob;
}

export async function putCachedDocumentBlob(cacheKey: string, blob: Blob, mimeType = ""): Promise<void> {
  if (!cacheKey || !blob.size || !canUseIndexedDb()) return;
  const database = await openCacheDatabase();
  const now = Date.now();
  const record: CachedDocumentBlob = {
    cacheKey,
    blob,
    mimeType: mimeType || blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: now,
    lastAccessedAt: now,
  };

  try {
    await idbRequest(
      database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record),
    );
    await trimDocumentCache(MAX_CACHE_SIZE_BYTES);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await trimDocumentCache(CLEANUP_TARGET_BYTES);
    await idbRequest(
      database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record),
    );
  }
}

export async function clearDocumentBlobCache(): Promise<void> {
  if (!canUseIndexedDb()) return;
  const database = await openCacheDatabase();
  await idbRequest(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear());
}

export async function estimateDocumentBlobCacheSize(): Promise<number> {
  if (!canUseIndexedDb()) return 0;
  const records = await allCachedDocuments();
  return records.reduce((total, record) => total + record.size, 0);
}

async function touchCachedDocument(cacheKey: string): Promise<void> {
  const database = await openCacheDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const record = await idbRequest<CachedDocumentBlob | undefined>(store.get(cacheKey));
  if (!record) return;
  record.lastAccessedAt = Date.now();
  await idbRequest(store.put(record));
}

async function trimDocumentCache(maxBytes: number): Promise<void> {
  const database = await openCacheDatabase();
  const records = await allCachedDocuments();
  let totalSize = records.reduce((total, record) => total + record.size, 0);
  if (totalSize <= maxBytes) return;

  for (const record of records.sort((first, second) => first.lastAccessedAt - second.lastAccessedAt)) {
    if (totalSize <= maxBytes) break;
    await idbRequest(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(record.cacheKey));
    totalSize -= record.size;
  }
}

async function allCachedDocuments(): Promise<CachedDocumentBlob[]> {
  const database = await openCacheDatabase();
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
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex("lastAccessedAt", "lastAccessedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не вдалося відкрити локальний кеш документів."));
    request.onblocked = () => reject(new Error("Локальний кеш документів заблокований іншою вкладкою."));
  });
  return dbPromise;
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
