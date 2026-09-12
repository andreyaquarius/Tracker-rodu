import type { ErrorEvent, StackFrame } from "@sentry/react";

const ROUTE_PARTS = new Set([
  "projects", "persons", "findings", "documents", "family-tree", "tree", "research",
  "tasks", "settings", "notifications", "hypotheses", "archive-requests", "year-matrix",
  "map", "notes", "admin", "analytics", "subscriptions", "moderation", "features",
  "pricing", "faq", "privacy", "terms", "login", "register", "reset-password",
  "zahuliaky", "zagulyaky", "places", "my", "import", "export", "security",
  "rodove-derevo", "dashboard", "researches", "backups", "feedback", "operations",
  "announcements", "subscription", "statistics", "edit", "new", "context",
  "social", "ritual", "documentary",
]);

/** Never return a project slug, person ID, search term, query string or bearer. */
export function monitoringRoute(pathname: string): string {
  return "/" + pathname.split(/[?#]/, 1)[0].split("/").filter(Boolean).slice(0, 8)
    .map(part => ROUTE_PARTS.has(part) ? part : ":id").join("/");
}

export function isPrivateShareRoute(pathname: string): boolean {
  return /^\/(?:shared-graph|share)(?:\/|$)/i.test(pathname);
}

/** This integration deliberately supports hosted Sentry only, not arbitrary collectors. */
export function sentryIngestOrigin(dsn: string): string | null {
  try {
    const url = new URL(dsn);
    return url.protocol === "https:"
      && /^o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io$/.test(url.hostname)
      && /^[a-f0-9]{32}$/i.test(url.username)
      && /^\/\d+$/.test(url.pathname)
      && !url.password && !url.port && !url.search && !url.hash
      ? url.origin : null;
  } catch {
    return null;
  }
}

function safeAssetFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, "https://app.invalid");
    // Only deployed, content-hashed application assets are useful for source maps.
    // Drop blob/data URLs, local file paths, third-party scripts and source context.
    if (!/^https?:$/.test(url.protocol)) return undefined;
    const match = /^\/assets\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:m?js))$/.exec(url.pathname);
    return match ? `/assets/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    filename: safeAssetFilename(frame.filename),
    function: frame.function && /^[A-Za-z0-9_$.<> [\]-]{1,100}$/.test(frame.function)
      ? frame.function : undefined,
    lineno: Number.isSafeInteger(frame.lineno) ? frame.lineno : undefined,
    colno: Number.isSafeInteger(frame.colno) ? frame.colno : undefined,
    in_app: frame.in_app,
  };
}

export function safeErrorMessage(message = ""): string {
  // Free-form Error messages can contain genealogy records, SQL DETAIL, names,
  // file contents and access tokens. Keep categories, never the original text.
  if (message === "Tracker Rodu monitoring test") return message;
  const network = /^Supabase (?:GET|POST|PUT|PATCH|DELETE|HEAD) failed: (?:HTTP [45]\d\d|network)(?: \((?:[A-Z0-9]{5}|PGRST\d{3})\))?$/.exec(message);
  if (network) return network[0];
  if (/cannot read properties of (undefined|null)/i.test(message)) return "Cannot read properties of null or undefined";
  if (/maximum call stack size exceeded|too much recursion/i.test(message)) return "Maximum call stack size exceeded";
  if (/dynamically imported module|loading chunk|chunkloaderror|module script failed/i.test(message)) return "Application chunk could not be loaded";
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) return "Network request failed";
  if (/is not a function/i.test(message)) return "Value is not a function";
  if (/is not defined/i.test(message)) return "Reference is not defined";
  return "Application error (details omitted for privacy)";
}

function safeType(value?: string): string {
  return value && /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|SupabaseRequestError)$/.test(value)
    ? value : "Error";
}

export function isExpectedBrowserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? error.name : undefined;
  const message = "message" in error ? String(error.message ?? "") : "";
  return name === "AbortError" || name === "AuthenticatedSessionRequiredError"
    || /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/.test(message);
}

/** Positive allowlist: newly added SDK fields must NOT silently start sending data. */
export function sanitizeBrowserEvent(event: ErrorEvent, pathname: string, userAgent = ""): ErrorEvent | null {
  if (isPrivateShareRoute(pathname)) return null;
  const tags: Record<string, string> = { route: monitoringRoute(pathname) };
  const tagPatterns = {
    area: /^(react-root|react-recovery|route|family-tree|supabase|monitoring-test)$/,
    operation: /^(rpc|edge|table):[a-z][a-z0-9_-]{0,95}$/,
    http_status: /^(0|[45]\d\d)$/,
    error_code: /^(?:[A-Z0-9]{5}|PGRST\d{3})$/,
  };
  for (const [key, pattern] of Object.entries(tagPatterns)) {
    const value = event.tags?.[key];
    if (typeof value === "string" && pattern.test(value)) tags[key] = value;
  }
  const browser = /\b(Edg)\/(\d+(?:\.\d+){0,3})/.exec(userAgent)
    ?? /\b(Firefox|Chrome|Version)\/(\d+(?:\.\d+){0,3})/.exec(userAgent);
  const browserName = browser ? { Edg: "Edge", Firefox: "Firefox", Chrome: "Chrome", Version: "Safari" }[browser[1]] : undefined;
  const os = /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS"
    : /Windows/.test(userAgent) ? "Windows" : /Macintosh/.test(userAgent) ? "macOS"
      : /Linux/.test(userAgent) ? "Linux" : undefined;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "javascript",
    level: event.level,
    release: event.release,
    environment: event.environment,
    contexts: {
      ...(browserName ? { browser: { name: browserName, version: browser![2] } } : {}),
      ...(os ? { os: { name: os } } : {}),
    },
    message: event.message ? safeErrorMessage(event.message) : undefined,
    exception: event.exception ? {
      values: event.exception.values?.slice(0, 3).map(value => ({
        type: safeType(value.type),
        value: safeErrorMessage(value.value),
        stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.slice(-40).map(safeFrame) } : undefined,
        mechanism: value.mechanism ? {
          type: /^[A-Za-z0-9_.-]{1,80}$/.test(value.mechanism.type) ? value.mechanism.type : "generic",
          handled: value.mechanism.handled,
        } : undefined,
      })),
    } : undefined,
    // Preserve debug IDs for private source-map resolution, but not arbitrary paths.
    debug_meta: event.debug_meta ? {
      images: event.debug_meta.images?.flatMap(image => {
        const file = "code_file" in image ? safeAssetFilename(image.code_file) : undefined;
        return image.type === "sourcemap" && file && /^[a-f0-9-]{36}$/i.test(image.debug_id ?? "")
          ? [{ type: "sourcemap" as const, code_file: file, debug_id: image.debug_id }] : [];
      }),
    } : undefined,
    tags,
    fingerprint: tags.area === "supabase" && tags.operation
      ? ["supabase", tags.operation, tags.http_status || "0", tags.error_code || "unknown"]
      : undefined,
  };
}

/** Bound a broken browser's traffic; this is not a project-wide quota. */
export function createMonitoringRateLimit(now: () => number = Date.now) {
  const recent = new Map<string, number>();
  let total = 0;
  return (event: ErrorEvent): boolean => {
    const value = event.exception?.values?.[0];
    const frames = value?.stacktrace?.frames;
    const key = JSON.stringify([event.message, value?.type, value?.value, frames?.slice(-3), event.tags]);
    const time = now();
    if (total >= 30 || (recent.has(key) && time - recent.get(key)! < 60_000)) return false;
    recent.set(key, time);
    total += 1;
    return true;
  };
}
