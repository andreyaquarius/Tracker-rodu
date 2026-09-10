import { getSupabaseClient } from "./supabaseAuth";
import { createSharedAbortableRequest } from "../utils/sharedAbortableRequest.ts";

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
  personIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, ProjectPersonSummary>> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const ids = [...new Set(personIds)].sort();
  if (!ids.length) return new Map();
  if (ids.length > 200) throw new RangeError("Person summaries are limited to 200 persons per request.");
  const client = getSupabaseClient();
  const session = await client.auth.getSession();
  if (session.error) throw session.error;
  // Never share a private read across accounts or JWT/permission changes.
  const token = session.data.session?.access_token;
  if (!token) throw new Error("Сесію завершено. Увійдіть до облікового запису ще раз.");
  return summaryRequests.run(JSON.stringify([token, projectId, ids]), async (requestSignal) => {
    const { data, error } = await client.rpc("list_person_summaries_v2", {
      target_project_id: projectId,
      target_person_ids: ids,
    }).abortSignal(requestSignal);
    // A missing migration falls back to the existing local counters in the UI,
    // never to the expensive unbounded legacy RPC.
    if (error) throw error;
    return mapProjectPersonSummaries(data);
  }, signal);
}

const summaryRequests = createSharedAbortableRequest<Map<string, ProjectPersonSummary>>();
