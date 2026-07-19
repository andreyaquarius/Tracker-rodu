import assert from "node:assert/strict";
import test from "node:test";
import {
  canUsePersonsModuleV2,
} from "../src/utils/personsModuleV2.ts";

test("persons module v2 exactly mirrors family-tree access", () => {
  assert.equal(canUsePersonsModuleV2({
    canUseFamilyTreeFeature: true,
  }), true);
  assert.equal(canUsePersonsModuleV2({
    canUseFamilyTreeFeature: false,
  }), false);
});
