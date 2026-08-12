import assert from "node:assert/strict";
import test from "node:test";
import {
  personKinshipLabel,
  type PersonKinshipDescriptor,
} from "../src/utils/personKinship.ts";

function kinship(
  kind: PersonKinshipDescriptor["kind"],
  upSteps: number,
  downSteps: number,
  viaPersonId?: string,
): PersonKinshipDescriptor {
  return {
    kind,
    upSteps,
    downSteps,
    partnerSteps: kind === "affinal" ? 1 : 0,
    orderPath: `${upSteps}:${downSteps}`,
    viaPersonId,
  };
}

test("direct line labels are gender-aware at every common generation", () => {
  assert.equal(personKinshipLabel(kinship("root", 0, 0)), "Коренева особа");
  assert.equal(personKinshipLabel(kinship("ancestor", 1, 0), { gender: "чоловік" }), "Батько");
  assert.equal(personKinshipLabel(kinship("ancestor", 1, 0), { gender: "жінка" }), "Мати");
  assert.equal(personKinshipLabel(kinship("ancestor", 2, 0), { gender: "чоловік" }), "Дідусь");
  assert.equal(personKinshipLabel(kinship("ancestor", 2, 0), { gender: "жінка" }), "Бабуся");
  assert.equal(personKinshipLabel(kinship("ancestor", 3, 0), { gender: "чоловік" }), "Прадідусь");
  assert.equal(personKinshipLabel(kinship("ancestor", 4, 0), { gender: "жінка" }), "Прапрабабуся");
  assert.equal(personKinshipLabel(kinship("descendant", 0, 1), { gender: "жінка" }), "Донька");
  assert.equal(personKinshipLabel(kinship("descendant", 0, 2), { gender: "чоловік" }), "Онук");
});

test("collateral labels distinguish siblings, uncles, nieces and cousin degrees", () => {
  assert.equal(personKinshipLabel(kinship("collateral", 1, 1), { gender: "чоловік" }), "Брат");
  assert.equal(personKinshipLabel(kinship("collateral", 1, 1), { gender: "жінка" }), "Сестра");
  assert.equal(personKinshipLabel(kinship("collateral", 2, 1), { gender: "чоловік" }), "Дядько");
  assert.equal(personKinshipLabel(kinship("collateral", 2, 1), { gender: "жінка" }), "Тітка");
  assert.equal(personKinshipLabel(kinship("collateral", 1, 2), { gender: "жінка" }), "Племінниця");
  assert.equal(personKinshipLabel(kinship("collateral", 2, 2), { gender: "чоловік" }), "Двоюрідний брат");
  assert.equal(personKinshipLabel(kinship("collateral", 2, 2), { gender: "жінка" }), "Двоюрідна сестра");
  assert.equal(personKinshipLabel(kinship("collateral", 3, 3), { gender: "жінка" }), "Троюрідна сестра");
});

test("one-partner relationships receive a useful in-law label", () => {
  assert.equal(personKinshipLabel(kinship("affinal", 0, 0, "root"), { gender: "жінка" }), "Дружина");
  assert.equal(personKinshipLabel(kinship("affinal", 0, 1, "child"), { gender: "чоловік" }), "Зять");
  assert.equal(personKinshipLabel(kinship("affinal", 1, 0, "parent"), { gender: "жінка" }), "Мачуха");
  assert.equal(
    personKinshipLabel(kinship("affinal", 1, 1, "sibling"), {
      gender: "чоловік",
      viaGender: "жінка",
    }),
    "Чоловік сестри",
  );
});
