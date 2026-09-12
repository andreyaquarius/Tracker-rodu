import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "vite";
import type { ErrorEvent } from "@sentry/react";
import {
  createMonitoringRateLimit, isExpectedBrowserError, monitoringRoute,
  sanitizeBrowserEvent, sentryIngestOrigin,
} from "../src/utils/browserMonitoringPrivacy.ts";
import { verifyNoPublicSourceMaps } from "../scripts/verify-browser-monitoring-build.mjs";

const fixtureEvent = (): ErrorEvent => ({
  type: undefined, event_id: "a".repeat(32), release: "commit-123", environment: "test",
  message: "Private genealogy record: Olena", user: { email: "private@example.test", id: "private-user", ip_address: "192.0.2.1" },
  request: { url: "https://app.test/projects/private-project?token=private-token", headers: { Authorization: "secret" }, data: "private-request-body" },
  transaction: "/private-project", extra: { records: "private-extra" },
  breadcrumbs: [{ message: "private-console" }],
  contexts: { trace: { data: { record: "private-trace" } }, private: { name: "private-context" } },
  fingerprint: ["private-fingerprint"],
  tags: { area: "family-tree", project: "private-project", operation: "private operation" },
  exception: { values: [{
    type: "TypeError", value: "Cannot read properties of undefined (reading 'private-name')",
    mechanism: { type: "generic", handled: true, data: { name: "private-mechanism" } },
    stacktrace: { frames: [{
      filename: "https://app.test/assets/tree-abcdefgh.js?token=private-token#private-fragment",
      abs_path: "D:/private/file.js", function: "renderTree", lineno: 15, colno: 34,
      vars: { name: "private-variable" }, context_line: "private-source-line",
      pre_context: ["private-context-lines"], post_context: ["private-post-context"],
    }] },
  }] },
  debug_meta: { images: [{ type: "sourcemap", code_file: "https://app.test/assets/tree-abcdefgh.js?secret=private-debug", debug_id: "00000000-1111-2222-3333-444444444444" }] },
});

test("browser events retain only technical fields, preserving stack coordinates and debug IDs", () => {
  const input = fixtureEvent();
  const output = sanitizeBrowserEvent(input, "/projects/private-project/persons/private-person?search=private-query");
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /private|Olena|example\.test|192\.0\.2\.1/);
  assert.equal(output?.tags?.route, "/projects/:id/persons/:id");
  assert.equal(output?.tags?.area, "family-tree");
  assert.equal(output?.tags?.operation, undefined);
  assert.equal(output?.exception?.values?.[0].stacktrace?.frames?.[0].filename, "/assets/tree-abcdefgh.js");
  assert.equal(output?.exception?.values?.[0].stacktrace?.frames?.[0].lineno, 15);
  assert.equal(output?.debug_meta?.images?.length, 1);
  assert.equal(input.user?.id, "private-user", "sanitizing never mutates the caller's error");
});

test("unknown messages and custom error names cannot leak unquoted text", () => {
  const output = sanitizeBrowserEvent({ type: undefined, exception: { values: [{ type: "Olena", value: "Birth of Olena" }] } }, "/");
  assert.doesNotMatch(JSON.stringify(output), /Olena/);
});

test("private-share pages are excluded, and unknown route segments are never emitted", () => {
  for (const path of ["/shared-graph", "/shared-graph/private-token", "/share/private-token"]) {
    assert.equal(sanitizeBrowserEvent(fixtureEvent(), path), null);
  }
  assert.equal(monitoringRoute("/projects/kalensky/persons/123#token"), "/projects/:id/persons/:id");
});

test("only the public hosted DSN can extend connect-src", () => {
  const key = "a".repeat(32);
  for (const host of ["o123.ingest.sentry.io", "o123.ingest.de.sentry.io", "o123.ingest.us.sentry.io"]) {
    assert.equal(sentryIngestOrigin(`https://${key}@${host}/12345`), `https://${host}`);
  }
  for (const dsn of ["", "not-a-url", `https://${key}:secret@o1.ingest.sentry.io/1`,
    `https://${key}@evil.test/1`, `https://${key}@o1.ingest.sentry.io.evil.test/1`,
    `https://${key}@o1.ingest.sentry.io/1?data=secret`, `http://${key}@o1.ingest.sentry.io/1`]) {
    assert.equal(sentryIngestOrigin(dsn), null);
  }
});

test("production builds use the configured public DSN, with a host override and explicit kill switch", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-monitoring-env-test-"));
  const previousDsn = process.env.VITE_SENTRY_DSN;
  const previousEnabled = process.env.VITE_SENTRY_ENABLED;
  try {
    // Use only the checked-in public settings, never the developer's .env files.
    const productionEnv = readFileSync(new URL("../.env.production", import.meta.url), "utf8");
    assert.doesNotMatch(productionEnv, /^\s*(?:SENTRY_AUTH_TOKEN|VITE_SENTRY_AUTH_TOKEN)\s*=/m);
    writeFileSync(join(directory, ".env.production"), productionEnv);
    delete process.env.VITE_SENTRY_DSN;
    delete process.env.VITE_SENTRY_ENABLED;
    const configuredDsn = loadEnv("production", directory, "VITE_SENTRY_").VITE_SENTRY_DSN;
    assert.equal(sentryIngestOrigin(configuredDsn), "https://o4512075083939840.ingest.de.sentry.io");
    assert.equal(new URL(configuredDsn).pathname, "/4512075160420432");
    assert.equal(loadEnv("development", directory, "VITE_SENTRY_").VITE_SENTRY_DSN, undefined);

    const overrideDsn = `https://${"b".repeat(32)}@o123.ingest.sentry.io/456`;
    process.env.VITE_SENTRY_DSN = overrideDsn;
    process.env.VITE_SENTRY_ENABLED = "false";
    const overridden = loadEnv("production", directory, "VITE_SENTRY_");
    assert.equal(overridden.VITE_SENTRY_DSN, overrideDsn);
    assert.equal(overridden.VITE_SENTRY_ENABLED, "false");

    const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
    assert.match(workflow, /if \[ -z "\$\{VITE_SENTRY_DSN:-\}" \]; then\s+unset VITE_SENTRY_DSN\s+fi\s+npm run build/);
    const sdk = readFileSync(new URL("../src/services/browserMonitoring.ts", import.meta.url), "utf8");
    assert.ok(sdk.includes('import.meta.env.VITE_SENTRY_ENABLED === "false"'));
  } finally {
    if (previousDsn === undefined) delete process.env.VITE_SENTRY_DSN;
    else process.env.VITE_SENTRY_DSN = previousDsn;
    if (previousEnabled === undefined) delete process.env.VITE_SENTRY_ENABLED;
    else process.env.VITE_SENTRY_ENABLED = previousEnabled;
    rmSync(directory, { recursive: true });
  }
});

test("browser/OS metadata uses fixed names and numeric versions, not the raw user agent", () => {
  const output = sanitizeBrowserEvent({ type: undefined }, "/", "Mozilla Windows Chrome/120.0.1.2 Safari/537.36 Edg/120.0.2.3 private-agent");
  assert.deepEqual(output?.contexts, { browser: { name: "Edge", version: "120.0.2.3" }, os: { name: "Windows" } });
});

test("abort/session cancellations are ignored but SQL permissions and timeouts are not", () => {
  assert.ok(isExpectedBrowserError({ name: "AbortError" }));
  assert.ok(isExpectedBrowserError({ name: "AuthenticatedSessionRequiredError" }));
  assert.equal(isExpectedBrowserError({ code: "42501" }), false);
  assert.equal(isExpectedBrowserError({ code: "57014" }), false);
  const output = sanitizeBrowserEvent({ type: undefined, message: "Supabase POST failed: HTTP 403 (42501)", tags: { error_code: "42501", operation: "table:projects" } }, "/projects");
  assert.equal(output?.message, "Supabase POST failed: HTTP 403 (42501)");
});

test("rate limits suppress duplicates for a minute and bound total events per page load", () => {
  let now = 0;
  const accept = createMonitoringRateLimit(() => now);
  assert.ok(accept({ type: undefined, message: "one" }));
  assert.equal(accept({ type: undefined, message: "one" }), false);
  now = 60001;
  assert.ok(accept({ type: undefined, message: "one" }));
  for (let i = 0; i < 28; i++) assert.ok(accept({ type: undefined, message: `other-${i}` }));
  assert.equal(accept({ type: undefined, message: "over-budget" }), false);
});

test("monitoring initializes after share URL cleanup and before React renders", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(source.indexOf("initializeBrowserMonitoring();") > source.indexOf("restoreSpaRedirect();"));
  assert.ok(source.indexOf("initializeBrowserMonitoring();") < source.indexOf('createRoot(document'));
  const sdk = readFileSync(new URL("../src/services/browserMonitoring.ts", import.meta.url), "utf8");
  for (const contract of ["!import.meta.env.PROD", "defaultIntegrations: false", "maxBreadcrumbs: 0", "hint.attachments = []", 'referrerPolicy: "no-referrer"']) assert.ok(sdk.includes(contract));
  assert.doesNotMatch(sdk, /replayIntegration\(|browserTracingIntegration\(|browserSessionIntegration\(|setUser\(/);
});

test("the build refuses any source maps in the published directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-monitoring-test-"));
  try {
    mkdirSync(join(directory, "assets"));
    verifyNoPublicSourceMaps(directory);
    writeFileSync(join(directory, "assets", "app.js.map"), "{}");
    assert.throws(() => verifyNoPublicSourceMaps(directory), /Refusing to publish/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
