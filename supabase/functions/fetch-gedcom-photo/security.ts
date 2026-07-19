export const GEDCOM_PHOTO_ALLOWED_HOSTNAME = "sites-cf.mhcache.com";
export const GEDCOM_PHOTO_MAX_REDIRECTS = 3;
export const GEDCOM_PHOTO_MAX_BYTES = 25 * 1024 * 1024;

export class GedcomPhotoSourceValidationError extends Error {
  readonly code = "GEDCOM_PHOTO_SOURCE_NOT_ALLOWED";

  constructor() {
    super("Джерело фотографії не дозволене.");
    this.name = "GedcomPhotoSourceValidationError";
  }
}

/**
 * The proxy is intentionally restricted to the single CDN hostname observed
 * in supported GEDCOM exports. Never broaden this into an arbitrary URL
 * fetcher: the strict allowlist is the primary SSRF boundary.
 */
export function validateGedcomPhotoSource(value: unknown): URL {
  if (typeof value !== "string") throw new GedcomPhotoSourceValidationError();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192) {
    throw new GedcomPhotoSourceValidationError();
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GedcomPhotoSourceValidationError();
  }

  if (
    url.protocol !== "https:"
    || url.hostname.toLocaleLowerCase("en-US") !== GEDCOM_PHOTO_ALLOWED_HOSTNAME
    || (url.port !== "" && url.port !== "443")
    || Boolean(url.username)
    || Boolean(url.password)
  ) {
    throw new GedcomPhotoSourceValidationError();
  }

  // Fragments are never sent over HTTP and should not become part of the
  // upstream request identity.
  url.hash = "";
  return url;
}

export function isGedcomPhotoRedirectStatus(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

export function resolveGedcomPhotoRedirect(currentUrl: URL, location: string): URL {
  if (!location.trim()) throw new GedcomPhotoSourceValidationError();
  let resolved: URL;
  try {
    resolved = new URL(location, currentUrl);
  } catch {
    throw new GedcomPhotoSourceValidationError();
  }
  return validateGedcomPhotoSource(resolved.href);
}
