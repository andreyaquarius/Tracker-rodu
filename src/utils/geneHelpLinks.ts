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

export function authenticatedGeneHelpViewUrl(viewUrl?: string, editUrl?: string): string | null {
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

  const sanitizedEdit = sanitizeWebUrl(editUrl || "");
  if (!sanitizedEdit) return sanitizedView;

  try {
    const edit = new URL(sanitizedEdit);
    const expectedEditPath = `${view.pathname.replace(/\/$/g, "")}/edit`;
    if (edit.origin === GENEHELP_ORIGIN && edit.pathname === expectedEditPath) {
      return sanitizedEdit;
    }
  } catch {
    return sanitizedView;
  }

  return sanitizedView;
}
