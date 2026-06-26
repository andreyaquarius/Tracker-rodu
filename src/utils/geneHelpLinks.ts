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

function requestIdFromGeneHelpUrl(url: URL): string | null {
  const match = url.pathname.match(/^\/(?:uk\/)?requests\/([^/]+)\/?(?:edit\/?)?$/);
  const requestId = match?.[1]?.trim();
  return requestId && /^[a-z0-9_-]{4,64}$/i.test(requestId) ? requestId : null;
}

function geneHelpMyRequestsUrl(requestId?: string | null): string {
  const url = new URL(GENEHELP_MY_REQUESTS_URL);
  if (requestId) url.searchParams.set("request", requestId);
  return url.toString();
}

export function authenticatedGeneHelpViewUrl(
  viewUrl?: string,
  editUrl?: string,
  requestId?: string,
): string | null {
  const sanitizedView = sanitizeWebUrl(viewUrl || "");
  const sanitizedEdit = sanitizeWebUrl(editUrl || "");
  if (!sanitizedView && !sanitizedEdit) return null;
  const normalizedRequestId = requestId?.trim();

  if (sanitizedView) {
    try {
      const view = new URL(sanitizedView);
      if (view.origin !== GENEHELP_ORIGIN) return sanitizedView;
      if (view.pathname === "/uk/my/requests") return sanitizedView;
      if (isGeneHelpRequestRoute(view)) {
        return geneHelpMyRequestsUrl(normalizedRequestId || requestIdFromGeneHelpUrl(view));
      }
      return sanitizedView;
    } catch {
      return sanitizedView;
    }
  }

  if (!sanitizedEdit) return null;

  try {
    const edit = new URL(sanitizedEdit);
    if (edit.origin === GENEHELP_ORIGIN && isGeneHelpRequestRoute(edit)) {
      return geneHelpMyRequestsUrl(normalizedRequestId || requestIdFromGeneHelpUrl(edit));
    }
  } catch {
    return null;
  }

  return null;
}
