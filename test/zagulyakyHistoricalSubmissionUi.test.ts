import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialog = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
  "utf8",
);
const moderationPanel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

test("historical Zagulyaky submit to moderation without author-rights or living-person declarations", () => {
  assert.doesNotMatch(dialog, /Я підтверджую, що маю право передати цю інформацію/);
  assert.doesNotMatch(dialog, /Цей запис може стосуватися живої людини або містити її персональні дані/);
  assert.doesNotMatch(dialog, /if \(!rightsConfirmed\)/);
  assert.doesNotMatch(dialog, /setRightsConfirmed/);
  assert.doesNotMatch(dialog, /update\("possibleLivingPerson", event\.target\.checked\)/);
  assert.match(dialog, /await submitZagulyakaDraft\(handle, account\.id\)/);
  assert.match(dialog, /Запис передано на модерацію\. До схвалення він не публічний\./);
});

test("editing a legacy draft preserves its already-recorded rights flag without asking again", () => {
  assert.match(dialog, /createZagulyakaDraft\(normalizedDraft, account\.id, initialRightsConfirmed\)/);
  assert.match(dialog, /saveZagulyakaDraft\(draftHandle, normalizedDraft, account\.id, initialRightsConfirmed\)/);
});

test("moderators retain the separate living-person clearance control but no rights warning", () => {
  assert.match(moderationPanel, /const requiresLivingPrivacyReview = Boolean\(/);
  assert.match(moderationPanel, /\{requiresLivingPrivacyReview && selected\.possibleLivingPerson \?/);
  assert.doesNotMatch(moderationPanel, /Автор не підтвердив права на публікацію матеріалу/);
  assert.doesNotMatch(moderationPanel, /requiresPublicationEvidence/);
});
