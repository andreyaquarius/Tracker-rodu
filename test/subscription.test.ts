import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasPlanCapacity, trialDaysRemaining } from "../src/utils/subscription.ts";
import {
  createInFlightRequestDeduper,
  getJitteredSubscriptionPollDelay,
  isSubscriptionRefreshDue,
  SUBSCRIPTION_POLL_INTERVAL_MS,
} from "../src/utils/subscriptionPolling.ts";

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
  const blocked = { key: "editors_total" as const, value: 0, isUnlimited: false };
  assert.equal(hasPlanCapacity(blocked, 0), false);
});

test("trial remaining days use server time and round partial days up", () => {
  assert.equal(trialDaysRemaining("2026-07-20T12:00:00Z", "2026-06-20T12:00:00Z"), 30);
  assert.equal(trialDaysRemaining("2026-06-21T00:01:00Z", "2026-06-20T23:59:00Z"), 1);
  assert.equal(trialDaysRemaining("2026-06-20T00:00:00Z", "2026-06-21T00:00:00Z"), 0);
});

test("subscription polling uses a ten-minute delay with bounded twenty-percent jitter", () => {
  assert.equal(SUBSCRIPTION_POLL_INTERVAL_MS, 600_000);
  assert.equal(getJitteredSubscriptionPollDelay(0), 480_000);
  assert.equal(getJitteredSubscriptionPollDelay(0.5), 600_000);
  assert.equal(getJitteredSubscriptionPollDelay(1), 720_000);
  assert.equal(getJitteredSubscriptionPollDelay(-10), 480_000);
  assert.equal(getJitteredSubscriptionPollDelay(10), 720_000);
  assert.equal(getJitteredSubscriptionPollDelay(Number.NaN), 600_000);
});

test("subscription refresh becomes due only after its scheduled deadline", () => {
  assert.equal(isSubscriptionRefreshDue(null, 1_000), true);
  assert.equal(isSubscriptionRefreshDue(1_001, 1_000), false);
  assert.equal(isSubscriptionRefreshDue(1_000, 1_000), true);
  assert.equal(isSubscriptionRefreshDue(999, 1_000), true);
});

test("subscription refresh deduper reuses one in-flight request", async () => {
  const deduper = createInFlightRequestDeduper<number>();
  let calls = 0;
  let finishRequest!: (value: number) => void;

  const first = deduper.run(() => {
    calls += 1;
    return new Promise<number>((resolve) => {
      finishRequest = resolve;
    });
  });
  const second = deduper.run(async () => {
    calls += 1;
    return 2;
  });

  assert.equal(first, second);
  assert.equal(deduper.hasInFlightRequest(), true);
  await Promise.resolve();
  assert.equal(calls, 1);

  finishRequest(1);
  assert.equal(await first, 1);
  assert.equal(deduper.hasInFlightRequest(), false);

  assert.equal(await deduper.run(async () => {
    calls += 1;
    return 3;
  }), 3);
  assert.equal(calls, 2);
});

test("subscription hook pauses automatic work in hidden tabs and refreshes stale data on return", () => {
  const source = readFileSync(
    new URL("../src/hooks/useSubscription.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /addEventListener\("visibilitychange"/);
  assert.match(source, /addEventListener\("focus"/);
  assert.match(source, /isSubscriptionRefreshDue\(ensureNextRefreshAt\(\)\)/);
  assert.match(source, /refreshDeduperRef\.current\.run/);
});
