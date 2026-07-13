import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AuthenticatedSessionRequiredError,
  runAuthenticatedRpc,
  type AuthenticatedRpcAuthResult,
  type AuthenticatedRpcResult,
} from "../src/utils/authenticatedRpc.ts";

const VALID_SESSION = {
  access_token: "access-token",
  expires_at: 2_000,
  user: { id: "user-id" },
};

function authResult(
  session: AuthenticatedRpcAuthResult["data"]["session"],
  error: unknown | null = null,
): AuthenticatedRpcAuthResult {
  return { data: { session }, error };
}

test("authenticated RPC is never invoked without a restored session", async () => {
  let invokes = 0;
  let refreshes = 0;

  await assert.rejects(
    runAuthenticatedRpc({
      getSession: async () => authResult(null),
      refreshSession: async () => {
        refreshes += 1;
        return authResult(VALID_SESSION);
      },
      invoke: async () => {
        invokes += 1;
        return { data: "unexpected", error: null };
      },
      shouldRetryAfterRefresh: () => true,
    }, 1_000),
    AuthenticatedSessionRequiredError,
  );

  assert.equal(invokes, 0);
  assert.equal(refreshes, 0);
});

test("authenticated RPC uses a valid session without an unnecessary refresh", async () => {
  let invokes = 0;
  let refreshes = 0;

  const result = await runAuthenticatedRpc({
    getSession: async () => authResult(VALID_SESSION),
    refreshSession: async () => {
      refreshes += 1;
      return authResult(VALID_SESSION);
    },
    invoke: async () => {
      invokes += 1;
      return { data: "ok", error: null };
    },
    shouldRetryAfterRefresh: () => true,
  }, 1_000);

  assert.deepEqual(result, { data: "ok", error: null });
  assert.equal(invokes, 1);
  assert.equal(refreshes, 0);
});

test("near-expiry session is refreshed before invoking the RPC", async () => {
  let invokes = 0;
  let refreshes = 0;

  const result = await runAuthenticatedRpc({
    getSession: async () => authResult({ ...VALID_SESSION, expires_at: 1_020 }),
    refreshSession: async () => {
      refreshes += 1;
      return authResult(VALID_SESSION);
    },
    invoke: async () => {
      invokes += 1;
      return { data: "ok", error: null };
    },
    shouldRetryAfterRefresh: () => true,
  }, 1_000);

  assert.deepEqual(result, { data: "ok", error: null });
  assert.equal(invokes, 1);
  assert.equal(refreshes, 1);
});

test("recognised auth failure refreshes once and retries once without a loop", async () => {
  const permissionError = {
    code: "42501",
    message: "permission denied for function get_my_subscription_context",
  };
  const results: AuthenticatedRpcResult<string>[] = [
    { data: null, error: permissionError },
    { data: null, error: permissionError },
  ];
  let invokes = 0;
  let refreshes = 0;

  const result = await runAuthenticatedRpc({
    getSession: async () => authResult(VALID_SESSION),
    refreshSession: async () => {
      refreshes += 1;
      return authResult(VALID_SESSION);
    },
    invoke: async () => results[invokes++],
    shouldRetryAfterRefresh: (error) => error === permissionError,
  }, 1_000);

  assert.equal(result.error, permissionError);
  assert.equal(invokes, 2);
  assert.equal(refreshes, 1);
});

test("database errors unrelated to authentication are not retried", async () => {
  const databaseError = { code: "57014", message: "statement timeout" };
  let invokes = 0;
  let refreshes = 0;

  const result = await runAuthenticatedRpc({
    getSession: async () => authResult(VALID_SESSION),
    refreshSession: async () => {
      refreshes += 1;
      return authResult(VALID_SESSION);
    },
    invoke: async () => {
      invokes += 1;
      return { data: null, error: databaseError };
    },
    shouldRetryAfterRefresh: () => false,
  }, 1_000);

  assert.equal(result.error, databaseError);
  assert.equal(invokes, 1);
  assert.equal(refreshes, 0);
});

test("subscription context ACL migration grants only authenticated execution", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/202607130010_subscription_context_acl.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /revoke execute[\s\S]+from public, anon/i);
  assert.match(migration, /grant execute[\s\S]+to authenticated/i);
  assert.doesNotMatch(migration, /grant execute[\s\S]+to (?:public|anon)/i);
});
