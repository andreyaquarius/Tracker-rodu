export type DeletionContinuationOptions = {
  supabaseUrl: string;
  serverToken: string;
  jobId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_CONTINUATION_TIMEOUT_MS = 8_000;

/** Compares secrets without returning at the first differing byte. */
export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isTrustedDeletionWorkerToken(
  providedToken: string,
  serviceRoleKey: string,
  cronSecret: string,
): boolean {
  if (!providedToken) return false;

  // Evaluate both configured server credentials before combining the result.
  // A normal browser access token must still pass the user-auth branch.
  const serviceRoleMatch = constantTimeEqual(serviceRoleKey, providedToken);
  const cronSecretMatch = cronSecret
    ? constantTimeEqual(cronSecret, providedToken)
    : false;
  return serviceRoleMatch || cronSecretMatch;
}

/**
 * Starts exactly one follow-up Edge invocation. The durable database job is
 * the source of truth, so a failed wake-up is left to the scheduled recovery
 * worker instead of being retried here and creating parallel worker chains.
 */
export async function requestDeletionContinuation({
  supabaseUrl,
  serverToken,
  jobId,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_CONTINUATION_TIMEOUT_MS,
}: DeletionContinuationOptions): Promise<void> {
  if (!serverToken) {
    throw new Error("A server-to-server token is required to continue project deletion.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/process-project-deletions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(jobId ? { jobId } : {}),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Project deletion continuation was rejected (${response.status})${
          responseText ? `: ${responseText.slice(0, 500)}` : ""
        }`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
