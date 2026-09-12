import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createGoogleDriveShortcutStore,
  GOOGLE_DRIVE_SHORTCUT_MIME_TYPE,
  resolveGoogleDriveShortcut,
  type DriveReferenceFile,
  type DriveShortcutOptions,
} from "../src/services/googleDriveShortcuts.ts";
import { uniqueNewAttachmentReferences } from "../src/utils/attachmentReferences.ts";
import {
  createProjectDriveAttachmentOrganizer,
  deleteScanFile,
  setProjectAttachmentTarget,
} from "../src/services/scanStorage.ts";
import type { ScanAttachment } from "../src/types/index.ts";

const file = { id: "original_file_id", name: "Архів.pdf", resourceKey: "original_key", parents: ["original_folder"] };
const options: DriveShortcutOptions = { projectId: "project-id", folderId: "project_folder", file };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

function fakeDrive() {
  const calls: Array<{ url: string; init?: RequestInit; maxAttempts?: number }> = [];
  const shortcuts: Array<{ id: string; parent: string; target: string }> = [];
  let loseResponse = false;
  const store = createGoogleDriveShortcutStore(async (url, init, maxAttempts) => {
    calls.push({ url, init, maxAttempts });
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://www.googleapis.com");
    assert.equal(parsed.pathname, "/drive/v3/files", "no uploads, copy, target PATCH/DELETE, media or permissions requests");
    if (!init?.method) {
      const query = parsed.searchParams.get("q") || "";
      assert.match(query, /trashed=false/);
      return json({ files: shortcuts.filter((shortcut) => query.startsWith(`'${shortcut.parent}' in parents`))
        .map((shortcut) => ({ id: shortcut.id, shortcutDetails: { targetId: shortcut.target } })) });
    }
    assert.equal(init.method, "POST");
    assert.equal(maxAttempts, 1, "a potentially committed create must not be blindly replayed");
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body as string);
    assert.deepEqual(Object.keys(body).sort(), ["appProperties", "mimeType", "name", "parents", "shortcutDetails"]);
    assert.equal(body.mimeType, GOOGLE_DRIVE_SHORTCUT_MIME_TYPE);
    assert.deepEqual(Object.keys(body.shortcutDetails), ["targetId"]);
    const shortcut = { id: `shortcut-${shortcuts.length + 1}`, parent: body.parents[0], target: body.shortcutDetails.targetId };
    shortcuts.push(shortcut);
    if (loseResponse) { loseResponse = false; throw new TypeError("Network response lost"); }
    return json({ id: shortcut.id });
  });
  return { store, calls, shortcuts, loseNextResponse: () => { loseResponse = true; } };
}

test("Drive creates a metadata-only shortcut and leaves original identity, parents and resource key unchanged", async () => {
  const drive = fakeDrive();
  const original = structuredClone(file);
  const result = await drive.store.ensure(options);
  assert.deepEqual(result, { folderId: "project_folder", shortcutId: "shortcut-1" });
  assert.deepEqual(file, original);
  const post = drive.calls.find((call) => call.init?.method === "POST")!;
  assert.equal(new Headers(post.init?.headers).get("X-Goog-Drive-Resource-Keys"), "original_file_id/original_key");
  assert.deepEqual(JSON.parse(post.init!.body as string).parents, ["project_folder"]);
});

test("reattachment and simultaneous attachment to two records reuse one shortcut", async () => {
  const drive = fakeDrive();
  const results = await Promise.all(Array.from({ length: 12 }, () => drive.store.ensure(options)));
  assert.equal(new Set(results.map((result) => result.shortcutId)).size, 1);
  assert.equal(drive.shortcuts.length, 1);
  await drive.store.ensure(options);
  assert.equal(drive.shortcuts.length, 1);
  assert.equal(drive.calls.filter((call) => call.init?.method === "POST").length, 1);
});

test("shortcut identity is folder plus target ID, not filename or attachment ID", async () => {
  const drive = fakeDrive();
  await drive.store.ensure(options);
  await drive.store.ensure({ ...options, file: { ...file, id: "different_original" } });
  await drive.store.ensure({ ...options, folderId: "other_project_subfolder" });
  assert.deepEqual(drive.shortcuts.map((shortcut) => [shortcut.parent, shortcut.target]), [
    ["project_folder", "original_file_id"], ["project_folder", "different_original"], ["other_project_subfolder", "original_file_id"],
  ]);
});

test("original already in the destination folder needs no shortcut and no Drive request", async () => {
  const drive = fakeDrive();
  assert.deepEqual(await drive.store.ensure({ ...options, file: { ...file, parents: [options.folderId] } }), { folderId: options.folderId });
  assert.equal(drive.calls.length, 0);
});

test("shortcut lookup follows pagination and reuses a user-created shortcut to the target", async () => {
  let count = 0;
  const store = createGoogleDriveShortcutStore(async (url, init) => {
    assert.equal(init?.method, undefined);
    count += 1;
    const token = new URL(url).searchParams.get("pageToken");
    return token === "page-2"
      ? json({ files: [{ id: "already-there", shortcutDetails: { targetId: file.id } }] })
      : json({ nextPageToken: "page-2", files: [{ id: "unrelated", shortcutDetails: { targetId: "unrelated" } }] });
  });
  assert.equal((await store.ensure(options)).shortcutId, "already-there");
  assert.equal(count, 2);
});

test("lost create response is reconciled without a second POST", async () => {
  const drive = fakeDrive();
  drive.loseNextResponse();
  assert.equal((await drive.store.ensure(options)).shortcutId, "shortcut-1");
  assert.equal(drive.calls.filter((call) => call.init?.method === "POST").length, 1);
});

test("failed shortcut creation never falls back to copying and releases its in-flight slot", async () => {
  let posts = 0;
  const store = createGoogleDriveShortcutStore(async (_url, init, attempts) => {
    if (init?.method) {
      posts += 1;
      assert.equal(init.method, "POST");
      assert.equal(attempts, 1);
      throw new Error("Permission denied");
    }
    return json({ files: [] });
  });
  await assert.rejects(store.ensure(options), /Permission denied/);
  await assert.rejects(store.ensure(options), /Permission denied/);
  assert.equal(posts, 2, "one create per user attempt, no automatic create retry");
});

test("cross-tab lock encloses the lookup as well as creation", async () => {
  let locked = false;
  const store = createGoogleDriveShortcutStore(async (_url, init) => {
    assert.equal(locked, true);
    return json(init?.method ? { id: "created" } : { files: [] });
  }, async (key, action) => {
    assert.deepEqual(JSON.parse(key), [options.folderId, file.id]);
    locked = true;
    try { return await action(); } finally { locked = false; }
  });
  assert.equal((await store.ensure(options)).shortcutId, "created");
  assert.equal(locked, false);
});

test("selecting a Drive shortcut resolves original metadata and target resource key", async () => {
  const calls: unknown[] = [];
  const resolved = await resolveGoogleDriveShortcut(async (id, resourceKey) => {
    calls.push([id, resourceKey]);
    return id === "shortcut" ? {
      id, mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE, resourceKey: "shortcut_key",
      shortcutDetails: { targetId: file.id, targetResourceKey: file.resourceKey },
    } : { ...file, mimeType: "application/pdf", size: "100" };
  }, "shortcut", "shortcut_key");
  assert.deepEqual(calls, [["shortcut", "shortcut_key"], [file.id, file.resourceKey]]);
  assert.equal(resolved.file.id, file.id);
  assert.equal(resolved.file.name, file.name);
  assert.equal(resolved.resourceKey, file.resourceKey);
});

test("a shortcut key is not reused when its target has no resource key", async () => {
  const resolved = await resolveGoogleDriveShortcut(async (id, key) => {
    if (id === "shortcut") return { id, mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE, shortcutDetails: { targetId: "original" } };
    assert.equal(key, undefined);
    return { id, name: "Original" };
  }, "shortcut", "shortcut_key");
  assert.equal(resolved.resourceKey, undefined);
});

test("broken, trashed and cyclic shortcuts fail instead of attaching unusable shortcut bytes", async () => {
  for (const item of [
    { id: "shortcut", trashed: true },
    { id: "shortcut", mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE },
    { id: "shortcut", mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE, shortcutDetails: { targetId: "shortcut" } },
  ] satisfies DriveReferenceFile[]) {
    await assert.rejects(resolveGoogleDriveShortcut(async () => item, "shortcut"), /кошик|Ярлик/);
  }
  await assert.rejects(resolveGoogleDriveShortcut(async () => { throw new Error("Access denied"); }, "shortcut"), /Access denied/);
});

function scan(overrides: Partial<ScanAttachment> = {}): ScanAttachment {
  return { id: "attachment-id", name: file.name, mimeType: "application/pdf", size: 100,
    storage: "google-drive", storagePath: file.id, driveResourceKey: file.resourceKey,
    createdAt: "2026-09-12T00:00:00Z", deleteOnRemove: false, ...overrides };
}

test("attachment deduplication uses resolved original IDs, retaining different files with identical names", () => {
  const original = scan();
  const viaShortcut = scan({ id: "different-row-id", driveShortcutId: "shortcut-1" });
  const other = scan({ id: "other-row", storagePath: "other-original" });
  assert.deepEqual(uniqueNewAttachmentReferences([], [original, viaShortcut, other]), [original, other]);
  assert.deepEqual(uniqueNewAttachmentReferences([original], [viaShortcut, other]), [other]);
});

test("organizer adds only shortcut metadata and keeps source fields and original deletion protection", async () => {
  setProjectAttachmentTarget("project-id", "Проєкт", true, "user-id");
  const original = scan({ sourceFingerprint: { md5: "checksum" } });
  const organize = createProjectDriveAttachmentOrganizer(["Документи", "Книга"], {
    getFileMetadata: async (id, key) => {
      assert.equal(id, original.storagePath);
      assert.equal(key, original.driveResourceKey);
      return { ...file, mimeType: "application/pdf", size: 100, webViewLink: "https://drive.google.com/original" };
    },
    ensureShortcut: async (target, metadata, path) => {
      assert.equal(target.projectId, "project-id");
      assert.equal(metadata.id, original.storagePath);
      assert.deepEqual(path, ["Документи", "Книга"]);
      return { folderId: "nested-folder", shortcutId: "shortcut-id" };
    },
  });
  const result = await organize([original]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.attachments, [{ ...original, driveShortcutId: "shortcut-id", driveShortcutFolderId: "nested-folder" }]);
  assert.equal(original.driveShortcutId, undefined);
});

test("shortcut failure still attaches the original with a visible warning, no upload fallback", async () => {
  setProjectAttachmentTarget("project-id", "Проєкт", true, "user-id");
  const original = scan();
  let shortcutCalls = 0;
  const result = await createProjectDriveAttachmentOrganizer([], {
    getFileMetadata: async () => ({ ...file, mimeType: "application/pdf", size: 100, webViewLink: "https://drive.google.com/original" }),
    ensureShortcut: async () => { shortcutCalls += 1; throw new Error("No folder permission"); },
  })([original]);
  assert.deepEqual(result.attachments, [original]);
  assert.equal(shortcutCalls, 1);
  assert.match(result.warnings[0], /прикріплено без копіювання.*ярлик.*не вдалося/);
});

test("organizer does not turn external links or app-uploaded files into new Drive files", async () => {
  const attachments = [scan({ storage: "external-url", storagePath: "https://example.org/a.pdf" }), scan({ deleteOnRemove: undefined })];
  const result = await createProjectDriveAttachmentOrganizer([], {
    getFileMetadata: async () => { throw new Error("Must not be called"); },
    ensureShortcut: async () => { throw new Error("Must not be called"); },
  })(attachments);
  assert.deepEqual(result, { attachments, warnings: [] });
});

test("switching project/account while Picker is open cannot attach into a different project", async () => {
  setProjectAttachmentTarget("first", "Перший", true, "first-user");
  const organize = createProjectDriveAttachmentOrganizer();
  setProjectAttachmentTarget("second", "Другий", true, "second-user");
  await assert.rejects(organize([scan()]), /змінився/);
});

test("switching project during a shortcut operation is not swallowed as a best-effort warning", async () => {
  setProjectAttachmentTarget("first", "Перший", true, "user");
  const organize = createProjectDriveAttachmentOrganizer([], {
    getFileMetadata: async () => {
      setProjectAttachmentTarget("second", "Другий", true, "user");
      return { ...file, mimeType: "application/pdf", size: 100, webViewLink: "https://drive.google.com/original" };
    },
  });
  await assert.rejects(organize([scan()]), /змінився/);
});

test("unlink never sends a Drive delete, including force-removal and a retained shortcut marker", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Must never delete the original"); };
  try {
    await deleteScanFile(scan(), { force: true });
    await deleteScanFile(scan({ driveShortcutId: "shortcut-id" }));
    await deleteScanFile(scan({ driveShortcutId: "shortcut-id", deleteOnRemove: undefined }), { force: true });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("all editor reference paths organize after identity/limit checks and before saving", () => {
  const source = readFileSync(new URL("../src/components/ScanAttachments.tsx", import.meta.url), "utf8");
  assert.match(source, /const unique = uniqueNewAttachmentReferences[\s\S]*?maxFiles[\s\S]*?await organize\(unique\)/);
  assert.match(source, /attachAttachmentReference[\s\S]*?await commitReferencedAttachments\(attached, organize\)/);
  assert.match(source, /attachPickedGoogleDriveFiles\(unique, policy\);\s*await commitReferencedAttachments\(attached, organize\)/);
  assert.match(source, /commitReferencedAttachments\(\[attached\], organize\)/);
  assert.match(source, /driveAttachNotice[\s\S]*role="status"/);
  assert.match(source, /Від’єднати файл/);
});
