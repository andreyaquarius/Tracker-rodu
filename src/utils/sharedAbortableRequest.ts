/** Shares only in-flight reads. Each caller owns its cancellation, not the transport. */
export function createSharedAbortableRequest<T>() {
  const pending = new Map<string, {
    controller: AbortController;
    promise: Promise<T>;
    consumers: number;
    settled: boolean;
  }>();
  const aborted = () => new DOMException("Aborted", "AbortError");

  return {
    run(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(aborted());
      let entry = pending.get(key);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          controller, consumers: 0, settled: false,
          promise: Promise.resolve().then(() => {
            if (controller.signal.aborted) throw aborted();
            return load(controller.signal);
          }),
        };
        const current = entry;
        const finish = () => {
          current.settled = true;
          if (pending.get(key) === current) pending.delete(key);
        };
        current.promise.then(finish, finish);
        pending.set(key, current);
      }
      const current = entry;
      current.consumers += 1;
      return new Promise<T>((resolve, reject) => {
        let released = false;
        const release = () => {
          if (released) return false;
          released = true;
          signal?.removeEventListener("abort", cancel);
          current.consumers -= 1;
          if (!current.consumers && !current.settled) {
            current.controller.abort();
            if (pending.get(key) === current) pending.delete(key);
          }
          return true;
        };
        const cancel = () => { if (release()) reject(aborted()); };
        signal?.addEventListener("abort", cancel, { once: true });
        current.promise.then((value) => {
          if (!release()) return;
          if (current.controller.signal.aborted) reject(aborted());
          else resolve(value);
        }, (error: unknown) => { if (release()) reject(error); });
      });
    },
    clear() {
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    },
  };
}
