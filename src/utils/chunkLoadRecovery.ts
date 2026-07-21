const CHUNK_RECOVERY_PREFIX = "tracker-rodu:chunk-recovery:";

const CHUNK_FAILURE_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /failed to load module script/i,
  /loading chunk [\w-]+ failed/i,
  /chunkloaderror/i,
] as const;

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChunkLoadRecoveryEnvironment {
  addEventListener(type: "vite:preloadError", listener: EventListener): void;
  removeEventListener(type: "vite:preloadError", listener: EventListener): void;
  storage: StorageLike;
  reload(): void;
}

interface VitePreloadErrorEvent extends Event {
  payload?: unknown;
}

export function isChunkLoadFailure(reason: unknown): boolean {
  const message = chunkFailureMessage(reason);
  return CHUNK_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Vite emits this event when an already-open application asks for a hashed
 * chunk removed by a newer deployment. Reload once for that exact failure so
 * the browser receives the current HTML/entry graph, but never create a loop.
 */
export function installChunkLoadRecovery(
  environment: ChunkLoadRecoveryEnvironment | undefined = browserEnvironment(),
): () => void {
  if (!environment) return () => undefined;

  const handlePreloadError: EventListener = event => {
    const payload = (event as VitePreloadErrorEvent).payload;
    const marker = `${CHUNK_RECOVERY_PREFIX}${fingerprint(
      chunkFailureMessage(payload),
    )}`;
    try {
      if (environment.storage.getItem(marker)) return;
      environment.storage.setItem(marker, new Date().toISOString());
    } catch {
      // Without a durable marker an automatic reload could loop forever.
      return;
    }
    event.preventDefault();
    environment.reload();
  };

  environment.addEventListener("vite:preloadError", handlePreloadError);
  return () => {
    environment.removeEventListener("vite:preloadError", handlePreloadError);
  };
}

export function resetChunkLoadRecovery(storage?: StorageLike): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key?.startsWith(CHUNK_RECOVERY_PREFIX)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
  } catch {
    // Recovery markers are best-effort and contain no application data.
  }
}

function browserEnvironment(): ChunkLoadRecoveryEnvironment | undefined {
  if (typeof window === "undefined") return undefined;
  const storage = browserStorage();
  if (!storage) return undefined;
  return {
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      window.removeEventListener(type, listener),
    storage,
    reload: () => window.location.reload(),
  };
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function chunkFailureMessage(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && !Array.isArray(reason)) {
    const candidate = reason as { message?: unknown; stack?: unknown };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.stack === "string") return candidate.stack;
  }
  return String(reason ?? "unknown-preload-error");
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
