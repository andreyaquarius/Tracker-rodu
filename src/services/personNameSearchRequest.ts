import { getSupabaseClient } from "./supabaseAuth";
import { createPersonNameSearchGuard } from "../utils/personNameSearchGuard.ts";
import { AuthenticatedSessionRequiredError, runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest.ts";

const guardedSearch = createPersonNameSearchGuard<unknown>();

export async function requestPersonNameSearch(projectId: string, query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new AuthenticatedSessionRequiredError();
  const userId = data.session.user.id;
  // Include JWT epoch so a token refresh / changed permissions discards hints.
  const scope = `${userId}:${data.session.access_token}`;
  return guardedSearch(scope, JSON.stringify([projectId, query.trim(), limit]), async (requestSignal) => {
    const result = await runAuthenticatedSupabaseRequest(client, async () => {
      const response = await client.rpc("search_project_person_names_v1", {
        p_project_id: projectId, p_query: query.trim(), p_limit: limit,
      }).abortSignal(requestSignal);
      return { data: response.data, error: response.error };
    }, userId);
    if (result.error) throw result.error;
    return result.data;
  }, signal);
}
