import type { Finding } from "../types/index.ts";
import { sanitizeWebUrl } from "./safeUrl.ts";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;:!?\]}]+$/u;
const EDGE_SEPARATORS = /^[\s·|,;:–—-]+|[\s·|,;:–—-]+$/gu;

function normalizedUrlCandidate(value: string): string {
  const trimmed = value.replace(TRAILING_URL_PUNCTUATION, "");
  return sanitizeWebUrl(trimmed) ?? "";
}

/** Returns the first safe HTTP(S) URL embedded in any supplied GEDCOM value. */
export function extractFindingSourceUrl(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    for (const match of value.matchAll(HTTP_URL_PATTERN)) {
      const normalized = normalizedUrlCandidate(match[0]);
      if (normalized) return normalized;
    }
  }
  return "";
}

/**
 * Removes web addresses from text intended for a visible finding field.
 * The untouched GEDCOM citation/source remains in customFields and the raw
 * import archive, so this only prevents the same URL being printed repeatedly.
 */
export function stripFindingSourceUrls(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value
    .replace(HTTP_URL_PATTERN, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").replace(EDGE_SEPARATORS, "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Reads the dedicated field and also recognizes malformed legacy imports so
 * existing cards get a usable link before/without a cleanup migration.
 */
export function resolvedFindingSourceUrl(
  finding: Pick<
    Finding,
    "sourceUrl" | "file" | "page" | "summary" | "description" | "transcription" | "notes" | "archive" | "fund"
  >,
): string {
  const explicit = sanitizeWebUrl(finding.sourceUrl);
  if (explicit) return explicit;
  return extractFindingSourceUrl(
    finding.file,
    finding.page,
    finding.summary,
    finding.description,
    finding.transcription,
    finding.notes,
    finding.archive,
    finding.fund,
  );
}
