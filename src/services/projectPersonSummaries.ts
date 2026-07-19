import { getSupabaseClient } from "./supabaseAuth";

export interface ProjectPersonSummary {
  personId: string;
  relationCount: number;
  taskCount: number;
  hypothesisCount: number;
  archiveRequestCount: number;
  findingCount: number;
  documentCount: number;
  lastEventType: string | null;
  lastEventDate: string | null;
}

type PersonSummaryRpcRow = {
  person_id?: unknown;
  relation_count?: unknown;
  task_count?: unknown;
  hypothesis_count?: unknown;
  archive_request_count?: unknown;
  finding_count?: unknown;
  document_count?: unknown;
  last_event_type?: unknown;
  last_event_date?: unknown;
};

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/** Normalize PostgREST bigint strings and nullable event columns. */
export function mapProjectPersonSummaries(value: unknown): Map<string, ProjectPersonSummary> {
  const summaries = new Map<string, ProjectPersonSummary>();
  if (!Array.isArray(value)) return summaries;

  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as PersonSummaryRpcRow;
    const personId = nullableText(row.person_id);
    if (!personId) continue;
    summaries.set(personId, {
      personId,
      relationCount: nonNegativeInteger(row.relation_count),
      taskCount: nonNegativeInteger(row.task_count),
      hypothesisCount: nonNegativeInteger(row.hypothesis_count),
      archiveRequestCount: nonNegativeInteger(row.archive_request_count),
      findingCount: nonNegativeInteger(row.finding_count),
      documentCount: nonNegativeInteger(row.document_count),
      lastEventType: nullableText(row.last_event_type),
      lastEventDate: nullableText(row.last_event_date),
    });
  }

  return summaries;
}

export async function loadProjectPersonSummaries(
  projectId: string,
): Promise<Map<string, ProjectPersonSummary>> {
  const { data, error } = await getSupabaseClient().rpc(
    "list_person_summaries",
    { target_project_id: projectId },
  );
  if (error) throw error;
  return mapProjectPersonSummaries(data);
}
