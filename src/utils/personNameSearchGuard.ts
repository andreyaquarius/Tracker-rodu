import { isDatabaseStatementTimeout } from "./databaseErrors.ts";

export class PersonNameSearchPausedError extends Error {
  constructor() {
    super("Пошук історичних імен тимчасово призупинено після таймауту. Пошук серед завантажених осіб працює; серверні підказки відновляться через хвилину.");
  }
}

/** Session-scoped, memory-only cache. Sharing a request must not let one
 * unmounted picker cancel another picker's request for the same name. */
export function createPersonNameSearchGuard<T>(now = Date.now) {
  let activeScope = "";
  let pausedUntil = 0;
  const cache = new Map<string, { value: T; expires: number }>();
  const pending = new Map<string, { promise: Promise<T>; controller: AbortController; readers: number }>();
  return async (scope: string, key: string, invoke: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (activeScope !== scope) {
      for (const item of pending.values()) item.controller.abort();
      pending.clear(); cache.clear(); pausedUntil = 0; activeScope = scope;
    }
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (pausedUntil > now()) throw new PersonNameSearchPausedError();
    let item = pending.get(key);
    if (!item || item.controller.signal.aborted) {
      const controller = new AbortController();
      item = { controller, readers: 0, promise: Promise.resolve(undefined as T) };
      const current = item;
      const timeout = setTimeout(() => controller.abort(), 6500);
      item.promise = invoke(controller.signal).then((value) => {
        if (activeScope === scope && !controller.signal.aborted) {
          cache.set(key, { value, expires: now() + 30_000 });
          if (cache.size > 100) cache.delete(cache.keys().next().value!);
        }
        return value;
      }).catch((error: unknown) => {
        if (activeScope === scope && (isDatabaseStatementTimeout(error) || (controller.signal.aborted && current.readers > 0))) {
          pausedUntil = now() + 60_000;
        }
        throw error;
      }).finally(() => {
        clearTimeout(timeout);
        if (pending.get(key) === current) pending.delete(key);
      });
      pending.set(key, item);
    }
    const shared = item;
    shared.readers += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        shared.readers -= 1;
        if (!shared.readers && pending.get(key) === shared) shared.controller.abort();
        return true;
      };
      const abort = () => { if (finish()) reject(new DOMException("Aborted", "AbortError")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      shared.promise.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    });
  };
}
