import assert from "node:assert/strict";
import test from "node:test";
import {
  productAnalyticsCountBucket,
  productAnalyticsDurationBucket,
} from "../src/utils/productAnalyticsBuckets.ts";

test("duration telemetry uses only coarse, bounded buckets", () => {
  assert.equal(productAnalyticsDurationBucket(0), "lt_1s");
  assert.equal(productAnalyticsDurationBucket(1_000), "1_3s");
  assert.equal(productAnalyticsDurationBucket(9_999), "3_10s");
  assert.equal(productAnalyticsDurationBucket(120_000), "gte_120s");
});

test("record counts never expose exact values", () => {
  assert.equal(productAnalyticsCountBucket(undefined), null);
  assert.equal(productAnalyticsCountBucket(100), "1_100");
  assert.equal(productAnalyticsCountBucket(501), "501_2000");
  assert.equal(productAnalyticsCountBucket(50_000), "gte_10001");
});
