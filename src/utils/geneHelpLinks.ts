const GENEHELP_ORIGIN = "https://genehelp.online";

function sanitizeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!cleaned) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(cleaned);
  const candidate = hasScheme ? cleaned : `https://${cleaned}`;
  try {
    const parsed = new URL(candidate);
    return /^https?:$/i.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function geneHelpLoginRedirectUrl(targetUrl: string): string | null {
  const sanitizedTarget = sanitizeWebUrl(targetUrl);
  if (!sanitizedTarget) return null;

  let target: URL;
  try {
    target = new URL(sanitizedTarget);
  } catch {
    return null;
  }

  if (target.origin !== GENEHELP_ORIGIN) return sanitizedTarget;

  const loginUrl = new URL("/login", target.origin);
  loginUrl.searchParams.set(
    "redirect",
    `${target.pathname}${target.search}${target.hash}`,
  );
  return loginUrl.toString();
}

export function authenticatedGeneHelpViewUrl(viewUrl?: string): string | null {
  const sanitizedView = sanitizeWebUrl(viewUrl || "");
  if (!sanitizedView) return null;

  let view: URL;
  try {
    view = new URL(sanitizedView);
  } catch {
    return sanitizedView;
  }

  if (view.origin !== GENEHELP_ORIGIN) return sanitizedView;
  if (!/^\/requests\/[^/]+\/?$/.test(view.pathname)) return sanitizedView;

  return geneHelpLoginRedirectUrl(sanitizedView) || sanitizedView;
}
