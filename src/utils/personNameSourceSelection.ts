export interface PersonNameSourceLinkFields {
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  sourceType: string;
  sourceId: string | null;
}

export type PersonNameSourceChoice = "" | "__legacy" | `document:${string}` | `finding:${string}`;

export interface ApplyPersonNameSourceChoiceOptions {
  /** The document containing the selected finding, when the finding has one. */
  findingDocumentId?: string | null;
}

/**
 * Converts the stored source fields into the one user-facing source choice.
 * Conflicting or non-catalogue legacy links are preserved behind a neutral
 * placeholder instead of exposing their UUIDs in the editor.
 */
export function personNameSourceChoice(source: PersonNameSourceLinkFields): PersonNameSourceChoice {
  const documentId = source.sourceDocumentId;
  const findingId = source.sourceFindingId;
  const genericId = source.sourceId;
  const genericType = source.sourceType.trim().toLocaleLowerCase("uk-UA");

  if (documentId && findingId) {
    return genericId && (genericType !== "finding" || genericId !== findingId)
      ? "__legacy"
      : `finding:${findingId}`;
  }
  if (documentId) {
    return genericId && (genericType !== "document" || genericId !== documentId)
      ? "__legacy"
      : `document:${documentId}`;
  }
  if (findingId) {
    return genericId && (genericType !== "finding" || genericId !== findingId)
      ? "__legacy"
      : `finding:${findingId}`;
  }
  if (!genericId) return genericType && genericType !== "manual" ? "__legacy" : "";
  if (genericType === "document") return `document:${genericId}`;
  if (genericType === "finding") return `finding:${genericId}`;
  return "__legacy";
}

/** Applies only an explicit selection made by the user; forward-compatible citation fields are untouched. */
export function applyPersonNameSourceChoice<T extends PersonNameSourceLinkFields>(
  source: T,
  choice: string,
  options: ApplyPersonNameSourceChoiceOptions = {},
): T {
  if (choice === "") {
    return {
      ...source,
      sourceDocumentId: null,
      sourceFindingId: null,
      sourceType: "",
      sourceId: null,
    };
  }
  if (choice.startsWith("document:")) {
    const documentId = choice.slice("document:".length);
    if (!documentId) return source;
    return {
      ...source,
      sourceDocumentId: documentId,
      sourceFindingId: null,
      sourceType: "document",
      sourceId: documentId,
    };
  }
  if (choice.startsWith("finding:")) {
    const findingId = choice.slice("finding:".length);
    if (!findingId) return source;
    return {
      ...source,
      sourceDocumentId: options.findingDocumentId || null,
      sourceFindingId: findingId,
      sourceType: "finding",
      sourceId: findingId,
    };
  }
  return source;
}
