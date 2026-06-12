import type { TaskRecord } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

export interface DashboardStats {
  researches: number;
  documents: number;
  documentsInProgress: number;
  documentsReviewed: number;
  openTasks: number;
  completedTasks: number;
  findings: number;
  archiveRequests: number;
  persons: number;
  activeHypotheses: number;
  yearGaps: number;
  uncheckedYears: number;
}

type DashboardTaskRow = {
  id: string;
  research_id: string | null;
  person_name: string;
  title: string;
  description: string;
  place: string;
  year_from: string;
  year_to: string;
  document_type: string;
  document_id: string | null;
  status: string;
  priority: string;
  deadline: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

const EMPTY_STATS: DashboardStats = {
  researches: 0,
  documents: 0,
  documentsInProgress: 0,
  documentsReviewed: 0,
  openTasks: 0,
  completedTasks: 0,
  findings: 0,
  archiveRequests: 0,
  persons: 0,
  activeHypotheses: 0,
  yearGaps: 0,
  uncheckedYears: 0,
};

export async function loadProjectDashboard(projectId: string): Promise<{
  stats: DashboardStats;
  tasks: TaskRecord[];
}> {
  const client = getSupabaseClient();
  const [statsResult, tasksResult] = await Promise.all([
    client.rpc("get_dashboard_stats", { target_project_id: projectId }),
    client
      .from("tasks")
      .select("id, research_id, person_name, title, description, place, year_from, year_to, document_type, document_id, status, priority, deadline, notes, custom_fields, created_at, updated_at")
      .eq("project_id", projectId)
      .in("status", ["не почато", "в роботі"])
      .order("updated_at", { ascending: false })
      .limit(6),
  ]);
  if (statsResult.error) throw statsResult.error;
  if (tasksResult.error) throw tasksResult.error;
  const raw = (statsResult.data ?? {}) as Record<string, unknown>;
  return {
    stats: {
      ...EMPTY_STATS,
      researches: numberValue(raw.researches),
      documents: numberValue(raw.documents),
      documentsInProgress: numberValue(raw.documents_in_progress),
      documentsReviewed: numberValue(raw.documents_reviewed),
      openTasks: numberValue(raw.open_tasks),
      completedTasks: numberValue(raw.completed_tasks),
      findings: numberValue(raw.findings),
      archiveRequests: numberValue(raw.archive_requests),
      persons: numberValue(raw.persons),
      activeHypotheses: numberValue(raw.active_hypotheses),
      yearGaps: numberValue(raw.year_gaps),
      uncheckedYears: numberValue(raw.unchecked_years),
    },
    tasks: (tasksResult.data as DashboardTaskRow[]).map((row) => ({
      id: row.id,
      researchId: row.research_id ?? "",
      personName: row.person_name,
      personIds: [],
      title: row.title,
      description: row.description,
      place: row.place,
      yearFrom: row.year_from,
      yearTo: row.year_to,
      documentType: row.document_type,
      documentId: row.document_id ?? "",
      status: row.status,
      priority: row.priority,
      deadline: row.deadline,
      notes: row.notes,
      customFields: objectValue(row.custom_fields),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export const emptyDashboardStats = EMPTY_STATS;

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(value: unknown): Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, never>;
}
