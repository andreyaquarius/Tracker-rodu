// Centralised URL sanitisation for user-supplied values.
//
// User-controlled "url" fields (custom fields, custom-section fields) and
// imported attachment links are rendered as <a href> / passed to
// window.open(). React does NOT sanitise href, so a value such as
// "javascript:…" executes script in the application origin when clicked.
// Because the Supabase session lives in localStorage, that is a full account
// takeover vector across shared projects. These helpers enforce a scheme
// allowlist so only navigable web/contact links survive.

const SAFE_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

// Remove C0/C1 control characters (incl. tab and newline) that browsers strip
// while parsing a scheme and that could smuggle "java\tscript:". Done with an
// explicit code-point check to avoid embedding raw control bytes in source.
function stripControlChars(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    result += char;
  }
  return result;
}

/**
 * Returns a safe, fully-qualified URL or `null` when the value cannot be
 * proven safe. Accepts http(s), mailto and tel. Scheme-less values are treated
 * as web hosts and promoted to https. Anything using a dangerous scheme
 * (javascript:, data:, vbscript:, file:, blob:, …) is rejected.
 */
export function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripControlChars(value).trim();
  if (!cleaned) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(cleaned);
  const candidate = hasScheme ? cleaned : `https://${cleaned}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.includes(parsed.protocol.toLowerCase())) return null;
  return parsed.href;
}

/**
 * Like {@link sanitizeUrl} but restricted to http(s) — for "open link"
 * affordances and window.open(). Returns `null` for mailto/tel and unsafe
 * schemes.
 */
export function sanitizeWebUrl(value: unknown): string | null {
  const url = sanitizeUrl(value);
  if (!url) return null;
  return /^https?:/i.test(url) ? url : null;
}
