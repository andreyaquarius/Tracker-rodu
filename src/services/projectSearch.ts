import { getSupabaseClient } from "./supabaseAuth";
import {
  mapProjectSearchResults,
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MIN_QUERY_LENGTH,
  projectSearchResultLimit,
} from "../utils/projectSearchResults";
import type { ProjectSearchResult } from "../utils/projectSearchResults";

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

  const { data, error } = await getSupabaseClient().rpc(
    "search_project_records",
    {
      target_project_id: projectId,
      search_query: normalizedQuery,
      result_limit: projectSearchResultLimit(limit),
    },
  );
  if (error) throw error;
  return mapProjectSearchResults(data);
}
