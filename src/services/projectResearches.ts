import type { CustomFieldValues, Research } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

type ResearchRow = {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  surnames: string;
  places: string;
  period_from: string;
  period_to: string;
  archives: string;
  status: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

function asCustomFields(value: unknown): CustomFieldValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as CustomFieldValues;
}

function fromRow(row: ResearchRow): Research {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    surnames: row.surnames,
    places: row.places,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    archives: row.archives,
    status: row.status as Research["status"],
    notes: row.notes,
    customFields: asCustomFields(row.custom_fields),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(projectId: string, research: Research) {
  return {
    id: research.id,
    project_id: projectId,
    title: research.title,
    goal: research.goal,
    surnames: research.surnames,
    places: research.places,
    period_from: research.periodFrom,
    period_to: research.periodTo,
    archives: research.archives,
    status: research.status,
    notes: research.notes,
    custom_fields: research.customFields ?? {},
    created_at: research.createdAt,
    updated_at: research.updatedAt,
  };
}

export async function listProjectResearches(projectId: string): Promise<Research[]> {
  const { data, error } = await getSupabaseClient()
    .from("researches")
    .select(
      "id, project_id, title, goal, surnames, places, period_from, period_to, archives, status, notes, custom_fields, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as ResearchRow[]).map(fromRow);
}

export async function saveProjectResearch(
  projectId: string,
  research: Research,
): Promise<Research> {
  const { data, error } = await getSupabaseClient()
    .from("researches")
    .upsert(toRow(projectId, research), { onConflict: "id" })
    .select(
      "id, project_id, title, goal, surnames, places, period_from, period_to, archives, status, notes, custom_fields, created_at, updated_at",
    )
    .single();
  if (error) throw error;
  return fromRow(data as ResearchRow);
}

export async function importProjectResearches(
  projectId: string,
  researches: Research[],
): Promise<Research[]> {
  if (!researches.length) return [];
  const { data, error } = await getSupabaseClient()
    .from("researches")
    .upsert(researches.map((research) => toRow(projectId, research)), { onConflict: "id" })
    .select(
      "id, project_id, title, goal, surnames, places, period_from, period_to, archives, status, notes, custom_fields, created_at, updated_at",
    );
  if (error) throw error;
  return (data as ResearchRow[]).map(fromRow);
}

export async function deleteProjectResearch(projectId: string, researchId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("researches")
    .delete()
    .eq("project_id", projectId)
    .eq("id", researchId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-researches:";

export function loadProjectResearchCache(projectId: string): Research[] {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as Research[]) : [];
  } catch {
    return [];
  }
}

export function saveProjectResearchCache(projectId: string, researches: Research[]): void {
  localStorage.setItem(`${CACHE_PREFIX}${projectId}`, JSON.stringify(researches));
}

export function clearProjectResearchCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
