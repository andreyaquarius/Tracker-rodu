import assert from "node:assert/strict";
import test from "node:test";
import { pdfGatewayLimitsFromEnvironment } from "../supabase/functions/pdf-gateway/config.ts";
import {
  canonicalFingerprint,
  createOpaqueSessionToken,
  hashOpaqueSessionToken,
  isValidOpaqueSessionToken,
} from "../supabase/functions/pdf-gateway/session.ts";

test("opaque gateway token has 256 bits of random input and only its hash is persisted", async () => {
  const token = createOpaqueSessionToken((length) => {
    assert.equal(length, 32);
    return Uint8Array.from({ length }, (_, index) => index);
  });
  assert.equal(token, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(isValidOpaqueSessionToken(token), true);
  const hash = await hashOpaqueSessionToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(hash, token);
  assert.equal(isValidOpaqueSessionToken("short"), false);
  await assert.rejects(hashOpaqueSessionToken("short"), /SESSION_TOKEN_INVALID/u);
});

test("fingerprint comparison is stable across JSON object key order", () => {
  assert.equal(
    canonicalFingerprint({ etag: "v1", nested: { sha1: "abc", size: 10 } }),
    canonicalFingerprint({ nested: { size: 10, sha1: "abc" }, etag: "v1" }),
  );
  assert.notEqual(
    canonicalFingerprint({ etag: "v1" }),
    canonicalFingerprint({ etag: "v2" }),
  );
});

test("gateway limits are configurable, bounded and have a 10 minute default session", () => {
  const defaults = pdfGatewayLimitsFromEnvironment({});
  assert.equal(defaults.sessionTtlSeconds, 600);
  assert.equal(defaults.maxRedirects, 4);
  assert.equal(defaults.connectTimeoutMs, 15_000);
  assert.equal(defaults.streamIdleTimeoutMs, 30_000);
  assert.equal(defaults.fallbackMaxBytesWithoutRange, 32 * 1024 * 1024);
  assert.equal(defaults.maxActiveSessionsPerUserProject, 8);
  assert.equal(defaults.probeRequestsPerWindow, 30);
  assert.equal(defaults.probeWindowSeconds, 60);
  assert.equal(defaults.telemetryRequestsPerWindow, 120);
  assert.equal(defaults.telemetryWindowSeconds, 60);
  assert.equal(defaults.telemetrySuccessSamplePercent, 10);

  const configured = pdfGatewayLimitsFromEnvironment({
    PDF_PROXY_TOKEN_TTL_SECONDS: "900",
    PDF_PROXY_MAX_REDIRECTS: "2",
    PDF_PROXY_CONNECT_TIMEOUT_MS: "5000",
    PDF_PROXY_STREAM_IDLE_TIMEOUT_MS: "20000",
    PDF_FALLBACK_MAX_BYTES_WITHOUT_RANGE: String(64 * 1024 * 1024),
    PDF_PROXY_MAX_RANGE_RESPONSE_BYTES: String(2 * 1024 * 1024),
    PDF_PROXY_MAX_REQUESTS_PER_SESSION: "1000",
    PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT: "12",
    PDF_PROBE_MAX_REQUESTS_PER_WINDOW: "45",
    PDF_PROBE_WINDOW_SECONDS: "120",
    PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW: "240",
    PDF_TELEMETRY_WINDOW_SECONDS: "180",
    PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT: "25",
  });
  assert.equal(configured.sessionTtlSeconds, 900);
  assert.equal(configured.maxRedirects, 2);
  assert.equal(configured.connectTimeoutMs, 5_000);
  assert.equal(configured.streamIdleTimeoutMs, 20_000);
  assert.equal(configured.fallbackMaxBytesWithoutRange, 64 * 1024 * 1024);
  assert.equal(configured.maxRangeResponseBytes, 2 * 1024 * 1024);
  assert.equal(configured.maxRequestsPerSession, 1_000);
  assert.equal(configured.maxActiveSessionsPerUserProject, 12);
  assert.equal(configured.probeRequestsPerWindow, 45);
  assert.equal(configured.probeWindowSeconds, 120);
  assert.equal(configured.telemetryRequestsPerWindow, 240);
  assert.equal(configured.telemetryWindowSeconds, 180);
  assert.equal(configured.telemetrySuccessSamplePercent, 25);

  assert.equal(
    pdfGatewayLimitsFromEnvironment({ PDF_PROXY_TOKEN_TTL_SECONDS: "999999" }).sessionTtlSeconds,
    600,
  );
  assert.equal(
    pdfGatewayLimitsFromEnvironment({
      PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT: "65",
    }).maxActiveSessionsPerUserProject,
    8,
  );
  assert.equal(
    pdfGatewayLimitsFromEnvironment({ PDF_PROBE_MAX_REQUESTS_PER_WINDOW: "1001" }).probeRequestsPerWindow,
    30,
  );
  assert.equal(
    pdfGatewayLimitsFromEnvironment({ PDF_PROBE_WINDOW_SECONDS: "9" }).probeWindowSeconds,
    60,
  );
  assert.equal(
    pdfGatewayLimitsFromEnvironment({ PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW: "2001" }).telemetryRequestsPerWindow,
    120,
  );
  assert.equal(
    pdfGatewayLimitsFromEnvironment({ PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT: "101" }).telemetrySuccessSamplePercent,
    10,
  );
});
