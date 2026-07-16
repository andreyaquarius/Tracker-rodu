import assert from "node:assert/strict";
import test from "node:test";
import {
  createActiveTimeAccumulator,
  discardAccumulatedActiveTime,
  drainActiveTimeSeconds,
  observeActiveTime,
} from "../src/utils/activeTimeAccumulator.ts";

test("active-time accumulator counts only intervals that started active", () => {
  let state = createActiveTimeAccumulator(0, false);
  state = observeActiveTime(state, true, 1_000);
  assert.equal(state.accumulatedMs, 0);

  state = observeActiveTime(state, true, 2_250);
  state = observeActiveTime(state, false, 3_400);
  assert.equal(state.accumulatedMs, 2_400);

  state = observeActiveTime(state, false, 10_000);
  assert.equal(state.accumulatedMs, 2_400);
});

test("draining sends complete seconds once and preserves the fractional remainder", () => {
  let state = createActiveTimeAccumulator(0, true);
  state = observeActiveTime(state, false, 2_450);

  const first = drainActiveTimeSeconds(state);
  assert.equal(first.activeSeconds, 2);
  assert.equal(first.accumulator.accumulatedMs, 450);

  const second = drainActiveTimeSeconds(first.accumulator);
  assert.equal(second.activeSeconds, 0);
  assert.equal(second.accumulator.accumulatedMs, 450);
});

test("a suspended browser interval is capped instead of counted as active use", () => {
  const active = createActiveTimeAccumulator(1_000, true);
  const observed = observeActiveTime(active, false, 61_000, 5_000);
  assert.equal(observed.accumulatedMs, 5_000);
});

test("a clock moving backwards cannot create extra active time", () => {
  let state = createActiveTimeAccumulator(1_000, true);
  state = observeActiveTime(state, true, 500, 5_000);
  state = observeActiveTime(state, false, 1_100, 5_000);

  assert.equal(state.accumulatedMs, 100);
  assert.equal(state.lastObservedAtMs, 1_100);
});

test("discarding pending engagement resets active state and accumulated time", () => {
  let state = createActiveTimeAccumulator(0, true);
  state = observeActiveTime(state, true, 3_000);

  const discarded = discardAccumulatedActiveTime(state);
  assert.equal(discarded.active, false);
  assert.equal(discarded.accumulatedMs, 0);
  assert.equal(discarded.lastObservedAtMs, 3_000);
});
