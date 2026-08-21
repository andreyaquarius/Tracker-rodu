import assert from "node:assert/strict";
import test from "node:test";
import { emptyZagulyakaDraft } from "../src/types/zagulyaky.ts";
import {
  isZagulyakaEventRoleAllowed,
  normalizeZagulyakaEventRoleCode,
  zagulyakaEventRoleLabel,
  zagulyakaEventRoleOptions,
  zagulyakaEventRoleOptionsByEvent,
} from "../src/utils/zagulyakyEventRoles.ts";

test("marriage exposes bride, groom, and one gender-neutral witness role", () => {
  const roles = zagulyakaEventRoleOptions("marriage");

  assert.deepEqual(
    roles.filter((option) => ["groom", "bride", "witness"].includes(option.code)),
    [
      { code: "groom", label: "Наречений", requiresCustomText: false },
      { code: "bride", label: "Наречена", requiresCustomText: false },
      { code: "witness", label: "Свідок", requiresCustomText: false },
    ],
  );
  assert.equal(roles.filter((option) => option.code === "witness").length, 1);
  assert.deepEqual(
    roles.filter((option) => [
      "pledger",
      "groom_father",
      "groom_mother",
      "bride_father",
      "bride_mother",
    ].includes(option.code)).map((option) => [option.code, option.label]),
    [
      ["pledger", "Поручитель / шафер"],
      ["groom_father", "Батько нареченого"],
      ["groom_mother", "Мати нареченого"],
      ["bride_father", "Батько нареченої"],
      ["bride_mother", "Мати нареченої"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(zagulyakaEventRoleOptionsByEvent), /свідкиня/i);
});

test("every event has a custom other role and uses event-specific allowed roles", () => {
  for (const [eventType, roles] of Object.entries(zagulyakaEventRoleOptionsByEvent)) {
    assert.ok(roles.some((option) => option.code === "other" && option.requiresCustomText), `${eventType} must allow a custom role`);
  }

  assert.equal(isZagulyakaEventRoleAllowed("marriage", "groom"), true);
  assert.equal(isZagulyakaEventRoleAllowed("marriage", "newborn"), false);
  assert.equal(isZagulyakaEventRoleAllowed("birth", "newborn"), true);
});

test("role labels remain human-readable for legacy, custom, and absent values", () => {
  assert.equal(normalizeZagulyakaEventRoleCode("subject"), "subject");
  assert.equal(normalizeZagulyakaEventRoleCode("Свідок"), "witness");
  assert.equal(zagulyakaEventRoleLabel("subject"), "Основна особа");
  assert.equal(zagulyakaEventRoleLabel("other", "Перекладач"), "Перекладач");
  assert.equal(zagulyakaEventRoleLabel("old_unmapped_role"), "Роль у події не вказана");
  assert.equal(zagulyakaEventRoleLabel("", "Згаданий родич"), "Згаданий родич");
});

test("a new draft starts with no role and no custom role text", () => {
  const draft = emptyZagulyakaDraft("person");

  assert.equal(draft.eventRoleCode, "");
  assert.equal(draft.eventRoleCustomText, "");
});
