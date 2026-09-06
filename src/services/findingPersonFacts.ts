import type { Person } from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import { getProjectPerson } from "./projectPeople";
import { invalidateProjectPersonMarriages } from "./projectPersonMarriages.ts";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest.ts";

export async function syncFindingPersonFacts(projectId: string, findingId: string): Promise<{ persons: Person[]; conflictCount: number }> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const response = await client.rpc("sync_finding_person_facts_v1", { p_project_id: projectId, p_finding_id: findingId });
    return { data: response.data, error: response.error };
  });
  if (error) throw error;
  const result = data as { personIds?: string[]; conflicts?: unknown[] } | null;
  invalidateProjectPersonMarriages(projectId);
  const persons: Person[] = [];
  const ids = [...new Set(result?.personIds ?? [])];
  // Bounded refresh; no full project reload (which used to interrupt editors).
  for (let offset = 0; offset < ids.length; offset += 8) {
    const loaded = await Promise.all(ids.slice(offset, offset + 8).map((id) => getProjectPerson(projectId, id)));
    persons.push(...loaded.filter((person): person is Person => person !== null));
  }
  return { persons, conflictCount: result?.conflicts?.length ?? 0 };
}
