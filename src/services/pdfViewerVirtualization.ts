/**
 * Framework-independent resource controls for the PDF.js viewer.
 *
 * The helpers in this module intentionally know nothing about React, canvas or
 * PDF.js concrete classes. This keeps the scheduling rules deterministic and
 * makes it possible to verify that a 1,000-page PDF never creates 1,000
 * canvases or concurrent render tasks.
 */

export type PageRange = {
  firstPage: number;
  lastPage: number;
};

export type VirtualizedThumbnailPlan = {
  /** Sorted page numbers that may have a mounted thumbnail row/canvas. */
  mountedPages: readonly number[];
  /** The same bounded set ordered by render importance. */
  renderQueue: readonly number[];
  /** Coalesced ranges useful for rendering top/bottom spacer elements. */
  mountedRanges: readonly PageRange[];
};

export type ThumbnailWindowOptions = {
  totalPages: number;
  firstVisiblePage: number;
  lastVisiblePage: number;
  currentPage: number;
  /** Pages mounted before and after the visible viewport. Defaults to 2. */
  overscan?: number;
  /** Current-page neighbours retained after a long jump. Defaults to 1. */
  currentPageRadius?: number;
};

/**
 * Builds a bounded thumbnail plan without materialising the complete page
 * range. The current page is retained separately when the scroll viewport has
 * not caught up after a page-number jump.
 */
export function createVirtualizedThumbnailPlan(
  options: ThumbnailWindowOptions,
): VirtualizedThumbnailPlan {
  const totalPages = toNonNegativeInteger(options.totalPages);
  if (!totalPages) {
    return { mountedPages: [], renderQueue: [], mountedRanges: [] };
  }

  const overscan = toNonNegativeInteger(options.overscan ?? 2);
  const currentPageRadius = toNonNegativeInteger(options.currentPageRadius ?? 1);
  const firstVisiblePage = clampPage(
    Math.min(options.firstVisiblePage, options.lastVisiblePage),
    totalPages,
  );
  const lastVisiblePage = clampPage(
    Math.max(options.firstVisiblePage, options.lastVisiblePage),
    totalPages,
  );
  const currentPage = clampPage(options.currentPage, totalPages);
  const viewportRange: PageRange = {
    firstPage: Math.max(1, firstVisiblePage - overscan),
    lastPage: Math.min(totalPages, lastVisiblePage + overscan),
  };
  const currentRange: PageRange = {
    firstPage: Math.max(1, currentPage - currentPageRadius),
    lastPage: Math.min(totalPages, currentPage + currentPageRadius),
  };

  const mounted = new Set<number>();
  addRange(mounted, viewportRange);
  addRange(mounted, currentRange);
  const mountedPages = [...mounted].sort((left, right) => left - right);
  const renderQueue = [...mountedPages].sort((left, right) => {
    const priorityDifference = thumbnailPriority(
      left,
      currentPage,
      firstVisiblePage,
      lastVisiblePage,
    ) - thumbnailPriority(right, currentPage, firstVisiblePage, lastVisiblePage);
    return priorityDifference || Math.abs(left - currentPage) - Math.abs(right - currentPage) || left - right;
  });

  return {
    mountedPages,
    renderQueue,
    mountedRanges: coalescePages(mountedPages),
  };
}

function thumbnailPriority(
  page: number,
  currentPage: number,
  firstVisiblePage: number,
  lastVisiblePage: number,
): number {
  if (page === currentPage) return 0;
  if (page >= firstVisiblePage && page <= lastVisiblePage) return 1;
  if (page === currentPage - 1 || page === currentPage + 1) return 2;
  return 3;
}

function addRange(target: Set<number>, range: PageRange): void {
  for (let page = range.firstPage; page <= range.lastPage; page += 1) {
    target.add(page);
  }
}

function coalescePages(pages: readonly number[]): PageRange[] {
  if (!pages.length) return [];
  const ranges: PageRange[] = [];
  let firstPage = pages[0]!;
  let lastPage = firstPage;
  for (const page of pages.slice(1)) {
    if (page === lastPage + 1) {
      lastPage = page;
      continue;
    }
    ranges.push({ firstPage, lastPage });
    firstPage = page;
    lastPage = page;
  }
  ranges.push({ firstPage, lastPage });
  return ranges;
}

function clampPage(value: number, totalPages: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(totalPages, Math.max(1, integer));
}

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export type ThumbnailRenderResult<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" };

export type ThumbnailRenderJob<TKey, TValue> = {
  key: TKey;
  /** Lower values are rendered first. */
  priority: number;
  run: (signal: AbortSignal) => Promise<TValue>;
};

export type BoundedThumbnailQueueOptions<TKey, TValue> = {
  maxConcurrency?: number;
  /** Maximum waiting jobs. Active jobs are accounted separately. */
  maxPending?: number;
  /** Cleans a late result produced after its job was cancelled. */
  disposeResult?: (value: TValue, key: TKey) => void;
};

type QueuedThumbnailJob<TKey, TValue> = {
  key: TKey;
  priority: number;
  sequence: number;
  state: "pending" | "active";
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<TValue>;
  resolve: (result: ThumbnailRenderResult<TValue>) => void;
  reject: (error: unknown) => void;
  promise: Promise<ThumbnailRenderResult<TValue>>;
};

/** A deduplicating priority queue with bounded thumbnail render concurrency. */
export class BoundedThumbnailRenderQueue<TKey, TValue> {
  readonly #maxConcurrency: number;
  readonly #maxPending: number;
  readonly #disposeResult?: (value: TValue, key: TKey) => void;
  readonly #jobs = new Map<TKey, QueuedThumbnailJob<TKey, TValue>>();
  #activeCount = 0;
  #sequence = 0;
  #disposed = false;

  constructor(options: BoundedThumbnailQueueOptions<TKey, TValue> = {}) {
    this.#maxConcurrency = positiveInteger(options.maxConcurrency ?? 2, "maxConcurrency");
    this.#maxPending = positiveInteger(options.maxPending ?? 32, "maxPending");
    this.#disposeResult = options.disposeResult;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get pendingCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) {
      if (job.state === "pending") count += 1;
    }
    return count;
  }

  schedule(job: ThumbnailRenderJob<TKey, TValue>): Promise<ThumbnailRenderResult<TValue>> {
    if (this.#disposed) return Promise.resolve({ status: "cancelled" });
    const existing = this.#jobs.get(job.key);
    if (existing) {
      if (existing.state === "pending" && job.priority < existing.priority) {
        existing.priority = finitePriority(job.priority);
      }
      return existing.promise;
    }

    let resolveJob!: (result: ThumbnailRenderResult<TValue>) => void;
    let rejectJob!: (error: unknown) => void;
    const promise = new Promise<ThumbnailRenderResult<TValue>>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const queued: QueuedThumbnailJob<TKey, TValue> = {
      key: job.key,
      priority: finitePriority(job.priority),
      sequence: this.#sequence,
      state: "pending",
      controller: new AbortController(),
      run: job.run,
      resolve: resolveJob,
      reject: rejectJob,
      promise,
    };
    this.#sequence += 1;
    this.#jobs.set(job.key, queued);
    this.#trimPendingQueue();
    this.#drain();
    return promise;
  }

  /** Cancels pending and active jobs that are no longer part of the virtual window. */
  retain(keys: ReadonlySet<TKey>): void {
    for (const job of [...this.#jobs.values()]) {
      if (!keys.has(job.key)) this.#cancelJob(job);
    }
    this.#drain();
  }

  cancel(key: TKey): boolean {
    const job = this.#jobs.get(key);
    if (!job) return false;
    this.#cancelJob(job);
    this.#drain();
    return true;
  }

  cancelAll(): void {
    for (const job of [...this.#jobs.values()]) this.#cancelJob(job);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelAll();
  }

  #trimPendingQueue(): void {
    const pending = [...this.#jobs.values()].filter((job) => job.state === "pending");
    if (pending.length <= this.#maxPending) return;
    pending.sort(compareQueuedJobs);
    for (const overflow of pending.slice(this.#maxPending)) this.#cancelJob(overflow);
  }

  #drain(): void {
    if (this.#disposed) return;
    while (this.#activeCount < this.#maxConcurrency) {
      const next = [...this.#jobs.values()]
        .filter((job) => job.state === "pending")
        .sort(compareQueuedJobs)[0];
      if (!next) break;
      this.#start(next);
    }
  }

  #start(job: QueuedThumbnailJob<TKey, TValue>): void {
    job.state = "active";
    this.#activeCount += 1;
    void job.run(job.controller.signal).then(
      (value) => {
        const wasCancelled = job.controller.signal.aborted || this.#jobs.get(job.key) !== job;
        this.#finish(job);
        if (wasCancelled) {
          try {
            this.#disposeResult?.(value, job.key);
          } catch {
            // Cleanup errors must not revive or reject an already-cancelled job.
          }
          job.resolve({ status: "cancelled" });
          return;
        }
        job.resolve({ status: "completed", value });
      },
      (error: unknown) => {
        const wasCancelled = job.controller.signal.aborted || this.#jobs.get(job.key) !== job;
        this.#finish(job);
        if (wasCancelled) {
          job.resolve({ status: "cancelled" });
          return;
        }
        job.reject(error);
      },
    );
  }

  #finish(job: QueuedThumbnailJob<TKey, TValue>): void {
    this.#activeCount -= 1;
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    this.#drain();
  }

  #cancelJob(job: QueuedThumbnailJob<TKey, TValue>): void {
    if (this.#jobs.get(job.key) !== job) return;
    this.#jobs.delete(job.key);
    job.controller.abort();
    if (job.state === "pending") job.resolve({ status: "cancelled" });
  }
}

function compareQueuedJobs<TKey, TValue>(
  left: QueuedThumbnailJob<TKey, TValue>,
  right: QueuedThumbnailJob<TKey, TValue>,
): number {
  return left.priority - right.priority || left.sequence - right.sequence;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${label} must be at least 1`);
  return Math.trunc(value);
}

function finitePriority(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export type BoundedResourceCacheOptions<TKey, TValue> = {
  capacity: number;
  dispose: (value: TValue, key: TKey) => void;
};

/** Small LRU cache that deterministically releases canvas/bitmap/object-URL resources. */
export class BoundedResourceCache<TKey, TValue> {
  readonly #capacity: number;
  readonly #dispose: (value: TValue, key: TKey) => void;
  readonly #entries = new Map<TKey, TValue>();

  constructor(options: BoundedResourceCacheOptions<TKey, TValue>) {
    this.#capacity = positiveInteger(options.capacity, "capacity");
    this.#dispose = options.dispose;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: TKey): boolean {
    return this.#entries.has(key);
  }

  get(key: TKey): TValue | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  peek(key: TKey): TValue | undefined {
    return this.#entries.get(key);
  }

  set(key: TKey, value: TValue): void {
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#entries.delete(key);
      if (!Object.is(previous, value)) this.#dispose(previous, key);
    }
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      const oldestKey = this.#entries.keys().next().value as TKey | undefined;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  delete(key: TKey): boolean {
    const value = this.#entries.get(key);
    if (value === undefined) return false;
    this.#entries.delete(key);
    this.#dispose(value, key);
    return true;
  }

  retain(keys: ReadonlySet<TKey>): void {
    for (const key of [...this.#entries.keys()]) {
      if (!keys.has(key)) this.delete(key);
    }
  }

  clear(): void {
    for (const key of [...this.#entries.keys()]) this.delete(key);
  }
}

export type CancelableRenderTask<TValue = unknown> = {
  promise: Promise<TValue>;
  cancel: () => void;
};

export type RenderTaskResult<TValue> =
  | { status: "completed"; value: TValue }
  | { status: "cancelled" };

export type PdfRenderLease = {
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
  track: <TValue>(task: CancelableRenderTask<TValue>) => Promise<RenderTaskResult<TValue>>;
};

type ActiveRender = {
  token: number;
  controller: AbortController;
  task: CancelableRenderTask<unknown> | null;
};

/** Ensures only the newest main-page PDF.js render may update the canvas. */
export class LatestPdfRenderController {
  #nextToken = 1;
  #active: ActiveRender | null = null;

  begin(): PdfRenderLease {
    this.cancel();
    const token = this.#nextToken;
    this.#nextToken += 1;
    const controller = new AbortController();
    const active: ActiveRender = { token, controller, task: null };
    this.#active = active;

    const isCurrent = () => this.#active === active && !controller.signal.aborted;
    return {
      signal: controller.signal,
      isCurrent,
      track: async <TValue>(task: CancelableRenderTask<TValue>) => {
        if (!isCurrent()) {
          task.cancel();
          return { status: "cancelled" } as const;
        }
        active.task = task;
        try {
          const value = await task.promise;
          return isCurrent()
            ? { status: "completed", value } as const
            : { status: "cancelled" } as const;
        } catch (error) {
          if (!isCurrent()) return { status: "cancelled" } as const;
          throw error;
        } finally {
          if (this.#active === active && active.task === task) active.task = null;
        }
      },
    };
  }

  cancel(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.controller.abort();
    active.task?.cancel();
  }

  dispose(): void {
    this.cancel();
  }
}
