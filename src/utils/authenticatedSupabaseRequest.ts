import {
  AuthenticatedSessionRequiredError,
  runAuthenticatedRpc,
  type AuthenticatedRpcAuthResult,
  type AuthenticatedRpcResult,
} from "./authenticatedRpc.ts";

interface AuthenticatedSupabaseClient {
  auth: {
    getSession: () => Promise<AuthenticatedRpcAuthResult>;
    refreshSession: () => Promise<AuthenticatedRpcAuthResult>;
  };
}

function requireExpectedUser(
  result: AuthenticatedRpcAuthResult,
  expectedUserId?: string,
): AuthenticatedRpcAuthResult {
  if (result.error || !expectedUserId || !result.data.session) return result;
  if (result.data.session.user?.id === expectedUserId) return result;

  return {
    data: { session: null },
    error: null,
  };
}

/**
 * Returns true only for failures that can be caused by an expired or missing
 * Supabase JWT. A real ACL failure is still returned after the single retry.
 */
export function isSupabaseAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code ?? "").toUpperCase() : "";
  const status = "status" in error ? Number(error.status) : 0;
  const message = "message" in error
    ? String(error.message ?? "").toLocaleLowerCase()
    : "";

  return status === 401 ||
    code === "PGRST301" ||
    code === "PGRST302" ||
    code === "42501" ||
    message.includes("jwt expired") ||
    message.includes("invalid jwt") ||
    message.includes("auth required");
}

/**
 * Prevents an authenticated-only PostgREST/RPC request from being sent with
 * the publishable `anon` role while Supabase is restoring or refreshing the
 * browser session. The request is retried at most once after a token refresh.
 */
export async function runAuthenticatedSupabaseRequest<T>(
  client: AuthenticatedSupabaseClient,
  invoke: () => Promise<AuthenticatedRpcResult<T>>,
  expectedUserId?: string,
): Promise<AuthenticatedRpcResult<T>> {
  return runAuthenticatedRpc({
    getSession: async () => requireExpectedUser(
      await client.auth.getSession(),
      expectedUserId,
    ),
    refreshSession: async () => requireExpectedUser(
      await client.auth.refreshSession(),
      expectedUserId,
    ),
    invoke,
    shouldRetryAfterRefresh: isSupabaseAuthenticationError,
  });
}

export { AuthenticatedSessionRequiredError };
