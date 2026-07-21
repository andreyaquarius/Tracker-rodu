import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  installChunkLoadRecovery,
  isChunkLoadFailure,
  resetChunkLoadRecovery,
  type ChunkLoadRecoveryEnvironment,
} from "../src/utils/chunkLoadRecovery.ts";

interface MemoryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(initialEntries: readonly (readonly [string, string])[] = []): MemoryStorage {
  const entries = new Map<string, string>(initialEntries);
  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

function preloadFailure(message: string): Event & { payload: Error } {
  const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
    payload: Error;
  };
  event.payload = new TypeError(message);
  return event;
}

function recoveryHarness(storage: MemoryStorage = memoryStorage()) {
  const target = new EventTarget();
  let reloads = 0;
  const environment: ChunkLoadRecoveryEnvironment = {
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    storage,
    reload: () => {
      reloads += 1;
    },
  };
  return {
    environment,
    dispatch: (event: Event) => target.dispatchEvent(event),
    reloadCount: () => reloads,
  };
}

test("chunk failure detection recognizes stale Vite assets without treating ordinary requests as chunks", () => {
  assert.equal(isChunkLoadFailure(new TypeError(
    "Failed to fetch dynamically imported module: https://trekerrodu.com.ua/assets/PersonsModuleV2-D8AZ1n2w.js",
  )), true);
  assert.equal(isChunkLoadFailure(new Error("Importing a module script failed.")), true);
  assert.equal(isChunkLoadFailure(new Error("ChunkLoadError: Loading chunk persons failed")), true);

  assert.equal(isChunkLoadFailure(new TypeError("Failed to fetch")), false);
  assert.equal(isChunkLoadFailure(new Error("TREE_GRAPH_VERSION_CHANGED")), false);
});

test("a missing deployment chunk triggers exactly one automatic reload for that failure", () => {
  const harness = recoveryHarness();
  const uninstall = installChunkLoadRecovery(harness.environment);
  const message =
    "Failed to fetch dynamically imported module: https://trekerrodu.com.ua/assets/PersonsModuleV2-old.js";

  const first = preloadFailure(message);
  harness.dispatch(first);
  harness.dispatch(preloadFailure(message));

  assert.equal(first.defaultPrevented, true);
  assert.equal(harness.reloadCount(), 1, "the same stale asset must never create a reload loop");

  uninstall();
  harness.dispatch(preloadFailure("Failed to load module script: /assets/other-old.js"));
  assert.equal(harness.reloadCount(), 1, "uninstall must detach the global recovery listener");
});

test("different stale chunk fingerprints can each recover once", () => {
  const harness = recoveryHarness();
  const uninstall = installChunkLoadRecovery(harness.environment);

  harness.dispatch(preloadFailure("Failed to load module script: /assets/PersonsModuleV2-old.js"));
  harness.dispatch(preloadFailure("Failed to load module script: /assets/MapPage-old.js"));
  harness.dispatch(preloadFailure("Failed to load module script: /assets/MapPage-old.js"));

  assert.equal(harness.reloadCount(), 2);
  uninstall();
});

test("automatic recovery fails closed when session storage cannot persist its loop guard", () => {
  const brokenStorage: MemoryStorage = {
    length: 0,
    key: () => null,
    getItem() {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem() {
      throw new DOMException("blocked", "SecurityError");
    },
    removeItem() {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  const harness = recoveryHarness(brokenStorage);
  const uninstall = installChunkLoadRecovery(harness.environment);

  harness.dispatch(preloadFailure("Failed to load module script: /assets/PersonsModuleV2-old.js"));

  assert.equal(harness.reloadCount(), 0, "a reload without a durable marker could loop forever");
  uninstall();
});

test("recovery markers can be reset without deleting unrelated session state", () => {
  const storage = memoryStorage([
    ["tracker-rodu:chunk-recovery:old-persons", "2026-07-21T00:00:00.000Z"],
    ["tracker-rodu-active-workspace", "project-1"],
  ]);

  resetChunkLoadRecovery(storage);

  assert.equal(storage.getItem("tracker-rodu:chunk-recovery:old-persons"), null);
  assert.equal(storage.getItem("tracker-rodu-active-workspace"), "project-1");
});

test("the application installs recovery before routing and provides a friendly route fallback", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const boundary = readFileSync(
    new URL("../src/components/ApplicationRouteError.tsx", import.meta.url),
    "utf8",
  );

  const installAt = main.indexOf("installChunkLoadRecovery()");
  const routerAt = main.indexOf("createBrowserRouter([");
  assert.ok(installAt >= 0 && routerAt > installAt, "recovery must be active before lazy routes load");
  assert.match(main, /errorElement:\s*<ApplicationRouteError\s*\/>/u);
  assert.match(boundary, /isChunkLoadFailure\(error\)/u);
  assert.match(boundary, /Потрібно оновити сторінку/u);
  assert.match(boundary, /Ваші дані в проєкті не пошкоджені/u);
  assert.match(boundary, /Оновити сторінку/u);
  assert.doesNotMatch(boundary, /\{String\(error\)\}|error\.stack/u);
});
