import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = service.indexOf(startMarker);
  const end = service.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section start: ${startMarker}`);
  assert.ok(end > start, `missing section end: ${endMarker}`);
  return service.slice(start, end);
}

test("draft and attachment deletes use the durable cleanup outbox rather than browser Storage removal", () => {
  const draftDelete = section(
    "export async function deleteMyZagulyakaDraft(",
    "export async function uploadZagulyakaDraftAttachment(",
  );
  const attachmentDelete = section(
    "export async function deleteZagulyakaDraftAttachment(",
    "async function wakeMyZagulyakyStorageCleanup()",
  );

  assert.match(draftDelete, /client\.rpc\("delete_my_zagulyaka_draft_v3"/);
  assert.match(attachmentDelete, /client\.rpc\("delete_my_zagulyaka_attachment_v2"/);
  assert.doesNotMatch(draftDelete, /privateObjects|client\.storage\.from\("zagulyaky-private"\)\.remove/);
  assert.doesNotMatch(attachmentDelete, /storagePath|client\.storage\.from\("zagulyaky-private"\)\.remove/);
  assert.match(service, /invokeEdgeFunction\("zagulyaky-storage-cleanup", \{ action: "process_mine", limit: 20 \}/);
  assert.match(service, /storageCleanupWakeSucceeded/);
});
