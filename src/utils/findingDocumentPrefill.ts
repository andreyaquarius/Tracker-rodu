import type { DocumentRecord } from "../types";

const findingDocumentFieldMappings = [
  ["researchId", "researchId"],
  ["place", "place"],
  ["archive", "archive"],
  ["fund", "fund"],
  ["description", "description"],
  ["file", "file"],
  ["sourceUrl", "url"],
] as const satisfies ReadonlyArray<readonly [string, keyof DocumentRecord]>;

/**
 * Copies source-level metadata into a finding without replacing independent
 * details that the user has already entered for the finding.
 *
 * When the linked document changes, a value inherited from the old document
 * can be replaced with the corresponding value from the new document. A
 * customized value is preserved.
 */
export function prefillFindingFromDocument<T extends Record<string, unknown>>(
  draft: T,
  document: DocumentRecord | null | undefined,
  previousDocument?: DocumentRecord | null,
): T {
  if (!document) return draft;

  let changed = false;
  const next: Record<string, unknown> = { ...draft };

  for (const [findingKey, documentKey] of findingDocumentFieldMappings) {
    const currentValue = textValue(draft[findingKey]);
    const previousValue = previousDocument
      ? textValue(previousDocument[documentKey])
      : "";

    if (currentValue && (!previousDocument || currentValue !== previousValue)) {
      continue;
    }

    const inheritedValue = textValue(document[documentKey]);
    if (currentValue === inheritedValue) continue;
    next[findingKey] = inheritedValue;
    changed = true;
  }

  return changed ? next as T : draft;
}

function textValue(value: unknown): string {
  return String(value ?? "").trim();
}
