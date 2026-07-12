export const PROJECT_SEARCH_MIN_QUERY_LENGTH = 3;
export const PROJECT_SEARCH_DEFAULT_LIMIT = 40;
export const PROJECT_SEARCH_MAX_LIMIT = 50;

export type ProjectSearchPage =
  | "researches"
  | "documents"
  | "yearMatrix"
  | "tasks"
  | "findings"
  | "hypotheses"
  | "archiveRequests"
  | "persons"
  | `custom:${string}`;

export interface ProjectSearchResult {
  id: string;
  entityId: string;
  module: string;
  page: ProjectSearchPage;
  moduleLabel: string;
  title: string;
  description: string;
}

export function projectSearchResultLimit(value: number): number {
  if (!Number.isFinite(value)) return PROJECT_SEARCH_DEFAULT_LIMIT;
  return Math.min(PROJECT_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

export function mapProjectSearchResults(value: unknown): ProjectSearchResult[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    const row = asRecord(candidate);
    const id = stringValue(row.id);
    const page = stringValue(row.page);
    if (!id || !isProjectSearchPage(page)) return [];

    return [{
      id,
      entityId: stringValue(row.entityId) || id,
      module: stringValue(row.module) || page,
      page,
      moduleLabel: stringValue(row.moduleLabel),
      title: stringValue(row.title),
      description: stringValue(row.description),
    }];
  });
}

function isProjectSearchPage(value: string): value is ProjectSearchPage {
  return value.startsWith("custom:") || [
    "researches",
    "documents",
    "yearMatrix",
    "tasks",
    "findings",
    "hypotheses",
    "archiveRequests",
    "persons",
  ].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
