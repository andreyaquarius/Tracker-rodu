import assert from "node:assert/strict";
import test from "node:test";
import {
  readSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_LAYOUT_CHANGE_EVENT,
  writeSidebarCollapsed,
} from "../src/utils/sidebarPreference.ts";

test("sidebar preference defaults to expanded and restores a persisted collapse", () => {
  assert.equal(readSidebarCollapsed(null), false);
  assert.equal(readSidebarCollapsed({ getItem: () => null }), false);
  assert.equal(
    readSidebarCollapsed({
      getItem: (key) => key === SIDEBAR_COLLAPSED_STORAGE_KEY ? "true" : null,
    }),
    true,
  );
});

test("sidebar preference tolerates unavailable browser storage", () => {
  assert.equal(readSidebarCollapsed({
    getItem: () => {
      throw new Error("blocked");
    },
  }), false);

  assert.doesNotThrow(() => writeSidebarCollapsed({
    setItem: () => {
      throw new Error("quota exceeded");
    },
  }, true));
});

test("sidebar preference persists explicit boolean values", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  writeSidebarCollapsed(storage, true);
  assert.equal(readSidebarCollapsed(storage), true);
  writeSidebarCollapsed(storage, false);
  assert.equal(readSidebarCollapsed(storage), false);
  assert.equal(SIDEBAR_LAYOUT_CHANGE_EVENT, "tracker-sidebar-layout-change");
});
