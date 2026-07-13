import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  completeAllHelpGuides,
  createScopedHelpStorage,
  loadHelpGuideProgress,
  readHelpStorageFlag,
  saveHelpStorageFlag,
  shouldAutoOpenHelpGuide,
  updateHelpGuideStatus,
  type HelpProgressStorage,
} from "../src/help/helpProgress.ts";
import {
  HELP_STORAGE_KEYS,
  fullHelpTourKeys,
} from "../src/help/helpGuides.ts";

const helpCenterSource = readFileSync(
  new URL("../src/components/HelpCenter.tsx", import.meta.url),
  "utf8",
);

function memoryStorage(initial: Record<string, string> = {}): HelpProgressStorage & {
  value(key: string): string | null;
} {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    value(key) {
      return values.get(key) ?? null;
    },
  };
}

test("each module has an independent first-visit status", () => {
  const storage = memoryStorage();
  const initial = loadHelpGuideProgress(storage);
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "persons",
    progress: initial,
    autoTipsDisabled: false,
  }), true);

  const afterPersons = updateHelpGuideStatus(initial, "persons", "completed", storage);
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "persons",
    progress: afterPersons,
    autoTipsDisabled: false,
  }), false);
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "documents",
    progress: afterPersons,
    autoTipsDisabled: false,
  }), true);
  assert.deepEqual(
    JSON.parse(storage.value(HELP_STORAGE_KEYS.guideProgress) ?? "{}"),
    { persons: "completed" },
  );
});

test("help progress is isolated between accounts on the same browser", () => {
  const browser = memoryStorage();
  const firstAccount = createScopedHelpStorage("user-one", browser);
  const secondAccount = createScopedHelpStorage("user-two", browser);
  assert.ok(firstAccount);
  assert.ok(secondAccount);

  updateHelpGuideStatus({}, "tasks", "completed", firstAccount);
  assert.deepEqual(loadHelpGuideProgress(firstAccount), { tasks: "completed" });
  assert.deepEqual(loadHelpGuideProgress(secondAccount), {});
});

test("legacy automatic-tip opt-out migrates once to the current account", () => {
  const browser = memoryStorage({
    [HELP_STORAGE_KEYS.autoTipsDisabled]: "1",
  });
  const firstAccount = createScopedHelpStorage("user-one", browser);
  const secondAccount = createScopedHelpStorage("user-two", browser);

  assert.equal(
    readHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, firstAccount),
    true,
  );
  assert.equal(browser.value(HELP_STORAGE_KEYS.autoTipsDisabled), null);
  assert.equal(
    readHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, secondAccount),
    false,
  );
});

test("dismissal is persisted separately from completion", () => {
  const storage = memoryStorage();
  const dismissed = updateHelpGuideStatus({}, "findings", "dismissed", storage);
  const reloaded = loadHelpGuideProgress(storage);

  assert.equal(dismissed.findings, "dismissed");
  assert.equal(reloaded.findings, "dismissed");
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "findings",
    progress: reloaded,
    autoTipsDisabled: false,
  }), false);
});

test("legacy full tour preserves intro but enables first-visit module tours", () => {
  const storage = memoryStorage({
    [HELP_STORAGE_KEYS.introCompleted]: "1",
  });
  const progress = loadHelpGuideProgress(storage);

  assert.deepEqual(progress, { "workspace-intro": "completed" });
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "tasks",
    progress,
    autoTipsDisabled: false,
  }), true);
  assert.ok(storage.value(HELP_STORAGE_KEYS.guideProgress));
});

test("new per-guide progress takes precedence over the legacy flag", () => {
  const storage = memoryStorage({
    [HELP_STORAGE_KEYS.introCompleted]: "1",
    [HELP_STORAGE_KEYS.guideProgress]: JSON.stringify({ persons: "dismissed" }),
  });

  assert.deepEqual(loadHelpGuideProgress(storage), { persons: "dismissed" });
});

test("global automatic tips preference remains reversible", () => {
  const storage = memoryStorage();
  saveHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, true, storage);
  assert.equal(readHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, storage), true);
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "tasks",
    progress: {},
    autoTipsDisabled: true,
  }), false);

  saveHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, false, storage);
  assert.equal(readHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, storage), false);
  assert.equal(shouldAutoOpenHelpGuide({
    guideKey: "tasks",
    progress: {},
    autoTipsDisabled: false,
  }), true);
});

test("full manual tour completion records every guide", () => {
  const storage = memoryStorage();
  const progress = completeAllHelpGuides(storage);
  assert.equal(Object.keys(progress).length, fullHelpTourKeys.length);
  assert.deepEqual(loadHelpGuideProgress(storage), progress);
});

test("unavailable storage never blocks help UI", () => {
  const storage: HelpProgressStorage = {
    getItem() {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem() {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem() {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  assert.deepEqual(loadHelpGuideProgress(storage), {});
  assert.equal(readHelpStorageFlag("flag", storage), false);
  assert.doesNotThrow(() => saveHelpStorageFlag("flag", true, storage));
  assert.deepEqual(updateHelpGuideStatus({}, "map", "completed", storage), {
    map: "completed",
  });
});

test("help button manually replays the current module instead of the full tour", () => {
  const buttonSource = helpCenterSource.slice(
    helpCenterSource.indexOf('className="help-topbar-button"'),
    helpCenterSource.indexOf('aria-label="Відкрити підказки"'),
  );
  assert.match(buttonSource, /setActiveKey\(currentGuide\.key\)/);
  assert.match(buttonSource, /openSourceRef\.current = "manual"/);
  assert.doesNotMatch(buttonSource, /setActiveKey\("full-tour"\)/);
  assert.match(helpCenterSource, /Не показувати підказки автоматично/);
});
