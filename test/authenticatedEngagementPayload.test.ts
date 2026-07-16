import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ACTIVE_SECONDS_PER_REQUEST,
  parseAuthenticatedEngagementPayload,
} from "../supabase/functions/track-authenticated-engagement/payload.ts";

const validPayload = {
  clientId: "1234567890.42",
  sessionId: "18446744073709551615",
  activeSeconds: 60,
};

test("authenticated engagement accepts only the anonymous aggregate contract", () => {
  assert.deepEqual(parseAuthenticatedEngagementPayload(validPayload), {
    ok: true,
    value: validPayload,
  });
});

test("authenticated engagement rejects private or identifying extra fields", () => {
  for (const extra of [
    { route: "/projects/private" },
    { pageUrl: "https://example.test/projects/private" },
    { userId: "private-user" },
    { email: "private@example.test" },
  ]) {
    assert.equal(
      parseAuthenticatedEngagementPayload({ ...validPayload, ...extra }).ok,
      false,
    );
  }
});

test("authenticated engagement requires bounded whole seconds and random-id shapes", () => {
  assert.equal(parseAuthenticatedEngagementPayload({ ...validPayload, activeSeconds: 0 }).ok, false);
  assert.equal(
    parseAuthenticatedEngagementPayload({
      ...validPayload,
      activeSeconds: MAX_ACTIVE_SECONDS_PER_REQUEST + 1,
    }).ok,
    false,
  );
  assert.equal(parseAuthenticatedEngagementPayload({ ...validPayload, activeSeconds: 1.5 }).ok, false);
  assert.equal(parseAuthenticatedEngagementPayload({ ...validPayload, clientId: "not-random" }).ok, false);
  assert.equal(parseAuthenticatedEngagementPayload({ ...validPayload, sessionId: "0" }).ok, false);
});
