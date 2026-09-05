import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearSensitiveLocalStorage,
  clearSensitiveProjectLocalStorage,
} from "../src/services/sensitiveBrowserState.ts";
import {
  DOCUMENT_BLOB_CACHE_TTL_MS,
  documentBlobCacheScopedKey,
} from "../src/services/documentBlobCache.ts";

function makeStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    has(key: string) {
      return values.has(key);
    },
  };
}

test("account privacy cleanup removes private mirrors but never the auth session or unrelated preferences", () => {
  const storage = makeStorage({
    "tracker-rodu-project-people:project-a": "private people",
    "tracker-rodu-project-documents:project-a": "private documents",
    "family-tree-layout:tree-a:root-a:ancestors:signature": "private layout",
    "family-tree-viewport:tree-a:root-a:ancestors": "private viewport",
    "family-tree-manual-positions-v3:tree-a:root-a:ancestors": "private positions",
    "tracker-rodu.family-tree-appearance.v1:project-a:tree-a": "private appearance",
    "tracker-rodu.family-tree-view-preferences.v1:user-a:project-a:tree-a": "private view settings",
    "tracker-rodu.feedback-draft.v1:user-a:reply:thread-a": "private unsent reply",
    "tracker-rodu-active-workspace": "project-a",
    "tracker-rodu-account-onboarded": "1",
    "tracker-rodu-ai-finding-indexing-consent": "yes",
    "tracker-rodu-google-drive-connected": "1",
    "sb-production-auth-token": "must remain for Supabase to manage",
    "tracker-rodu-analytics-consent-v1": "granted",
    "tracker-rodu.sidebar-collapsed.v1": "true",
  });

  const removed = clearSensitiveLocalStorage(storage);

  assert.equal(removed, 12);
  assert.equal(storage.has("tracker-rodu-project-people:project-a"), false);
  assert.equal(storage.has("family-tree-viewport:tree-a:root-a:ancestors"), false);
  assert.equal(storage.has("tracker-rodu-active-workspace"), false);
  assert.equal(storage.has("tracker-rodu-google-drive-connected"), false);
  assert.equal(storage.has("tracker-rodu.feedback-draft.v1:user-a:reply:thread-a"), false);
  assert.equal(storage.has("sb-production-auth-token"), true);
  assert.equal(storage.has("tracker-rodu-analytics-consent-v1"), true);
  assert.equal(storage.has("tracker-rodu.sidebar-collapsed.v1"), true);
});

test("project access cleanup removes only that project's data caches", () => {
  const storage = makeStorage({
    "tracker-rodu-project-people:project-a": "a",
    "tracker-rodu-project-documents:project-a": "a",
    "tracker-rodu.family-tree-appearance.v1:project-a:tree-a": "a",
    "tracker-rodu.family-tree-view-preferences.v1:user-a:project-a:tree-a": "a",
    "tracker-rodu.family-tree-view-preferences.v1:user-b:project-a:tree-b": "a",
    "tracker-rodu-project-people:project-b": "b",
    "tracker-rodu.family-tree-appearance.v1:project-b:tree-b": "b",
    "tracker-rodu.family-tree-view-preferences.v1:user-a:project-b:tree-b": "b",
    "family-tree-viewport:tree-a:root-a:ancestors": "visual state without project id",
    "unrelated": "keep",
  });

  assert.equal(clearSensitiveProjectLocalStorage("project-a", storage), 6);
  assert.equal(storage.has("tracker-rodu-project-people:project-a"), false);
  assert.equal(storage.has("tracker-rodu.family-tree-appearance.v1:project-a:tree-a"), false);
  assert.equal(storage.has("tracker-rodu.family-tree-view-preferences.v1:user-a:project-a:tree-a"), false);
  assert.equal(storage.has("tracker-rodu.family-tree-view-preferences.v1:user-b:project-a:tree-b"), false);
  assert.equal(storage.has("family-tree-viewport:tree-a:root-a:ancestors"), false);
  assert.equal(storage.has("tracker-rodu-project-people:project-b"), true);
  assert.equal(storage.has("tracker-rodu.family-tree-appearance.v1:project-b:tree-b"), true);
  assert.equal(storage.has("tracker-rodu.family-tree-view-preferences.v1:user-a:project-b:tree-b"), true);
  assert.equal(storage.has("unrelated"), true);
});

test("document cache keys are isolated by both user and project", () => {
  const logicalKey = "gdrive:file-1:revision-1";
  const userAProjectA = documentBlobCacheScopedKey(logicalKey, {
    userId: "user-a",
    projectId: "project-a",
  });
  assert.notEqual(
    userAProjectA,
    documentBlobCacheScopedKey(logicalKey, { userId: "user-b", projectId: "project-a" }),
  );
  assert.notEqual(
    userAProjectA,
    documentBlobCacheScopedKey(logicalKey, { userId: "user-a", projectId: "project-b" }),
  );
  assert.match(userAProjectA, /^v2:user-a:project-a:/);
  assert.equal(DOCUMENT_BLOB_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("legacy document migration is copy-verify and never deletes the v1 record during upgrade", () => {
  const source = readFileSync(
    new URL("../src/services/documentBlobCache.ts", import.meta.url),
    "utf8",
  );
  const migration = source.slice(
    source.indexOf("// v1 stored the logical cache key"),
    source.indexOf("export async function putCachedDocumentBlob"),
  );

  assert.match(migration, /readCachedDocument\(database, cacheKey\)/);
  assert.match(migration, /writeCachedDocument\(database, migrated\)/);
  assert.match(migration, /const verified = await readCachedDocument\(database, scopedKey\)/);
  assert.match(migration, /return legacyRecord\.blob/);
  assert.doesNotMatch(migration, /deleteCachedDocument\(database, cacheKey\)/);
});

test("session loss, account switch and failed server sign-out all invoke the privacy boundary", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../src/services/supabaseAuth.ts", import.meta.url), "utf8");

  assert.match(
    app,
    /if \(!session\) \{[\s\S]*?await clearSensitiveBrowserState\([\s\S]*?clearAllDocumentCaches: !previousUserId/,
  );
  assert.match(
    app,
    /previousUserId && previousUserId !== session\.user\.id[\s\S]*?await clearSensitiveBrowserState/,
  );
  assert.match(
    app,
    /catch \(error\) \{[\s\S]*?signOutLocallyFromSupabase\(\)[\s\S]*?\} finally \{[\s\S]*?await clearSensitiveBrowserState/,
  );
  assert.match(auth, /localStorage\.removeItem\(key\)/);
  assert.match(auth, /supabaseAuthStorageKey}-code-verifier/);
  assert.match(app, /remoteSignOutError[\s\S]*?window\.location\.replace/);
  assert.match(
    app,
    /setProjectAttachmentTarget\([\s\S]*?canCreateProjectRecords,[\s\S]*?account\?\.id \?\? null/,
  );
});
