import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ANALYTICS_CONSENT_KEY,
  ANALYTICS_MEASUREMENT_ID,
  normalizePublicAnalyticsPath,
  publicAnalyticsContext,
  safeAnalyticsReferrer,
} from "../public/site-analytics.js";

const publicPaths = ["/", "/features", "/pricing", "/privacy", "/terms"] as const;

const privateSentinels = [
  "/projects/private-project-sentinel",
  "/persons/private-person-sentinel",
  "/documents/private-document-sentinel",
  "/settings",
  "/auth/callback",
  "/features/private-nested-sentinel",
  "/pricing/private-nested-sentinel",
  "/auth/success",
] as const;

test("analytics allowlist contains only the five public pages", () => {
  for (const path of publicPaths) {
    assert.equal(normalizePublicAnalyticsPath(path), path);
    assert.equal(normalizePublicAnalyticsPath(`${path === "/" ? "" : path}/`), path);
    assert.equal(normalizePublicAnalyticsPath(`${path}?private=secret#fragment`), path);
  }

  for (const path of privateSentinels) {
    assert.equal(normalizePublicAnalyticsPath(path), null, path);
    assert.equal(publicAnalyticsContext(path), null, path);
  }

  assert.equal(normalizePublicAnalyticsPath("https://trekerrodu.com.ua/features"), null);
  assert.equal(normalizePublicAnalyticsPath("//trekerrodu.com.ua/features"), null);
  assert.equal(normalizePublicAnalyticsPath(""), null);
  assert.equal(normalizePublicAnalyticsPath(null), null);
});

test("public analytics context is canonical and cannot carry query or hash data", () => {
  assert.deepEqual(
    publicAnalyticsContext(
      "/features?project=private-project-sentinel#private-fragment",
      "https://trekerrodu.com.ua/private-origin-path?secret=1",
    ),
    {
      pagePath: "/features",
      pageLocation: "https://trekerrodu.com.ua/features",
      pageTitle: "Можливості Трекера Роду",
    },
  );
  assert.equal(publicAnalyticsContext("/", "not a URL"), null);
  assert.equal(publicAnalyticsContext("/", "javascript:alert(1)"), null);
  assert.equal(publicAnalyticsContext("/", "file:///private/path"), null);
});

test("referrer sanitizer keeps no path/query for external sources and no private same-site route", () => {
  const origin = "https://trekerrodu.com.ua";

  assert.equal(
    safeAnalyticsReferrer(
      "https://search.example/results?q=private-person-sentinel#secret",
      origin,
    ),
    "https://search.example/",
  );
  assert.equal(
    safeAnalyticsReferrer("https://user:password@search.example/private", origin),
    "https://search.example/",
  );
  assert.equal(
    safeAnalyticsReferrer("https://trekerrodu.com.ua/privacy?secret=1#fragment", origin),
    "https://trekerrodu.com.ua/privacy",
  );
  assert.equal(
    safeAnalyticsReferrer(
      "https://trekerrodu.com.ua/projects/private-project-sentinel?secret=1",
      origin,
    ),
    "",
  );
  assert.equal(safeAnalyticsReferrer("file:///private/path", origin), "");
  assert.equal(safeAnalyticsReferrer("javascript:alert(1)", origin), "");
  assert.equal(safeAnalyticsReferrer("not a URL", origin), "");
});

test("client bootstrap is consent-first, self-hosted, and contains no private analytics fields", () => {
  const source = readFileSync(new URL("../public/site-analytics.js", import.meta.url), "utf8");

  assert.equal(ANALYTICS_MEASUREMENT_ID, "G-SF2725LS4P");
  assert.equal(ANALYTICS_CONSENT_KEY, "tracker-rodu-analytics-consent-v1");
  assert.match(source, /gtag\("consent",\s*"default",\s*\{[\s\S]*?analytics_storage:\s*"denied"/);
  assert.match(source, /send_page_view:\s*false/);
  assert.match(source, /allow_google_signals:\s*false/);
  assert.match(source, /allow_ad_personalization_signals:\s*false/);
  assert.match(source, /data-choice="accept"/);
  assert.match(source, /data-choice="reject"/);
  assert.match(source, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/);
  assert.doesNotMatch(source, /\buser_id\b|\buser_properties\b|project_id|person_id|document_id/i);
});
