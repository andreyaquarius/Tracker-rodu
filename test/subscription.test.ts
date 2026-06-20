import assert from "node:assert/strict";
import test from "node:test";
import { hasPlanCapacity, trialDaysRemaining } from "../src/utils/subscription.ts";

test("finite plan limits allow only usage below the configured value", () => {
  const limit = { key: "projects" as const, value: 1, isUnlimited: false };
  assert.equal(hasPlanCapacity(limit, 0), true);
  assert.equal(hasPlanCapacity(limit, 1), false);
  assert.equal(hasPlanCapacity(limit, 2), false);
});

test("unlimited plans remain available regardless of usage", () => {
  const limit = { key: "projects" as const, value: null, isUnlimited: true };
  assert.equal(hasPlanCapacity(limit, 10_000), true);
});

test("missing limits fail closed while zero limits block immediately", () => {
  assert.equal(hasPlanCapacity(null, 0), false);
  const blocked = { key: "project_members" as const, value: 0, isUnlimited: false };
  assert.equal(hasPlanCapacity(blocked, 0), false);
});

test("trial remaining days use server time and round partial days up", () => {
  assert.equal(trialDaysRemaining("2026-07-20T12:00:00Z", "2026-06-20T12:00:00Z"), 30);
  assert.equal(trialDaysRemaining("2026-06-21T00:01:00Z", "2026-06-20T23:59:00Z"), 1);
  assert.equal(trialDaysRemaining("2026-06-20T00:00:00Z", "2026-06-21T00:00:00Z"), 0);
});
