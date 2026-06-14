import { getSupabaseClient } from "./supabaseAuth";

export interface ProjectDashboardStats {
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

export interface ProjectDashboardTask {
  id: string;
  title: string;
  personName: string;
  place: string;
  status: string;
  priority: string;
}

const EMPTY_STATS: ProjectDashboardStats = {
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

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadProjectDashboard(
  projectId: string,
): Promise<{
  stats: ProjectDashboardStats;
  tasks: ProjectDashboardTask[];
}> {
  const client = getSupabaseClient();
  const [statsResult, tasksResult] = await Promise.all([
    client.rpc("get_dashboard_stats", { target_project_id: projectId }),
    client
      .from("tasks")
      .select("id, title, person_name, place, status, priority")
      .eq("project_id", projectId)
      .in("status", ["не почато", "в роботі"])
      .order("updated_at", { ascending: false })
      .limit(10),
  ]);
  if (statsResult.error) throw statsResult.error;
  if (tasksResult.error) throw tasksResult.error;

  const value = (
    statsResult.data &&
    typeof statsResult.data === "object" &&
    !Array.isArray(statsResult.data)
  )
    ? statsResult.data as Record<string, unknown>
    : {};

  return {
    stats: {
      researches: numberValue(value.researches),
      documents: numberValue(value.documents),
      documentsInProgress: numberValue(value.documents_in_progress),
      documentsReviewed: numberValue(value.documents_reviewed),
      openTasks: numberValue(value.open_tasks),
      completedTasks: numberValue(value.completed_tasks),
      findings: numberValue(value.findings),
      archiveRequests: numberValue(value.archive_requests),
      persons: numberValue(value.persons),
      activeHypotheses: numberValue(value.active_hypotheses),
      yearGaps: numberValue(value.year_gaps),
      uncheckedYears: numberValue(value.unchecked_years),
    },
    tasks: (tasksResult.data ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      personName: String(row.person_name ?? ""),
      place: String(row.place ?? ""),
      status: String(row.status ?? ""),
      priority: String(row.priority ?? ""),
    })),
  };
}

export function emptyProjectDashboardStats(): ProjectDashboardStats {
  return { ...EMPTY_STATS };
}
