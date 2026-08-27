import { getSupabaseClient } from "./supabaseAuth";
import {
  mapProjectSearchResults,
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MIN_QUERY_LENGTH,
  projectSearchResultLimit,
} from "../utils/projectSearchResults";
import type { ProjectSearchResult } from "../utils/projectSearchResults";
import { mapHistoricalPersonNameSearchResults } from "../utils/historicalPersonNameSearch.ts";

export {
  mapProjectSearchResults,
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MAX_LIMIT,
  PROJECT_SEARCH_MIN_QUERY_LENGTH,
  projectSearchResultLimit,
} from "../utils/projectSearchResults";
export type {
  ProjectSearchPage,
  ProjectSearchResult,
} from "../utils/projectSearchResults";

export async function searchProjectRecords(
  projectId: string,
  query: string,
  limit = PROJECT_SEARCH_DEFAULT_LIMIT,
): Promise<ProjectSearchResult[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < PROJECT_SEARCH_MIN_QUERY_LENGTH) return [];

  const boundedLimit = projectSearchResultLimit(limit);
  const client = getSupabaseClient();
  const [recordsResult, personNamesResult] = await Promise.all([
    client.rpc("search_project_records", {
      target_project_id: projectId,
      search_query: normalizedQuery,
      result_limit: projectSearchResultLimit(limit),
    }),
    client.rpc("search_project_person_names_v1", {
      p_project_id: projectId,
      p_query: normalizedQuery,
      p_limit: boundedLimit,
    }),
  ]);
  if (recordsResult.error) throw recordsResult.error;

  const regularResults = mapProjectSearchResults(recordsResult.data);
  // Historical-name search is additive. A rollout gap, timeout, or transient
  // failure must not take the existing cross-module search offline.
  const historicalNameResults = personNamesResult.error
    ? []
    : mapHistoricalPersonNameSearchResults(personNamesResult.data);

  // Historical matches go first because they explain why a query such as
  // "Kaleński" found the current profile "Іван Каленський". The entity key
  // keeps a person returned by both searches from appearing twice.
  const unique = new Map<string, ProjectSearchResult>();
  for (const result of [...historicalNameResults, ...regularResults]) {
    const key = `${result.page}:${result.entityId}`;
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()].slice(0, boundedLimit);
}
