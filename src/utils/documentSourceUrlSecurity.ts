import { DocumentSourceError } from "../services/document-sources/errors.ts";

const DEFAULT_MAX_URL_LENGTH = 8_192;

const SENSITIVE_EXACT_NAMES = new Set([
  "accesstoken",
  "authtoken",
  "authorization",
  "awsaccesskeyid",
  "credential",
  "credentials",
  "googleaccessid",
  "idtoken",
  "key",
  "keypairid",
  "oauth",
  "oauthsignature",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "resourcekey",
  "secret",
  "secretkey",
  "securitytoken",
  "sessiontoken",
  "signature",
  "signedurl",
  "sig",
  "token",
]);

const SIGNED_URL_COMPANION_NAMES = new Set([
  "algorithm",
  "credential",
  "date",
  "expires",
  "keypairid",
  "policy",
  "signedheaders",
  // Azure-style signed-link companions are removed when a signature marker is
  // present, even though the initial adapters target AWS and Google URLs.
  "se",
  "sip",
  "sp",
  "spr",
  "sr",
  "st",
  "sv",
]);

export interface NormalizedExternalDocumentUrl {
  /** Canonical HTTPS URL safe to persist in document metadata. */
  url: string;
  removedSensitiveParameters: readonly string[];
}

export interface NormalizeExternalDocumentUrlOptions {
  maxLength?: number;
}

/**
 * Produces a persistence-safe external URL. Credentials are rejected rather
 * than silently accepted; secret-bearing query parameters and fragments are
 * stripped. Safe public parameters such as `id`, `title`, `page`, and `oldid`
 * remain unchanged.
 */
export function normalizeExternalDocumentUrl(
  value: unknown,
  options: NormalizeExternalDocumentUrlOptions = {},
): NormalizedExternalDocumentUrl {
  if (typeof value !== "string") throw new DocumentSourceError("INVALID_URL");
  const input = value.trim();
  const maxLength = options.maxLength ?? DEFAULT_MAX_URL_LENGTH;
  if (!input || input.length > maxLength || hasControlCharacter(input)) {
    throw new DocumentSourceError("INVALID_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (cause) {
    throw new DocumentSourceError("INVALID_URL", { cause });
  }
  if (parsed.protocol !== "https:") {
    throw new DocumentSourceError("UNSUPPORTED_SCHEME");
  }
  if (parsed.username || parsed.password) {
    throw new DocumentSourceError("INVALID_URL");
  }

  return scrubParsedUrl(parsed);
}

/**
 * Safe for diagnostics. It never returns embedded credentials, fragments, or
 * values of recognised secret/signed query parameters.
 */
export function redactExternalDocumentUrl(value: unknown): string {
  if (typeof value !== "string") return "[invalid-url]";
  const input = value.trim();
  if (!input || input.length > DEFAULT_MAX_URL_LENGTH || hasControlCharacter(input)) {
    return "[invalid-url]";
  }
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:") return "[unsupported-url]";
    parsed.username = "";
    parsed.password = "";
    return scrubParsedUrl(parsed).url;
  } catch {
    return "[invalid-url]";
  }
}

export function isSensitiveDocumentQueryParameter(name: string): boolean {
  const normalized = normalizeParameterName(name);
  if (!normalized) return false;
  if (normalized.startsWith("xamz") || normalized.startsWith("xgoog")) return true;
  if (SENSITIVE_EXACT_NAMES.has(normalized)) return true;
  if (normalized.includes("token") || normalized.includes("signature")) return true;
  return /^(?:api|access|secret|private|resource|signing|developer|subscription)key(?:id)?$/u.test(normalized);
}

function scrubParsedUrl(parsed: URL): NormalizedExternalDocumentUrl {
  parsed.hash = "";
  const entries = [...parsed.searchParams.entries()];
  const signedUrl = entries.some(([name]) => isSignedUrlMarker(name));
  const removed: string[] = [];
  parsed.search = "";

  for (const [name, value] of entries) {
    const normalizedName = normalizeParameterName(name);
    if (
      isSensitiveDocumentQueryParameter(name)
      || (signedUrl && SIGNED_URL_COMPANION_NAMES.has(normalizedName))
    ) {
      removed.push(name);
      continue;
    }
    parsed.searchParams.append(name, value);
  }

  return {
    url: parsed.href,
    removedSensitiveParameters: [...new Set(removed)],
  };
}

function isSignedUrlMarker(name: string): boolean {
  const normalized = normalizeParameterName(name);
  return normalized.startsWith("xamz")
    || normalized.startsWith("xgoog")
    || normalized === "awsaccesskeyid"
    || normalized === "googleaccessid"
    || normalized === "signature"
    || normalized === "oauthsignature"
    || normalized === "sig";
}

function normalizeParameterName(name: string): string {
  return name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
