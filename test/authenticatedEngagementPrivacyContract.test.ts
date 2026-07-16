import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAuthenticatedEngagementPayload } from "../supabase/functions/track-authenticated-engagement/payload.ts";

const validPayload = Object.freeze({
  clientId: "4294967295.1234567890",
  sessionId: "18446744073709551615",
  activeSeconds: 60,
});

test("engagement payload rejects every private field and arbitrary nested content", () => {
  for (const [key, value] of [
    ["userId", "private-user"],
    ["projectId", "private-project"],
    ["personId", "private-person"],
    ["documentId", "private-document"],
    ["pageLocation", "/projects/private-project/persons/private-person"],
    ["pageTitle", "Private project title"],
    ["eventDetails", { private: true }],
  ] as const) {
    assert.deepEqual(
      parseAuthenticatedEngagementPayload({ ...validPayload, [key]: value }),
      { ok: false, error: "Invalid analytics payload." },
      key,
    );
  }
});

test("engagement payload rejects missing and malformed anonymous identifiers", () => {
  for (const payload of [
    null,
    [],
    {},
    { clientId: validPayload.clientId, sessionId: validPayload.sessionId },
    { ...validPayload, clientId: "" },
    { ...validPayload, clientId: "0.1" },
    { ...validPayload, clientId: "01.2" },
    { ...validPayload, clientId: "1.2.3" },
    { ...validPayload, clientId: "private-client" },
    { ...validPayload, sessionId: "" },
    { ...validPayload, sessionId: "0" },
    { ...validPayload, sessionId: "01" },
    { ...validPayload, sessionId: "1".repeat(21) },
    { ...validPayload, sessionId: "private-session" },
    { ...validPayload, activeSeconds: Number.NaN },
    { ...validPayload, activeSeconds: Number.POSITIVE_INFINITY },
    { ...validPayload, activeSeconds: "60" },
  ]) {
    assert.deepEqual(parseAuthenticatedEngagementPayload(payload), {
      ok: false,
      error: "Invalid analytics payload.",
    });
  }
});

test("edge relay requires authentication and emits no private route/account fields", () => {
  const source = readFileSync(
    new URL(
      "../supabase/functions/track-authenticated-engagement/index.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");

  assert.match(source, /supabase\.auth\.getUser\(\)/);
  assert.match(source, /GA4_API_SECRET/);
  assert.match(source, /name:\s*"authenticated_active_time"/);
  assert.match(source, /non_personalized_ads:\s*true/);
  assert.doesNotMatch(
    source,
    /\buser_id\b|\buser_properties\b|page_location|page_path|page_title|project_id|person_id|document_id/i,
  );
  assert.match(
    config,
    /\[functions\.track-authenticated-engagement\]\s*verify_jwt\s*=\s*true/,
  );
});
