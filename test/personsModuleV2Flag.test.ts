import assert from "node:assert/strict";
import test from "node:test";
import {
  canUsePersonsModuleV2,
  isPersonsModuleV2Enabled,
} from "../src/utils/personsModuleV2.ts";

test("persons module v2 is opt-in and supports environment and remote rollout", () => {
  assert.equal(isPersonsModuleV2Enabled({}), false);
  assert.equal(isPersonsModuleV2Enabled({ envValue: "true" }), true);
  assert.equal(isPersonsModuleV2Enabled({ envValue: "1" }), true);
  assert.equal(isPersonsModuleV2Enabled({ remoteValue: true }), true);
  assert.equal(isPersonsModuleV2Enabled({ envValue: "false" }), false);
  assert.equal(isPersonsModuleV2Enabled({ envValue: "0" }), false);
  assert.equal(isPersonsModuleV2Enabled({ remoteValue: false }), false);
  assert.equal(isPersonsModuleV2Enabled({ envValue: "true", remoteValue: false }), false);
});

test("persons module v2 is available only with family-tree access", () => {
  assert.equal(canUsePersonsModuleV2({
    rolloutEnabled: true,
    canUseFamilyTreeFeature: true,
  }), true);
  assert.equal(canUsePersonsModuleV2({
    rolloutEnabled: true,
    canUseFamilyTreeFeature: false,
  }), false);
  assert.equal(canUsePersonsModuleV2({
    rolloutEnabled: false,
    canUseFamilyTreeFeature: true,
  }), false);
});
