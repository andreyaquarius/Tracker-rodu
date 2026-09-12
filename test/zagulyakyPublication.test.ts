import assert from "node:assert/strict";
import test from "node:test";
import { attachmentPublicationAction, isArchivalPublicationSource, publicationBlocker, publishZagulyakaWithAttachments } from "../src/utils/zagulyakyPublication.ts";

test("attachment publication respects the parent record workflow", () => {
  assert.equal(attachmentPublicationAction({ status: "pending_review", privacyStatus: "pending" }), "publish_record");
  assert.equal(attachmentPublicationAction({ status: "published", privacyStatus: "cleared" }), "publish_attachment");
  for (const status of ["draft", "archived", "withdrawn", "merged", "needs_changes", "rejected"]) {
    assert.equal(attachmentPublicationAction({ status, privacyStatus: "cleared" }), "unavailable");
  }
  for (const privacyStatus of ["pending", "requires_consent", "blocked"]) {
    assert.equal(attachmentPublicationAction({ status: "published", privacyStatus }), "unavailable");
  }
  assert.equal(attachmentPublicationAction({ status: "pending_review", privacyStatus: "blocked" }), "unavailable");
});

test("archival source must be identifiable and not restricted", () => {
  for (const evidence of [{ citation: "Ф. 12, оп. 1, спр. 5" }, { archive_name: "Державний архів" }, { source_url: "https://archive.example/1" }]) {
    assert.equal(isArchivalPublicationSource({ id: "source", ...evidence }), true);
    assert.equal(isArchivalPublicationSource({ id: "source", ...evidence, permission_status: "restricted" }), false);
  }
  assert.equal(isArchivalPublicationSource({ id: "source", title: "Лише назва", citation: " " }), false);
  assert.equal(isArchivalPublicationSource({ id: "source", source_url: "javascript:alert(1)" }), false);
  assert.equal(isArchivalPublicationSource({ citation: "Джерело без id" }), false);
});

test("historical attestation does not invent consent or bypass a privacy block", () => {
  const input = { privacyBlocked: false, possibleLivingPerson: true, hasCurrentClearance: false, archivalConfirmed: false, hasArchivalSource: true };
  assert.equal(publicationBlocker(input), "LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED");
  assert.equal(publicationBlocker({ ...input, archivalConfirmed: true }), null);
  assert.equal(publicationBlocker({ ...input, hasCurrentClearance: true }), null);
  assert.equal(publicationBlocker({ ...input, possibleLivingPerson: false }), null);
  assert.equal(publicationBlocker({ ...input, archivalConfirmed: true, hasArchivalSource: false }), "ARCHIVAL_PUBLICATION_SOURCE_REQUIRED");
  assert.equal(publicationBlocker({ ...input, archivalConfirmed: true, privacyBlocked: true }), "ARCHIVAL_PUBLICATION_BLOCKED");
});

test("record approval commits before any photo request; repeated IDs are copied once", async () => {
  const calls: string[] = [];
  let completeApproval!: () => void;
  const approval = new Promise<void>((resolve) => { completeApproval = resolve; });
  const operation = publishZagulyakaWithAttachments({
    publishRecord: async () => { calls.push("approve"); await approval; calls.push("approved"); return { status: "published", privacyStatus: "cleared" }; },
    attachmentIds: ["photo1", "photo1", "photo2"],
    publishAttachment: async (id) => { calls.push(id); },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["approve"]);
  completeApproval();
  assert.deepEqual((await operation).failures, []);
  assert.deepEqual(calls, ["approve", "approved", "photo1", "photo2"]);
});

test("failed or non-public approval never starts attachment publication", async () => {
  for (const publishRecord of [
    async () => { throw new Error("ZAGULYAKA_VERSION_CONFLICT"); },
    async () => ({ status: "pending_review", privacyStatus: "cleared" }),
    async () => ({ status: "published", privacyStatus: "requires_consent" }),
  ]) {
    let copies = 0;
    await assert.rejects(publishZagulyakaWithAttachments({ publishRecord, attachmentIds: ["photo"], publishAttachment: async () => { copies++; } }));
    assert.equal(copies, 0);
  }
});

test("real storage failure is preserved as partial success and later files continue sequentially", async () => {
  const calls: string[] = [];
  const failure = new Error("ATTACHMENT_COPY_FAILED");
  const result = await publishZagulyakaWithAttachments({
    publishRecord: async () => ({ status: "published", privacyStatus: "cleared" }),
    attachmentIds: ["bad", "good"],
    publishAttachment: async (id) => { calls.push(id); if (id === "bad") throw failure; },
  });
  assert.equal(result.record.status, "published");
  assert.deepEqual(result.failures, [{ attachmentId: "bad", error: failure }]);
  assert.deepEqual(calls, ["bad", "good"]);
});
