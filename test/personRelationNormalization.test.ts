import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PersonRelation } from "../src/types/index.ts";
import { repairMojibakeText } from "../src/utils/mojibake.ts";
import { normalizePersonGender } from "../src/utils/personGender.ts";
import {
  normalizePersonRelation,
  normalizePersonRelationStatus,
  normalizePersonRelationType,
} from "../src/utils/personRelation.ts";

test("repairs legacy family-tree relationship text without changing valid Ukrainian", () => {
  const corrupt = "РЎС‚РІРѕСЂРµРЅРѕ Р· РјРѕРґСѓР»СЏ СЂРѕРґРѕРІРѕРіРѕ РґРµСЂРµРІР°.";
  assert.equal(
    repairMojibakeText(corrupt),
    "Створено з модуля родового дерева.",
  );
  assert.equal(
    repairMojibakeText("Створено з модуля родового дерева."),
    "Створено з модуля родового дерева.",
  );
});

test("normalizes legacy relationship types, statuses and tree-created gender", () => {
  assert.equal(
    normalizePersonRelationType("Р±Р°С‚СЊРєРѕ Р°Р±Рѕ РјР°С‚Рё"),
    "батько або мати",
  );
  assert.equal(normalizePersonRelationStatus("РґРѕРІРµРґРµРЅРѕ"), "доведено");
  assert.equal(normalizePersonRelationStatus("proven"), "доведено");
  assert.equal(normalizePersonGender("РЅРµРІС–РґРѕРјРѕ"), "невідомо");
});

test("normalizes every user-visible field of an old relationship row", () => {
  const relation: PersonRelation = {
    id: "relation-1",
    personId: "person-1",
    relatedPersonId: "person-2",
    relationType: "Р±Р°С‚СЊРєРѕ Р°Р±Рѕ РјР°С‚Рё" as PersonRelation["relationType"],
    status: "РґРѕРІРµРґРµРЅРѕ" as PersonRelation["status"],
    evidenceText: "РЎС‚РІРѕСЂРµРЅРѕ Р· РјРѕРґСѓР»СЏ СЂРѕРґРѕРІРѕРіРѕ РґРµСЂРµРІР°.",
    notes: "",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
  const normalized = normalizePersonRelation(relation);
  assert.equal(normalized.relationType, "батько або мати");
  assert.equal(normalized.status, "доведено");
  assert.equal(normalized.evidenceText, "Створено з модуля родового дерева.");
});

test("family-tree mutations contain clean Ukrainian builder constants", () => {
  const source = readFileSync(
    new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Спочатку додайте батьків або батьківський набір/);
  assert.match(source, /relationType: "батько або мати"/);
  assert.match(source, /title = "Родове дерево"/);
  assert.match(source, /gender: input\.person\.gender \|\| "невідомо"/);
  assert.match(source, /\["чоловік", "дружина", "подружжя"\]/);
  assert.match(source, /evidence_text: "Створено з модуля родового дерева\."/);
  assert.doesNotMatch(source, /РЎС‚РІРѕСЂРµРЅРѕ/);
});
