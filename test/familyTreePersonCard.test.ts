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

test("tree cards expose and explain the direct lineage fill without replacing other states", () => {
  const card = readFileSync(
    new URL("../src/features/family-tree-view/react/PersonCard.tsx", import.meta.url),
    "utf8",
  );
  const viewport = readFileSync(
    new URL("../src/features/family-tree-view/react/FamilyTreeViewport.tsx", import.meta.url),
    "utf8",
  );
  const semanticList = readFileSync(
    new URL("../src/features/family-tree-view/react/FamilyTreeSemanticList.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/features/family-tree-view/react/familyTree.css", import.meta.url),
    "utf8",
  );

  assert.match(card, /data-lineage=\{node\.lineageRole \?\? "collateral"\}/);
  assert.match(card, /data-lineage-group=\{node\.lineageGroup\}/);
  assert.match(card, /прямий предок/);
  assert.match(card, /коренева особа/);
  assert.match(viewport, /Пряма гілка/);
  assert.match(viewport, /--ft-lineage-group-/);
  assert.match(semanticList, /data-lineage-group=\{node\.lineageGroup\}/);
  assert.match(css, /--ft-direct-lineage-color:/);
  assert.match(css, /\.ft-person-card\[data-lineage="direct-ancestor"\][\s\S]*?background:\s*var\(--ft-card-lineage-fill\)/);
  assert.doesNotMatch(css, /data-lineage="direct-lineage"/);
  assert.match(css, /\.ft-person-card\[data-lineage="direct-ancestor"\] \.ft-card-actions button[\s\S]*?background:\s*var\(--ft-card-lineage-fill\)/);
  assert.match(css, /\.ft-person-card\[data-lineage-group="0"\][\s\S]*?--ft-card-lineage-color:\s*var\(--ft-lineage-group-0\)/);
  assert.match(css, /\.ft-person-card\[data-reference="true"\][\s\S]*?border-style:\s*dashed/);
  assert.match(css, /\.ft-person-card\[data-selected="true"\][\s\S]*?box-shadow:/);
});
