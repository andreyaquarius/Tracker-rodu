import assert from "node:assert/strict";
import test from "node:test";
import { invokeAuthenticatedEdgeFunction } from "../src/utils/authenticatedEdgeFunction.ts";
import { AuthenticatedSessionRequiredError, type AuthenticatedRpcAuthResult } from "../src/utils/authenticatedRpc.ts";

const valid = () => ({ access_token: "old-token", user: { id: "user-a" }, expires_at: Date.now() / 1000 + 3600 });
function harness(statuses: number[] = [200]) {
  let session: AuthenticatedRpcAuthResult["data"]["session"] = valid();
  let refreshes = 0;
  const calls: Array<{ name: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      refreshSession: async () => {
        refreshes += 1;
        session = { ...valid(), access_token: "new-token" };
        return { data: { session }, error: null };
      },
    },
    functions: {
      invoke: async <T>(name: string, options: { body: Record<string, unknown>; headers: Record<string, string> }) => {
        calls.push({ name, ...options });
        const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
        return status === 200 ? { data: { ok: true } as T, error: null }
          : { data: null, error: { context: new Response("rejected", { status }) } };
      },
    },
  };
  return { client, calls, setSession: (next: typeof session) => { session = next; }, refreshes: () => refreshes };
}

test("authenticated Edge calls never use an anonymous session", async () => {
  const h = harness(); h.setSession(null);
  await assert.rejects(invokeAuthenticatedEdgeFunction(h.client, "genehelp", {}), AuthenticatedSessionRequiredError);
  assert.equal(h.calls.length, 0);
  assert.equal(h.refreshes(), 0);
});

test("Edge 401 refreshes once and replays the original body with the new JWT", async () => {
  const h = harness([401, 200]); const body = { action: "create-simple-request", description: "example request" };
  const result = await invokeAuthenticatedEdgeFunction(h.client, "genehelp", body);
  assert.equal(result.error, null);
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.calls.map(call => call.headers.Authorization), ["Bearer old-token", "Bearer new-token"]);
  assert.ok(h.calls.every(call => call.name === "genehelp" && call.body === body));
});

test("near-expiry refresh happens before sending and persistent 401 never loops", async () => {
  const h = harness([401]); h.setSession({ ...valid(), expires_at: Date.now() / 1000 + 10 });
  assert.ok((await invokeAuthenticatedEdgeFunction(h.client, "test", {})).error);
  assert.equal(h.refreshes(), 1); assert.equal(h.calls.length, 1);
  const other = harness([401]);
  assert.ok((await invokeAuthenticatedEdgeFunction(other.client, "test", {})).error);
  assert.equal(other.refreshes(), 1); assert.equal(other.calls.length, 2);
});

test("validation, permission, and server failures do not replay a mutation", async () => {
  for (const status of [400, 403, 422, 429, 500, 502]) {
    const h = harness([status]);
    assert.ok((await invokeAuthenticatedEdgeFunction(h.client, "genehelp", {})).error);
    assert.equal(h.refreshes(), 0); assert.equal(h.calls.length, 1);
  }
  const h = harness(); const error = new TypeError("connection lost after accepting the request");
  let calls = 0;
  h.client.functions.invoke = async () => { calls += 1; throw error; };
  await assert.rejects(invokeAuthenticatedEdgeFunction(h.client, "genehelp", {}), value => value === error);
  assert.equal(calls, 1); assert.equal(h.refreshes(), 0);
});

test("session loss or account switch during refresh prevents replay", async () => {
  for (const session of [null, { ...valid(), user: { id: "user-b" } }]) {
    const h = harness([401]);
    h.client.auth.refreshSession = async () => { h.setSession(session); return h.client.auth.getSession(); };
    await assert.rejects(invokeAuthenticatedEdgeFunction(h.client, "genehelp", {}), AuthenticatedSessionRequiredError);
    assert.equal(h.calls.length, 1);
  }
});

test("concurrent failures share one pending token refresh", async () => {
  const h = harness([401]);
  let complete!: () => void; let refreshes = 0;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  h.client.auth.refreshSession = async () => {
    refreshes += 1; await gate;
    h.setSession({ ...valid(), access_token: "new-token" });
    return h.client.auth.getSession();
  };
  const calls = [1, 2, 3].map(() => invokeAuthenticatedEdgeFunction(h.client, "test", {}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  complete(); await Promise.all(calls);
  assert.equal(refreshes, 1); assert.equal(h.calls.length, 6);
});
