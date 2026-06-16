import test from "node:test";
import assert from "node:assert/strict";
import { clearAllProjectCaches, PROJECT_CACHE_PREFIX } from "../src/utils/projectCache.ts";

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
