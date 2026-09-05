import {
  normalizeFamilyTreeViewPreferences,
  type FamilyTreeViewPreferences,
} from "../utils/familyTreeViewPreferences.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

type FamilyTreeViewPreferenceRow = {
  view_settings: unknown;
  updated_at: string | null;
};

export interface StoredFamilyTreeViewPreference {
  preferences: FamilyTreeViewPreferences;
  updatedAt: string;
}

export async function getAuthenticatedFamilyTreeViewPreferenceUserId(): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw error;
  const userId = data.session?.user.id;
  if (!userId) {
    throw new Error("Для синхронізації налаштувань потрібно увійти в обліковий запис.");
  }
  return userId;
}

async function assertExpectedUser(expectedUserId?: string): Promise<string> {
  const userId = await getAuthenticatedFamilyTreeViewPreferenceUserId();
  if (expectedUserId && userId !== expectedUserId) {
    throw new Error("Обліковий запис змінився. Налаштування не були синхронізовані.");
  }
  return userId;
}

/** Loads only the current user's private view_settings for one project tree. */
export async function loadFamilyTreeViewPreference(
  projectId: string,
  treeId: string,
  expectedUserId?: string,
): Promise<StoredFamilyTreeViewPreference | null> {
  if (!projectId || !treeId) return null;
  const userId = await assertExpectedUser(expectedUserId);
  const { data, error } = await getSupabaseClient()
    .from("family_tree_view_preferences")
    .select("view_settings, updated_at")
    .eq("user_id", userId)
    .eq("tree_id", treeId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const row = data as FamilyTreeViewPreferenceRow;
  return {
    preferences: normalizeFamilyTreeViewPreferences(row.view_settings),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** Upserts only view_settings; appearance choices in the same row stay intact. */
export async function saveFamilyTreeViewPreference(
  projectId: string,
  treeId: string,
  preferences: FamilyTreeViewPreferences,
  expectedUserId?: string,
): Promise<StoredFamilyTreeViewPreference> {
  if (!projectId || !treeId) {
    throw new Error("Для збереження налаштувань потрібно вибрати родове дерево.");
  }
  const userId = await assertExpectedUser(expectedUserId);
  const normalized = normalizeFamilyTreeViewPreferences(preferences);
  const { data, error } = await getSupabaseClient()
    .from("family_tree_view_preferences")
    .upsert({
      user_id: userId,
      tree_id: treeId,
      view_settings: normalized,
    }, {
      onConflict: "user_id,tree_id",
    })
    .select("view_settings, updated_at")
    .single();

  if (error) throw error;
  const row = data as FamilyTreeViewPreferenceRow;
  return {
    preferences: normalizeFamilyTreeViewPreferences(row.view_settings),
    updatedAt: String(row.updated_at ?? ""),
  };
}
