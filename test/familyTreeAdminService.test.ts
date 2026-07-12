import test from "node:test";
import assert from "node:assert/strict";
import {
  isDeceasedAdminPerson,
  isLivingAdminPerson,
  isUnknownVitalStatusAdminPerson,
} from "../src/utils/familyTreeAdminStats.ts";

test("classifies family tree admin vital status explicitly", () => {
  const living = { is_living: true, death_date: null };
  const deceasedByFlag = { is_living: false, death_date: null };
  const deceasedByDate = { is_living: null, death_date: "1944-01-01" };
  const unknown = { is_living: null, death_date: null };

  assert.equal(isLivingAdminPerson(living), true);
  assert.equal(isDeceasedAdminPerson(living), false);
  assert.equal(isUnknownVitalStatusAdminPerson(living), false);

  assert.equal(isLivingAdminPerson(deceasedByFlag), false);
  assert.equal(isDeceasedAdminPerson(deceasedByFlag), true);
  assert.equal(isUnknownVitalStatusAdminPerson(deceasedByFlag), false);

  assert.equal(isLivingAdminPerson(deceasedByDate), false);
  assert.equal(isDeceasedAdminPerson(deceasedByDate), true);
  assert.equal(isUnknownVitalStatusAdminPerson(deceasedByDate), false);

  assert.equal(isLivingAdminPerson(unknown), false);
  assert.equal(isDeceasedAdminPerson(unknown), false);
  assert.equal(isUnknownVitalStatusAdminPerson(unknown), true);
});
