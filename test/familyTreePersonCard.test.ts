import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ScanAttachment } from "../src/types/index.ts";
import {
  clearTreePersonPhotoSourceCache,
  leaseTreePersonPhotoSource,
  photoCacheKey,
} from "../src/features/family-tree-view/react/personPhotoSourceCache.ts";

const photo: ScanAttachment = {
  id: "portrait",
  name: "portrait.jpg",
  mimeType: "image/jpeg",
  size: 2048,
  createdAt: "2026-07-12T00:00:00.000Z",
  storage: "google-drive",
  storagePath: "drive-file-id",
  driveRevisionId: "revision-1",
};

test("tree portrait cache shares one Drive source between duplicate mounted cards", async () => {
  let calls = 0;
  const resolver = async () => {
    calls += 1;
    return { url: "blob:portrait", revokeOnClose: false };
  };
  const first = leaseTreePersonPhotoSource(photo, resolver);
  const second = leaseTreePersonPhotoSource({ ...photo }, resolver);

  assert.deepEqual(await first.source, { url: "blob:portrait", revokeOnClose: false });
  assert.deepEqual(await second.source, { url: "blob:portrait", revokeOnClose: false });
  assert.equal(calls, 1);
  assert.equal(photoCacheKey(photo), "google-drive:drive-file-id:revision-1");

  first.release();
  second.release();
  clearTreePersonPhotoSourceCache();
});

test("tree card keeps full names and life dates readable without a single-line ellipsis", () => {
  const card = readFileSync(
    new URL("../src/features/family-tree-view/react/PersonCard.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/features/family-tree-view/react/familyTree.css", import.meta.url),
    "utf8",
  );

  assert.match(card, /<strong title=\{name\}>\{name\}<\/strong>/);
  assert.match(card, /<small title=\{life\}>\{life\}<\/small>/);
  assert.match(css, /\.ft-card-copy strong[\s\S]*?-webkit-line-clamp:\s*3/);
  assert.match(css, /\.ft-card-copy small[\s\S]*?-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(css.match(/\.ft-card-copy strong,[\s\S]*?\n\}/)?.[0] ?? "", /white-space:\s*nowrap/);
});
