import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);
const detailSource = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);
const moderationSource = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

test("person drafts let the author choose an event-specific role and a source wording", () => {
  assert.match(dialogSource, /<span>Роль людини в події \*<\/span>/);
  assert.match(dialogSource, /disabled=\{!draft\.eventType\}/);
  assert.match(dialogSource, /zagulyakaEventRoleOptions\(draft\.eventType\)/);
  assert.match(dialogSource, /draft\.eventRoleCode === "other"/);
  assert.match(dialogSource, /<span>Роль як у джерелі \*<\/span>/);
  assert.match(dialogSource, /Оберіть роль людини в події\./);
  assert.match(dialogSource, /Вкажіть роль так, як її подано в джерелі\./);
});

test("event role travels beside, never instead of, the structural subject role", () => {
  const participantPayload = serviceSource.slice(
    serviceSource.indexOf("function participantPayload"),
    serviceSource.indexOf("function documentDiscoveryPayload"),
  );

  assert.match(participantPayload, /role:\s*"subject"/);
  assert.match(participantPayload, /eventRoleCode:\s*input\.eventRoleCode \|\| null/);
  assert.match(participantPayload, /eventRoleCustom:/);
  assert.doesNotMatch(participantPayload, /role:\s*input\.eventRoleCode/);
});

test("public detail and moderation present friendly event roles rather than raw structural codes", () => {
  assert.match(detailSource, /<Fact label="Роль у події" value=\{participantEventRoleLabel\(/);
  assert.match(detailSource, /Роль у події: \{participantEventRoleLabel\(participant\)\}/);
  assert.match(detailSource, /zagulyakaEventRoleLabel\(/);
  assert.match(moderationSource, /const eventRole = zagulyakaEventRoleLabel\(/);
  assert.match(moderationSource, /Роль у події: \{eventRole\}/);
});
