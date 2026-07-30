import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const eventNames = [
  "document_source_resolve_started",
  "document_source_resolve_succeeded",
  "document_source_resolve_failed",
  "pdf_viewer_opened",
  "pdf_first_page_rendered",
  "pdf_proxy_request",
  "finding_created_from_pdf_selection",
  "pdf_page_export_succeeded",
  "pdf_page_export_failed",
] as const;

test("authenticated PDF operational events never enter GA4 transports", () => {
  const gaSources = [
    "../public/site-analytics.js",
    "../src/services/siteAnalytics.ts",
    "../src/services/authenticatedEngagement.ts",
    "../supabase/functions/track-authenticated-engagement/index.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  for (const source of gaSources) {
    for (const eventName of eventNames) assert.equal(source.includes(eventName), false, eventName);
  }
});

test("required PDF operational events are wired only to the dedicated helper and gateway", () => {
  const clientHelper = readFileSync(
    new URL("../src/services/pdfOperationalTelemetry.ts", import.meta.url),
    "utf8",
  );
  const gatewayTelemetry = readFileSync(
    new URL("../supabase/functions/pdf-gateway/telemetry.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(clientHelper, /siteAnalytics|gtag|GA4|authenticatedEngagement/u);
  for (const eventName of eventNames.filter((name) => name !== "pdf_proxy_request")) {
    assert.match(clientHelper, new RegExp(eventName, "u"));
  }
  assert.match(gatewayTelemetry, /pdf_proxy_request/u);
});
