import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedResourceCache,
  BoundedThumbnailRenderQueue,
  createVirtualizedThumbnailPlan,
  LatestPdfRenderController,
} from "../src/services/pdfViewerVirtualization.ts";

test("thumbnail virtualization remains bounded after jumping to page 900 of 1000", () => {
  const plan = createVirtualizedThumbnailPlan({
    totalPages: 1_000,
    firstVisiblePage: 1,
    lastVisiblePage: 5,
    currentPage: 900,
    overscan: 2,
    currentPageRadius: 1,
  });

  assert.deepEqual(plan.mountedPages, [1, 2, 3, 4, 5, 6, 7, 899, 900, 901]);
  assert.deepEqual(plan.mountedRanges, [
    { firstPage: 1, lastPage: 7 },
    { firstPage: 899, lastPage: 901 },
  ]);
  assert.equal(plan.renderQueue[0], 900);
  assert.equal(plan.mountedPages.length, 10);
});

test("thumbnail virtualization clamps malformed and edge page ranges", () => {
  assert.deepEqual(
    createVirtualizedThumbnailPlan({
      totalPages: 0,
      firstVisiblePage: 1,
      lastVisiblePage: 1,
      currentPage: 1,
    }).mountedPages,
    [],
  );
  const lastPage = createVirtualizedThumbnailPlan({
    totalPages: 10,
    firstVisiblePage: 12,
    lastVisiblePage: 8,
    currentPage: 99,
    overscan: 4,
    currentPageRadius: 2,
  });
  assert.deepEqual(lastPage.mountedPages, [4, 5, 6, 7, 8, 9, 10]);
  assert.equal(lastPage.renderQueue[0], 10);
});

test("thumbnail queue deduplicates jobs and never exceeds configured concurrency", async () => {
  const queue = new BoundedThumbnailRenderQueue<number, string>({
    maxConcurrency: 2,
    maxPending: 8,
  });
  const gates = new Map<number, ReturnType<typeof deferred<string>>>();
  const started: number[] = [];
  let peak = 0;

  const schedule = (page: number, priority: number) => queue.schedule({
    key: page,
    priority,
    run: async () => {
      started.push(page);
      peak = Math.max(peak, queue.activeCount);
      const gate = deferred<string>();
      gates.set(page, gate);
      return gate.promise;
    },
  });

  const pageOne = schedule(1, 10);
  const pageTwo = schedule(2, 10);
  const pageThree = schedule(3, 5);
  const duplicateThree = schedule(3, 0);
  assert.equal(pageThree, duplicateThree);
  await tick();
  assert.deepEqual(started, [1, 2]);
  assert.equal(peak, 2);

  gates.get(1)!.resolve("page-1");
  assert.deepEqual(await pageOne, { status: "completed", value: "page-1" });
  await tick();
  assert.deepEqual(started, [1, 2, 3]);
  gates.get(2)!.resolve("page-2");
  gates.get(3)!.resolve("page-3");
  assert.deepEqual(await pageTwo, { status: "completed", value: "page-2" });
  assert.deepEqual(await pageThree, { status: "completed", value: "page-3" });
  assert.equal(peak, 2);
});

test("thumbnail queue cancels pages outside the window and disposes late results", async () => {
  const disposed: string[] = [];
  const queue = new BoundedThumbnailRenderQueue<number, string>({
    maxConcurrency: 1,
    maxPending: 2,
    disposeResult: (value) => disposed.push(value),
  });
  const active = deferred<string>();
  const first = queue.schedule({ key: 1, priority: 0, run: () => active.promise });
  const second = queue.schedule({ key: 2, priority: 1, run: async () => "page-2" });
  queue.retain(new Set([3]));

  assert.deepEqual(await second, { status: "cancelled" });
  active.resolve("late-page-1");
  assert.deepEqual(await first, { status: "cancelled" });
  assert.deepEqual(disposed, ["late-page-1"]);
  assert.equal(queue.activeCount, 0);
});

test("thumbnail queue drops the lowest-priority overflow without running it", async () => {
  const queue = new BoundedThumbnailRenderQueue<number, number>({
    maxConcurrency: 1,
    maxPending: 2,
  });
  const blocker = deferred<number>();
  const started: number[] = [];
  const active = queue.schedule({ key: 1, priority: 0, run: () => blocker.promise });
  const low = queue.schedule({ key: 2, priority: 20, run: async () => (started.push(2), 2) });
  const medium = queue.schedule({ key: 3, priority: 10, run: async () => (started.push(3), 3) });
  const high = queue.schedule({ key: 4, priority: 1, run: async () => (started.push(4), 4) });

  assert.deepEqual(await low, { status: "cancelled" });
  blocker.resolve(1);
  await active;
  assert.deepEqual(await high, { status: "completed", value: 4 });
  assert.deepEqual(await medium, { status: "completed", value: 3 });
  assert.deepEqual(started, [4, 3]);
});

test("resource cache evicts least-recently-used entries and disposes exactly once", () => {
  const disposed: string[] = [];
  const cache = new BoundedResourceCache<number, string>({
    capacity: 2,
    dispose: (value, key) => disposed.push(`${key}:${value}`),
  });
  cache.set(1, "one");
  cache.set(2, "two");
  assert.equal(cache.get(1), "one");
  cache.set(3, "three");
  assert.deepEqual(disposed, ["2:two"]);

  cache.retain(new Set([3]));
  assert.deepEqual(disposed, ["2:two", "1:one"]);
  cache.clear();
  assert.deepEqual(disposed, ["2:two", "1:one", "3:three"]);
  assert.equal(cache.size, 0);
});

test("latest render controller cancels the previous PDF.js task", async () => {
  const controller = new LatestPdfRenderController();
  const firstLease = controller.begin();
  const firstTask = cancelableDeferred<string>();
  const firstResult = firstLease.track(firstTask);
  const secondLease = controller.begin();
  assert.equal(firstTask.cancelled, true);
  assert.equal(firstLease.signal.aborted, true);

  const secondTask = cancelableDeferred<string>();
  const secondResult = secondLease.track(secondTask);
  firstTask.reject(new Error("RenderingCancelledException"));
  secondTask.resolve("latest");

  assert.deepEqual(await firstResult, { status: "cancelled" });
  assert.deepEqual(await secondResult, { status: "completed", value: "latest" });
  assert.equal(secondLease.isCurrent(), true);
});

test("a stale render lease cancels a task attached after page loading", async () => {
  const controller = new LatestPdfRenderController();
  const staleLease = controller.begin();
  controller.begin();
  const staleTask = cancelableDeferred<string>();

  assert.deepEqual(await staleLease.track(staleTask), { status: "cancelled" });
  assert.equal(staleTask.cancelled, true);
});

test("latest render controller preserves genuine render errors", async () => {
  const controller = new LatestPdfRenderController();
  const lease = controller.begin();
  const task = cancelableDeferred<string>();
  const result = lease.track(task);
  task.reject(new Error("Malformed PDF page"));
  await assert.rejects(result, /Malformed PDF page/u);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cancelableDeferred<T>() {
  const gate = deferred<T>();
  return {
    promise: gate.promise,
    resolve: gate.resolve,
    reject: gate.reject,
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
