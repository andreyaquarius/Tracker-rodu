export type AuthenticatedEngagementPayload = Readonly<{
  clientId: string;
  sessionId: string;
  activeSeconds: number;
}>;

export type AuthenticatedEngagementPayloadResult =
  | Readonly<{ ok: true; value: AuthenticatedEngagementPayload }>
  | Readonly<{ ok: false; error: string }>;

export const MAX_ACTIVE_SECONDS_PER_REQUEST = 300;

const EXACT_KEYS = ["activeSeconds", "clientId", "sessionId"] as const;
const CLIENT_ID_PATTERN = /^[1-9]\d{0,9}\.[1-9]\d{0,9}$/;
const SESSION_ID_PATTERN = /^[1-9]\d{0,19}$/;

export function parseAuthenticatedEngagementPayload(
  input: unknown,
): AuthenticatedEngagementPayloadResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid analytics payload." };
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== EXACT_KEYS.length ||
    !keys.every((key, index) => key === EXACT_KEYS[index])
  ) {
    return { ok: false, error: "Invalid analytics payload." };
  }

  if (
    typeof record.clientId !== "string" ||
    !CLIENT_ID_PATTERN.test(record.clientId)
  ) {
    return { ok: false, error: "Invalid analytics payload." };
  }
  if (
    typeof record.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(record.sessionId)
  ) {
    return { ok: false, error: "Invalid analytics payload." };
  }
  if (
    typeof record.activeSeconds !== "number" ||
    !Number.isInteger(record.activeSeconds) ||
    record.activeSeconds < 1 ||
    record.activeSeconds > MAX_ACTIVE_SECONDS_PER_REQUEST
  ) {
    return { ok: false, error: "Invalid analytics payload." };
  }

  return {
    ok: true,
    value: {
      clientId: record.clientId,
      sessionId: record.sessionId,
      activeSeconds: record.activeSeconds,
    },
  };
}
