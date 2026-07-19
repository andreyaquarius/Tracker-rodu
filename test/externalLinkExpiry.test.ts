import test from "node:test";
import assert from "node:assert/strict";
import {
  externalLinkExpiry,
  formatExternalLinkExpiry,
} from "../src/utils/externalLinkExpiry.ts";

const now = Date.parse("2026-07-19T12:00:00.000Z");

test("reads Unix and ISO expiry values without guessing a provider TTL", () => {
  const unix = externalLinkExpiry(
    `https://cdn.example/photo.jpg?Expires=${Math.floor((now + 2 * 86_400_000) / 1000)}`,
    now,
  );
  assert.equal(unix.kind, "known");
  if (unix.kind === "known") {
    assert.equal(unix.remainingDays, 2);
    assert.equal(unix.expired, false);
  }

  const azure = externalLinkExpiry(
    "https://blob.example/photo.jpg?se=2026-07-20T12%3A00%3A00Z",
    now,
  );
  assert.equal(azure.kind, "known");
  if (azure.kind === "known") assert.equal(azure.expiresAt, "2026-07-20T12:00:00.000Z");
});

test("reads AWS and Google signed URL durations case-insensitively", () => {
  const aws = externalLinkExpiry(
    "https://s3.example/photo.jpg?X-Amz-Date=20260719T120000Z&X-Amz-Expires=3600",
    now,
  );
  assert.equal(aws.kind, "known");
  if (aws.kind === "known") assert.equal(aws.expiresAt, "2026-07-19T13:00:00.000Z");

  const google = externalLinkExpiry(
    "https://storage.example/photo.jpg?x-goog-date=20260719T120000Z&x-goog-expires=86400",
    now,
  );
  assert.equal(google.kind, "known");
  if (google.kind === "known") assert.equal(google.remainingDays, 1);
});

test("marks elapsed explicit deadlines and leaves ambiguous links unknown", () => {
  const elapsed = externalLinkExpiry("https://cdn.example/photo.jpg?exp=1700000000", now);
  assert.equal(elapsed.kind, "known");
  if (elapsed.kind === "known") {
    assert.equal(elapsed.expired, true);
    assert.match(formatExternalLinkExpiry(elapsed), /строк дії завершився/i);
  }

  assert.deepEqual(externalLinkExpiry("https://example.test/photo.jpg", now), { kind: "unknown" });
  assert.deepEqual(externalLinkExpiry("https://example.test/photo.jpg?e=2", now), { kind: "unknown" });
  assert.deepEqual(externalLinkExpiry("https://example.test/photo.jpg?exp=1e308", now), { kind: "unknown" });
  assert.deepEqual(
    externalLinkExpiry("https://example.test/photo.jpg?X-Amz-Date=20260719T120000Z&X-Amz-Expires=1e308", now),
    { kind: "unknown" },
  );
  assert.deepEqual(externalLinkExpiry("not a URL", now), { kind: "unknown" });
});

test("reads the signed MyHeritage photo deadline from its base64url path", () => {
  const token = "az10ZXN0JnM9c2lnJmU9MTc4NDEwOTYwMA";
  const expired = externalLinkExpiry(
    `https://sites-cf.mhcache.com/e/1/${token}/photo.jpg`,
    now,
  );

  assert.equal(expired.kind, "known");
  if (expired.kind === "known") {
    assert.equal(expired.expiresAt, "2026-07-15T10:00:00.000Z");
    assert.equal(expired.expired, true);
  }

  for (const rejected of [
    `http://sites-cf.mhcache.com/e/1/${token}/photo.jpg`,
    `https://sites-cf.mhcache.com.evil.example/e/1/${token}/photo.jpg`,
    `https://user@sites-cf.mhcache.com/e/1/${token}/photo.jpg`,
    `https://sites-cf.mhcache.com:444/e/1/${token}/photo.jpg`,
  ]) {
    assert.deepEqual(externalLinkExpiry(rejected, now), { kind: "unknown" }, rejected);
  }
});
