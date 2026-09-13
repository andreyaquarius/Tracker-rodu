/** Provider validation details belong in the user's form, never in telemetry. */
export function readableProviderError(value: unknown, depth = 0): string {
  if (!value || typeof value !== "object" || depth > 3) return "";
  const record = value as Record<string, unknown>;
  const messages: string[] = [];
  const add = (text: unknown) => {
    if (typeof text !== "string" || !text.trim() || messages.length >= 8) return;
    const bounded = text.trim().slice(0, 500);
    if (!messages.includes(bounded)) messages.push(bounded);
  };
  // Laravel-style field errors contain the actionable constraint; message alone
  // often only says "The given data was invalid."
  if (record.errors && typeof record.errors === "object") {
    for (const details of Object.values(record.errors).slice(0, 8)) {
      for (const detail of Array.isArray(details) ? details.slice(0, 8) : [details]) add(detail);
    }
  }
  if (messages.length) return messages.join("\n");
  if (record.error && typeof record.error === "object") {
    const nested = readableProviderError(record.error, depth + 1);
    if (nested) return nested;
  }
  for (const key of ["message", "error", "detail"]) add(record[key]);
  return messages.join("\n");
}

/** Fixed operation codes only; no request IDs, field values, or provider body. */
export function geneHelpProviderOperationCode(path: string): string {
  if (path === "/api/partners/onboarding/users") return "GHONB";
  if (path === "/api/partners/v2/genealogy-requests/simple") return "GHCRT";
  if (path !== "/api/partners/genealogy-requests/minimal"
    && /^\/api\/partners\/genealogy-requests\/[a-z0-9_-]{4,64}$/i.test(path)) return "GHSTS";
  return "GHSYN";
}
