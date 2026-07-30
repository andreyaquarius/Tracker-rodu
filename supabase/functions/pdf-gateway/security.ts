export const PDF_GATEWAY_MAX_URL_LENGTH = 8_192;

export type PdfGatewaySecurityErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "SOURCE_URL_NOT_SAFE"
  | "HOST_NOT_ALLOWED"
  | "DNS_RESOLUTION_FAILED"
  | "DNS_REBINDING_DETECTED"
  | "REDIRECT_NOT_ALLOWED"
  | "RANGE_INVALID";

export class PdfGatewaySecurityError extends Error {
  readonly code: PdfGatewaySecurityErrorCode;

  constructor(code: PdfGatewaySecurityErrorCode) {
    super(code);
    this.name = "PdfGatewaySecurityError";
    this.code = code;
  }
}

export type HostAddressResolver = (hostname: string) => Promise<readonly string[]>;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home",
  ".lan",
  ".corp",
];

const SENSITIVE_QUERY_EXACT_NAMES = new Set([
  "key",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret_key",
  "private_key",
  "subscription_key",
  "developer_key",
  "token",
  "access_token",
  "auth_token",
  "id_token",
  "refresh_token",
  "session_token",
  "signature",
  "sig",
  "oauth_signature",
  "awsaccesskeyid",
  "googleaccessid",
  "credential",
  "x-ms-signature",
]);

function isSensitiveQueryName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  return SENSITIVE_QUERY_EXACT_NAMES.has(normalized)
    || normalized.startsWith("x-amz-")
    || normalized.startsWith("x-goog-")
    || normalized.includes("token")
    || normalized.includes("signature")
    || normalized.endsWith("_secret")
    || normalized.endsWith("-secret");
}

function normalizedHostname(value: string): string {
  return value
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLocaleLowerCase("en-US");
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function isPublicIpv4(bytes: readonly number[]): boolean {
  const [a, b, c, d] = bytes;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return false;

  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function parseIpv6(value: string): bigint | null {
  const normalized = normalizedHostname(value);
  if (!normalized.includes(":")) return null;
  if (normalized.includes("%")) return null;

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":")
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":")
    : [];

  const isHextet = (part: string) => /^[0-9a-f]{1,4}$/iu.test(part);
  if (!left.every(isHextet) || !right.every(isHextet)) return null;

  const explicitCount = left.length + right.length;
  if (doubleColonParts.length === 1 && explicitCount !== 8) return null;
  if (doubleColonParts.length === 2 && explicitCount >= 8) return null;

  const missing = doubleColonParts.length === 2 ? 8 - explicitCount : 0;
  const hextets = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (hextets.length !== 8) return null;

  let result = 0n;
  for (const hextet of hextets) {
    result = (result << 16n) | BigInt(Number.parseInt(hextet, 16));
  }
  return result;
}

function isPublicIpv6(value: bigint): boolean {
  // Generic outbound proxying is limited to ordinary globally routable IPv6.
  // This deliberately rejects ULA, link-local, multicast, mapped IPv4, NAT64,
  // documentation and other special-purpose blocks.
  const globalStart = 0x20000000000000000000000000000000n;
  const globalEnd = 0x3fffffffffffffffffffffffffffffffn;
  if (value < globalStart || value > globalEnd) return false;

  const inCidr = (network: bigint, prefixBits: number) => {
    const shift = BigInt(128 - prefixBits);
    return (value >> shift) === (network >> shift);
  };
  // 2001:0000::/23 is IETF protocol-assignment space, not ordinary unicast.
  if (inCidr(0x20010000000000000000000000000000n, 23)) return false;
  // 2001:db8::/32 and 3fff::/20 are documentation-only ranges.
  if (inCidr(0x20010db8000000000000000000000000n, 32)) return false;
  if (inCidr(0x3fff0000000000000000000000000000n, 20)) return false;
  // 6to4 can encode otherwise blocked IPv4 destinations.
  if (inCidr(0x20020000000000000000000000000000n, 16)) return false;
  return true;
}

export function isPublicIpAddress(value: string): boolean {
  const hostname = normalizedHostname(value);
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(hostname);
  return ipv6 !== null && isPublicIpv6(ipv6);
}

export function isIpAddress(value: string): boolean {
  const hostname = normalizedHostname(value);
  return parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
}

export function validatePublicPdfUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw new PdfGatewaySecurityError("INVALID_URL");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PDF_GATEWAY_MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new PdfGatewaySecurityError("INVALID_URL");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PdfGatewaySecurityError("INVALID_URL");
  }

  if (url.protocol !== "https:") {
    throw new PdfGatewaySecurityError("UNSUPPORTED_SCHEME");
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new PdfGatewaySecurityError("SOURCE_URL_NOT_SAFE");
  }

  const hostname = normalizedHostname(url.hostname);
  if (
    !hostname
    || BLOCKED_HOSTNAMES.has(hostname)
    || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    || (!hostname.includes(".") && !isIpAddress(hostname))
    || (isIpAddress(hostname) && !isPublicIpAddress(hostname))
  ) {
    throw new PdfGatewaySecurityError("HOST_NOT_ALLOWED");
  }

  for (const name of url.searchParams.keys()) {
    if (isSensitiveQueryName(name)) {
      throw new PdfGatewaySecurityError("SOURCE_URL_NOT_SAFE");
    }
  }

  url.hash = "";
  return url;
}

export function resolveValidatedRedirect(currentUrl: URL, location: string): URL {
  if (!location.trim()) {
    throw new PdfGatewaySecurityError("REDIRECT_NOT_ALLOWED");
  }
  try {
    return validatePublicPdfUrl(new URL(location, currentUrl).href);
  } catch (error) {
    if (error instanceof PdfGatewaySecurityError) throw error;
    throw new PdfGatewaySecurityError("REDIRECT_NOT_ALLOWED");
  }
}

function canonicalAddressSet(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map(normalizedHostname))].sort();
}

export async function resolvePublicHostAddresses(
  hostnameValue: string,
  resolver: HostAddressResolver,
): Promise<readonly string[]> {
  const hostname = normalizedHostname(hostnameValue);
  if (isIpAddress(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new PdfGatewaySecurityError("HOST_NOT_ALLOWED");
    }
    return [hostname];
  }

  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new PdfGatewaySecurityError("DNS_RESOLUTION_FAILED");
  }
  const normalized = canonicalAddressSet(addresses);
  if (!normalized.length) {
    throw new PdfGatewaySecurityError("DNS_RESOLUTION_FAILED");
  }
  if (normalized.some((address) => !isIpAddress(address) || !isPublicIpAddress(address))) {
    throw new PdfGatewaySecurityError("HOST_NOT_ALLOWED");
  }
  return normalized;
}

export function assertSameAddressSet(
  before: readonly string[],
  after: readonly string[],
): void {
  const normalizedBefore = canonicalAddressSet(before);
  const normalizedAfter = canonicalAddressSet(after);
  if (
    normalizedBefore.length !== normalizedAfter.length
    || normalizedBefore.some((address, index) => address !== normalizedAfter[index])
  ) {
    throw new PdfGatewaySecurityError("DNS_REBINDING_DETECTED");
  }
}

export type ParsedByteRange = {
  header: string;
  start?: number;
  end?: number;
  suffixLength?: number;
};

export function parseSingleByteRange(value: string | null): ParsedByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (!match || (!match[1] && !match[2])) {
    throw new PdfGatewaySecurityError("RANGE_INVALID");
  }
  const first = match[1] ? Number(match[1]) : undefined;
  const second = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && (!Number.isSafeInteger(first) || first < 0))
    || (second !== undefined && (!Number.isSafeInteger(second) || second < 0))
    || (first !== undefined && second !== undefined && first > second)
    || (first === undefined && second === 0)
  ) {
    throw new PdfGatewaySecurityError("RANGE_INVALID");
  }
  if (first === undefined) {
    return { header: `bytes=-${second}`, suffixLength: second };
  }
  return {
    header: `bytes=${first}-${second ?? ""}`,
    start: first,
    end: second,
  };
}

export function isRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}
