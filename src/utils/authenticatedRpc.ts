export interface AuthenticatedRpcSession {
  access_token?: string;
  expires_at?: number;
  user?: {
    id?: string;
  };
}

export interface AuthenticatedRpcAuthResult {
  data: {
    session: AuthenticatedRpcSession | null;
  };
  error: unknown | null;
}

export interface AuthenticatedRpcResult<T> {
  data: T | null;
  error: unknown | null;
}

export interface AuthenticatedRpcOperations<T> {
  getSession: () => Promise<AuthenticatedRpcAuthResult>;
  refreshSession: () => Promise<AuthenticatedRpcAuthResult>;
  invoke: () => Promise<AuthenticatedRpcResult<T>>;
  shouldRetryAfterRefresh: (error: unknown) => boolean;
}

const SESSION_REFRESH_MARGIN_SECONDS = 30;

export class AuthenticatedSessionRequiredError extends Error {
  readonly code = "AUTH_SESSION_REQUIRED";

  constructor() {
    super("Сесію завершено. Увійдіть до облікового запису ще раз.");
    this.name = "AuthenticatedSessionRequiredError";
  }
}

function isUsableSession(
  session: AuthenticatedRpcSession | null,
): session is AuthenticatedRpcSession {
  return Boolean(session?.access_token && session.user?.id);
}

function isSessionNearExpiry(session: AuthenticatedRpcSession, nowSeconds: number): boolean {
  return typeof session.expires_at === "number" &&
    session.expires_at <= nowSeconds + SESSION_REFRESH_MARGIN_SECONDS;
}

function requireSession(result: AuthenticatedRpcAuthResult): AuthenticatedRpcSession {
  if (result.error) throw result.error;
  if (!isUsableSession(result.data.session)) {
    throw new AuthenticatedSessionRequiredError();
  }
  return result.data.session;
}

/**
 * Prevents an authenticated-only RPC from accidentally being sent as `anon`
 * while Supabase is restoring or refreshing the browser session. A failed
 * request is retried at most once, and only for an explicitly recognised auth
 * error.
 */
export async function runAuthenticatedRpc<T>(
  operations: AuthenticatedRpcOperations<T>,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<AuthenticatedRpcResult<T>> {
  let session = requireSession(await operations.getSession());
  let refreshed = false;

  if (isSessionNearExpiry(session, nowSeconds)) {
    session = requireSession(await operations.refreshSession());
    refreshed = true;
  }

  const firstResult = await operations.invoke();
  if (!firstResult.error || refreshed || !operations.shouldRetryAfterRefresh(firstResult.error)) {
    return firstResult;
  }

  requireSession(await operations.refreshSession());
  return operations.invoke();
}
