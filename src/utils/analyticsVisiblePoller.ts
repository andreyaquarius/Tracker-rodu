/** One bounded read at a time; a hidden/unmounted admin page never keeps polling. */
export function startAnalyticsVisiblePoller<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError: (error: unknown) => void;
  onLoading: () => void;
  visibility: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const visible = () => options.visibility.visibilityState === "visible";
  function refresh() {
    if (stopped || !visible() || pending) return;
    clearTimeout(timer);
    const current = new AbortController();
    controller = current;
    options.onLoading();
    const deadline = setTimeout(() => current.abort(), options.timeoutMs ?? 15_000);
    pending = (async () => {
      try {
        const data = await Promise.race([
          Promise.resolve().then(() => options.load(current.signal)),
          new Promise<never>((_, reject) => {
            current.signal.addEventListener("abort", () => reject(new Error("ANALYTICS_REQUEST_ABORTED")), { once: true });
          }),
        ]);
        if (!stopped && !current.signal.aborted && visible()) options.onData(data);
      } catch (error) {
        if (!stopped && visible()) options.onError(error);
      } finally {
        clearTimeout(deadline);
        pending = undefined;
        controller = undefined;
        if (!stopped && visible()) timer = setTimeout(refresh, options.intervalMs ?? 30_000);
      }
    })();
  }
  function visibilityChanged() {
    clearTimeout(timer);
    if (visible()) refresh();
    else controller?.abort();
  }
  options.visibility.addEventListener("visibilitychange", visibilityChanged);
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      options.visibility.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
