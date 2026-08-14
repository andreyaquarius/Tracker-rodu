import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProductAnalyticsPayload,
  PRODUCT_ANALYTICS_CONSENT_VERSION,
} from "../supabase/functions/collect-product-analytics/payload.ts";

function validPayload() {
  return {
    sessionId: "287db2f1-82e6-4b08-a964-5b91cf608782",
    consentVersion: PRODUCT_ANALYTICS_CONSENT_VERSION,
    deviceClass: "desktop",
    viewportBucket: "lg",
    appVersion: "2026.08.15",
    events: [{
      eventId: "c19a0fc1-a37c-44f1-85af-8510e5d74080",
      name: "page_viewed",
      occurredAt: new Date().toISOString(),
      pageCode: "person_profile",
      activeSeconds: 0,
    }],
  };
}

test("accepts only the documented privacy-safe analytics shape", () => {
  const parsed = parseProductAnalyticsPayload(validPayload());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.events[0]?.pageCode, "person_profile");
  }
});

test("rejects identifiers, URLs, search text and other undeclared fields", () => {
  for (const [key, value] of [
    ["projectId", "project-secret"],
    ["personId", "person-secret"],
    ["url", "/projects/project-secret/persons/person-secret"],
    ["searchText", "private surname"],
    ["fileName", "private-document.pdf"],
  ] as const) {
    const payload = validPayload() as Record<string, unknown>;
    payload[key] = value;
    assert.equal(parseProductAnalyticsPayload(payload).ok, false, key);
  }
});

test("rejects dynamic page codes and invalid active-time values", () => {
  const dynamicPage = validPayload();
  dynamicPage.events[0]!.pageCode = "/projects/private-id/persons/private-id";
  assert.equal(parseProductAnalyticsPayload(dynamicPage).ok, false);

  const invalidTiming = validPayload();
  invalidTiming.events[0] = {
    ...invalidTiming.events[0]!,
    name: "page_active_time",
    activeSeconds: 301,
  };
  assert.equal(parseProductAnalyticsPayload(invalidTiming).ok, false);
});
