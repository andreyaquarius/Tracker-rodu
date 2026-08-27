import type { AppSettings, PersonNameDisplayMode } from "../types";
import {
  DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE,
  normalizePersonNameDisplayMode,
} from "../utils/personNameDisplay.ts";
import { getSupabaseClient } from "./supabaseAuth";

export interface ProjectPreferences {
  researcherName: string;
  compactTables: boolean;
  lastAutomaticBackupAt: string | null;
  personNameDisplayMode: PersonNameDisplayMode;
  personNameDisplayLanguage: string;
  personNameDisplayDate: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function projectPreferencesFromSettings(settings: AppSettings): ProjectPreferences {
  return {
    researcherName: settings.researcherName,
    compactTables: settings.compactTables,
    lastAutomaticBackupAt: settings.lastAutomaticBackupAt,
    personNameDisplayMode: normalizePersonNameDisplayMode(settings.personNameDisplayMode),
    personNameDisplayLanguage:
      typeof settings.personNameDisplayLanguage === "string"
        ? settings.personNameDisplayLanguage
        : DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE,
    personNameDisplayDate:
      typeof settings.personNameDisplayDate === "string"
        ? settings.personNameDisplayDate
        : "",
  };
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
    personNameDisplayMode: normalizePersonNameDisplayMode(
      settings.personNameDisplayMode ?? fallback.personNameDisplayMode,
    ),
    personNameDisplayLanguage:
      typeof settings.personNameDisplayLanguage === "string"
        ? settings.personNameDisplayLanguage
        : fallback.personNameDisplayLanguage,
    personNameDisplayDate:
      typeof settings.personNameDisplayDate === "string"
        ? settings.personNameDisplayDate
        : fallback.personNameDisplayDate,
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
