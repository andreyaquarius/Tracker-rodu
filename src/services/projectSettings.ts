import type { AppSettings } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

export type ProjectPreferences = Pick<
  AppSettings,
  "researcherName" | "compactTables" | "lastAutomaticBackupAt"
>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function loadProjectPreferences(
  projectId: string,
  fallback: ProjectPreferences,
): Promise<ProjectPreferences> {
  const { data, error } = await getSupabaseClient()
    .from("projects")
    .select("settings")
    .eq("id", projectId)
    .single();
  if (error) throw error;

  const settings = asRecord(data.settings);
  return {
    researcherName:
      typeof settings.researcherName === "string"
        ? settings.researcherName
        : fallback.researcherName,
    compactTables:
      typeof settings.compactTables === "boolean"
        ? settings.compactTables
        : fallback.compactTables,
    lastAutomaticBackupAt:
      typeof settings.lastAutomaticBackupAt === "string"
        ? settings.lastAutomaticBackupAt
        : null,
  };
}

export async function saveProjectPreferences(
  projectId: string,
  preferences: ProjectPreferences,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("projects")
    .update({ settings: preferences })
    .eq("id", projectId);
  if (error) throw error;
}
