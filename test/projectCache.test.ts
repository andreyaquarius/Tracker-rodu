import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllProjectCaches,
  discardOptionalProjectCache,
  PROJECT_CACHE_PREFIX,
  saveOptionalProjectCache,
} from "../src/utils/projectCache.ts";

function makeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    get(key: string) {
      return map.get(key);
    },
    has(key: string) {
      return map.has(key);
    },
  };
}

// F-05: sign-out must wipe every cached-project key but leave unrelated keys.
test("removes all project cache keys and keeps unrelated keys", () => {
  const storage = makeStorage({
    [`${PROJECT_CACHE_PREFIX}people:abc`]: "[secret persons]",
    [`${PROJECT_CACHE_PREFIX}documents:abc`]: "[secret docs]",
    [`${PROJECT_CACHE_PREFIX}analysis-records:xyz`]: "[secret]",
    "tracker-rodu-active-workspace": "abc",
    "unrelated-key": "keep me",
  });

  const removed = clearAllProjectCaches(storage);

  assert.equal(removed, 3);
  assert.equal(storage.has(`${PROJECT_CACHE_PREFIX}people:abc`), false);
  assert.equal(storage.has(`${PROJECT_CACHE_PREFIX}documents:abc`), false);
  assert.equal(storage.has(`${PROJECT_CACHE_PREFIX}analysis-records:xyz`), false);
  assert.equal(storage.has("tracker-rodu-active-workspace"), true);
  assert.equal(storage.has("unrelated-key"), true);
});

test("is a no-op when storage is unavailable", () => {
  assert.equal(clearAllProjectCaches(undefined), 0);
});

test("optional cache writes a payload within its size budget", () => {
  const storage = makeStorage({});
  const key = `${PROJECT_CACHE_PREFIX}people:abc`;

  assert.equal(saveOptionalProjectCache(key, { persons: [{ id: "1" }] }, 1_000, storage), true);
  assert.equal(storage.get(key), JSON.stringify({ persons: [{ id: "1" }] }));
});

test("optional cache drops only its own oversized entry", () => {
  const key = `${PROJECT_CACHE_PREFIX}documents:abc`;
  const storage = makeStorage({
    [key]: "stale",
    "unrelated-key": "keep me",
  });

  assert.equal(saveOptionalProjectCache(key, { text: "too large" }, 5, storage), false);
  assert.equal(storage.has(key), false);
  assert.equal(storage.get("unrelated-key"), "keep me");
});

test("explicitly discards a large reproducible cache without serializing it", () => {
  const key = `${PROJECT_CACHE_PREFIX}work-records:abc`;
  const storage = makeStorage({ [key]: "stale", "unrelated-key": "keep me" });
  const value = {
    toJSON() {
      throw new Error("must not serialize");
    },
  };

  assert.equal(discardOptionalProjectCache(key, storage), true);
  assert.equal(storage.has(key), false);
  assert.equal(storage.get("unrelated-key"), "keep me");
  assert.equal(typeof value.toJSON, "function");
});

test("optional cache swallows quota errors and removes its stale entry", () => {
  const key = `${PROJECT_CACHE_PREFIX}documents:abc`;
  const storage = makeStorage({ [key]: "stale" });
  storage.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };

  assert.equal(saveOptionalProjectCache(key, { documents: [] }, 1_000, storage), false);
  assert.equal(storage.has(key), false);
});

test("optional cache removes computed layouts and retries once after quota", () => {
  const key = `${PROJECT_CACHE_PREFIX}documents:abc`;
  const layoutKey = "family-tree-layout:tree:root:ancestors:old-signature";
  const storage = makeStorage({
    [layoutKey]: "large disposable projection",
    "tracker-rodu-auth-token": "keep auth",
  });
  const originalSetItem = storage.setItem.bind(storage);
  let attempts = 0;
  storage.setItem = (candidate, value) => {
    attempts += 1;
    if (storage.has(layoutKey)) throw new DOMException("quota", "QuotaExceededError");
    originalSetItem(candidate, value);
  };

  assert.equal(saveOptionalProjectCache(key, { documents: [] }, 1_000, storage), true);
  assert.equal(attempts, 2);
  assert.equal(storage.has(layoutKey), false);
  assert.equal(storage.get("tracker-rodu-auth-token"), "keep auth");
});
