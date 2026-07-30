const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function createOpaqueSessionToken(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  const bytes = randomBytes(SESSION_TOKEN_BYTES);
  if (bytes.byteLength !== SESSION_TOKEN_BYTES) {
    throw new Error("SESSION_RANDOM_SOURCE_INVALID");
  }
  return bytesToBase64Url(bytes);
}

export function isValidOpaqueSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value);
}

export async function hashOpaqueSessionToken(value: string): Promise<string> {
  if (!isValidOpaqueSessionToken(value)) {
    throw new Error("SESSION_TOKEN_INVALID");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalFingerprint(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}
