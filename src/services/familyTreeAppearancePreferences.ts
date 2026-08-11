import type { FamilyTreeAppearancePreferences } from "../utils/familyTreeAppearance.ts";
import { normalizeFamilyTreeAppearance } from "../utils/familyTreeAppearance.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

type FamilyTreeAppearancePreferenceRow = {
  appearance: unknown;
  updated_at: string | null;
};

export interface StoredFamilyTreeAppearancePreference {
  appearance: FamilyTreeAppearancePreferences;
  updatedAt: string;
}

/**
 * Loads the current user's private appearance preference for one tree.
 * RLS binds the returned row to auth.uid(), so collaborators keep independent
 * visual settings for the same shared tree.
 */
export async function loadFamilyTreeAppearancePreference(
  projectId: string,
  treeId: string,
): Promise<StoredFamilyTreeAppearancePreference | null> {
  if (!projectId || !treeId) return null;

  const { data, error } = await getSupabaseClient()
    .from("family_tree_user_preferences")
    .select("appearance, updated_at")
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as FamilyTreeAppearancePreferenceRow;
  return {
    appearance: normalizeFamilyTreeAppearance(row.appearance),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** Saves all appearance options as one normalized, per-user tree preference. */
export async function saveFamilyTreeAppearancePreference(
  projectId: string,
  treeId: string,
  appearance: FamilyTreeAppearancePreferences,
): Promise<StoredFamilyTreeAppearancePreference> {
  if (!projectId || !treeId) {
    throw new Error("Для збереження налаштувань потрібно вибрати родове дерево.");
  }

  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;

  const userId = sessionData.session?.user.id;
  if (!userId) {
    throw new Error("Для синхронізації налаштувань потрібно увійти в обліковий запис.");
  }

  const normalized = normalizeFamilyTreeAppearance(appearance);
  const { data, error } = await client
    .from("family_tree_user_preferences")
    .upsert({
      user_id: userId,
      project_id: projectId,
      tree_id: treeId,
      appearance: normalized,
    }, {
      onConflict: "user_id,tree_id",
    })
    .select("appearance, updated_at")
    .single();

  if (error) throw error;

  const row = data as FamilyTreeAppearancePreferenceRow;
  return {
    appearance: normalizeFamilyTreeAppearance(row.appearance),
    updatedAt: String(row.updated_at ?? ""),
  };
}
