const GENEHELP_ORIGIN = "https://genehelp.online";
const GENEHELP_MY_REQUESTS_URL = `${GENEHELP_ORIGIN}/uk/my/requests`;

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

function isGeneHelpRequestRoute(url: URL): boolean {
  return /^\/(?:uk\/)?requests\/[^/]+\/?(?:edit\/?)?$/.test(url.pathname);
}

export function authenticatedGeneHelpViewUrl(viewUrl?: string, editUrl?: string): string | null {
  const sanitizedView = sanitizeWebUrl(viewUrl || "");
  const sanitizedEdit = sanitizeWebUrl(editUrl || "");
  if (!sanitizedView && !sanitizedEdit) return null;

  if (sanitizedView) {
    try {
      const view = new URL(sanitizedView);
      if (view.origin !== GENEHELP_ORIGIN) return sanitizedView;
      if (view.pathname === "/uk/my/requests") return sanitizedView;
      if (isGeneHelpRequestRoute(view)) return GENEHELP_MY_REQUESTS_URL;
      return sanitizedView;
    } catch {
      return sanitizedView;
    }
  }

  if (!sanitizedEdit) return null;

  try {
    const edit = new URL(sanitizedEdit);
    if (edit.origin === GENEHELP_ORIGIN && isGeneHelpRequestRoute(edit)) {
      return GENEHELP_MY_REQUESTS_URL;
    }
  } catch {
    return null;
  }

  return null;
}
