import {
  AuthenticatedSessionRequiredError, runAuthenticatedRpc,
  type AuthenticatedRpcAuthResult, type AuthenticatedRpcResult,
} from "./authenticatedRpc.ts";

interface EdgeClient {
  auth: {
    getSession(): Promise<AuthenticatedRpcAuthResult>;
    refreshSession(): Promise<AuthenticatedRpcAuthResult>;
  };
  functions: {
    invoke<T>(name: string, options: { body: Record<string, unknown>; headers: Record<string, string> }): Promise<AuthenticatedRpcResult<T>>;
  };
}

const refreshes = new WeakMap<EdgeClient, Promise<AuthenticatedRpcAuthResult>>();

function refreshSession(client: EdgeClient): Promise<AuthenticatedRpcAuthResult> {
  const active = refreshes.get(client);
  if (active) return active;
  const request = client.auth.refreshSession().finally(() => {
    if (refreshes.get(client) === request) refreshes.delete(client);
  });
  refreshes.set(client, request);
  return request;
}

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("context" in error)) return false;
  return error.context instanceof Response && error.context.status === 401;
}

/** Opt-in for functions whose 401 rejects authorization before performing work. */
export async function invokeAuthenticatedEdgeFunction<T>(
  client: EdgeClient, name: string, body: Record<string, unknown>,
): Promise<AuthenticatedRpcResult<T>> {
  const initial = await client.auth.getSession();
  const expectedUserId = initial.data.session?.user?.id;
  const requireSameUser = (result: AuthenticatedRpcAuthResult) => {
    if (result.error) throw result.error;
    if (!expectedUserId || result.data.session?.user?.id !== expectedUserId
      || !result.data.session.access_token) throw new AuthenticatedSessionRequiredError();
    return result;
  };
  requireSameUser(initial);
  return runAuthenticatedRpc({
    getSession: async () => requireSameUser(await client.auth.getSession()),
    refreshSession: async () => requireSameUser(await refreshSession(client)),
    invoke: async () => {
      // Pin the checked user's JWT; never fall back to the anonymous key or a newly signed-in user.
      const current = requireSameUser(await client.auth.getSession());
      return client.functions.invoke<T>(name, {
        body, headers: { Authorization: `Bearer ${current.data.session!.access_token}` },
      });
    },
    shouldRetryAfterRefresh: isUnauthorized,
  });
}
